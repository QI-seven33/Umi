import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call, text, removeTestRoot, eventually } from './fixtures.js';
import type { Step } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { toolNames } from '../apps/desktop/renderer/src/activity.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'umi-audit-')), source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'a.txt'), '计数:0');
  const steps: Step[] = [], model = new ScriptModel(steps), app = new UmiApplication(join(root, 'data'), model), c = app.createConversation(source), mount = app.files.repo.mounts(c.environmentId)[0]!;
  return { root, source, steps, model, app, c, mount, async run() { const result = app.send(c.conversationId, uid(), '按当前目标读改验证'); await app.wait(result.runId); return result; }, async close() { await app.close(); removeTestRoot(root); } };
}
const dataOf = (request: import('../packages/agent/src/ports.js').PreparedRequest): any => JSON.parse((request.body.messages as import('../packages/protocol/src/model.js').WireMessage[]).filter(m => m.role === 'tool').at(-1)!.content).data;

test('审查：同文件三次编辑后的第四次读取是新版本进展，不能误报停滞', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) f.steps.push(call('read_file', { mountId: f.mount.id, path: 'a.txt' }, '读当前版本', `read-${i}`), request => { const d = dataOf(request); return call('edit_file', { mountId: f.mount.id, path: 'a.txt', readExecutionId: d.readExecutionId, expectedReadHash: d.hash, oldText: `计数:${i}`, newText: `计数:${i + 1}` }, '修改当前版本', `edit-${i}`); });
    f.steps.push(call('read_file', { mountId: f.mount.id, path: 'a.txt' }, '核验第三次修改', 'read-3'), request => { assert.equal(dataOf(request).text, '计数:3'); return text('已核验当前版本'); });
    const result = await f.run(); assert.equal(f.app.store.getRun(result.runId).status, 'completed'); assert(f.app.store.tools(result.runId).every(t => t.state === 'succeeded'));
    assert.equal(readFileSync(join(f.source, 'a.txt'), 'utf8'), '计数:0');
  } finally { await f.close(); }
});

test('审查：外部改变目标版本也允许复读，不能仅以环境修订计进展', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) f.steps.push(() => { writeFileSync(join(f.mount.root, 'a.txt'), `外部版本:${i}`); return call('read_file', { mountId: f.mount.id, path: 'a.txt' }, '读外部新版本', `read-${i}`); });
    f.steps.push(request => { assert.equal(dataOf(request).text, '外部版本:3'); return text('观察事实'); });
    const result = await f.run(); assert.equal(f.app.store.getRun(result.runId).status, 'completed'); assert.equal(f.app.store.environment(f.c.environmentId).revision, 0);
  } finally { await f.close(); }
});

test('审查：同目标同版本第四次请求仍受原停滞限制，auto 未隐式授权宿主命令', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 4; i++) f.steps.push(call('read_file', { mountId: f.mount.id, path: 'a.txt' }, '重复读取', `read-${i}`));
    const result = await f.run(); assert.equal(f.app.store.getRun(result.runId).status, 'failed'); assert.equal(f.app.store.tools(result.runId).at(-1)!.state, 'failed');
    f.app.store.updateSettings(f.c.conversationId, { ...f.app.store.settings(f.c.conversationId), executionPolicy: 'auto' });
    f.steps.push(call('run_command', { program: process.execPath, argv: ['-e', "throw Error('未获准不能执行')"], cwd: { kind: 'mount', mountId: f.mount.id } }), text('尊重拒绝'));
    const next = f.app.send(f.c.conversationId, uid(), '拒绝命令');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
    f.app.approve(f.c.conversationId, approval, 'deny'); await f.app.wait(next.runId); assert.equal(f.app.store.tools(next.runId)[0]!.state, 'denied');
  } finally { await f.close(); }
});

test('审查：当前默认工具都有明确展示名称，不以“调用工具”掩盖任务状态', async () => {
  const f = fixture();
  try { const missing = f.app.registry.specs().map(spec => spec.name).filter(name => !toolNames[name]); assert.deepEqual(missing, []); }
  finally { await f.close(); }
});
