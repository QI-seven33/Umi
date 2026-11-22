import { contextFixture } from './context-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { applyBatch, type Batch } from '../apps/desktop/renderer/src/transport.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { projectHistoryPreview } from '../apps/desktop/renderer/src/components/ui/ConversationMap.js';
import { uid } from '../packages/agent/src/identity.js';
import { validatePairs, type WireMessage } from '../packages/protocol/src/model.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { ScriptModel, text, call, eventually, removeTestRoot, projectedFacts, type Step } from './fixtures.js';

function fixture(steps: Step[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'umi-message-edit-')), workspace = join(root, 'workspace'), data = join(root, 'data');
  mkdirSync(workspace); const model = new ScriptModel(steps); let app = new UmiApplication(data, model);
  const c = app.createConversation(workspace), mount = app.files.repo.direct.mounts(c.environmentId)[0]!;
  return { root, workspace, data, model, steps, c, mount, get app() { return app; },
    get service() { return new DesktopService(app); },
    async send(content: string, attachments: string[] = []) { const r = app.send(c.conversationId, uid(), content, attachments); await app.wait(r.runId); return r; },
    async edit(target: string, content: string, commandId = uid()) { return app.editMessage(c.conversationId, commandId, target, app.store.userMessages(c.conversationId).at(-1)!.id, content); },
    async reopen() { await app.close(); app = new UmiApplication(data, model); },
    async close() { await app.close(); removeTestRoot(root); } };
}

test('消息修订：真实替换当前线性对话，原文/事件不改写，重连与冷重放一致', async () => {
  const f = fixture([text('保留回复一'), text('废弃回复二'), text('废弃回复三'), text('修订后的回复')]);
  try {
    await f.send('保留问题一'); const target = await f.send('废弃问题二'); await f.send('废弃问题三');
    const before = f.service.snapshot(f.c.conversationId), original = f.app.store.originalMessages(f.c.conversationId), events = f.app.store.events(f.c.conversationId);
    const r = await f.edit(target.messageId, '修订问题二'); await f.app.wait(r.runId);
    assert.notEqual(r.runId, target.runId);
    const full = f.service.snapshot(f.c.conversationId);
    assert.deepEqual(full.messages.map(m => m.payload.content), ['保留问题一', '修订问题二']);
    assert.deepEqual(f.app.store.originalMessages(f.c.conversationId).slice(0, original.length), original);
    assert.deepEqual(f.app.store.events(f.c.conversationId).slice(0, events.length), events);
    const wire = f.model.requests.at(-1)!.body.messages as WireMessage[];
    assert(wire.some(m => m.content === '保留回复一')); assert(wire.some(m => m.content === '修订问题二'));
    assert(!wire.some(m => /废弃/.test(m.content))); validatePairs(wire);
    assert.equal(f.app.store.searchMessages(f.c.conversationId, { query: '废弃', role: 'all', limit: 20 }).total, 0);
    assert.equal(f.app.store.messageById(f.c.conversationId, target.messageId), undefined);
    const html = renderToStaticMarkup(createElement(Timeline, { snapshot: full, onPreview() {}, onError() {} }));
    assert(html.includes('保留回复一')); assert(html.includes('修订后的回复')); assert(!html.includes('废弃回复'));
    assert(!JSON.stringify(projectHistoryPreview(full)).includes('废弃'));
    // 特意按单事件重连，跨 input.accepted / input.revised 分页边界也必须收敛。
    let live = before;
    for (const event of f.app.store.events(f.c.conversationId, before.state.cursor)) {
      const row = event.type === 'input.accepted' ? f.app.store.messageById(f.c.conversationId, event.payload.messageId) : undefined;
      live = applyBatch(live, { events: [event], messages: row ? [{ ...row, attachments: f.app.store.messageAttachments(f.c.conversationId, row.id) }] : [] });
    }
    assert.deepEqual(live.messages, full.messages); assert.deepEqual(live.state, full.state);
    assert.deepEqual(events.reduce(reduceConversation, initialState(f.c.conversationId, before.state.cursor.logEpoch)), before.state);
    await f.reopen(); assert.deepEqual(f.service.snapshot(f.c.conversationId).messages, full.messages);
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId), full.state);
    assert.throws(() => f.app.resume(f.c.conversationId, target.runId), /退出当前对话/);
  } finally { await f.close(); }
});

