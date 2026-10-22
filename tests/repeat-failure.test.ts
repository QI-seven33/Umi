import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { UmiApplication } from '../apps/headless/src/application.js';
import { hostContext } from '../packages/adapters/src/host-files/scratch.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { settingsSchema } from '../packages/protocol/src/model.js';
import { ScriptModel, call, text, removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import type { ToolResult } from '../packages/agent/src/persistence.js';

function fixture(attempts: number, successAt = Infinity, invalid = false, grouped = false) {
  const root = mkdtempSync(join(tmpdir(), 'umi-repeat-failure-'));
  const calls = Array.from({ length: attempts }, (_, i) => call('read_fixture', invalid ? { bad: true } : {}, '读取', String(i)));
  const model = new ScriptModel([...(grouped ? [{ ...calls[0]!, tool_calls: calls.flatMap(c => c.tool_calls!) }] : calls), text('已说明实际读取结果。')]);
  const app = new UmiApplication(join(root, 'data'), model), c = app.createConversation(root);
  let executed = 0;
  app.registry.register({ name: 'read_fixture', description: '离线读取', schema: z.object({}).strict(), effect: 'read', prepare: hostContext,
    async execute() { executed++; return executed >= successAt ? { outcome: 'succeeded', content: '已恢复，读取成功', data: { value: 42 } }
      : { outcome: 'failed', content: '暂时不可读取', data: { code: 'FIXTURE_NOT_READY', original: true } }; } });
  return { root, model, app, c, get executed() { return executed; }, async close() { await app.close(); removeTestRoot(root); } };
}
test('失败保护：先反馈相同失败；提醒后同参数确实恢复成功时正常完成', async () => {
  const f = fixture(5, 5);
  try {
    const run = f.app.send(f.c.conversationId, uid(), '尝试读取，恢复后答复');
    assert.equal((await f.app.wait(run.runId)).status, 'completed'); assert.equal(f.executed, 5);
    const tools = f.app.store.tools(run.runId), warning = f.app.store.readArtifact<ToolResult>(tools[3]!.result_ref!);
    assert.match(warning.content, /宿主提醒/); assert.equal((warning.data as any).original, true);
    assert.equal((warning.data as any).code, 'FIXTURE_NOT_READY');
    assert.equal(tools[4]!.state, 'succeeded'); assert.equal(f.model.requests.length, 6);
    assert.equal(f.app.store.events(f.c.conversationId).filter(e => e.type === 'run.failed').length, 0);
  } finally { await f.close(); }
});
test('失败保护：提醒后仍相同已知失败才停，用户得到正文，未知效果不被伪造', async () => {
  const f = fixture(5);
  try {
    const run = f.app.send(f.c.conversationId, uid(), '读取');
    assert.equal((await f.app.wait(run.runId)).status, 'failed'); assert.equal(f.executed, 5);
    const last = f.app.store.readArtifact<any>(f.app.store.tools(run.runId).at(-1)!.result_ref!);
    assert.equal(last.data.code, 'TASK_STALLED'); assert.equal(last.data.causeCode, 'FIXTURE_NOT_READY');
    assert.equal(f.model.requests.length, 6);
    assert.equal(f.app.store.unresolvedEnvironment(f.c.environmentId).length, 0);
    assert(f.app.store.messages(f.c.conversationId).at(-1)!.payload.content.trim());
  } finally { await f.close(); }
});
test('失败保护：工具参数反复无效也能得到具体反馈和收尾，不派发工具', async () => {
  const f = fixture(5, Infinity, true);
  try {
    const run = f.app.send(f.c.conversationId, uid(), '读取');
    assert.equal((await f.app.wait(run.runId)).status, 'failed'); assert.equal(f.executed, 0);
    const tools = f.app.store.tools(run.runId);
    assert.match(f.app.store.readArtifact<ToolResult>(tools[3]!.result_ref!).content, /宿主提醒/);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[run.runId]!.code, 'TASK_STALLED');
  } finally { await f.close(); }
});
test('失败保护：新用户条件不继承上一条原话下的失败计数', async () => {
  const f = fixture(5), settle = f.app.store.settle.bind(f.app.store); let steered = false;
  f.app.store.settle = (...args) => {
    const result = settle(...args);
    if (!steered && (args[1].data as any)?.umiRepeat?.warning) {
      steered = true; f.app.send(f.c.conversationId, uid(), '按新的条件再试一次，仍失败就说明，不再尝试。');
    }
    return result;
  };
  try {
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    assert(steered); assert.equal(f.executed, 5);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[run.runId]!.code, undefined);
    assert.equal(f.model.requests.length, 6);
  } finally { await f.close(); }
});
test('思考关闭不再捆绑短输出：Off/Normal/High都预留相同文件生成容量', () => {
  const manager = new ContextManager();
  for (const thinking of ['off', 'normal', 'high'] as const) {
    const context = manager.prepare({ messages: [], settings: settingsSchema.parse({ thinking }), state: {} }, []);
    assert.equal(context.maxOutputTokens, 65536);
  }
});

test('失败保护：同一批次只计算此前实际回执，提醒后持续失败会结算余下未执行调用', async () => {
  const f = fixture(6, Infinity, false, true);
  try {
    const run = f.app.send(f.c.conversationId, uid(), '读取');
    assert.equal((await f.app.wait(run.runId)).status, 'failed'); assert.equal(f.executed, 5);
    const tools = f.app.store.tools(run.runId);
    assert.equal(tools.length, 6); assert.equal(tools[5]!.state, 'cancelled');
    assert.match(f.app.store.readArtifact<ToolResult>(tools[3]!.result_ref!).content, /宿主提醒/);
    assert.equal(f.model.requests.length, 2);
  } finally { await f.close(); }
});
test('输出容量：较小窗口按真实输入协调预留，不因固定65K预留拒绝合法输入', () => {
  const context = new ContextManager().prepare({ messages: [], settings: settingsSchema.parse({ thinking: 'off', contextWindow: 128000 }), state: {} },
    [{ name: 'read_fixture', description: 'x'.repeat(70000), parameters: { type: 'object', properties: {} } }]);
  assert(context.maxOutputTokens >= 8192); assert(context.maxOutputTokens < 65536);
  assert(context.estimatedInputTokens + context.maxOutputTokens + 16384 <= 128000);
});

test('输出容量：显式64K小窗口在所有思考档位仍能容纳普通请求', () => {
  for (const thinking of ['off', 'normal', 'high'] as const) {
    const context = new ContextManager().prepare({ messages: [], settings: settingsSchema.parse({ thinking, contextWindow: 64000 }), state: {} }, []);
    assert.equal(context.maxOutputTokens, 8192);
    assert(context.estimatedInputTokens + context.maxOutputTokens + 16384 <= 64000);
  }
});
