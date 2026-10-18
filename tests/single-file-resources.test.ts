import { replaceFileSteps } from './file-write-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  symlinkSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { recoverySummary } from '../apps/desktop/renderer/src/recovery.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid } from '../packages/agent/src/identity.js';
import { fileIdentity } from '../packages/adapters/src/host-files/paths.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';

const lastData = (r: PreparedRequest) =>
  JSON.parse(
    (r.body.messages as { role: string; content: string }[])
      .filter((m) => m.role === 'tool')
      .at(-1)!.content,
  ).data as Record<string, any>;
const pending = (app: UmiApplication, id: string) =>
  Object.entries(app.store.snapshot(id).approvals).find(
    ([, a]) => a.status === 'pending',
  )?.[0];
function setup(steps: Step[]) {
  const root = mkdtempSync(join(tmpdir(), 'umi-single-file-')),
    workspace = join(root, 'workspace'),
    external = join(root, 'external');
  mkdirSync(workspace);
  mkdirSync(external);
  const model = new ScriptModel(steps),
    app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace);
  return {
    root,
    workspace,
    external,
    model,
    app,
    c,
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}
const request = (r: PreparedRequest) =>
  call('request_resource', {
    candidateId: lastData(r).candidates[0].id,
    access: 'edit',
    purpose: '单文件验收',
  });