test('消息修订：文件与备份继续存在，模型可分页核验修订前执行，不重跑写入', async () => {
  const f = fixture();
  try {
    f.steps.push(call('write_file', { mountId: f.mount.id, path: 'kept.txt', content: '已经发生的效果' }), text('原任务完成'), text('只调整说明'));
    const old = await f.send('创建文件，然后解释'); const oldTools = f.app.store.tools(old.runId);
    const changes = f.app.files.repo.direct.changes(f.c.conversationId);
    const r = await f.edit(old.messageId, '只说明当前文件，不再次创建'); await f.app.wait(r.runId);
    assert.equal(readFileSync(join(f.workspace, 'kept.txt'), 'utf8'), '已经发生的效果');
    assert.deepEqual(f.app.files.repo.direct.changes(f.c.conversationId), changes);
    assert.equal(f.app.store.tools(r.runId).length, 0); assert.deepEqual(f.app.store.tools(old.runId), oldTools);
    const facts = projectedFacts(f.model.requests.at(-1)!.body.messages as WireMessage[]);
    assert.equal(facts['runtime.conversationRevision'].priorExecutions.total, 1);
    assert.equal(f.app.store.revisionExecutions(f.c.conversationId, 0, 1).entries[0]!.name, 'write_file');
    const tool = f.app.registry.get('list_revision_executions');
    const result = await tool.execute({ offset: 0, limit: 1 }, {} as any, f.c.conversationId, new AbortController().signal);
    assert.equal((result.data as any).entries[0].executionId, oldTools[0]!.id);
  } finally { await f.close(); }
});

test('消息修订：旧任务笔记/要求和 carry 退出上下文，原资料仍留存', async () => {
  const f = fixture();
  try {
    f.steps.push(request => {
      const source = projectedFacts(request.body.messages as WireMessage[])['memory.requirements'][0];
      return call('record_work_note', { category: 'inference', text: 'OLD-NOTE-MARKER', sources: [{ kind: 'message', messageId: source.messageId, startByte: 0, endByte: Buffer.byteLength('旧任务') }] });
    }, text('已记录旧笔记'), text('按新要求继续'));
    const old = await f.send('旧任务'); assert.equal(f.app.store.contextMemory(f.c.conversationId).entries.length, 1);
    const r = await f.edit(old.messageId, '新任务'); await f.app.wait(r.runId);
    assert.equal(f.app.store.contextMemory(f.c.conversationId).entries.length, 0);
    const saved = f.app.store.all('SELECT * FROM memory_entries');
    assert.equal(saved.length, 1);
    assert.throws(() => f.app.store.accessibleArtifact(f.c.conversationId, String(saved[0]!.artifact_ref)), /退出当前对话/);
    assert(f.app.store.readArtifact(String(saved[0]!.artifact_ref)));
    const wire = f.model.requests.at(-1)!.body.messages as WireMessage[];
    assert(!JSON.stringify(wire).includes('OLD-NOTE-MARKER')); assert(!wire.some(m => m.content === '旧任务'));
    assert.equal(f.app.store.snapshot(f.c.conversationId).memory.window.version, 2);
  } finally { await f.close(); }
});

test('消息修订：保留原附件字节并生成新归属，Agent 附件目录不返回废弃消息附件', async () => {
  const f = fixture([text('旧附件回复'), text('新附件回复')]);
  try {
    const a = f.app.store.uploadAttachment(f.c.conversationId, 'ref.txt', 'text/plain', '不可变附件正文');
    const old = await f.send('读取资料', [a.id]);
    const r = await f.edit(old.messageId, '解释这份资料'); await f.app.wait(r.runId);
    const attached = f.app.store.messageAttachments(f.c.conversationId, r.messageId);
    assert.equal(attached.length, 1); assert.notEqual(attached[0]!.id, a.id);
    assert.equal(f.app.store.attachment(f.c.conversationId, attached[0]!.id).artifact_ref, f.app.store.attachment(f.c.conversationId, a.id).artifact_ref);
    assert.throws(() => f.app.store.sentAttachment(f.c.conversationId, a.id), /尚未/);
    assert.equal(f.app.store.sentAttachment(f.c.conversationId, attached[0]!.id).messageId, r.messageId);
    assert.equal((f.app.store.listAttachments(f.c.conversationId, {}) as any).total, 1);
  } finally { await f.close(); }
});

