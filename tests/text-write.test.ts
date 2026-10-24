import { DesktopVerificationModel } from '../apps/desktop/verification-model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { ScriptModel, call, text, removeTestRoot, eventually } from './fixtures.js';
import type { Step } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import {
  bytesHash,
  fileIdentity,
  createExclusive,
} from '../packages/adapters/src/host-files/paths.js';
import { replaceFileSteps } from './file-write-fixtures.js';

function fixture(initial?: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'umi-text-write-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  if (initial !== undefined) writeFileSync(join(workspace, 'a.txt'), initial);
  const steps: Step[] = [],
    model = new ScriptModel(steps),
    app = new UmiApplication(join(root, 'data'), model);
  const c = app.createConversation(workspace),
    m = app.files.repo.mounts(c.environmentId)[0]!,
    file = join(m.root, 'a.txt');
  return {
    root,
    workspace,
    steps,
    app,
    c,
    m,
    file,
    env() {
      return app.store.environment(c.environmentId);
    },
    async run() {
      const r = app.send(c.conversationId, uid(), '文本写入验收');
      await app.wait(r.runId);
      return r;
    },
    async read(options = {}) {
      steps.push(
        call('read_file', {
          mountId: m.id,
          path: 'a.txt',
          byteLength: 64000,
          ...options,
        }),
        text('已读'),
      );
      const r = await this.run(),
        t = app.store.tools(r.runId).find((t) => t.name === 'read_file')!;
      return app.store.readArtifact<{ data: any }>(t.result_ref!).data;
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}
const args = (f: ReturnType<typeof fixture>, read: any, content = '新文本') => ({
  mountId: f.m.id,
  path: 'a.txt',
  content,
  mode: 'replace',
  readExecutionId: read.readExecutionId,
  expectedReadHash: read.hash,
});

test('创建：默认 create 可新建父目录，成功回执前不改源目录；重复创建不覆盖', async () => {
  const f = fixture();
  try {
    f.steps.push(
      call('write_file', {
        mountId: f.m.id,
        path: '新目录/新文件.txt',
        content: '中文\r\n',
      }),
      call('write_file', { mountId: f.m.id, path: '新目录/新文件.txt', content: '覆盖' }),
      text('已核验'),
    );
    const r = await f.run(),
      tools = f.app.store.tools(r.runId);
    assert.equal(tools[0]!.state, 'succeeded');
    assert.equal(tools[1]!.state, 'failed');
    assert.equal(readFileSync(join(f.m.root, '新目录/新文件.txt'), 'utf8'), '中文\r\n');
    assert(!existsSync(join(f.workspace, '新目录')));
    const events = f.app.store.events(f.c.conversationId);
    assert(
      events.findIndex((e) => e.type === 'tool.dispatch_intent') <
        events.findIndex((e) => e.type === 'tool.settled'),
    );
  } finally {
    await f.close();
  }
});
test('创建：未指定 mode 的旧写入不能绕过读取覆盖现有文件', async () => {
  const f = fixture('原文');
  try {
    f.steps.push(
      call('write_file', { mountId: f.m.id, path: 'a.txt', content: '覆盖' }),
      text('拒绝覆盖'),
    );
    const r = await f.run();
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
    assert.equal(readFileSync(f.file, 'utf8'), '原文');
  } finally {
    await f.close();
  }
});
for (const mode of ['late-file', 'junction', 'cancel'] as const)
  test(`创建：${mode} 派发后拒绝且不覆盖`, async () => {
    const f = fixture();
    try {
      const input = { mountId: f.m.id, path: 'sub/a.txt', content: '新建' },
        tool = f.app.registry.get('write_file');
      const ctx = tool.prepare(input, f.env(), uid());
      if (mode === 'late-file') {
        mkdirSync(join(f.m.root, 'sub'));
        writeFileSync(join(f.m.root, 'sub/a.txt'), '晚到文件');
      }
      if (mode === 'junction') {
        mkdirSync(join(f.root, 'outside'));
        symlinkSync(join(f.root, 'outside'), join(f.m.root, 'sub'), 'junction');
      }
      const result = await tool.execute(
        input,
        ctx,
        f.c.conversationId,
        mode === 'cancel' ? AbortSignal.abort() : new AbortController().signal,
      );
      assert.equal(result.outcome, mode === 'cancel' ? 'cancelled' : 'failed');
      if (mode === 'late-file')
        assert.equal(readFileSync(join(f.m.root, 'sub/a.txt'), 'utf8'), '晚到文件');
      if (mode === 'junction') assert(!existsSync(join(f.root, 'outside/a.txt')));
      if (mode === 'cancel') assert(!existsSync(join(f.m.root, 'sub')));
    } finally {
      await f.close();
    }
  });
test('独占创建：已有名称 EEXIST；不截断第三方文件', async () => {
  const f = fixture('第三方');
  try {
    assert.throws(
      () => createExclusive(f.m.root, 'a.txt', Buffer.from('覆盖'), f.m.rootIdentity),
      /EEXIST/,
    );
    assert.equal(readFileSync(f.file, 'utf8'), '第三方');
  } finally {
    await f.close();
  }
});
test('替换：真实完整读取绑定 BOM/CRLF/中文字节，无变化保留身份/mtime/环境修订', async () => {
  const f = fixture('\uFEFF中文\r\n// 学习注释\r\n');
  try {
    const read = await f.read(),
      tool = f.app.registry.get('write_file'),
      input = args(f, read, read.text);
    const identity = fileIdentity(f.file),
      modified = statSync(f.file, { bigint: true }).mtimeNs,
      revision = f.env().revision;
    const ctx = tool.prepare(input, f.env(), uid());
    const result = await tool.execute(
      input,
      ctx,
      f.c.conversationId,
      new AbortController().signal,
    );
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.mutated, false);
    assert.equal(fileIdentity(f.file), identity);
    assert.equal(statSync(f.file, { bigint: true }).mtimeNs, modified);
    assert.equal(f.env().revision, revision);
    f.steps.push(
      ...replaceFileSteps(() => f.m.id, 'a.txt', '\uFEFF新中文\r\n// 学习注释\r\n'),
      text('替换已核验'),
    );
    const run = await f.run();
    assert.equal(
      f.app.store.tools(run.runId).find((t) => t.name === 'write_file')!.state,
      'succeeded',
    );
    assert(readFileSync(f.file).equals(Buffer.from('\uFEFF新中文\r\n// 学习注释\r\n')));
    assert.equal(
      readFileSync(join(f.workspace, 'a.txt'), 'utf8'),
      '\uFEFF中文\r\n// 学习注释\r\n',
    );
  } finally {
    await f.close();
  }
});
for (const mode of [
  'missing-receipt',
  'wrong-hash',
  'wrong-path',
  'content',
  'identity',
  'partial',
  'binary',
  'foreign',
] as const)
  test(`替换：${mode} 拒绝`, async () => {
    const f = fixture(mode === 'binary' ? Buffer.from([0, 255, 1]) : '原文长内容');
    let other: ReturnType<typeof fixture> | undefined;
    try {
      const read = await f.read(mode === 'partial' ? { byteLength: 3 } : {}),
        input = args(f, read);
      if (mode === 'missing-receipt') input.readExecutionId = 'missing';
      if (mode === 'wrong-hash') input.expectedReadHash = '0'.repeat(64);
      if (mode === 'wrong-path') {
        input.path = 'other.txt';
        writeFileSync(join(f.m.root, 'other.txt'), '原文长内容');
      }
      if (mode === 'content') writeFileSync(f.file, '第三方内容');
      if (mode === 'identity') {
        renameSync(f.file, f.file + '.old');
        writeFileSync(f.file, '原文长内容');
      }
      if (mode === 'foreign') {
        other = fixture('原文长内容');
        const foreign = await other.read();
        input.readExecutionId = foreign.readExecutionId;
        input.expectedReadHash = foreign.hash;
      }
      assert.throws(() =>
        f.app.registry.get('write_file').prepare(input, f.env(), uid()),
      );
      if (mode !== 'binary')
        assert.equal(
          readFileSync(f.file, 'utf8'),
          mode === 'content' ? '第三方内容' : '原文长内容',
        );
    } finally {
      await other?.close();
      await f.close();
    }
  });
for (const content of ['bad\0text', '\ud800'])
  test(`文本：拒绝非法内容 ${JSON.stringify(content)}`, async () => {
    const f = fixture();
    try {
      assert.throws(
        () =>
          f.app.registry
            .get('write_file')
            .prepare({ mountId: f.m.id, path: 'a.txt', content }, f.env(), uid()),
        /NUL|Unicode/,
      );
      assert(!existsSync(f.file));
    } finally {
      await f.close();
    }
  });
test('替换：派发后原对象变化失败，取消无写入', async () => {
  const f = fixture('原文');
  try {
    const read = await f.read(),
      tool = f.app.registry.get('write_file'),
      input = args(f, read),
      ctx = tool.prepare(input, f.env(), uid());
    writeFileSync(f.file, '第三方');
    const result = await tool.execute(
      input,
      ctx,
      f.c.conversationId,
      new AbortController().signal,
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(readFileSync(f.file, 'utf8'), '第三方');
    const cancelled = await tool.execute(
      input,
      ctx,
      f.c.conversationId,
      AbortSignal.abort(),
    );
    assert.equal(cancelled.outcome, 'cancelled');
  } finally {
    await f.close();
  }
});
for (const mode of ['create', 'replace'] as const)
  for (const point of ['tool.started', 'tool.settled'] as const)
    test(`恢复：${mode}/${point} 重启核验不重复写入`, async () => {
      const f = fixture(mode === 'replace' ? '原文' : undefined);
      try {
        f.steps.push(
          ...(mode === 'replace'
            ? replaceFileSteps(() => f.m.id, 'a.txt', '新文')
            : [call('write_file', { mountId: f.m.id, path: 'a.txt', content: '新文' })]),
          text('结束'),
        );
        f.app.store.db.exec(
          `CREATE TRIGGER write_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='${point}' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='write_file' BEGIN SELECT RAISE(ABORT,'故障'); END;`,
        );
        const r = await f.run();
        assert.equal(f.app.store.getRun(r.runId).status, 'recovery_required');
        const identity = existsSync(f.file) ? fileIdentity(f.file) : null;
        f.app.store.db.exec('DROP TRIGGER write_failure');
        await f.app.close();
        const next = new UmiApplication(
          join(f.root, 'data'),
          new ScriptModel([text('核验原状态')]),
        );
        try {
          next.resume(f.c.conversationId, r.runId);
          await next.wait(r.runId);
          const t = next.store.tools(r.runId).find((t) => t.name === 'write_file')!;
          assert.equal(t.state, point === 'tool.started' ? 'failed' : 'succeeded');
          assert.equal(existsSync(f.file) ? fileIdentity(f.file) : null, identity);
          assert.equal(
            next.store
              .events(f.c.conversationId)
              .filter((e) => e.type === 'tool.dispatch_intent' && e.executionId === t.id)
              .length,
            1,
          );
        } finally {
          await next.close();
        }
      } finally {
        await f.close();
      }
    });
test('恢复：部分创建/第三方字节保持 unknown；旧冻结上下文只核验不写入', async () => {
  const f = fixture();
  try {
    const tool = f.app.registry.get('write_file'),
      input = { mountId: f.m.id, path: 'a.txt', content: '完整内容' },
      ctx = tool.prepare(input, f.env(), uid());
    writeFileSync(f.file, '部分');
    const result = await tool.reconcile!(
      input,
      ctx,
      f.c.conversationId,
      new AbortController().signal,
    );
    assert.equal(result.outcome, 'unknown');
    assert.equal(readFileSync(f.file, 'utf8'), '部分');
    writeFileSync(f.file, '完整内容');
    const { fileWrite, ...legacy } = ctx;
    const identity = fileIdentity(f.file),
      verified = await tool.reconcile!(
        input,
        legacy,
        f.c.conversationId,
        new AbortController().signal,
      );
    assert.equal(verified.outcome, 'succeeded');
    assert.equal(fileIdentity(f.file), identity);
    assert.equal(bytesHash(readFileSync(f.file)), ctx.locations[0]!.desiredHash);
  } finally {
    await f.close();
  }
});

test('桌面验收模型：交付卡片沿真实读取与显式替换，批准前来源不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-text-write-desktop-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const target = join(workspace, 'delivery-preview.txt');
  writeFileSync(target, '旧正文');
  const app = new UmiApplication(join(root, 'data'), new DesktopVerificationModel());
  try {
    const c = app.createConversation(workspace);
    const run = app.send(c.conversationId, uid(), '交付卡片验证');
    const approvalId = await eventually(
      () =>
        Object.entries(app.store.snapshot(c.conversationId).approvals).find(
          ([, approval]) => approval.status === 'pending',
        )?.[0],
    );
    assert.equal(readFileSync(target, 'utf8'), '旧正文');
    const tools = app.store.tools(run.runId);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['read_file', 'write_file', 'build_changeset', 'deliver_changeset'],
    );
    assert.equal(tools[0]!.state, 'succeeded');
    assert.equal(tools[1]!.state, 'succeeded');
    const write = JSON.parse(tools[1]!.args);
    assert.equal(write.mode, 'replace');
    assert.equal(write.readExecutionId, tools[0]!.id);
    app.approve(c.conversationId, approvalId, 'allow');
    assert.equal((await app.wait(run.runId)).status, 'completed');
    assert.equal(readFileSync(target, 'utf8'), '冻结预览正文。'.repeat(300));
    assert.equal(app.store.tools(run.runId).at(-1)!.state, 'succeeded');
  } finally {
    await app.close();
    removeTestRoot(root);
  }
});