test('单文件：大目录中小 HTML 完成批准、副本编辑和固定交付，旁边大文件与链接不参与', async () => {
  let target = '',
    mountId = '';
  const f = setup([
    () => call('discover_resource', { path: target, query: '不匹配的目录名' }),
    request,
    ...replaceFileSteps(
      (r) => (mountId = lastData(r).mountId),
      '页面.html',
      '<h1>新内容</h1>',
    ),
    () => call('build_changeset', { mountId }),
    (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
    text('已核验'),
  ]);
  target = join(f.external, '页面.html');
  writeFileSync(target, '<h1>旧内容</h1>');
  writeFileSync(join(f.external, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  symlinkSync(f.workspace, join(f.external, 'unrelated-link'), 'junction');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '修改这个文件'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    assert.match(
      f.app.store.snapshot(f.c.conversationId).approvals[a]!.description,
      /这一个文件/,
    );
    const discovery = f.app.store
        .tools(r.runId)
        .find((t) => t.name === 'discover_resource')!,
      result = f.app.store.readArtifact<{ data: any }>(discovery.result_ref!);
    assert.equal(result.data.candidates[0].path, target);
    assert.equal(result.data.candidates[0].scope.kind, 'file');
    assert.equal(result.data.contentRead, false);
    assert(!JSON.stringify(result).includes('<h1>旧内容'));
    f.app.approve(f.c.conversationId, a, 'allow');
    const deliver = await eventually(() => pending(f.app, f.c.conversationId));
    const m = f.app.files.repo.mount(mountId, f.c.environmentId),
      env = f.app.store.environment(f.c.environmentId);
    assert.deepEqual(Object.keys(f.app.files.repo.baseline(m)), ['页面.html']);
    assert(!existsSync(join(m.root, 'large.bin')));
    assert.equal(readFileSync(target, 'utf8'), '<h1>旧内容</h1>');
    for (const name of ['read_file', 'stat_file', 'write_file', 'delete_file'])
      assert.throws(
        () =>
          f.app.registry.get(name).prepare(
            {
              mountId,
              path: 'large.bin',
              ...(name === 'write_file' ? { content: '越界' } : {}),
            },
            env,
          ),
        /单文件授权/,
      );
    assert.throws(
      () =>
        f.app.registry
          .get('recycle_file')
          .prepare({ resourceId: m.resourceId, path: 'large.bin' }, env),
      /单文件授权/,
    );
    await assert.rejects(
      () =>
        f.app.registry
          .get('build_changeset')
          .execute(
            { mountId, paths: ['large.bin'] },
            f.app.files.mountContext({}, env, mountId),
            f.c.conversationId,
            new AbortController().signal,
          ),
      /单文件授权/,
    );
    // 即使其他宿主操作在副本创建旁支文件，结构化列表和搜索仍只看所选文件。
    writeFileSync(join(m.root, 'foreign.txt'), '旁支秘密');
    const list = await f.app.registry
      .get('list_files')
      .execute(
        { mountId },
        f.app.files.mountContext({}, env, mountId),
        f.c.conversationId,
        new AbortController().signal,
      );
    assert.deepEqual(
      (list.data as any).files.map((x: any) => x.path),
      ['页面.html'],
    );
    const search = await f.app.registry
      .get('search_text')
      .execute(
        { mountId, query: '旁支秘密' },
        f.app.files.mountContext({}, env, mountId),
        f.c.conversationId,
        new AbortController().signal,
      );
    assert.equal((search.data as any).totalMatches, 0);
    const cs = f.app.files.repo.changeSet(
      f.app.store.get('SELECT id FROM changesets')!.id as string,
      env.id,
    );
    assert.equal(cs.resourceScope?.kind, 'file');
    assert.deepEqual(
      cs.changes.map((c) => c.path),
      ['页面.html'],
    );
    f.app.approve(f.c.conversationId, deliver, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(readFileSync(target, 'utf8'), '<h1>新内容</h1>');
    assert.equal(f.app.store.all('SELECT * FROM delivery_items').length, 1);
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(
      f.app.store
        .events(f.c.conversationId)
        .reduce(
          reduceConversation,
          initialState(f.c.conversationId, state.cursor.logEpoch),
        ),
      state,
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['content', 'restored-time', 'identity', 'missing'] as const)
  test(`单文件：等待批准后 ${mode} 变化使原批准失效，未读取正文或复制`, async () => {
    let target = '';
    const f = setup([
      () => call('discover_resource', { path: target }),
      request,
      text('来源变化'),
    ]);
    target = join(f.external, 'a.txt');
    writeFileSync(target, '旧');
    try {
      const r = f.app.send(f.c.conversationId, uid(), '读取单文件'),
        a = await eventually(() => pending(f.app, f.c.conversationId));
      const stamp = statSync(target);
      if (mode === 'restored-time') {
        writeFileSync(target, '新');
        utimesSync(target, stamp.atime, stamp.mtime);
      }
      if (mode === 'identity' || mode === 'missing') renameSync(target, target + '.old');
      if (mode === 'identity') writeFileSync(target, '旧');
      if (mode === 'content') {
        writeFileSync(target, '新');
        utimesSync(target, new Date(), new Date(Date.now() + 5000));
      }
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      assert.equal(
        f.app.store.tools(r.runId).find((t) => t.name === 'request_resource')!.state,
        'failed',
      );
      assert.equal(
        f.app.store.all('SELECT * FROM capabilities WHERE run_id IS NOT NULL').length,
        0,
      );
      assert.equal(f.app.files.repo.mounts(f.c.environmentId).length, 1);
      assert.equal(
        f.app.store.snapshot(f.c.conversationId).approvals[a]!.status,
        'invalidated',
      );
    } finally {
      await f.close();
    }
  });

test('单文件：多个同名文件通过候选和挂载身份独立定位', async () => {
  let one = '',
    two = '';
  const mounts: string[] = [];
  const f = setup([
    () => call('discover_resource', { path: one }),
    request,
    (r) => {
      mounts.push(lastData(r).mountId);
      return call('discover_resource', { path: two });
    },
    request,
    (r) => {
      mounts.push(lastData(r).mountId);
      return text('两个来源');
    },
  ]);
  one = join(f.external, 'a.txt');
  const other = join(f.root, 'other');
  mkdirSync(other);
  two = join(other, 'a.txt');
  writeFileSync(one, '甲');
  writeFileSync(two, '乙');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '读取两个来源');
    for (let i = 0; i < 2; i++) {
      const a = await eventually(() => pending(f.app, f.c.conversationId));
      f.app.approve(f.c.conversationId, a, 'allow');
    }
    await f.app.wait(r.runId);
    assert.notEqual(mounts[0], mounts[1]);
    const a = f.app.files.repo.mount(mounts[0]!, f.c.environmentId),
      b = f.app.files.repo.mount(mounts[1]!, f.c.environmentId);
    assert.notEqual(a.resourceId, b.resourceId);
    assert.equal(f.app.files.read(a, 'a.txt').text, '甲');
    assert.equal(f.app.files.read(b, 'a.txt').text, '乙');
  } finally {
    await f.close();
  }
});

for (const kind of ['file', 'directory'] as const)
  test(`物化：${kind} 超过 4 MiB 单文件限额，扫描失败直接结算并保留具体原因`, async () => {
    let target = '';
    const f = setup([
      () => call('discover_resource', { path: target }),
      request,
      text('限额未完成'),
    ]);
    const big = join(f.external, 'large.bin');
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1));
    target = kind === 'file' ? big : f.external;
    try {
      const r = f.app.send(f.c.conversationId, uid(), '读取来源'),
        a = await eventually(() => pending(f.app, f.c.conversationId));
      f.app.approve(f.c.conversationId, a, 'allow');
      assert.equal((await f.app.wait(r.runId)).status, 'completed');
      const t = f.app.store.tools(r.runId).find((t) => t.name === 'request_resource')!,
        result = f.app.store.readArtifact<any>(t.result_ref!);
      assert.equal(t.state, 'failed');
      assert.equal(result.data.code, 'RESOURCE_LIMIT');
      assert.match(result.content, /4 MiB/);
      assert.equal(result.data.failure.effects, 'not-started');
      assert.equal(result.data.failure.stage, 'scan');
      assert.equal(f.app.store.all('SELECT * FROM materializations').length, 1); // 仅初始空工作区的计划。
      const inspection = f.app.inspectRecovery(f.c.conversationId, r.runId),
        lines = recoverySummary(inspection as any);
      assert(lines.some((l) => l.includes('4 MiB') && l.includes('尚未开始复制')));
      const html = renderToStaticMarkup(
        createElement(Timeline, {
          snapshot: new DesktopService(f.app).snapshot(f.c.conversationId),
          onPreview: () => {},
          onError: () => {},
        }),
      );
      assert(html.includes('资源物化结果'));
      assert(html.includes('4 MiB'));
      const before = f.app.store.events(f.c.conversationId);
      f.app.inspectRecovery(f.c.conversationId, r.runId);
      assert.deepEqual(f.app.store.events(f.c.conversationId), before);
    } finally {
      await f.close();
    }
  });

test('发现：精确路径缺失、链接拒绝和目录候选为空有不同结果', async () => {
  const f = setup([]);
  try {
    const env = f.app.store.environment(f.c.environmentId),
      missing = f.app.files.discover(env, '', join(f.external, 'missing.html'));
    assert.equal(missing.status, 'not_found');
    assert.equal(missing.exactPath, true);
    symlinkSync(f.workspace, join(f.external, 'linked'), 'junction');
    assert.equal(
      f.app.files.discover(env, '', join(f.external, 'linked')).status,
      'rejected',
    );
    const empty = f.app.files.discover(env, 'umi-query-that-cannot-match-' + uid());
    assert.equal(empty.status, 'no_candidates');
    assert.equal(empty.exactPath, false);
    assert.deepEqual(empty.searchedKinds, ['directory']);
    assert.match(empty.notice!, /不代表文件不存在/);
  } finally {
    await f.close();
  }
});

test('单文件：拒绝后同对象内容变化和重新发现不能绕过拒绝', async () => {
  const f = setup([]);
  const target = join(f.external, 'a.txt');
  writeFileSync(target, '旧');
  try {
    const env = f.app.store.environment(f.c.environmentId),
      first = f.app.files.discover(env, '', target).candidates[0]!;
    f.app.files.repo.recordDenial(first, 'read');
    writeFileSync(target, '新内容');
    const next = f.app.files.discover(env, '', target).candidates[0]!;
    assert.notEqual(first.id, next.id);
    assert(f.app.files.repo.denied(next, 'edit'));
  } finally {
    await f.close();
  }
});

test('迁移 6：版本 5 的目录候选、挂载、原始消息和事件原样保留', async () => {
  const f = setup([text('普通会话')]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '迁移前原文');
    await f.app.wait(r.runId);
    const events = f.app.store.events(f.c.conversationId),
      messages = f.app.store.messages(f.c.conversationId),
      mounts = f.app.files.repo.mounts(f.c.environmentId),
      checksums = f.app.store.all('SELECT * FROM schema_migrations WHERE version<=5');
    f.app.store.db.exec(
      'DROP TABLE conversation_deletions; DELETE FROM schema_migrations WHERE version=7; DROP TABLE resource_scopes; DELETE FROM schema_migrations WHERE version=6',
    );
    await f.app.close();
    const app = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try {
      assert.equal(
        app.store.get('SELECT max(version) version FROM schema_migrations')!.version,
        7,
      );
      assert.deepEqual(
        app.store.all('SELECT * FROM schema_migrations WHERE version<=5'),
        checksums,
      );
      assert.deepEqual(app.store.events(f.c.conversationId), events);
      assert.deepEqual(app.store.messages(f.c.conversationId), messages);
      assert.deepEqual(app.files.repo.mounts(f.c.environmentId), mounts);
      assert.equal(mounts[0]!.scope.kind, 'directory');
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});

test('单文件：交付批准后来源被用户编辑，记录冲突且不覆盖', async () => {
  let target = '',
    mountId = '';
  const f = setup([
    () => call('discover_resource', { path: target }),
    request,
    ...replaceFileSteps((r) => (mountId = lastData(r).mountId), 'a.txt', '模型修改'),
    () => call('build_changeset', { mountId }),
    (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
    text('有冲突'),
  ]);
  target = join(f.external, 'a.txt');
  writeFileSync(target, '原文');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '编辑并交付'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    f.app.approve(f.c.conversationId, a, 'allow');
    const delivery = await eventually(() => pending(f.app, f.c.conversationId));
    writeFileSync(target, '用户修改');
    f.app.approve(f.c.conversationId, delivery, 'allow');
    await f.app.wait(r.runId);
    assert.equal(
      f.app.store.tools(r.runId).find((t) => t.name === 'deliver_changeset')!.state,
      'failed',
    );
    assert.equal(readFileSync(target, 'utf8'), '用户修改');
    assert.equal(f.app.store.all('SELECT * FROM delivery_items').length, 0);
  } finally {
    await f.close();
  }
});

for (const mode of ['file-partial', 'file-complete'])
  test(
    `单文件：实际子进程退出 ${mode}，重启只核验原计划，来源后来变化不触发复制`,
    { timeout: 15000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'umi-single-file-crash-')),
        workspace = join(root, 'workspace'),
        external = join(root, 'external'),
        data = join(root, 'data');
      mkdirSync(workspace);
      mkdirSync(external);
      writeFileSync(join(external, 'a.txt'), '甲');
      writeFileSync(join(external, 'b.txt'), '乙');
      const child = fork(
        new URL('./materialization-crash-worker.js', import.meta.url),
        [data, workspace, mode],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      let errors = '',
        app: UmiApplication | undefined;
      child.stderr!.on('data', (b) => (errors += String(b)));
      try {
        const [code] = await once(child, 'exit');
        assert.equal(code, 137, errors);
        const cp = JSON.parse(readFileSync(join(data, 'checkpoint.json'), 'utf8'));
        writeFileSync(join(external, 'a.txt'), '用户后来修改');
        app = new UmiApplication(data, new ScriptModel([text('说明核验结果')]));
        const t = app.store.tool(cp.executionId),
          ctx = executionContextSchema.parse(app.store.readArtifact(t.context_ref!)),
          loc = ctx.locations.find((l) => l.rootRef.kind === 'mount')!;
        assert.equal(ctx.resourceScope?.kind, 'file');
        const before = existsSync(join(loc.physicalRoot!, 'a.txt'))
          ? fileIdentity(join(loc.physicalRoot!, 'a.txt'))
          : null;
        const inspect = app.inspectRecovery(cp.conversationId, cp.runId);
        assert(recoverySummary(inspect as any).some((l) => l.includes('1 项原操作待核验')));
        app.resume(cp.conversationId, cp.runId);
        assert.equal((await app.wait(cp.runId)).status, 'completed');
        assert.equal(
          app.store.tool(t.id).state,
          mode === 'file-complete' ? 'succeeded' : 'failed',
        );
        assert.equal(readFileSync(join(external, 'a.txt'), 'utf8'), '用户后来修改');
        assert(!existsSync(join(loc.physicalRoot!, 'b.txt')));
        assert.equal(
          existsSync(join(loc.physicalRoot!, 'a.txt'))
            ? fileIdentity(join(loc.physicalRoot!, 'a.txt'))
            : null,
          before,
        );
        if (mode === 'file-complete')
          assert.equal(readFileSync(join(loc.physicalRoot!, 'a.txt'), 'utf8'), '甲');
        assert.equal(
          app.store
            .events(cp.conversationId)
            .filter((e) => e.type === 'tool.dispatch_intent' && e.executionId === t.id)
            .length,
          1,
        );
        const state = app.store.snapshot(cp.conversationId);
        assert.equal(
          Object.values(state.tools).find((x) => x.executionId === t.id)!.verification,
          mode === 'file-complete' ? 'materialized-plan-verified' : 'not-materialized',
        );
      } finally {
        if (child.exitCode === null && !child.killed) {
          const done = once(child, 'exit');
          child.kill('SIGKILL');
          await done;
        }
        await app?.close();
        removeTestRoot(root);
      }
    },
  );

test('单文件：复制根绑定后停止，恢复失败核验保留原副本且不重复制', async () => {
  let target = '',
    runId = '',
    stop: Promise<void> | undefined;
  const f = setup([
    () => call('discover_resource', { path: target }),
    request,
    text('停止后的核验'),
  ]);
  target = join(f.external, 'a.txt');
  writeFileSync(target, '原文');
  try {
    const bind = f.app.files.repo.bindMaterializationRoot.bind(f.app.files.repo);
    f.app.files.repo.bindMaterializationRoot = (id, env, identity) => {
      bind(id, env, identity);
      stop = f.app.stop(f.c.conversationId, runId);
    };
    runId = f.app.send(f.c.conversationId, uid(), '读取文件').runId;
    const a = await eventually(() => pending(f.app, f.c.conversationId));
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(runId)).status, 'stopped');
    await stop;
    const t = f.app.store.tools(runId).find((t) => t.name === 'request_resource')!,
      result = f.app.store.readArtifact<any>(t.result_ref!);
    assert.equal(t.state, 'unknown');
    assert.equal(result.data.failure.stage, 'copy');
    f.app.resume(f.c.conversationId, runId);
    await f.app.wait(runId);
    assert.equal(f.app.store.tool(t.id).state, 'failed');
    assert.equal(readFileSync(target, 'utf8'), '原文');
    assert.equal(f.app.files.repo.mounts(f.c.environmentId).length, 1);
  } finally {
    await f.close();
  }
});

