import { replaceFileSteps, replaceFilesSteps } from './file-write-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid } from '../packages/agent/src/identity.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { fileIdentity } from '../packages/adapters/src/host-files/paths.js';

const lastData = (r: PreparedRequest) =>
  JSON.parse(
    (r.body.messages as { role: string; content: string }[])
      .filter((m) => m.role === 'tool')
      .at(-1)!.content,
  ).data as Record<string, any>;
const pending = (app: UmiApplication, c: string) =>
  Object.entries(app.store.snapshot(c).approvals).find(
    ([, a]) => a.status === 'pending',
  )?.[0];
function fixture(steps: Step[], source: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'umi-resource-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  for (const [p, v] of Object.entries(source)) {
    mkdirSync(join(workspace, p, '..'), { recursive: true });
    writeFileSync(join(workspace, p), v);
  }
  const model = new ScriptModel(steps),
    app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace),
    m = app.files.repo.mounts(c.environmentId)[0]!;
  return {
    root,
    workspace,
    model,
    app,
    c,
    m,
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('A23/A25/A27：多文件副本编辑自动执行，固定交付阻塞，回执后才发布最终回复', async () => {
  let mountId = '';
  const steps: Step[] = [
    ...replaceFilesSteps(
      () => mountId,
      [
        ['a.txt', '新甲'],
        ['b.txt', '新乙'],
      ],
    ),
    () => call('build_changeset', { mountId }),
    (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
    text('交付回执已核验'),
    text('最终：两文件已写回'),
  ];
  const f = fixture(steps, { 'a.txt': '旧甲', 'b.txt': '旧乙' });
  mountId = f.m.id;
  try {
    const r = f.app.send(f.c.conversationId, uid(), '修改两个文件并交付'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    assert.equal(f.model.requests.length, 4);
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '旧甲');
    assert.equal(readFileSync(join(f.m.root, 'a.txt'), 'utf8'), '新甲');
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      1,
    );
    assert.equal(f.app.store.getRun(r.runId).status, 'waiting_permission');
    assert(
      !f.app.store
        .snapshot(f.c.conversationId)
        .blocks.some((b) => b.displayRole === 'final'),
    );
    assert.match(
      f.app.store.snapshot(f.c.conversationId).approvals[a]!.description,
      /a.txt/,
    );
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '新甲');
    assert.equal(readFileSync(join(f.workspace, 'b.txt'), 'utf8'), '新乙');
    assert.equal(f.app.store.all('SELECT * FROM delivery_items').length, 2);
    assert.equal(
      f.app.store.all("SELECT * FROM delivery_items WHERE state='intent'").length,
      0,
    );
    const events = f.app.store.events(f.c.conversationId),
      snap = f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(
      events.reduce(
        reduceConversation,
        initialState(f.c.conversationId, snap.cursor.logEpoch),
      ),
      snap,
    );
    const ctx = executionContextSchema.parse(
      f.app.store.readArtifact(
        f.app.store.tools(r.runId).find((t) => t.name === 'deliver_changeset')!
          .context_ref!,
      ),
    );
    assert(
      ctx.locations.some(
        (l) => l.rootRef.kind === 'mount' && l.rootRef.mountId === mountId,
      ),
    );
    assert(
      ctx.locations.some(
        (l) => l.rootRef.kind === 'source' && l.rootRef.resourceId === f.m.resourceId,
      ),
    );
  } finally {
    await f.close();
  }
});

