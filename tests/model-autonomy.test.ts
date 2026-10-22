import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { uid } from '../packages/agent/src/identity.js';
import { UmiError, validatePairs } from '../packages/protocol/src/model.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { ScriptModel, call, text, eventually, removeTestRoot, projectedFacts } from './fixtures.js';

const onlyReasoning = () => ({ role: 'assistant' as const, content: '', reasoning_content: '我已理解要求，接下来处理文件。' });
function fixture(model: ScriptModel | DeepSeekAdapter) {
  const root = mkdtempSync(join(tmpdir(), 'umi-model-autonomy-')), source = join(root, 'source');
  mkdirSync(source);
  const app = new UmiApplication(join(root, 'data'), model), c = app.createConversation(source, { thinking: 'normal' });
  return { root, source, app, c, async close() { await app.close(); removeTestRoot(root); } };
}
const sse = (delta: unknown, finish: string) => new Response('data: ' + JSON.stringify({
  choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 30, completion_tokens: 20 },
}) + '\n\ndata: [DONE]\n\n');

test('自主执行：仅思考stop后继续真实工具链，50KB成果一次保存，无任务账本或重复收尾', async () => {
  const requests: any[] = [], html = '<!doctype html><h1>离线成果</h1><!--' + 'x'.repeat(50000) + '-->';
  const model = new DeepSeekAdapter(() => 'fixture', 'https://api.deepseek.com', async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request); validatePairs(request.messages);
    assert.equal(request.reasoning_effort, 'low');
    const facts = projectedFacts(request.messages);
    assert.equal(facts['runtime.taskAcceptance'], undefined);
    if (requests.length === 1) return sse({ reasoning_content: '先理解用户的页面需求。' }, 'stop');
    if (requests.length === 2) {
      assert(request.messages.some((m: any) => m.reasoning_content === '先理解用户的页面需求。'));
      assert.equal(facts['runtime.answerRecovery'].count, 1);
      return sse({ content: '保存页面。', tool_calls: [{ index: 0, id: 'output', function: {
        name: 'create_output', arguments: JSON.stringify({ name: 'scene.html', mime: 'text/html', content: html }),
      } }] }, 'tool_calls');
    }
    assert.equal(facts['runtime.answerRecovery'], null);
    assert(request.messages.some((m: any) => m.role === 'tool' && JSON.parse(m.content).outcome === 'succeeded'));
    return sse({ content: 'scene.html已生成，尚未导出或检查真实浏览器画面。' }, 'stop');
  });
  const f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '制作一个约50KB的HTML成果');
    assert.equal((await f.app.wait(r.runId)).status, 'completed'); assert.equal(requests.length, 3);
    const tools = f.app.store.tools(r.runId); assert.deepEqual(tools.map(t => t.name), ['create_output']);
    const page = f.app.outputs.read(f.c.conversationId, { outputId: tools[0]!.id, byteLength: 64000 });
    assert.equal('text' in page ? page.text : '', html);
    assert.equal(existsSync(join(f.source, 'scene.html')), false);
    assert.equal(f.app.tasks.list(f.c.conversationId).length, 0);
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)), state);
  } finally { await f.close(); }
});

for (const decision of ['allow', 'deny'] as const) test(`自主续作：模型补发写入仍须具体批准，${decision}后按真实结果回答`, async () => {
  const model = new ScriptModel([onlyReasoning(), call('write_scratch', { relativePath: 'result.txt', content: '实际内容' }), text('已按批准结果处理，结果以回执为准。')]);
  const f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '制作文件');
    const id = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    const target = join(f.app.store.environment(f.c.environmentId).root, 'task/scratch/result.txt');
    assert.equal(model.requests.length, 2); assert.equal(existsSync(target), false);
    f.app.approve(f.c.conversationId, id, decision);
    assert.equal((await f.app.wait(r.runId)).status, 'completed'); assert.equal(model.requests.length, 3);
    assert.equal(existsSync(target), decision === 'allow');
    if (decision === 'allow') assert.equal(readFileSync(target, 'utf8'), '实际内容');
    assert.equal(f.app.store.tools(r.runId)[0]!.state, decision === 'allow' ? 'succeeded' : 'denied');
    assert.equal(f.app.store.events(f.c.conversationId).some(e => e.type === 'task.state_changed'), false);
  } finally { await f.close(); }
});

test('自主续作：用户停止优先于仅思考异常恢复，不请求额外收尾', async () => {
  const model = new ScriptModel([onlyReasoning()]), f = fixture(model);
  const persist = f.app.store.persistResponse.bind(f.app.store);
  f.app.store.persistResponse = (...args) => { const id = persist(...args); f.app.requestStop(f.c.conversationId, args[0].runId!); return id; };
  try {
    const r = f.app.send(f.c.conversationId, uid(), '开始操作');
    assert.equal((await f.app.wait(r.runId)).status, 'stopped'); assert.equal(model.requests.length, 1);
    assert.match(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummary!.text, /目标未被取消/);
  } finally { await f.close(); }
});

test('自主续作：仅思考响应到达时若有新原话，先处理新原话而不插入旧恢复要求', async () => {
  const model = new ScriptModel([onlyReasoning(), request => {
    assert((request.body.messages as any[]).some(m => m.role === 'user' && m.content === '先解释方案，不做文件'));
    assert.equal(projectedFacts(request.body.messages as any[])['runtime.answerRecovery'], null);
    return text('当前先解释方案。');
  }]), f = fixture(model);
  model.beforeResponse = async () => { model.beforeResponse = undefined; f.app.send(f.c.conversationId, uid(), '先解释方案，不做文件'); };
  try {
    const r = f.app.send(f.c.conversationId, uid(), '制作文件');
    assert.equal((await f.app.wait(r.runId)).status, 'completed'); assert.equal(model.requests.length, 2);
    assert.equal(f.app.store.tools(r.runId).length, 0);
  } finally { await f.close(); }
});

test('自主续作：恢复依据跨重启保留，同一输入第二次仅思考停止自动请求，新原话可继续', async () => {
  const model = new ScriptModel([onlyReasoning(), () => { throw new UmiError('PROVIDER_INTERRUPTED', '模拟离线断连'); }]), f = fixture(model);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '制作文件');
    assert.equal((await f.app.wait(r.runId)).status, 'interrupted'); assert.equal(model.requests.length, 2);
    await f.app.close();
    const next = new ScriptModel([onlyReasoning(), text('按新原话继续处理。')]), reopened = new UmiApplication(join(f.root, 'data'), next);
    try {
      reopened.resume(f.c.conversationId, r.runId);
      assert.equal((await reopened.wait(r.runId)).status, 'failed'); assert.equal(next.requests.length, 1);
      assert.match(reopened.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummary!.text, /只有思考/);
      const continued = reopened.send(f.c.conversationId, uid(), '继续，先给出说明');
      assert.equal((await reopened.wait(continued.runId)).status, 'completed'); assert.equal(next.requests.length, 2);
      validatePairs(reopened.store.messages(f.c.conversationId).filter(m => m.applied).map(m => m.payload));
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('自主答复：正常解释不由关键词触发恢复，完全空响应不冒充仅思考stop', async () => {
  for (const answer of [text('我会说明“接下来调用工具”这句话的含义。'), text('')]) {
    const model = new ScriptModel([answer]), f = fixture(model);
    try {
      const r = f.app.send(f.c.conversationId, uid(), '解释这句话'); await f.app.wait(r.runId);
      assert.equal(model.requests.length, 1);
      assert.equal(f.app.store.getRun(r.runId).status, answer.content ? 'completed' : 'failed');
    } finally { await f.close(); }
  }
});