test('初始工作区：复制中失败依据已保存计划说明部分效果，不误报扫描前失败', async () => {
  const f = setup([]);
  writeFileSync(join(f.external, 'a.txt'), '甲');
  writeFileSync(join(f.external, 'b.txt'), '乙');
  try {
    const save = f.app.files.saveBlob.bind(f.app.files);
    let count = 0;
    f.app.files.saveBlob = (env, bytes) => {
      if (++count === 2) throw new Error('注入第二个文件复制失败');
      return save(env, bytes);
    };
    const c = f.app.createConversation(f.external),
      state = f.app.store.snapshot(c.conversationId),
      failure = Object.values(state.resources).find(
        (r) => r.materializationError,
      )!.materializationError!;
    assert.equal(failure.failure?.stage, 'copy');
    assert.equal(failure.failure?.effects, 'partial-or-unknown');
    assert.match(failure.reason, /第二个文件/);
    assert.equal(f.app.files.repo.mounts(c.environmentId).length, 0);
  } finally {
    await f.close();
  }
});

test(
  'Windows 单文件：不同路径大小写仍复用同一规范候选',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = setup([]),
      target = join(f.external, 'MixedCase.txt');
    writeFileSync(target, '原文');
    try {
      const env = f.app.store.environment(f.c.environmentId),
        a = f.app.files.discover(env, '', target).candidates[0]!,
        b = f.app.files.discover(env, '', target.toUpperCase()).candidates[0]!;
      assert.equal(a.id, b.id);
      assert.equal(a.scope.kind, 'file');
    } finally {
      await f.close();
    }
  },
);