test('A21/A22：外部发现只有元数据，拒绝持久保存且换用途不能重复申请', async () => {
  let outside = '',
    candidate = '';
  const f = fixture([
    () => call('discover_resource', { path: outside }),
    (r) => {
      candidate = lastData(r).candidates[0].id;
      return call('request_resource', {
        candidateId: candidate,
        access: 'read',
        purpose: '读取参考资料',
      });
    },
    text('已拒绝'),
    () =>
      call('request_resource', {
        candidateId: candidate,
        access: 'read',
        purpose: '换个用途再试',
      }),
    text('仍拒绝'),
    text('结束'),
  ]);
  outside = join(f.root, 'external');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), '仅在授权后读取的正文');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '读取外部参考'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    assert.equal(f.model.requests.length, 2);
    assert.equal(f.app.files.repo.mounts(f.c.environmentId).length, 1);
    const discovery = f.app.store
      .tools(r.runId)
      .find((t) => t.name === 'discover_resource')!;
    assert(
      !JSON.stringify(f.app.store.readArtifact(discovery.result_ref!)).includes(
        '仅在授权后读取',
      ),
    );
    f.app.approve(f.c.conversationId, a, 'deny');
    await f.app.wait(r.runId);
    const r2 = f.app.send(f.c.conversationId, uid(), '换用途再试');
    await f.app.wait(r2.runId);
    assert.equal(pending(f.app, f.c.conversationId), undefined);
    assert.equal(f.app.store.tools(r2.runId)[0]!.state, 'failed');
    assert.equal(f.app.files.repo.mounts(f.c.environmentId).length, 1);
    await f.app.close();
    const reopened = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try {
      assert(
        reopened.files.repo.denied(
          reopened.files.repo.getCandidate(candidate, f.c.environmentId),
          'edit',
        ),
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('A21/A23/A45：外部批准后物化，多挂载同名文件不混淆', async () => {
  let outside = '',
    initial = '',
    external = '';
  const f = fixture(
    [
      () => call('discover_resource', { path: outside }),
      (r) =>
        call('request_resource', {
          candidateId: lastData(r).candidates[0].id,
          access: 'edit',
          purpose: '修改另一个项目',
        }),
      ...replaceFileSteps(
        (r) => (external = lastData(r).mountId),
        'same.txt',
        '外部新内容',
      ),
      () => call('read_file', { mountId: initial, path: 'same.txt' }),
      text('副本已修改，尚未交付'),
      text('结束'),
    ],
    { 'same.txt': '初始内容' },
  );
  initial = f.m.id;
  outside = join(f.root, 'external');
  mkdirSync(outside);
  writeFileSync(join(outside, 'same.txt'), '外部原文');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '修改外部项目'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.notEqual(initial, external);
    assert.equal(readFileSync(join(outside, 'same.txt'), 'utf8'), '外部原文');
    assert.equal(readFileSync(join(f.m.root, 'same.txt'), 'utf8'), '初始内容');
    assert.equal(
      readFileSync(
        join(f.app.files.repo.mount(external, f.c.environmentId).root, 'same.txt'),
        'utf8',
      ),
      '外部新内容',
    );
    const ctx = executionContextSchema.parse(
      f.app.store.readArtifact(
        f.app.store.tools(r.runId).find((t) => t.name === 'write_file')!.context_ref!,
      ),
    );
    assert.equal(ctx.locations[0]!.rootRef.kind, 'mount');
    const other = f.app.createConversation(f.workspace);
    assert.throws(
      () => f.app.previewFile(other.conversationId, external, 'same.txt'),
      /不属于/,
    );
  } finally {
    await f.close();
  }
});

for (const mode of [
  'source-content',
  'source-identity',
  'copy-content',
  'reject',
] as const) {
  test(`A25/A27：交付等待后变化或拒绝 ${mode} 不写回`, async () => {
    let mountId = '';
    const f = fixture(
      [
        ...replaceFileSteps(() => mountId, 'a.txt', '新内容'),
        () => call('build_changeset', { mountId }),
        (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
        text('交付未发生'),
        text('结束'),
      ],
      { 'a.txt': '原文' },
    );
    mountId = f.m.id;
    try {
      const r = f.app.send(f.c.conversationId, uid(), '修改并交付'),
        a = await eventually(() => pending(f.app, f.c.conversationId));
      if (mode === 'source-content')
        writeFileSync(join(f.workspace, 'a.txt'), '外部修改');
      if (mode === 'copy-content')
        writeFileSync(join(f.m.root, 'a.txt'), '预览后的副本修改');
      if (mode === 'source-identity') {
        renameSync(join(f.workspace, 'a.txt'), join(f.workspace, 'old.txt'));
        writeFileSync(join(f.workspace, 'a.txt'), '原文');
      }
      f.app.approve(f.c.conversationId, a, mode === 'reject' ? 'deny' : 'allow');
      assert.equal((await f.app.wait(r.runId)).status, 'completed');
      assert.equal(
        readFileSync(join(f.workspace, 'a.txt'), 'utf8'),
        mode === 'source-content' ? '外部修改' : '原文',
      );
      assert.equal(f.app.store.all('SELECT * FROM delivery_items').length, 0);
      assert.equal(
        f.app.store.tools(r.runId).find((t) => t.name === 'deliver_changeset')!.state,
        mode === 'reject' ? 'denied' : 'failed',
      );
    } finally {
      await f.close();
    }
  });
}

test('A23：新 run 和进程重启保留未交付副本与原基线', async () => {
  let mountId = '';
  const f = fixture(
    [
      ...replaceFileSteps(() => mountId, 'a.txt', '待交付'),
      text('只改副本'),
      text('结束'),
    ],
    { 'a.txt': '原文' },
  );
  mountId = f.m.id;
  try {
    const r = f.app.send(f.c.conversationId, uid(), '只在副本修改');
    await f.app.wait(r.runId);
    const base = f.app.files.repo.mount(mountId, f.c.environmentId).baselineRef;
    await f.app.close();
    const model = new ScriptModel([
        call('read_file', { mountId, path: 'a.txt' }),
        text('继承未交付内容'),
        text('结束'),
      ]),
      app = new UmiApplication(join(f.root, 'data'), model);
    try {
      const next = app.send(f.c.conversationId, uid(), '继续前任务');
      assert.notEqual(next.runId, r.runId);
      assert.equal((await app.wait(next.runId)).status, 'completed');
      assert.equal(app.files.repo.mount(mountId, f.c.environmentId).baselineRef, base);
      assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '原文');
      assert.equal(app.previewFile(f.c.conversationId, mountId, 'a.txt').text, '待交付');
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});

test('A24：路径穿越、设备名、ADS 和 junction 不获副本访问', async () => {
  const f = fixture([], { 'ok.txt': '安全' });
  try {
    for (const path of [
      '../outside',
      'C:/outside',
      'NUL.txt',
      'file:ads',
      'dir\\file',
      'file.',
      '.git/config',
    ])
      assert.throws(() =>
        f.app.registry.parse(
          'write_file',
          JSON.stringify({ mountId: f.m.id, path, content: 'x' }),
        ),
      );
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), '不可越界');
    symlinkSync(outside, join(f.m.root, 'linked'), 'junction');
    assert.throws(
      () =>
        f.app.registry
          .get('read_file')
          .prepare(
            { mountId: f.m.id, path: 'linked/secret.txt' },
            f.app.store.environment(f.c.environmentId),
          ),
      /链接|联接/,
    );
  } finally {
    await f.close();
  }
});

test('A36：派发事务失败，不写回任何源文件', async () => {
  let mountId = '';
  const f = fixture(
    [
      ...replaceFileSteps(() => mountId, 'a.txt', '新'),
      () => call('build_changeset', { mountId }),
      (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
    ],
    { 'a.txt': '旧' },
  );
  mountId = f.m.id;
  try {
    const r = f.app.send(f.c.conversationId, uid(), '交付'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    f.app.store.db.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.dispatch_intent' BEGIN SELECT RAISE(ABORT,'注入数据库失败'); END;",
    );
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'failed');
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '旧');
    assert.equal(f.app.store.all('SELECT * FROM delivery_items').length, 0);
  } finally {
    await f.close();
  }
});

