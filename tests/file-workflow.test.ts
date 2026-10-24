import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { ScriptModel, call, text, removeTestRoot, eventually, projectedFacts } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid } from '../packages/agent/src/identity.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { settingsSchema, type WireMessage } from '../packages/protocol/src/model.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { approvalDecisionWaits } from '../packages/agent/src/loop/request-diagnostics.js';
import { PERSONA } from '../packages/agent/src/context/prompts.js';

const lastData = (r: PreparedRequest): any => JSON.parse((r.body.messages as WireMessage[]).filter(m => m.role === 'tool').at(-1)!.content).data;
function fixture(sources: Record<string, string | Buffer>) {
  const root = mkdtempSync(join(tmpdir(), 'umi-file-workflow-')), source = join(root, 'source'); mkdirSync(source);
  for (const [path, content] of Object.entries(sources)) { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), content); }
  const steps: Step[] = [], model = new ScriptModel(steps), app = new UmiApplication(join(root, 'data'), model), c = app.createConversation(source);
  const mount = app.files.repo.mounts(c.environmentId)[0]!;
  return { root, source, steps, model, app, c, mount,
    async invoke(name: string, args: Record<string, unknown>) {
      const input = { mountId: mount.id, ...args }, definition = app.registry.get(name);
      return definition.execute(input, definition.prepare(input, app.store.environment(c.environmentId), uid()), c.conversationId, new AbortController().signal);
    },
    async send(content = '按要求修改工作副本') { const result = app.send(c.conversationId, uid(), content); await app.wait(result.runId); return result; },
    async close() { await app.close(); removeTestRoot(root); },
  };
}
const section = (i: number) => `<section id="s${i}">内容🙂${i}</main>`;
const sections = Array.from({ length: 6 }, (_, i) => section(i + 1));
const html = '\uFEFF<!doctype html>\r\n' + sections[0] + sections[1] + '\r\n' + '填🙂'.repeat(4390) + sections[2] + '\r\n' + '填🙂'.repeat(4390) + sections[3] + '\r\n' + '填🙂'.repeat(4390) + sections[4] + sections[5] + '\r\n';
const expected = html.replaceAll('</main>', '</section>');

test('查找：单文件六次出现含同行/64KB后，分页绑定查询与版本，不扫描相邻文件', async () => {
  const f = fixture({ 'report.html': html, 'other.txt': '</main> 不应扫描' });
  try {
    const first: any = (await f.invoke('search_text', { path: 'report.html', query: '</main>', limit: 2 })).data;
    assert.equal(first.totalMatches, 6); assert.equal(first.matchedLines, 4); assert.equal(first.matchedFiles, 1); assert(first.totalExact);
    assert.equal(first.coverage.scannedFiles, 1); assert.equal(first.matches[0].line, first.matches[1].line);
    const second: any = (await f.invoke('search_text', { path: 'report.html', query: '</main>', limit: 10, cursor: first.nextCursor })).data;
    assert.equal(second.matches.length, 4); assert.equal(second.nextCursor, null); assert(second.matches.some((m: any) => m.startByte > 64000));
    for (const m of [...first.matches, ...second.matches]) { assert.equal(Buffer.from(html).subarray(m.startByte, m.endByte).toString(), '</main>'); assert.equal(m.readSuggestion.expectedHash, m.hash); }
    await assert.rejects(f.invoke('search_text', { path: 'report.html', query: '内容', cursor: first.nextCursor }), /查询或文件版本变化/);
    writeFileSync(join(f.mount.root, 'report.html'), html + '外部变化');
    await assert.rejects(f.invoke('search_text', { path: 'report.html', query: '</main>', cursor: first.nextCursor }), /文件版本变化/);
  } finally { await f.close(); }
});

test('查找：子目录范围、重叠出现和不完整覆盖诚实报告', async () => {
  const f = fixture({ 'sub/a.txt': 'aaaa\r\na', 'b.txt': 'aaaa', 'sub/binary.dat': Buffer.from([0xff, 0xfe]) });
  try {
    const data: any = (await f.invoke('search_text', { prefix: 'sub', query: 'aa' })).data;
    assert.equal(data.totalMatches, 3); assert.equal(data.matchedLines, 1); assert.equal(data.matchedFiles, 1);
    assert.equal(data.totalExact, false); assert.equal(data.coverage.counts, 'lower-bound'); assert.equal(data.nextCursor, null);
    assert(data.matches.every((m: any) => m.path === 'sub/a.txt')); assert(data.coverage.skipped.some((s: any) => s.reason === 'non-utf8-or-binary'));
  } finally { await f.close(); }
});

