import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandOutputPreview } from '../packages/adapters/src/host-process/output-preview.js';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { LegacyWindowsProcessPort } from '../packages/adapters/src/host-process/port.js';
import { uid } from '../packages/agent/src/identity.js';
import type { Step } from './fixtures.js';

function verify(stdout: string, stderr: string, budget: number) {
  const p = commandOutputPreview(stdout, stderr, budget);
  let total = 0;
  for (const [channel, original] of [['stdout', stdout], ['stderr', stderr]] as const) {
    const range = p.outputPreview[channel], bytes = Buffer.from(original);
    const head = p[channel], tail = p[channel === 'stdout' ? 'stdoutTail' : 'stderrTail'];
    assert.equal(bytes.subarray(range.head.startByte, range.head.endByte).toString('utf8'), head);
    assert(!head.includes('\ufffd')); assert(!tail.includes('\ufffd'));
    if (range.tail) {
      assert.equal(bytes.subarray(range.tail.startByte, range.tail.endByte).toString('utf8'), tail);
      assert(range.head.endByte <= range.tail.startByte);
      assert.equal(range.tail.endByte, bytes.length);
    } else assert.equal(tail, '');
    const kept = Buffer.byteLength(head) + Buffer.byteLength(tail);
    assert.equal(kept + (range.omitted ? range.omitted.endByte - range.omitted.startByte : 0), bytes.length);
    assert.equal(p[channel === 'stdout' ? 'stdoutNextStartByte' : 'stderrNextStartByte'], range.omitted?.startByte ?? null);
    total += kept;
  }
  assert.equal(total, p.outputPreview.keptBytes);
  assert(total <= Math.min(8000, budget));
  return p;
}

test('命令反馈：短输出完整，空输出没有伪造省略和下一页', () => {
  const p = verify('中文😀完成', '警告', 1024);
  assert.equal(p.stdout, '中文😀完成'); assert.equal(p.stderr, '警告');
  assert.equal(p.previewTruncated, false);
  assert.equal(p.outputPreview.stdout.tail, null);
  assert.equal(verify('', '', 1024).outputPreview.keptBytes, 0);
});
test('命令反馈：同预算保留长日志首尾，明确省略中段且错误可见', () => {
  const body = '启动日志\n' + '普通进度'.repeat(4000) + '\nERROR: 缺少配置 ready.json';
  const p = verify(body, '', 8000);
  assert(p.stdout.startsWith('启动日志')); assert(p.stdoutTail.endsWith('ERROR: 缺少配置 ready.json'));
  assert(p.previewTruncated); assert(p.outputPreview.stdout.omitted);
  assert.equal(p.outputPreview.stdout.archivedBytes, Buffer.byteLength(body));
});
test('命令反馈：stderr 独占和短 stdout 时可使用空余预算，不再固定只给四分之一', () => {
  const body = 'e'.repeat(5999) + '!';
  assert.equal(verify('', body, 8000).stderr, body);
  assert.equal(verify('ok', body, 8000).previewTruncated, false);
  const p = verify('a'.repeat(20000), 'ERROR', 1024);
  assert.equal(p.stderr, 'ERROR'); assert.equal(p.outputPreview.keptBytes, 1024);
});
test('命令反馈：双流均长时保留两边首尾，总预览上限维持8000', () => {
  const p = verify('O'.repeat(20000) + 'stdout-end', 'E'.repeat(6000) + 'stderr-end', 65536);
  assert.equal(p.outputPreview.limitBytes, 8000);
  assert(p.stdoutTail.endsWith('stdout-end')); assert(p.stderrTail.endsWith('stderr-end'));
  assert.equal(Buffer.byteLength(p.stderr) + Buffer.byteLength(p.stderrTail), 2000);
});
test('命令反馈：Unicode、小预算及边界穷举不拆字符，范围可精确回到原文', () => {
  for (let n = 0; n < 40; n++) for (let budget = 0; budget < 40; budget++)
    verify(('文😀aé\n').repeat(n), ('警告🌱b').repeat(39 - n), budget);
  for (const n of [1023, 1024, 1025, 7999, 8000, 8001]) verify('中😀'.repeat(1700), '警告'.repeat(600), n);
});
test('命令反馈：拒绝无效预算，不把归档外的未知输出补造成尾部', () => {
  for (const n of [-1, 1.5, NaN, Infinity]) assert.throws(() => commandOutputPreview('', '', n), RangeError);
  const p = verify('只有归档前缀', '', 8000);
  assert.equal(p.stdoutTail, ''); assert(!JSON.stringify(p).includes('真实流末尾'));
});