test('C11：阶段 2 数据库升级保留原消息、scratch 定位与事件游标', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-migration-')),
    app = new UmiApplication(
      join(root, 'data'),
      new ScriptModel([text('阶段'), text('完成')]),
    );
  try {
    const c = app.createConversation(root),
      r = app.send(c.conversationId, uid(), '旧原文');
    await app.wait(r.runId);
    const events = app.store.events(c.conversationId),
      messages = app.store.messages(c.conversationId);
    // 阶段 2 已有表和记录；去掉仅新增的表及版本，模拟真实版本 1 存量。
    app.store.db.exec(
      'DROP TABLE context_maintenance; DROP TABLE memory_entries; DROP TABLE process_outputs; DROP TABLE process_executions; DROP TABLE process_fingerprints; DROP TABLE delivery_items; DROP TABLE changesets; DROP TABLE mounts; DROP TABLE materializations; DROP TABLE resource_denials; DROP TABLE capabilities; DROP TABLE resources; DROP TABLE resource_scopes; DROP TABLE resource_candidates; DELETE FROM schema_migrations WHERE version IN(2,3,4,6);',
    );
    await app.close();
    const upgraded = new SqliteStore(join(root, 'data'));
    try {
      assert.equal(upgraded.all('SELECT * FROM schema_migrations').length, 6);
      assert.deepEqual(upgraded.messages(c.conversationId), messages);
      assert.deepEqual(upgraded.events(c.conversationId), events);
    } finally {
      upgraded.close();
    }
  } finally {
    await app.close();
    removeTestRoot(root);
  }
});