test('消息修订：运行中先停止结算，迟到响应不混入新任务', async () => {
  const f = fixture([text('迟到旧答复'), text('新答复')]); let once = true;
  f.model.beforeResponse = async () => { if (once) { once = false; await delay(60); } };
  try {
    const old = f.app.send(f.c.conversationId, uid(), '运行中的旧问题');
    await eventually(() => f.model.requests.length ? true : undefined);
    const r = await f.edit(old.messageId, '改成新问题'); await f.app.wait(r.runId);
    assert.equal(f.app.store.getRun(old.runId).status, 'stopped'); assert.equal(f.app.store.getRun(r.runId).status, 'completed');
    assert.equal(f.app.store.environment(f.c.environmentId).active_run_id, null);
    assert(!renderToStaticMarkup(createElement(Timeline, { snapshot: f.service.snapshot(f.c.conversationId), onPreview() {}, onError() {} })).includes('迟到旧答复'));
  } finally { await f.close(); }
});

test('消息修订：并发、重复回执和不同内容复用 ID 不创建重复任务', async () => {
  const f = fixture([text('旧回复'), text('唯一修订回复')]);
  try {
    const old = await f.send('旧问题'), id = uid();
    const outcomes = await Promise.allSettled([
      f.app.editMessage(f.c.conversationId, id, old.messageId, old.messageId, '修订甲'),
      f.app.editMessage(f.c.conversationId, uid(), old.messageId, old.messageId, '修订乙'),
    ]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const r = (outcomes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.edit>>>).value;
    await f.app.wait(r.runId); const requests = f.model.requests.length;
    assert.deepEqual(await f.app.editMessage(f.c.conversationId, id, old.messageId, old.messageId, '修订甲'), r);
    await assert.rejects(f.app.editMessage(f.c.conversationId, id, old.messageId, old.messageId, '不同内容'), /相同命令/);
    assert.equal(f.model.requests.length, requests); assert.equal(f.app.store.all('SELECT * FROM message_revisions').length, 1);
  } finally { await f.close(); }
});

test('消息修订：真实任务命令许可不跨修订复用，已执行命令效果保留', { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    f.app.store.updateSettings(f.c.conversationId, { ...f.app.store.settings(f.c.conversationId), executionPolicy: 'auto' });
    writeFileSync(join(f.workspace, 'probe.cjs'), "require('node:fs').appendFileSync('effects.txt','A')");
    const args = { program: process.execPath, argv: ['--test', 'probe.cjs'], cwd: { kind: 'mount', mountId: f.mount.id }, timeoutMs: 15000 };
    f.steps.push(call('run_command', args), text('首次结束'), call('run_command', args), text('尊重拒绝'));
    const old = f.app.send(f.c.conversationId, uid(), '运行测试');
    const pending = () => eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending'), 12000);
    const first = await pending(); f.app.approve(f.c.conversationId, first[0], 'allow', 'task'); await f.app.wait(old.runId);
    assert.equal(readFileSync(join(f.workspace, 'effects.txt'), 'utf8'), 'A');
    const r = await f.edit(old.messageId, '换一种方式测试'); const second = await pending();
    assert.notEqual(second[0], first[0]); assert(!second[1].sourceApprovalId);
    assert.throws(() => f.app.approve(f.c.conversationId, first[0], 'allow', 'task'), /退出当前对话/);
    f.app.approve(f.c.conversationId, second[0], 'deny'); await f.app.wait(r.runId);
    assert.equal(readFileSync(join(f.workspace, 'effects.txt'), 'utf8'), 'A');
  } finally { await f.close(); }
});