test('读取：1-based 行选择保留 BOM/CRLF，长行原文两页连续，过期版本先于起点解析拒绝', async () => {
  const source = '\uFEFF头🙂\r\n' + '长🙂'.repeat(13000) + '\r\n尾\r\n';
  const f = fixture({ 'a.txt': source });
  try {
    const first: any = (await f.invoke('read_file', { path: 'a.txt', startLine: 2, lineCount: 1 })).data;
    assert.equal(first.startByte, Buffer.byteLength('\uFEFF头🙂\r\n')); assert.equal(first.lineSelection.rangeComplete, false);
    assert(first.nextStartByte); assert(!first.text.includes('\uFFFD'));
    const next: any = (await f.invoke('read_file', { path: 'a.txt', startByte: first.nextStartByte, byteLength: 64000, expectedHash: first.hash })).data;
    assert.equal(first.text + next.text, source.slice(source.indexOf('\n') + 1));
    const head: any = (await f.invoke('read_file', { path: 'a.txt', startLine: 1, lineCount: 1 })).data;
    assert.equal(head.text, '\uFEFF头🙂\r\n'); assert(head.lineSelection.rangeComplete);
    await assert.rejects(f.invoke('read_file', { path: 'a.txt', startLine: 5 }), /超出文件范围/);
    await assert.rejects(f.invoke('read_file', { path: 'a.txt', startLine: 1, startByte: 0 }), /行范围和字节起点互斥/);
    writeFileSync(join(f.mount.root, 'a.txt'), '新🙂');
    await assert.rejects(f.invoke('read_file', { path: 'a.txt', expectedHash: first.hash, startByte: 2 }), /版本已改变/);
  } finally { await f.close(); }
});

function batchFixture(mode = 'success', deliver = false) {
  const f = fixture({ 'report.html': html }); let first: any, second: any;
  f.steps.push(call('read_file', { mountId: f.mount.id, path: 'report.html', startLine: 1, lineCount: 100 }),
    r => { first = lastData(r); return call('read_file', { mountId: f.mount.id, path: 'report.html', startByte: first.nextStartByte, expectedHash: first.hash, byteLength: 64000 }); },
    r => {
      second = lastData(r); const edits = sections.map(oldText => ({ oldText, newText: oldText.replace('</main>', '</section>') }));
      if (mode === 'invalid') edits[2]!.oldText = '不存在';
      if (mode === 'overlap') edits.push({ oldText: '内容🙂1', newText: '重复修改' });
      if (mode === 'ambiguous') edits[2]!.oldText = '</main>';
      if (mode === 'stale') writeFileSync(join(f.mount.root, 'report.html'), html + '第三方字节');
      if (mode === 'identity') { renameSync(join(f.mount.root, 'report.html'), join(f.mount.root, 'old.html')); writeFileSync(join(f.mount.root, 'report.html'), html); }
      if (mode === 'noop') for (const item of edits) item.newText = item.oldText;
      return call('edit_file', { mountId: f.mount.id, path: 'report.html', expectedReadHash: first.hash,
        readExecutionIds: mode === 'hidden' ? [first.readExecutionId] : [first.readExecutionId, second.readExecutionId], edits });
    });
  if (deliver) f.steps.push(call('build_changeset', { mountId: f.mount.id }), r => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }));
  f.steps.push(text('依据实际回执答复'));
  return f;
}

