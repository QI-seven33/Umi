import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { settingsSchema } from '../packages/protocol/src/model.js';
import { editFileSchema } from '../packages/protocol/src/file-edit.js';
import { uid } from '../packages/agent/src/identity.js';
import { removeTestRoot } from './fixtures.js';

const settings = settingsSchema.parse({ thinking: 'high' });
const single = { mountId: 'mount', path: 'a.txt', expectedReadHash: 'a'.repeat(64), readExecutionId: 'read', oldText: '原文', newText: '新文' };
const batch = { mountId: single.mountId, path: single.path, expectedReadHash: single.expectedReadHash, readExecutionIds: ['read'], edits: [{ oldText: single.oldText, newText: single.newText }] };
function sse(delta: unknown, finish = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}
function validateTools(body: any) {
  const names = new Set<string>();
  for (const tool of body.tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object', `${tool.function.name}: parameter root`);
    assert(tool.function.parameters.properties);
    assert(!names.has(tool.function.name)); names.add(tool.function.name);
  }
  assert(names.has('ask_user_question')); assert(names.has('edit_file')); assert(names.has('open_delivered_file'));
  const edit = body.tools.find((t: any) => t.function.name === 'edit_file').function.parameters;
  assert.deepEqual(edit.required, ['mountId', 'path', 'expectedReadHash']);
  assert(!edit.anyOf && !edit.oneOf);
  for (const field of ['readExecutionId', 'oldText', 'newText', 'readExecutionIds', 'edits']) assert(edit.properties[field]);
  const question = body.tools.find((t: any) => t.function.name === 'ask_user_question').function.parameters;
  assert.deepEqual(question.properties.questions.items.properties.options.items.required, ['label']);
}
test('DeepSeek 请求契约：顶层 union 复现缺陷并在本地拒绝；完整工具表为 object 输入规格', async () => {
  const adapter = new DeepSeekAdapter(() => 'local-only');
  const broken = z.toJSONSchema(z.union([z.object({ oldText: z.string() }), z.object({ edits: z.array(z.string()) })]));
  assert.equal(broken.type, undefined);
  assert.throws(() => adapter.prepare([{ role: 'user', content: '你好' }], [{ name: 'edit_file', description: '', parameters: broken }], settings, 8192), /edit_file.*object/);
  const root = mkdtempSync(join(tmpdir(), 'umi-request-')), app = new UmiApplication(root, adapter, { openDocument: async () => {} });
  try {
    const request = adapter.prepare([{ role: 'user', content: '你好' }], app.registry.specs(), settings, 8192);
    validateTools(JSON.parse(JSON.stringify(request.body)));
    assert.equal(request.body.reasoning_effort, 'high');
    assert.deepEqual(z.toJSONSchema(editFileSchema, { io: 'input' }), app.registry.specs().find(t => t.name === 'edit_file')!.parameters);
  } finally { await app.close(); removeTestRoot(root); }
});
test('编辑参数：模型可见两种字段，本地仍拒绝混用、缺项、未知字段及重复读取回执', () => {
  assert.deepEqual(editFileSchema.parse(single), single);
  assert.deepEqual(editFileSchema.parse(batch), batch);
  for (const value of [
    { ...single, edits: batch.edits }, { ...batch, oldText: single.oldText },
    { ...single, newText: undefined }, { ...batch, edits: undefined },
    { ...batch, readExecutionIds: ['read', 'read'] }, { ...single, unexpected: true },
    { mountId: 'mount', path: 'a.txt', expectedReadHash: single.expectedReadHash },
  ]) assert.equal(editFileSchema.safeParse(value).success, false);
  assert.equal(editFileSchema.safeParse({ ...single, newText: '' }).success, true);
});
test('真实循环/适配器：你好携带完整工具表通过本地服务校验，读文件后批量修改连续请求成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-request-flow-')), source = join(root, 'source');
  mkdirSync(source); writeFileSync(join(source, 'a.txt'), '第一处原文\n第二处原文\n');
  let requests = 0, mountId = '', mode = 'greeting';
  const transport: typeof fetch = async (_url, init) => {
    requests++; const body = JSON.parse(String(init!.body)); validateTools(body);
    if (mode === 'greeting') return sse({ content: '你好！' });
    const results = body.messages.filter((m: any) => m.role === 'tool');
    if (!results.length) return sse({ reasoning_content: '读取并精准修改两处。', tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ mountId, path: 'a.txt' }) } }] }, 'tool_calls');
    const data = JSON.parse(results.at(-1).content).data;
    if (results.length === 1) return sse({ reasoning_content: '使用同一读取版本。', tool_calls: [{ index: 0, id: 'edit-1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ mountId, path: 'a.txt', expectedReadHash: data.hash, readExecutionIds: [data.readExecutionId], edits: [{ oldText: '第一处原文', newText: '第一处新文' }, { oldText: '第二处原文', newText: '第二处新文' }] }) } }] }, 'tool_calls');
    assert.equal(data.noOp, false); return sse({ content: '工作副本两处已修改。' });
  };
  const adapter = new DeepSeekAdapter(() => 'local-only', 'http://127.0.0.1:1', transport);
  const app = new UmiApplication(join(root, 'data'), adapter, { openDocument: async () => {} });
  try {
    const hello = app.createConversation(source), sent = app.send(hello.conversationId, uid(), '你好'); await app.wait(sent.runId);
    assert.equal(app.store.getRun(sent.runId).status, 'completed'); assert.equal(requests, 1);
    mode = 'edit'; const task = app.createConversation(source); const mount = app.files.repo.mounts(task.environmentId)[0]!; mountId = mount.id;
    const edit = app.send(task.conversationId, uid(), '把第一处和第二处的原文改为新文'); await app.wait(edit.runId);
    assert.equal(app.store.getRun(edit.runId).status, 'completed'); assert.equal(requests, 4);
    assert.equal(readFileSync(join(mount.root, 'a.txt'), 'utf8'), '第一处新文\n第二处新文\n');
    assert.equal(readFileSync(join(source, 'a.txt'), 'utf8'), '第一处原文\n第二处原文\n');
  } finally { await app.close(); removeTestRoot(root); }
});