test('消息修订：未知效果阻止提交，不隐藏原执行或假称撤销文件', async () => {
  const f = fixture();
  try {
    f.steps.push(call('write_file', { mountId: f.mount.id, path: 'unknown.txt', content: '真实效果' }), text('旧任务结束'));
    const old = await f.send('创建文件'), tool = f.app.store.tools(old.runId)[0]!;
    // 故障注入：模拟外部效果已发生而终态回执丢失的宿主状态。
    f.app.store.run("UPDATE tool_executions SET state='unknown',result_ref=NULL WHERE id=?", tool.id);
    const before = f.app.store.events(f.c.conversationId);
    await assert.rejects(f.edit(old.messageId, '新要求'), /未结算效果/);
    assert.deepEqual(f.app.store.events(f.c.conversationId), before);
    assert.equal(f.app.store.userMessages(f.c.conversationId)[0]!.id, old.messageId);
    assert.equal(readFileSync(join(f.workspace, 'unknown.txt'), 'utf8'), '真实效果');
  } finally { await f.close(); }
});

test('消息修订：排队输入跨越工具组时整体退出现有配对，未派发批准被取消', async () => {
  const f = fixture();
  try {
    const args = { program: process.execPath, argv: ['-e', '0'], cwd: { kind: 'mount', mountId: f.mount.id } };
    f.steps.push(call('run_command', args), text('按更正继续'));
    const old = f.app.send(f.c.conversationId, uid(), '原问题');
    const approval = await eventually(() => Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending'));
    const queued = f.app.store.acceptInput(f.c.conversationId, uid(), '尚未应用的要求');
    const r = await f.edit(queued.messageId, '更正排队要求'); await f.app.wait(r.runId);
    validatePairs(f.app.store.messages(f.c.conversationId).filter(m => m.applied).map(m => m.payload));
    assert.equal(f.app.store.tool(f.app.store.approval(approval[0]).execution_id).state, 'cancelled');
    assert.equal(f.app.store.tools(r.runId).length, 0); assert.equal(f.app.store.getRun(old.runId).status, 'stopped');
    assert(!existsSync(join(f.workspace, 'effects.txt')));
  } finally { await f.close(); }
});

test('消息修订：DB12升级不重写旧事实；整组删除清除修订索引并保留源文件', async () => {
  const f = fixture([text('旧答复'), text('新答复')]);
  try {
    writeFileSync(join(f.workspace, 'keep.txt'), '保留源文件');
    const old = await f.send('旧问题'), events = f.app.store.events(f.c.conversationId);
    const fingerprints = f.app.store.all('SELECT * FROM schema_migrations WHERE version<=12');
    f.app.store.db.exec('DROP TABLE message_revisions; DELETE FROM schema_migrations WHERE version=13');
    await f.reopen(); assert.equal(f.app.store.databaseVersion, 13);
    assert.deepEqual(f.app.store.events(f.c.conversationId), events);
    assert.deepEqual(f.app.store.all('SELECT * FROM schema_migrations WHERE version<=12'), fingerprints);
    const r = await f.edit(old.messageId, '新问题'); await f.app.wait(r.runId);
    await f.service.handle({ type: 'archive', conversationId: f.c.conversationId });
    await f.service.handle({ type: 'delete_conversation', conversationId: f.c.conversationId, confirm: true });
    assert.equal(f.app.store.all('SELECT * FROM message_revisions').length, 0);
    assert.equal(readFileSync(join(f.workspace, 'keep.txt'), 'utf8'), '保留源文件');
  } finally { await f.close(); }
});

test('消息修订：已实际压缩的摘要和清单失效，原摘要保留为内部审计资料', async () => {
  const f = contextFixture();
  try {
    const model = new ScriptModel([request => {
      const input = JSON.parse((request.body.messages as WireMessage[])[1]!.content);
      return text(JSON.stringify({ items: [{ kind: 'decision', text: 'OLD-SUMMARY-MARKER', sourceIds: [input.sources[0].sourceId] }] }));
    }]);
    await f.manager.prepareTurn(f.app.store, model, f.runId, f.generation, [], f.facts, new AbortController().signal);
    const before = f.app.store.contextMemory(f.c.conversationId);
    assert(before.summary); assert(before.archivedIds.length > 0);
    const target = f.app.store.userMessages(f.c.conversationId)[0]!;
    await f.app.stop(f.c.conversationId, f.runId);
    const r = f.app.store.acceptInput(f.c.conversationId, uid(), '更正后的新要求', [], { targetMessageId: target.id, expectedLastMessageId: target.id });
    f.app.store.applyInputs(r.runId);
    const after = f.app.store.contextMemory(f.c.conversationId);
    assert.equal(after.summary, null); assert.equal(after.window.manifestRef, null); assert.deepEqual(after.archivedIds, []);
    assert.equal(after.window.version, before.window.version + 1); assert.equal(f.app.store.contextCarry(f.c.conversationId), null);
    assert(f.app.store.readArtifact(before.window.summaryRef!));
    assert.throws(() => f.app.store.accessibleArtifact(f.c.conversationId, before.window.summaryRef!), /退出当前对话/);
  } finally { await f.close(); }
});

test('消息修订：已退出上下文的文件读取不再充当当前已见证据，新读取正常建立依据', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'source.txt'), '真实当前字节');
    const args = { mountId: f.mount.id, path: 'source.txt' };
    f.steps.push(call('read_file', args), text('旧读取完成'), call('read_file', args), text('新读取完成'));
    const old = await f.send('读取原文件'), evidence = f.app.store.tools(old.runId)[0]!;
    assert(f.app.store.modelReceivedToolResult(evidence.id));
    const r = await f.edit(old.messageId, '重新观察当前文件'); await f.app.wait(r.runId);
    assert.equal(f.app.store.modelReceivedToolResult(evidence.id), false);
    assert(f.app.store.modelReceivedToolResult(f.app.store.tools(r.runId)[0]!.id));
    assert.equal(readFileSync(join(f.workspace, 'source.txt'), 'utf8'), '真实当前字节');
  } finally { await f.close(); }
});