test('批量：约93KB中文HTML两页读取、六处一次修改和一次批准交付，原文/前缀完整', async () => {
  const f = batchFixture('success', true);
  try {
    assert(Buffer.byteLength(html) > 92000 && Buffer.byteLength(html) < 94000);
    const result = f.app.send(f.c.conversationId, uid(), '修复六处结构并交付');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    assert.equal(readFileSync(join(f.source, 'report.html'), 'utf8'), html);
    assert.equal(readFileSync(join(f.mount.root, 'report.html'), 'utf8'), expected);
    assert.equal(f.app.store.environment(f.c.environmentId).revision, 1); // 六处副本修改只推进一次。
    const edit = f.app.store.tools(result.runId).find(t => t.name === 'edit_file')!;
    const context: any = f.app.store.readArtifact(edit.context_ref!); assert.equal(context.fileEdit.schemaVersion, 2); assert.equal(context.fileEdit.edits.length, 6);
    f.app.approve(f.c.conversationId, approval, 'allow'); assert.equal((await f.app.wait(result.runId)).status, 'completed');
    assert.equal(readFileSync(join(f.source, 'report.html'), 'utf8'), expected);
    assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length, 1);
    for (let i = 1; i < f.model.requests.length; i++) {
      const previous = f.model.requests[i - 1]!.body.messages as WireMessage[], current = f.model.requests[i]!.body.messages as WireMessage[];
      assert.deepEqual(current.slice(0, previous.length), previous);
    }
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)), state);
    console.log(JSON.stringify({ sample: 'six-html-edits', bytes: Buffer.byteLength(html), requests: f.model.requests.length, reads: 2, edits: 6, approvals: 1, realAPI: false }));
  } finally { await f.close(); }
});

for (const mode of ['invalid', 'overlap', 'ambiguous', 'stale', 'identity', 'hidden']) test(`批量：${mode} 整批不写入，源文件和无关字节保持`, async () => {
  const f = batchFixture(mode);
  try {
    const result = await f.send(), edit = f.app.store.tools(result.runId).find(t => t.name === 'edit_file')!;
    assert.equal(edit.state, 'failed');
    assert.equal(readFileSync(join(f.mount.root, 'report.html'), 'utf8'), mode === 'stale' ? html + '第三方字节' : html);
    assert.equal(readFileSync(join(f.source, 'report.html'), 'utf8'), html); assert.equal(f.app.store.environment(f.c.environmentId).revision, 0);
    const receipt: any = f.app.store.readArtifact(edit.result_ref!);
    if (['invalid', 'overlap', 'ambiguous', 'hidden'].includes(mode)) assert(receipt.data.diagnostics.length > 0);
    if (mode === 'invalid') assert.equal(receipt.data.diagnostics[0].index, 2);
  } finally { await f.close(); }
});

test('批量：no-op 保留对象与mtime；取消在落盘前保持原字节', async () => {
  for (const mode of ['noop', 'cancel']) {
    const f = batchFixture(mode), file = join(f.mount.root, 'report.html'), before = statSync(file, { bigint: true });
    try {
      if (mode === 'cancel') { const tool = f.app.registry.get('edit_file'), execute = tool.execute; tool.execute = (a, ctx, c) => execute(a, ctx, c, AbortSignal.abort()); }
      const result = await f.send(), edit = f.app.store.tools(result.runId).find(t => t.name === 'edit_file')!;
      assert.equal(edit.state, mode === 'noop' ? 'succeeded' : 'cancelled'); assert.equal(readFileSync(file, 'utf8'), html);
      assert.equal(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs); assert.equal(f.app.store.environment(f.c.environmentId).revision, 0);
    } finally { await f.close(); }
  }
});

