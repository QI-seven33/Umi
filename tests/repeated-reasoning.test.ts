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
      yield { kind: 'delta', channel: 'text', key: 'text', text: '准备开始执行。' };
      yield { kind: 'delta', channel: 'tool', key: 'draft', text: '{"relativePath":"unexecuted.txt","content":"' };
      for (let i = 0; i < 1000; i++) {
        const chunk = phrase.repeat(12); this.generated += chunk;
        yield { kind: 'delta', channel: 'reasoning', key: 'reasoning', text: chunk };
        signal.throwIfAborted();
      }
      throw new Error('保护未生效');
    } finally { this.closed = true; }
  }
}
function fixture(model: ScriptModel) {
  const root = mkdtempSync(join(tmpdir(), 'umi-reasoning-guard-')), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const app = new UmiApplication(join(root, 'data'), model, {
    limits: { maxTurns: 6, maxRetries: 2, modelTimeoutMs: 1000, retryDelayMs: 1 },
  });
  const c = app.createConversation(workspace, { thinking: 'normal' });
  return { root, workspace, app, c, async close() { await app.close(); removeTestRoot(root); } };
}

test('思考重复：真实循环取消连接、逐片段保留原稿、无重试/工具/批准，用量未知且暂停可见', async () => {
  const model = new LoopModel([text('已按继续要求重新判断')]), f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '创建文件');
    assert.equal((await f.app.wait(r.runId)).status, 'interrupted');
    assert.equal(model.requests.length, 1); assert(model.closed); assert(model.aborted);
    const state = f.app.store.snapshot(f.c.conversationId), run = state.runs[r.runId]!;
    assert.equal(run.code, 'PROVIDER_REPETITION');
    assert.equal(state.blocks.filter(b => b.kind === 'reasoning').map(b => b.text).join(''), model.generated);
    assert(Buffer.byteLength(model.generated) < 20000);
    assert.equal(f.app.store.tools(r.runId).length, 0); assert.equal(Object.keys(state.approvals).length, 0);
    assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/unexecuted.txt')));
    assert(f.app.store.messages(f.c.conversationId).filter(m => m.role === 'assistant').every(m => !m.modelAttemptId));
    assert.equal(f.app.store.events(f.c.conversationId).filter(e => e.type === 'usage.recorded').length, 0);
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.missingUsage, 1);
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.retries, 0);
    assert(run.failureSummary?.text.includes('任务尚未完成')); assert(run.failureSummary?.text.includes('\n\n'));
    const html = renderToStaticMarkup(createElement(Timeline, { snapshot: new DesktopService(f.app).snapshot(f.c.conversationId), onPreview: () => {}, onError: () => {} }));
    assert.match(html, /持续逐字重复/); assert.match(html, /用量为未知/);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)), state);
    await f.app.close();
    const reopened = new UmiApplication(join(f.root, 'data'), model);
    try { assert.deepEqual(reopened.store.snapshot(f.c.conversationId), state); assert.equal(model.requests.length, 1); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});
test('思考重复：用户明确继续才有新请求，看到本地暂停事实，不回传残缺工具或删已完成历史', async () => {
  const model = new LoopModel([text('已按继续要求重新判断')]), f = fixture(model);
  try {
    const first = f.app.send(f.c.conversationId, uid(), '创建文件'); await f.app.wait(first.runId);
    const next = f.app.send(f.c.conversationId, uid(), '继续，先简短说明已有结果，不调用工具');
    assert.equal((await f.app.wait(next.runId)).status, 'completed'); assert.equal(model.requests.length, 2);
    const messages = model.requests[1]!.body.messages as any[];
    validatePairs(messages); assert(messages.some(m => m.role === 'assistant' && m.content.includes('持续逐字重复')));
    assert(!messages.some(m => m.tool_calls?.length));
    assert.equal(f.app.store.events(f.c.conversationId).filter(e => e.type === 'run.failure_summary').length, 1);
  } finally { await f.close(); }
});
test('思考重复：用户停止优先于同帧保护，迭代器仍关闭', async () => {
  const external = new AbortController(), model = new LoopModel([]);
  const request = model.prepare([], [], settingsSchema.parse({ thinking: 'normal' }), 1000);
  const stream = streamWithIdleTimeout(model, request, external.signal, 1000);
  while (Buffer.byteLength(model.generated) < 4096) await stream.next();
  const stop = new UmiError('STOPPED', '用户停止'); external.abort(stop);
  await assert.rejects(() => stream.next(), error => error === stop);
  assert(model.closed);
});
test('思考重复：新输入阻止旧受阻说明，本地说明失败不会冒充成功或额外请求模型', async () => {
  for (const code of ['CONTEXT_SOURCE_CHANGED', 'PERSISTENCE_FAILED']) {
    const model = new LoopModel([]), f = fixture(model);
    f.app.store.persistFailureSummary = () => { throw new UmiError(code, '注入收尾失败'); };
    try {
      const r = f.app.send(f.c.conversationId, uid(), '创建文件'); await f.app.wait(r.runId);
      const run = f.app.store.snapshot(f.c.conversationId).runs[r.runId]!;
      assert.equal(run.status, 'interrupted'); assert.equal(run.code, code);
      assert.equal(run.failureSummary, undefined); assert.equal(model.requests.length, 1);
      assert.equal(f.app.store.tools(r.runId).length, 0);
    } finally { await f.close(); }
  }
});
test('思考重复：正常长正文和重复代码工具参数不截断，实际写入仍需一次具体批准', async () => {
  const content = 'const repeated = 1;\n'.repeat(600), prose = '这是用户要求的重复正文。'.repeat(300);
  const model = new ScriptModel([call('write_scratch', { relativePath: 'repeat.js', content }, prose), text('写入完成')]);
  const f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '写入重复代码样本');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    f.app.approve(f.c.conversationId, approval, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.app.store.tools(r.runId).length, 1); assert.equal(model.requests.length, 2);
    assert.equal(readFileSync(join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/repeat.js'), 'utf8'), content);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.code, undefined);
  } finally { await f.close(); }
});
