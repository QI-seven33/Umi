import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReasoningRepetitionGuard } from '../packages/agent/src/loop/repeated-reasoning.js';
import { streamWithIdleTimeout } from '../packages/agent/src/model-stream.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { UmiError, settingsSchema, validatePairs } from '../packages/protocol/src/model.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';

const phrase = '我要开始写代码。先确认一下。现在开始。\n';
const unique = (length: number) => Array.from({ length: Math.ceil(length / 64) }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('').slice(0, length);

test('思考重复：连续足量逐字重复才触发，短暂复述和7个长周期均不触发', () => {
  const guard = new ReasoningRepetitionGuard();
  for (let i = 0; i < 8; i++) assert.equal(guard.observe(phrase), null);
  const longUnit = unique(2048);
  assert.equal(new ReasoningRepetitionGuard().observe(longUnit.repeat(7)), null);
  const proof = new ReasoningRepetitionGuard().observe(longUnit.repeat(8));
  assert.equal(proof?.periodBytes, 2048); assert.equal(proof?.repetitions, 8);
  assert.equal(proof?.repeatedBytes, 16384);
});
test('思考重复：中文emoji和任意代理对分片保留同一字节模式，不依赖SSE边界', () => {
  const body = ('思考🌱开始😀\n').repeat(1500);
  for (const size of [1, 7, 61, 1024, body.length]) {
    const guard = new ReasoningRepetitionGuard(); let proof = null;
    for (let i = 0; i < body.length && !proof; i += size) proof = guard.observe(body.slice(i, i + size));
    assert(proof, `没有识别分片${size}`); assert(proof.repeatedBytes >= 4096);
    assert(guard.retainedBytes <= 16384);
  }
});
test('思考重复：不归一空白或变化步骤，不把正常长推理和超过范围的周期当作精确循环', () => {
  const guard = new ReasoningRepetitionGuard();
  for (let i = 0; i < 800; i++) {
    assert.equal(guard.observe(`步骤${i}：依据不同证据${unique(64).slice(i % 20)}，继续检查\n`), null);
    assert(guard.retainedBytes <= 16384);
  }
  assert.equal(new ReasoningRepetitionGuard().observe((unique(2048) + '!').repeat(16)), null);
  assert.equal(new ReasoningRepetitionGuard().observe(phrase.repeat(300) + unique(16384)), null);
});
test('思考重复：每次请求独立，空片段不推进，检测只返回计数而非私有原文', () => {
  const a = new ReasoningRepetitionGuard(), b = new ReasoningRepetitionGuard();
  assert.equal(a.observe(''), null); assert(a.observe(phrase.repeat(300)));
  assert.equal(b.observe(phrase), null);
  const proof = a.observe('');
  assert.deepEqual(Object.keys(proof!).sort(), ['observedBytes', 'periodBytes', 'repeatedBytes', 'repetitions']);
  assert(!JSON.stringify(proof).includes('我要'));
});

class LoopModel extends ScriptModel {
  generated = ''; closed = false; aborted = false;
  override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
    if (this.requests.length) { yield* super.stream(request, signal); return; }
    this.requests.push(structuredClone(request));
    signal.addEventListener('abort', () => { this.aborted = true; }, { once: true });
    try {
      for (let i = 0; i < 64; i++) {
        const chunk = phrase.repeat(12); this.generated += chunk;
        yield { kind: 'delta', channel: 'reasoning', key: 'reasoning', text: chunk };
        signal.throwIfAborted();
      }
      yield { kind: 'delta', channel: 'text', key: 'text', text: '推演结束，给出用户答复。' };
      yield { kind: 'response', message: { role: 'assistant', content: '推演结束，给出用户答复。', reasoning_content: this.generated },
        finishReason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 5000 }, raw: {} };
    } finally { this.closed = true; }
  }
}
function fixture(model: ScriptModel) {
  const root = mkdtempSync(join(tmpdir(), 'umi-reasoning-guard-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const app = new UmiApplication(join(root, 'data'), model, { limits: { maxTurns: 6, maxRetries: 2, modelTimeoutMs: 1000, retryDelayMs: 1 } });
  const c = app.createConversation(workspace, { thinking: 'normal' });
  return { root, workspace, app, c, async close() { await app.close(); removeTestRoot(root); } };
}

test('思考重复只作观察：保留完整思考/正文/usage，不截流或额外请求，重启与重放一致', async () => {
  const model = new LoopModel([]), f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '分析重复模式');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(model.requests.length, 1); assert(model.closed);
    const state = f.app.store.snapshot(f.c.conversationId), events = f.app.store.events(f.c.conversationId);
    assert.equal(state.blocks.filter(b => b.kind === 'reasoning').map(b => b.text).join(''), model.generated);
    assert(Buffer.byteLength(model.generated) > 40000);
    assert.equal(events.filter(e => e.type === 'model.repetition_observed').length, 1);
    assert.equal(events.filter(e => e.type === 'model.attempt_failed' || e.type === 'run.failure_summary').length, 0);
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.missingUsage, 0);
    assert.equal(f.app.store.readArtifact<any>(events.find(e => e.type === 'usage.recorded')!.payload.usageRef).completion_tokens, 5000);
    assert.equal(f.app.store.messages(f.c.conversationId).at(-1)!.payload.content, '推演结束，给出用户答复。');
    assert.deepEqual(events.reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)), state);
    await f.app.close(); const reopened = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try { assert.deepEqual(reopened.store.snapshot(f.c.conversationId), state); } finally { await reopened.close(); }
  } finally { await f.close(); }
});
test('思考重复观察不插入模型指令，不替用户创建继续请求', async () => {
  const model = new LoopModel([text('按新要求继续解释')]), f = fixture(model);
  try {
    const first = f.app.send(f.c.conversationId, uid(), '分析'); await f.app.wait(first.runId);
    assert.equal(model.requests.length, 1);
    const next = f.app.send(f.c.conversationId, uid(), '进一步解释'); await f.app.wait(next.runId);
    assert.equal(model.requests.length, 2);
    const messages = model.requests[1]!.body.messages as any[]; validatePairs(messages);
    assert(messages.some(m => m.reasoning_content === model.generated));
    assert(!messages.some(m => m.role === 'system' && /model.repetition_observed|暂停本轮生成/.test(m.content)));
  } finally { await f.close(); }
});
test('思考重复之后用户停止仍生效，迭代器关闭且不产生完整响应', async () => {
  const external = new AbortController(), model = new LoopModel([]), observations: unknown[] = [];
  const request = model.prepare([], [], settingsSchema.parse({ thinking: 'normal' }), 65536);
  const stream = streamWithIdleTimeout(model, request, external.signal, 1000, o => observations.push(o));
  while (Buffer.byteLength(model.generated) < 10000) await stream.next();
  assert.equal(observations.length, 1);
  const stop = new UmiError('STOPPED', '用户停止'); external.abort(stop);
  await assert.rejects(() => stream.next(), error => error === stop); assert(model.closed);
});
test('重复观察之后真实断流仍解释受阻，残缺工具不执行、不自动重试', async () => {
  class BrokenModel extends ScriptModel {
    override async *stream(request: PreparedRequest): AsyncGenerator<ModelFrame> {
      this.requests.push(request);
      yield { kind: 'delta', channel: 'reasoning', key: 'r', text: phrase.repeat(300) };
      yield { kind: 'delta', channel: 'tool', key: 't', text: '{"relativePath":"unexecuted.txt","content":"' };
      throw new UmiError('PROVIDER_INTERRUPTED', '测试连接断开', true);
    }
  }
  const model = new BrokenModel([]), f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '创建文件');
    assert.equal((await f.app.wait(r.runId)).status, 'interrupted');
    assert.equal(model.requests.length, 1); assert.equal(f.app.store.tools(r.runId).length, 0);
    assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/unexecuted.txt')));
    assert.equal(f.app.store.events(f.c.conversationId).filter(e => e.type === 'model.repetition_observed').length, 1);
    const summary = f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummary!;
    assert.match(summary.text, /测试连接断开/); assert.match(summary.text, /未.*完成/);
  } finally { await f.close(); }
});
test('长思考、重复代码工具参数与正文可以完成写入，宿主操作仍需具体批准', async () => {
  const content = 'const repeated = 1;\n'.repeat(600), prose = '这是用户要求的重复正文。'.repeat(300);
  const write = call('write_scratch', { relativePath: 'repeat.js', content }, prose); write.reasoning_content = phrase.repeat(400);
  const model = new ScriptModel([write, text('写入完成')]), f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '写入重复代码样本');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/repeat.js')));
    f.app.approve(f.c.conversationId, approval, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.app.store.tools(r.runId).length, 1); assert.equal(model.requests.length, 2);
    assert.equal(readFileSync(join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/repeat.js'), 'utf8'), content);
  } finally { await f.close(); }
});