for (const point of ['tool.started', 'tool.settled']) test(`批量：${point} 崩溃后只核验原快照，不重放六项`, async () => {
  const f = batchFixture();
  try {
    f.app.store.db.exec(`CREATE TRIGGER fail_batch BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='${point}' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='edit_file' BEGIN SELECT RAISE(ABORT,'批量故障'); END;`);
    const result = await f.send(); assert.equal(f.app.store.getRun(result.runId).status, 'recovery_required');
    f.app.store.db.exec('DROP TRIGGER fail_batch'); await f.app.close();
    const reopened = new UmiApplication(join(f.root, 'data'), new ScriptModel([text('核验结果')]));
    try {
      reopened.resume(f.c.conversationId, result.runId); assert.equal((await reopened.wait(result.runId)).status, 'completed');
      const edit = reopened.store.tools(result.runId).find(t => t.name === 'edit_file')!;
      assert.equal(edit.state, point === 'tool.started' ? 'failed' : 'succeeded');
      assert.equal(readFileSync(join(f.mount.root, 'report.html'), 'utf8'), point === 'tool.started' ? html : expected);
      assert.equal(reopened.store.events(f.c.conversationId).filter(e => e.type === 'tool.dispatch_intent' && e.executionId === edit.id).length, 1);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('上下文：20轮不变必要事实只注入一次，冻结编码前缀完整，撤销/未知/新要求立即更新', () => {
  const manager = new ContextManager(), settings = settingsSchema.parse({ thinking: 'high' });
  const model = new DeepSeekAdapter(() => { throw Error('禁止真实 API'); });
  const rows = [{ id: 'u', applied: true, projectionSequence: '1', payload: { role: 'user' as const, content: '按用户要求做修改' } }];
  let carry: ReturnType<ContextManager['prepare']> | undefined, previous: any[] = [], firstBytes = 0, lastBytes = 0;
  for (let i = 0; i < 20; i++) {
    if (i) rows.push({ id: `a${i}`, applied: true, projectionSequence: String(i + 1), payload: { role: 'assistant' as any, content: `答复${i}` } });
    const current = manager.prepare({ messages: rows, settings, state: { resources: [{ access: 'edit' }], unresolvedExecutions: [], tools: [i], toolCount: i }, ...(carry ? { carry } : {}) }, []);
    const encoded = model.prepare(current.messages, [], settings, current.maxOutputTokens), wire = encoded.body.messages as any[];
    if (previous.length) assert.deepEqual(wire.slice(0, previous.length), previous);
    assert.equal(current.messages.filter(m => m.content.startsWith('当前宿主事实按域更新；')).length, 1);
    lastBytes = Buffer.byteLength(JSON.stringify(encoded.body)); if (!i) firstBytes = lastBytes;
    previous = wire; carry = current;
  }
  assert(lastBytes - firstBytes < 3000);
  const changed = manager.prepare({ messages: rows, settings, carry: carry!, state: { resources: [], unresolvedExecutions: [{ executionId: 'unknown', state: 'unknown' }] } }, []);
  const domains = projectedFacts(changed.messages); assert.deepEqual(domains['runtime.resources'], []); assert.equal(domains['runtime.unresolvedExecutions'][0].executionId, 'unknown');
  const removed = manager.prepare({ messages: rows, settings, carry: changed, state: { resources: [] } }, []); assert.equal(projectedFacts(removed.messages)['runtime.unresolvedExecutions'], null);
  rows.push({ id: 'u2', applied: true, projectionSequence: '21', payload: { role: 'user', content: '取消修改，先解释' } });
  const next = manager.prepare({ messages: rows, settings, carry: removed, state: { resources: [] } }, []);
  assert(next.messages.some(m => m.role === 'user' && m.content === '取消修改，先解释'));
  assert(projectedFacts(next.messages)['memory.requirements'].some((r: any) => r.messageId === 'u2'));
  const rebuilt = manager.prepare({ messages: rows, settings, carry: null, state: { resources: [] } }, []);
  assert.deepEqual(projectedFacts(rebuilt.messages)['runtime.resources'], []);
  console.log(JSON.stringify({ sample: 'stable-facts-20', firstBytes, lastBytes, addedRequestBytes: lastBytes - firstBytes, snapshots: 1, realAPI: false }));
});

test('请求诊断：关联真实原话，计费usage与本地估算分开，流式/工具测量不进入模型提示', async () => {
  const f = fixture({ 'a.txt': '原文' });
  try {
    f.steps.push(call('read_file', { mountId: f.mount.id, path: 'a.txt' }), text('已读'));
    const result = await f.send();
    const latest = f.app.store.messages(f.c.conversationId).find(m => m.role === 'user')!;
    const events = f.app.store.events(f.c.conversationId), measured = events.filter(e => e.type === 'model.attempt_measured');
    assert.equal(measured.length, 2);
    for (const event of measured) if (event.type === 'model.attempt_measured') { assert(event.payload.elapsedMs >= event.payload.firstFrameMs!); assert.notEqual(event.payload.firstTextMs, null); }
    const contexts = f.app.store.all('SELECT artifact_id FROM context_snapshots WHERE conversation_id=?', f.c.conversationId);
    for (const row of contexts) { const context: any = f.app.store.readArtifact(row.artifact_id as string); assert.equal(context.diagnostics.appliedUserMessageId, latest.id); assert(context.diagnostics.encodedRequestBytes > 0); assert(context.diagnostics.byRole.user.bytes > 0); }
    const tool = events.find(e => e.type === 'tool.measured'); assert(tool?.type === 'tool.measured' && tool.payload.prepareMs > 0); assert.equal(tool.payload.approvalPollingMs, 0);
    assert(f.app.contextStatistics(f.c.conversationId).lastActualUsage);
    assert(f.model.requests.every(r => !(r.body.messages as WireMessage[]).some(m => m.content.includes('encodedRequestBytes'))));
    assert.equal(f.app.store.getRun(result.runId).status, 'completed'); assert(PERSONA.includes('明确要求都完成且有关验证通过就收尾'));
  } finally { await f.close(); }
});

test('日常文件：17KB中文待办一次修改两项，行读取回读准确且来源不变', async () => {
  const original = '# 待办\r\n会议：星期一\r\n资料状态：待整理\r\n' + '备注🙂\r\n'.repeat(1400), f = fixture({ '日常.txt': original });
  try {
    f.steps.push(call('read_file', { mountId: f.mount.id, path: '日常.txt', startLine: 1, lineCount: 3 }), r => { const d = lastData(r); return call('edit_file', { mountId: f.mount.id, path: '日常.txt', expectedReadHash: d.hash, readExecutionIds: [d.readExecutionId], edits: [{ oldText: '会议：星期一', newText: '会议：星期二' }, { oldText: '资料状态：待整理', newText: '资料状态：已整理' }] }); },
      call('read_file', { mountId: f.mount.id, path: '日常.txt', startLine: 1, lineCount: 3 }), r => { assert.equal(lastData(r).text, '# 待办\r\n会议：星期二\r\n资料状态：已整理\r\n'); return text('已核验两项更正'); });
    const result = await f.send('修改会议日期和资料状态'); assert.equal(f.app.store.getRun(result.runId).status, 'completed');
    assert.equal(readFileSync(join(f.source, '日常.txt'), 'utf8'), original);
  } finally { await f.close(); }
});

test('小项目：读改两处后真实Node测试通过，仅一项命令批准，源项目未改', { timeout: 30000 }, async () => {
  const original = 'exports.sum=(a,b)=>a-b;\nexports.product=(a,b)=>a+b;\n';
  const f = fixture({ 'math.cjs': original, 'math.test.cjs': "const {test}=require('node:test');const assert=require('node:assert/strict');const m=require('./math.cjs');test('sum',()=>assert.equal(m.sum(2,3),5));test('product',()=>assert.equal(m.product(2,3),6));" });
  try {
    f.steps.push(call('read_file', { mountId: f.mount.id, path: 'math.cjs', startLine: 1 }), r => { const d = lastData(r); return call('edit_file', { mountId: f.mount.id, path: 'math.cjs', expectedReadHash: d.hash, readExecutionIds: [d.readExecutionId], edits: [{ oldText: 'exports.sum=(a,b)=>a-b;', newText: 'exports.sum=(a,b)=>a+b;' }, { oldText: 'exports.product=(a,b)=>a+b;', newText: 'exports.product=(a,b)=>a*b;' }] }); },
      call('run_command', { program: process.execPath, argv: ['--test', 'math.test.cjs'], cwd: { kind: 'mount', mountId: f.mount.id }, timeoutMs: 15000 }), text('两项测试通过'));
    const result = f.app.send(f.c.conversationId, uid(), '修复运算并运行测试');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    f.app.approve(f.c.conversationId, approval, 'allow'); assert.equal((await f.app.wait(result.runId)).status, 'completed');
    const tool = f.app.store.tools(result.runId).find(t => t.name === 'run_command')!; assert.equal(tool.state, 'succeeded');
    const receipt: any = f.app.store.readArtifact(tool.result_ref!); assert.equal(JSON.parse(receipt.content).exitCode, 0);
    assert.equal(readFileSync(join(f.source, 'math.cjs'), 'utf8'), original);
    const timing = f.app.store.events(f.c.conversationId).find(e => e.type === 'tool.measured' && e.executionId === tool.id);
    assert(timing?.type === 'tool.measured' && timing.payload.executeMs > 0);
  } finally { await f.close(); }
});

test('批量：跨两页的唯一片段可由连续可见范围覆盖，缺一页拒绝', async () => {
  for (const missing of [false, true]) {
    const f = fixture({ 'a.txt': '前🙂跨页唯一目标后' }); let first: any;
    try {
      f.steps.push(call('read_file', { mountId: f.mount.id, path: 'a.txt', byteLength: Buffer.byteLength('前🙂跨页唯') }),
        r => { first = lastData(r); return call('read_file', { mountId: f.mount.id, path: 'a.txt', startByte: first.nextStartByte, expectedHash: first.hash }); },
        r => call('edit_file', { mountId: f.mount.id, path: 'a.txt', expectedReadHash: first.hash, readExecutionIds: missing ? [first.readExecutionId] : [first.readExecutionId, lastData(r).readExecutionId], edits: [{ oldText: '唯一目标', newText: '精确替换' }] }), text('根据范围答复'));
      const result = await f.send(); assert.equal(f.app.store.tools(result.runId).find(t => t.name === 'edit_file')!.state, missing ? 'failed' : 'succeeded');
      assert.equal(readFileSync(join(f.mount.root, 'a.txt'), 'utf8'), missing ? '前🙂跨页唯一目标后' : '前🙂跨页精确替换后');
    } finally { await f.close(); }
  }
});
test('读取证据：批量不能使用未反馈模型的工具回执', async () => {
  const f = batchFixture();
  try {
    f.app.store.modelReceivedToolResult = () => false;
    const result = await f.send(), edit = f.app.store.tools(result.runId).find(t => t.name === 'edit_file')!;
    assert.equal(edit.state, 'failed'); const receipt: any = f.app.store.readArtifact(edit.result_ref!); assert.equal(receipt.data.code, 'MODEL_READ_REQUIRED');
    assert.equal(readFileSync(join(f.mount.root, 'report.html'), 'utf8'), html);
  } finally { await f.close(); }
});

test('诊断：停止中的模型记录中断耗时；审批拒绝记录等待且不执行副作用', async () => {
  const f = fixture({ 'a.txt': '原文' });
  try {
    f.steps.push(text('收到正文但未结束'));
    f.model.beforeResponse = async () => { await new Promise(resolve => setTimeout(resolve, 150)); };
    const first = f.app.send(f.c.conversationId, uid(), '等待停止');
    await eventually(() => f.app.store.snapshot(f.c.conversationId).blocks.some(b => b.text.length > 0) || undefined);
    await f.app.stop(f.c.conversationId, first.runId); assert.equal((await f.app.wait(first.runId)).status, 'stopped');
    const measured = f.app.store.events(f.c.conversationId).find(e => e.type === 'model.attempt_measured');
    assert(measured?.type === 'model.attempt_measured' && measured.payload.outcome === 'interrupted');
    f.model.beforeResponse = undefined;
    f.steps.push(call('run_command', { program: process.execPath, argv: ['-e', "throw Error('不得执行')"], cwd: { kind: 'mount', mountId: f.mount.id } }), text('操作已拒绝'));
    const second = f.app.send(f.c.conversationId, uid(), '请求命令后拒绝');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    await new Promise(resolve => setTimeout(resolve, 80)); f.app.approve(f.c.conversationId, approval, 'deny'); await f.app.wait(second.runId);
    const tool = f.app.store.tools(second.runId)[0]!; assert.equal(tool.state, 'denied');
    const timing = f.app.store.events(f.c.conversationId).find(e => e.type === 'tool.measured' && e.executionId === tool.id);
    assert(timing?.type === 'tool.measured' && timing.payload.approvalPollingMs > 0);
    const decisionWait = approvalDecisionWaits(f.app.store.events(f.c.conversationId)).find(item => item.approvalId === approval)!;
    assert(decisionWait.waitMs !== null && decisionWait.waitMs >= 70); assert.equal(timing.payload.executeMs, 0);
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
  } finally { await f.close(); }
});

test('查找：跳过依赖目录不宣称全挂载精确总数，单文件范围不受影响', async () => {
  const f = fixture({ 'a.txt': '目标' });
  try {
    mkdirSync(join(f.mount.root, 'node_modules')); writeFileSync(join(f.mount.root, 'node_modules', 'hidden.txt'), '目标');
    const all: any = (await f.invoke('search_text', { query: '目标' })).data;
    assert.equal(all.totalMatches, 1); assert.equal(all.totalExact, false); assert.equal(all.coverage.inventory.skipped.ignored, 1);
    const scoped: any = (await f.invoke('search_text', { query: '目标', path: 'a.txt' })).data; assert(scoped.totalExact);
  } finally { await f.close(); }
});