test('消息修订：真实发送的排队更正不会在停止后抢先恢复旧 run', async () => {
  const f = fixture([text('旧流式答复'), text('更正后的答复')]); let first = true;
  f.model.beforeResponse = async () => { if (first) { first = false; await delay(80); } };
  try {
    const old = f.app.send(f.c.conversationId, uid(), '第一条问题');
    await eventually(() => f.model.requests.length ? true : undefined);
    const queued = f.app.send(f.c.conversationId, uid(), '排队的新要求');
    assert.equal(queued.runId, old.runId);
    const r = await f.edit(queued.messageId, '修改排队的新要求'); await f.app.wait(r.runId);
    assert.equal(f.app.store.getRun(old.runId).status, 'stopped');
    assert.equal(f.app.store.getRun(r.runId).status, 'completed');
    assert.equal(f.model.requests.length, 2);
    assert.deepEqual(f.app.store.userMessages(f.c.conversationId).map(m => m.payload.content), ['第一条问题', '修改排队的新要求']);
  } finally { await f.close(); }
});
test('消息修订：连续再次编辑当前修订版本，前缀保留且旧版本不返回', async () => {
  const f = fixture([text('前缀答复'), text('原答复'), text('第一次修订答复'), text('第二次修订答复')]);
  try {
    await f.send('前缀问题'); const old = await f.send('原问题');
    const first = await f.edit(old.messageId, '第一次修改'); await f.app.wait(first.runId);
    const second = await f.edit(first.messageId, '第二次修改'); await f.app.wait(second.runId);
    await f.reopen();
    assert.deepEqual(f.app.store.userMessages(f.c.conversationId).map(m => m.payload.content), ['前缀问题', '第二次修改']);
    const wire = f.model.requests.at(-1)!.body.messages as WireMessage[];
    assert(wire.some(m => m.content === '前缀答复')); assert(!wire.some(m => /第一次|原问题|原答复/.test(m.content)));
    assert.equal(f.app.store.all('SELECT * FROM message_revisions').length, 2);
  } finally { await f.close(); }
});