test('A46：100 次工具调用后原文检索有界，中文与字节范围保留', async () => {
  const calls = Array.from(
    { length: 100 },
    (_, i) =>
      call('search_history', { query: `针${i}：` }, '', `call-${i}`).tool_calls![0]!,
  );
  const f = fixture([
    { role: 'assistant', content: '检索', tool_calls: calls },
    text('结算'),
    text('完成'),
  ]);
  try {
    const original = Array.from({ length: 100 }, (_, i) => `针${i}：完整细节😀`).join(
        '\n',
      ),
      r = f.app.send(f.c.conversationId, uid(), original);
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    const def = f.app.registry.get('search_history'),
      args = { query: '针50：' },
      env = f.app.store.environment(f.c.environmentId),
      ctx = def.prepare(args, env);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(),
        result = await def.execute(
          args,
          ctx,
          f.c.conversationId,
          new AbortController().signal,
        );
      times.push(performance.now() - start);
      assert.equal(
        (result.data as { matches: { messageId: string }[] }).matches[0]!.messageId,
        r.messageId,
      );
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        benchmark: 'history-100-tools',
        messages: f.app.store.messages(f.c.conversationId).length,
        medianMs: times[10],
        p95Ms: times[18],
      }),
    );
    assert(times[18]! < 1000, '本机小型会话检索 P95 应小于 1 秒；不是长期性能承诺');
  } finally {
    await f.close();
  }
});

