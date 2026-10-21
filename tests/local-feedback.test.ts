import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamBuffer } from '../packages/agent/src/loop/stream-buffer.js';
import { reduceConversation, initialState } from '../packages/protocol/src/reducer.js';
import type { EventBody } from '../packages/protocol/src/events.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { desktopCommandSchema } from '../packages/protocol/src/desktop.js';
import { appendPreviewPage } from '../apps/desktop/renderer/src/preview-page.js';
import { userFacingError } from '../apps/desktop/renderer/src/ui-error.js';
import { Composer } from '../apps/desktop/renderer/src/features/work/components/Composer.js';
import { contextFixture } from './context-fixture.js';
import { ScriptModel, text, call, eventually, removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
type Delta = Extract<EventBody, { type: 'model.delta' }>;
function streamFixture() {
  const f = contextFixture(4, 8000), scope = { conversationId: f.c.conversationId, runId: f.runId, modelTurnId: uid(), modelAttemptId: uid() }, blockId = uid(), requestId = uid();
  f.app.store.persistRequest(scope, requestId, uid(), new ScriptModel([]).prepare([], [], f.app.store.settings(f.c.conversationId), 1024), { estimatedInputTokens: 1, inputCeiling: 100000, estimator: 'fixture' }, f.generation);
  f.app.store.commit(scope, { type: 'model.attempt_started', payload: { requestId } });
  f.app.store.commit(scope, { type: 'model.block_started', payload: { blockId, kind: 'reasoning', displayRole: 'commentary' } });
  const delta = (index: number, body = '中文🙂') : Delta => ({ type: 'model.delta', payload: { blockId, kind: 'reasoning', deltaIndex: index, text: body } });
  return { ...f, scope, blockId, delta };
}
test('本地反馈：批次保持全部片段索引，失败事务不留下半批，公开快照与重放一致', async () => {
  const f = streamFixture();
  try {
    const seed = f.app.store.snapshot(f.c.conversationId);
    assert.throws(() => f.app.store.commitModelDeltas(f.scope, f.generation, [f.delta(0), f.delta(2)]), /顺序/);
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId), seed);
    f.app.store.commitModelDeltas(f.scope, f.generation, [f.delta(0), f.delta(1)]);
    const events = f.app.store.events(f.c.conversationId, seed.cursor);
    assert.equal(events.length, 2); assert.deepEqual(events.map(e => e.type === 'model.delta' ? e.payload.deltaIndex : null), [0,1]);
    const live = events.reduce(reduceConversation, seed);
    assert.equal(seed.blocks.at(-1)!.text, ''); assert.equal(live.blocks.at(-1)!.text, '中文🙂中文🙂');
    assert.equal(live.runs, seed.runs); assert.equal(live.blocks[0], seed.blocks[0]);
    assert.deepEqual(live, f.app.store.snapshot(f.c.conversationId));
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, live.cursor.logEpoch)), live);
    live.blocks.at(-1)!.text = '外部修改';
    assert.equal(f.app.store.snapshot(f.c.conversationId).blocks.at(-1)!.text, '中文🙂中文🙂');
  } finally { await f.close(); }
});
test('本地反馈：停止后仅刷新已观察片段，新租约与已结束块禁止追加', async () => {
  const f = streamFixture();
  try {
    f.app.store.commit({ conversationId: f.c.conversationId, runId: f.runId }, { type: 'run.stop_requested', payload: { reason: '模拟运行中停止' } });
    f.app.store.commitModelDeltas(f.scope, f.generation, [f.delta(0)]);
    assert.throws(() => f.app.store.commitModelDeltas(f.scope, f.generation + 1, [f.delta(1)]), /执行权/);
    f.app.store.commit(f.scope, { type: 'model.block_completed', payload: { blockId: f.blockId } });
    assert.throws(() => f.app.store.commitModelDeltas(f.scope, f.generation, [f.delta(1)]), /生命周期/);
  } finally { await f.close(); }
});
test('本地反馈：等待下一帧时按时刷新，计时器失败可观察且不重复提交', async () => {
  const f = streamFixture(), batches: Delta[][] = [];
  try {
    const buffer = new StreamBuffer(ds => batches.push(ds)); buffer.push(f.delta(0));
    await eventually(() => batches.length || undefined, 500);
    assert.equal(batches[0]!.length, 1); buffer.flush(); assert.equal(batches.length, 1);
    let count = 0; const failure = new StreamBuffer(() => { count++; throw new Error('持久化失败'); });
    failure.push(f.delta(0)); await delay(60); assert.throws(() => failure.flush(), /持久化失败/); assert.equal(count, 1);
  } finally { await f.close(); }
});
class BurstModel extends ScriptModel {
  emitted = 0;
  constructor(readonly count: number, readonly pause = false) { super([]); }
  override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
    this.requests.push(request);
    for (let n = 0; n < this.count; n++) {
      signal.throwIfAborted(); this.emitted++;
      // 压测片段批次/停止响应，使用不同编号避免把夹具本身构造成模型逐字回环。
      yield { kind: 'delta', channel: 'reasoning', key: 'thinking', text: `中文🙂${n};` };
    }
    if (this.pause) await delay(10000, undefined, { signal });
    yield { kind: 'delta', channel: 'text', key: 'text', text: '完成' };
    yield { kind: 'response', message: { ...text('完成'), reasoning_content: Array.from({ length: this.count }, (_, i) => `中文🙂${i};`).join('') }, finishReason: 'stop', usage: null, raw: { fixture: true } };
  }
}
function appFixture(model: ScriptModel) {
  const root = mkdtempSync(join(tmpdir(), 'umi-local-feedback-')), workspace = join(root, 'source'); mkdirSync(workspace);
  writeFileSync(join(workspace, '报告.html'), '中文🙂'.repeat(20000));
  const app = new UmiApplication(join(root, 'data'), model), c = app.createConversation(workspace), service = new DesktopService(app);
  return { root, app, c, service, async close() { await app.close(); removeTestRoot(root); } };
}
test('本地反馈：2048 帧经过唯一循环，块边界、完整模型响应及原始事实无损', async () => {
  const model = new BurstModel(2048), f = appFixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '回答'); await f.app.wait(r.runId);
    assert.equal(f.app.store.getRun(r.runId).status, 'completed');
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.equal(state.blocks.find(b => b.kind === 'reasoning')!.text, Array.from({ length: 2048 }, (_, i) => `中文🙂${i};`).join(''));
    const deltas = f.app.store.events(f.c.conversationId).filter(e => e.type === 'model.delta'); assert.equal(deltas.length, 2049);
    assert.equal(model.requests.length, 1); assert.equal(f.app.store.messages(f.c.conversationId).at(-1)!.payload.reasoning_content, Array.from({ length: 2048 }, (_, i) => `中文🙂${i};`).join(''));
  } finally { await f.close(); }
});
test('本地反馈：高频缓冲帧不阻塞停止计时器，停止后不产生完整响应或工具派发', async () => {
  const model = new BurstModel(10000, true), f = appFixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '回答');
    await eventually(() => model.emitted || undefined);
    let emittedAtStop = 0;
    const stopped = new Promise<void>(resolve => setTimeout(() => { emittedAtStop = model.emitted; f.app.requestStop(f.c.conversationId, r.runId); resolve(); }, 0));
    await stopped; await f.app.wait(r.runId);
    assert(emittedAtStop < 10000, '停止应在全部缓冲帧消费完之前到达');
    assert.equal(f.app.store.getRun(r.runId).status, 'stopped');
    assert.equal(f.app.store.tools(r.runId).length, 0);
    assert.equal(f.app.store.messages(f.c.conversationId).filter(m => m.role === 'assistant' && m.modelAttemptId).length, 0);
    assert(f.app.store.snapshot(f.c.conversationId).blocks.some(b => b.text && b.status === 'interrupted'));
  } finally { await f.close(); }
});
test('本地反馈：128 条事件后明确提示积压，追赶结束后 hasMore 为 false', async () => {
  const f = streamFixture(), service = new DesktopService(f.app);
  try {
    const cursor = f.app.store.snapshot(f.c.conversationId).cursor;
    for (let n = 0; n < 160; n += 32) f.app.store.commitModelDeltas(f.scope, f.generation, Array.from({ length: 32 }, (_, i) => f.delta(n + i)));
    const first = await service.handle({ type: 'events', conversationId: f.c.conversationId, cursor }) as any;
    assert.equal(first.events.length, 128); assert.equal(first.hasMore, true);
    const second = await service.handle({ type: 'events', conversationId: f.c.conversationId, cursor: { ...cursor, sequence: first.events.at(-1).sequence } }) as any;
    assert.equal(second.events.length, 32); assert.equal(second.hasMore, false);
  } finally { await f.close(); }
});
test('界面对象：工具摘要不读取结果资料，失败路径和脚本参数不是文件入口', async () => {
  const f = appFixture(new ScriptModel([call('read_file', { mountId: '不存在', path: '报告.html' }), text('无法读取。')]));
  try {
    const r = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(r.runId);
    const tool = f.app.store.tools(r.runId)[0]!;
    const original = f.app.store.readArtifact; f.app.store.readArtifact = () => { throw Error('摘要不应读取正文'); };
    const summary = await f.service.handle({ type: 'tool_detail', conversationId: f.c.conversationId, callId: tool.call_id, summaryOnly: true }) as any;
    assert.equal(summary.file, null); assert.equal(summary.arguments.path, '报告.html'); assert.equal(summary.result, undefined);
    f.app.store.readArtifact = original;
    await assert.rejects(f.service.handle({ type: 'tool_detail', conversationId: uid(), callId: tool.call_id, summaryOnly: true }), /当前会话/);
  } finally { await f.close(); }
});
test('界面对象：真实中文文件分页连续，版本改变不能拼接旧预览；附件支持真实范围', async () => {
  const f = appFixture(new ScriptModel([]));
  try {
    f.app.files.initialize(f.c.environmentId); const mount = f.app.files.repo.mounts(f.c.environmentId)[0]!;
    const first = await f.service.handle({ type: 'preview_file', conversationId: f.c.conversationId, mountId: mount.id, path: '报告.html', startByte: 0, byteLength: 64000 }) as any;
    const second = await f.service.handle({ type: 'preview_file', conversationId: f.c.conversationId, mountId: mount.id, path: '报告.html', startByte: first.nextStartByte, byteLength: 64000 }) as any;
    assert.equal(appendPreviewPage(first, second).text, '中文🙂'.repeat(12800));
    writeFileSync(join(mount.root, '报告.html'), '新版🙂'.repeat(20000));
    const changed = await f.service.handle({ type: 'preview_file', conversationId: f.c.conversationId, mountId: mount.id, path: '报告.html', startByte: first.nextStartByte, byteLength: 64000 }) as any;
    assert.throws(() => appendPreviewPage(first, changed), (e: any) => e.code === 'PREVIEW_CHANGED');
    const a = f.app.store.uploadAttachment(f.c.conversationId, '说明.txt', 'text/plain', '中文🙂'.repeat(10000));
    const page = await f.service.handle(desktopCommandSchema.parse({ type: 'preview_attachment', conversationId: f.c.conversationId, attachmentId: a.id, startByte: 64000, byteLength: 64000 })) as any;
    assert.equal(page.startByte, 64000); assert.equal(page.text, '中文🙂'.repeat(3600));
  } finally { await f.close(); }
});
test('本地历史：流式事件增加不会改变原话应用顺序，查询使用局部事实索引', async () => {
  const f = streamFixture();
  try {
    const before = f.app.store.messages(f.c.conversationId);
    for (let n = 0; n < 2048; n += 64) f.app.store.commitModelDeltas(f.scope, f.generation, Array.from({ length: 64 }, (_, i) => f.delta(n + i)));
    assert.deepEqual(f.app.store.messages(f.c.conversationId), before);
    const plan = f.app.store.all("EXPLAIN QUERY PLAN SELECT a.sequence FROM events a WHERE a.conversation_id=? AND json_extract(a.payload,'$.type')='input.applied' AND json_extract(a.payload,'$.payload.messageId')=? LIMIT 1", f.c.conversationId, before[0]!.id);
    assert(plan.some(row => String(row.detail).includes('events_applied_input')));
  } finally { await f.close(); }
});
test('预览版本：旧分页起点在新版本切开 UTF-8 时，先返回版本改变', async () => {
  const f = appFixture(new ScriptModel([]));
  try {
    f.app.files.initialize(f.c.environmentId); const mount = f.app.files.repo.mounts(f.c.environmentId)[0]!;
    const first = f.app.previewFile(f.c.conversationId, mount.id, '报告.html', 0, 64000);
    writeFileSync(join(mount.root, '报告.html'), 'a' + '中文🙂'.repeat(20000));
    assert.throws(() => f.app.previewFile(f.c.conversationId, mount.id, '报告.html', 64000, 64000, first.hash), (e: any) => e.code === 'RESOURCE_CHANGED');
  } finally { await f.close(); }
});
test('界面提示：内部命令回执超时静默，真实错误仍保留；批准等待只提供批准和拒绝', () => {
  assert.equal(userFacingError({ code: 'COMMAND_TIMEOUT', message: '查询 commandId' }), '');
  assert.equal(userFacingError({ code: 'NOT_FOUND', message: '文件不存在' }), '文件不存在');
  const noop = () => {};
  const props: any = { prompt: '', workspace: '', onPromptChange: noop, onDragOver: noop, onDragLeave: noop, onDrop: noop, onPaste: noop, attachments: [], onAddFiles: noop, onRemoveAttachment: noop, onPreviewAttachment: noop, modelOptions: [], selectedModel: '', onSelectModel: noop, thinking: 'off', onSelectThinking: noop, executionPolicy: 'ask', onSelectExecutionPolicy: noop, onSubmit: noop, onStop: noop, streaming: true, approvalPanel: createElement('p', null, '批准正文'), isAtBottom: true, onScrollToBottom: noop };
  const html = renderToStaticMarkup(createElement(Composer, props)); assert(!html.includes('停止任务')); assert(!html.includes('stop-button')); assert(html.includes('批准正文'));
});