test('命令反馈：真实循环只改模型摘录，退出失败/归档/分页/恢复和会话边界保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-process-feedback-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const stdout = '开始\n' + '中间日志🌱'.repeat(4000) + '\nERROR: missing-ready-config';
  const stderr = '警告';
  const runner: LegacyWindowsProcessPort = {
    async run(_snapshot, c) {
      const owner = { pid: 920001, birth: '1' }, child = { pid: 920002, birth: '2' };
      c.owner(owner); await c.ready(owner, child); c.started();
      c.output('stdout', stdout); c.output('stderr', stderr);
      return { kind: 'exit', reason: 'exited', exitCode: 7, jobInactive: true, gateReleased: true,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), truncated: false };
    },
    async probe() { return 'absent'; },
  };
  const steps: Step[] = [], model = new ScriptModel(steps), app = new UmiApplication(join(root, 'data'), model, { processRunner: runner });
  const c = app.createConversation(workspace), mount = app.files.repo.mounts(c.environmentId)[0]!;
  steps.push(call('run_command', { program: 'node', argv: ['-e', ''], cwd: { kind: 'mount', mountId: mount.id } }), text('失败需处理'));
  try {
    const run = app.send(c.conversationId, uid(), '验证失败回执');
    const approval = await eventually(() => Object.entries(app.store.snapshot(c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    assert.equal(app.store.all('SELECT * FROM process_executions').length, 0);
    app.approve(c.conversationId, approval, 'allow'); await app.wait(run.runId);
    const tool = app.store.tools(run.runId)[0]!, result = app.store.readArtifact<any>(tool.result_ref!);
    const view = JSON.parse(result.content);
    assert.equal(result.outcome, 'failed'); assert.equal(view.exitCode, 7);
    assert.equal(view.archiveComplete, true); assert(view.previewTruncated);
    assert(view.stdoutTail.endsWith('ERROR: missing-ready-config'));
    assert(view.outputInstruction.includes('不必仅为取日志重跑'));
    assert.equal(app.store.readArtifact<any>(result.data.stdoutRef).text, stdout);
    const modelReply = model.requests[1]!.body.messages as { role: string; content: string }[];
    assert(modelReply.some(m => m.role === 'tool' && m.content.includes('missing-ready-config')));
    const gap = view.outputPreview.stdout.omitted;
    const read = app.registry.get('read_process_output');
    const input = { executionId: tool.id, channel: 'stdout', startByte: gap.startByte, byteLength: Math.min(1024, gap.endByte - gap.startByte) };
    const env = app.store.environment(c.environmentId), ctx = read.prepare(input, env);
    const page = await read.execute(input, ctx, c.conversationId, new AbortController().signal);
    assert.equal((page.data as any).startByte, gap.startByte);
    const second = app.createConversation(workspace);
    await assert.rejects(() => read.execute(input, ctx, second.conversationId, new AbortController().signal), { code: 'PERMISSION_DENIED' });
    const restored = await app.commands.reconcile(app.store.readArtifact(tool.context_ref!));
    assert.equal(restored.content, result.content);
    assert.equal(app.store.all('SELECT * FROM process_executions').length, 1);
  } finally { await app.close(); removeTestRoot(root); }
});

async function locatingFixture(truncated = false) {
  const root = mkdtempSync(join(tmpdir(), 'umi-log-find-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const query = 'TypeError: wings[0]', stdout = '开始🌱\n' + '普通日志🙂'.repeat(30000) + '\n' + query + ' 未定义🙂\n' + '后续上下文'.repeat(20) + query + ' 第二处\n' + '普通日志🙂'.repeat(30000);
  let starts = 0;
  const runner: LegacyWindowsProcessPort = {
    async run(_snapshot, c) {
      starts++;
      const owner = { pid: 920011, birth: '1' }, child = { pid: 920012, birth: '2' };
      c.owner(owner); await c.ready(owner, child); c.started();
      c.output('stdout', stdout.slice(0, 100)); c.output('stdout', stdout.slice(100)); c.output('stderr', '独立警告');
      return { kind: 'exit', reason: 'exited', exitCode: 1, jobInactive: true, gateReleased: true,
        stdoutBytes: Buffer.byteLength(stdout) + (truncated ? 1000 : 0), stderrBytes: Buffer.byteLength('独立警告'), truncated };
    },
    async probe() { return 'absent'; },
  };
  const steps: Step[] = [], model = new ScriptModel(steps), app = new UmiApplication(join(root, 'data'), model, { processRunner: runner });
  const c = app.createConversation(workspace), mount = app.files.repo.mounts(c.environmentId)[0]!;
  let id = '';
  steps.push(call('run_command', { program: 'node', argv: ['-e', ''], cwd: { kind: 'mount', mountId: mount.id } }), request => {
    const view = JSON.parse((request.body.messages as any[]).findLast(m => m.role === 'tool').content);
    assert.equal(view.outcome, 'failed'); assert(!JSON.parse(view.content).stdout.includes(query));
    id = app.store.tools(app.store.environment(c.environmentId).active_run_id!)[0]!.id;
    return call('read_process_output', { executionId: id, channel: 'stdout', find: query, byteLength: 1024 });
  }, request => {
    const data = JSON.parse((request.body.messages as any[]).findLast(m => m.role === 'tool').content).data;
    assert.equal(data.search.found, true); assert(data.text.includes(query));
    assert.equal(data.archiveComplete, !truncated);
    return text('已从原日志定位中段错误，命令没有重跑。');
  });
  try {
    const r = app.send(c.conversationId, uid(), '定位已有命令错误');
    const approval = await eventually(() => Object.entries(app.store.snapshot(c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    app.approve(c.conversationId, approval, 'allow');
    assert.equal((await app.wait(r.runId)).status, 'completed');
  } catch (e) { await app.close(); removeTestRoot(root); throw e; }
  const read = async (input: Record<string, unknown>, cid = c.conversationId) => {
    const args = app.registry.parse('read_process_output', JSON.stringify({ executionId: id, channel: 'stdout', ...input }));
    const tool = app.registry.get('read_process_output');
    return (await tool.execute(args, tool.prepare(args, app.store.environment(c.environmentId)), cid, new AbortController().signal)).data as any;
  };
  return { root, workspace, stdout, query, app, c, model, read, get id() { return id; }, get starts() { return starts; },
    async close() { await app.close(); removeTestRoot(root); } };
}

test('日志定位：一次读取找到长日志中段，字面/Unicode范围及后续匹配可追溯，不重跑进程', async () => {
  const f = await locatingFixture();
  try {
    const bytes = Buffer.from(f.stdout), first = await f.read({ find: f.query, byteLength: 1024 });
    assert.equal(first.search.matchStartByte, bytes.indexOf(Buffer.from(f.query)));
    assert.equal(bytes.subarray(first.startByte, first.endByte).toString('utf8'), first.text);
    assert(!first.text.includes('\ufffd')); assert(Buffer.byteLength(first.text) <= 1024);
    const next = await f.read({ find: f.query, startByte: first.search.nextSearchByte, byteLength: 1024 });
    assert(next.search.matchStartByte > first.search.matchStartByte);
    assert.equal(next.sourceHash, first.sourceHash);
    const absent = await f.read({ find: f.query, startByte: next.search.nextSearchByte });
    assert.equal(absent.search.found, false); assert.equal(absent.text, ''); assert.equal(absent.nextStartByte, null);
    assert.equal(absent.search.searchedToByte, bytes.length);
    assert.equal((await f.read({ find: 'wings.*' })).search.found, false);
    const unicode = await f.read({ find: '未定义🙂', byteLength: 101 });
    assert.equal(unicode.search.matchStartByte, bytes.indexOf(Buffer.from('未定义🙂')));
    assert(!unicode.text.includes('\ufffd'));
    const plain = await f.read({ byteLength: 100 }); assert.equal(plain.search, undefined);
    assert.equal(plain.startByte, 0); assert.equal(plain.sourceHash, first.sourceHash);
    assert.equal((await f.read({ channel: 'stderr', find: '独立' })).text, '独立警告');
    await assert.rejects(f.read({ find: f.query, startByte: 1 }), /UTF-8/);
    await assert.rejects(f.read({ find: '' }), /参数错误/);
    await assert.rejects(f.read({ find: '\ud800' }), /UTF-8/);
    const other = f.app.createConversation(f.workspace);
    await assert.rejects(f.read({ find: f.query }, other.conversationId), { code: 'PERMISSION_DENIED' });
    assert.equal(f.starts, 1); assert.equal(f.model.requests.length, 3);
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 1);
    await f.app.close();
    const reopened = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try {
      const tool = reopened.registry.get('read_process_output'), input = { executionId: f.id, channel: 'stdout', find: f.query, byteLength: 1024 };
      const result = await tool.execute(input, tool.prepare(input, reopened.store.environment(f.c.environmentId)), f.c.conversationId, new AbortController().signal);
      assert.deepEqual(result.data, first);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('日志定位：未命中只表示归档范围内没有，不把截断输出宣称为全量无错误', async () => {
  const f = await locatingFixture(true);
  try {
    const page = await f.read({ find: '未归档的错误' });
    assert.equal(page.search.found, false); assert.equal(page.archiveComplete, false);
    assert(page.observedBytes > page.totalBytes); assert.equal(page.text, '');
    assert.equal(page.search.matchStartByte, null); assert.equal(page.search.nextSearchByte, null);
    assert.equal(page.search.searchedToByte, page.totalBytes); assert.equal(f.starts, 1);
  } finally { await f.close(); }
});