test('A22/A24：资源批准后目录被同名替换，不物化新对象', async () => {
  let outside = '';
  const f = fixture([
    () => call('discover_resource', { path: outside }),
    (r) =>
      call('request_resource', {
        candidateId: lastData(r).candidates[0].id,
        access: 'edit',
        purpose: '修改项目',
      }),
    text('来源变化'),
    text('结束'),
  ]);
  outside = join(f.root, 'external');
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.txt'), '原目录');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '修改外部'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    renameSync(outside, `${outside}-old`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'a.txt'), '新对象正文');
    f.app.approve(f.c.conversationId, a, 'allow');
    await f.app.wait(r.runId);
    assert.equal(
      f.app.store.tools(r.runId).find((t) => t.name === 'request_resource')!.state,
      'failed',
    );
    assert.equal(f.app.files.repo.mounts(f.c.environmentId).length, 1);
    assert.equal(
      f.app.store.all('SELECT * FROM capabilities WHERE run_id IS NOT NULL').length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('A25：拒绝交付后重建相同变更集，不能重复弹出等价批准', async () => {
  let mountId = '';
  const f = fixture(
    [
      ...replaceFileSteps(() => mountId, 'a.txt', '新'),
      () => call('build_changeset', { mountId }),
      (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
      () => call('build_changeset', { mountId }),
      (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
      text('交付已拒绝'),
      text('结束'),
    ],
    { 'a.txt': '旧' },
  );
  mountId = f.m.id;
  try {
    const r = f.app.send(f.c.conversationId, uid(), '交付'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    f.app.approve(f.c.conversationId, a, 'deny');
    await f.app.wait(r.runId);
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      1,
    );
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '旧');
  } finally {
    await f.close();
  }
});

for (const mode of ['receipt', 'tool-result']) {
  test(`A36：文件写回后 ${mode} 事务失败保持可恢复，核验不重复写入`, async () => {
    let mountId = '';
    const f = fixture(
      [
        ...replaceFileSteps(() => mountId, 'a.txt', '新'),
        () => call('build_changeset', { mountId }),
        (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
        text('核验后的结果'),
        text('结束'),
      ],
      { 'a.txt': '旧' },
    );
    mountId = f.m.id;
    try {
      const r = f.app.send(f.c.conversationId, uid(), '交付'),
        a = await eventually(() => pending(f.app, f.c.conversationId));
      const type = mode === 'receipt' ? 'delivery.item_settled' : 'tool.settled';
      f.app.store.db.exec(
        `CREATE TRIGGER fail_after_effect BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='${type}' BEGIN SELECT RAISE(ABORT,'注入回执提交失败'); END;`,
      );
      f.app.approve(f.c.conversationId, a, 'allow');
      assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
      assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '新');
      const identity = fileIdentity(join(f.workspace, 'a.txt'));
      f.app.store.db.exec('DROP TRIGGER fail_after_effect');
      f.app.resume(f.c.conversationId, r.runId);
      assert.equal((await f.app.wait(r.runId)).status, 'completed');
      assert.equal(fileIdentity(join(f.workspace, 'a.txt')), identity);
      assert.equal(
        f.app.store.tools(r.runId).find((t) => t.name === 'deliver_changeset')!.state,
        'succeeded',
      );
    } finally {
      await f.close();
    }
  });
}

test('A23：初始物化超过容量时保留失败事实，普通模型会话仍可执行', async () => {
  const f = fixture([text('普通任务'), text('完成')]);
  try {
    const big = join(f.root, 'large');
    mkdirSync(big);
    writeFileSync(join(big, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const c = f.app.createConversation(big);
    assert.equal(f.app.files.repo.mounts(c.environmentId).length, 0);
    assert(
      f.app.store
        .events(c.conversationId)
        .some((e) => e.type === 'resource.materialization_failed'),
    );
    const r = f.app.send(c.conversationId, uid(), '只回答一个普通问题');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(
      f.app.store
        .events(c.conversationId)
        .filter((e) => e.type === 'resource.materialization_failed').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('A36：变更集已保存但工具结果提交失败，恢复复用原快照', async () => {
  let mountId = '';
  const f = fixture(
    [
      ...replaceFileSteps(() => mountId, 'a.txt', '新'),
      () => call('build_changeset', { mountId }),
      text('解释原快照'),
      text('结束'),
    ],
    { 'a.txt': '旧' },
  );
  mountId = f.m.id;
  try {
    f.app.store.db.exec(
      "CREATE TRIGGER fail_changeset_result BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.settled' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='build_changeset' BEGIN SELECT RAISE(ABORT,'变更集结果提交失败'); END;",
    );
    const r = f.app.send(f.c.conversationId, uid(), '只预览');
    assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
    const original = f.app.store.get('SELECT id FROM changesets')!.id;
    writeFileSync(join(f.m.root, 'a.txt'), '快照后的变化');
    f.app.store.db.exec('DROP TRIGGER fail_changeset_result');
    f.app.resume(f.c.conversationId, r.runId);
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.app.store.all('SELECT * FROM changesets').length, 1);
    assert.equal(f.app.store.get('SELECT id FROM changesets')!.id, original);
    const t = f.app.store.tools(r.runId).find((t) => t.name === 'build_changeset')!,
      result = f.app.store.readArtifact<{
        verification: string;
        data: { changeSetId: string };
      }>(t.result_ref!);
    assert.equal(result.verification, 'original-snapshot-reused');
    assert.equal(result.data.changeSetId, original);
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '旧');
  } finally {
    await f.close();
  }
});

test('A24/A25：副本删除与二进制预览，源删除仅在固定交付获准后发生', async () => {
  let mountId = '';
  const f = fixture(
    [
      () => call('delete_file', { mountId, path: 'delete.txt' }),
      () => call('build_changeset', { mountId }),
      (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
      text('已核验删除'),
      text('结束'),
    ],
    { 'delete.txt': '需删除', 'keep.txt': '保留' },
  );
  mountId = f.m.id;
  try {
    writeFileSync(join(f.m.root, 'binary.bin'), Buffer.from([0xff, 0, 1]));
    assert.equal(
      f.app.previewFile(f.c.conversationId, mountId, 'binary.bin').kind,
      'binary',
    );
    unlinkSync(join(f.m.root, 'binary.bin'));
    const r = f.app.send(f.c.conversationId, uid(), '删除文件'),
      a = await eventually(() => pending(f.app, f.c.conversationId));
    assert(existsSync(join(f.workspace, 'delete.txt')));
    assert.match(
      f.app.store.snapshot(f.c.conversationId).approvals[a]!.description,
      /delete/,
    );
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert(!existsSync(join(f.workspace, 'delete.txt')));
    assert.equal(readFileSync(join(f.workspace, 'keep.txt'), 'utf8'), '保留');
  } finally {
    await f.close();
  }
});
