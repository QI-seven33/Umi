import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { activityLabel } from '../apps/desktop/renderer/src/activity.js';
import { deliveredTarget, verifiedDocumentPath } from '../packages/adapters/src/host-files/delivered-open.js';
import { UmiError, validatePairs } from '../packages/protocol/src/model.js';
import { reduceConversation, initialState } from '../packages/protocol/src/reducer.js';
import { uid } from '../packages/agent/src/identity.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import type { DocumentTarget } from '../packages/protocol/src/native-open.js';

const data = (r: PreparedRequest) => JSON.parse((r.body.messages as any[]).filter(m => m.role === 'tool').at(-1)!.content).data;
function setup(openError?: string) {
  const root = mkdtempSync(join(tmpdir(), 'umi-cross-run-')), workspace = join(root, 'workspace'), external = join(root, 'external');
  mkdirSync(workspace); mkdirSync(external); writeFileSync(join(external, 'report.html'), '<p>OLD</p>');
  const steps: Step[] = [], model = new ScriptModel(steps), opened: DocumentTarget[] = [];
  let openAttempts = 0;
  const app = new UmiApplication(join(root, 'data'), model, { limits: { maxTurns: 24, maxRetries: 2, modelTimeoutMs: 1000, retryDelayMs: 1 },
    openDocument: async target => { openAttempts++; if (openError) throw new UmiError(openError, '模拟系统打开结果'); verifiedDocumentPath(target); opened.push(target); } });
  const c = app.createConversation(workspace);
  let mountId = '', candidateId = '', csId = '';
  const pending = (name: string, except?: string) => eventually(() => {
    const s = app.store.snapshot(c.conversationId);
    return Object.entries(s.approvals).find(([id, a]) => id !== except && a.status === 'pending' && s.tools[a.callId]?.name === name)?.[0];
  });
  const approve = async (name: string) => app.approve(c.conversationId, await pending(name), 'allow');
  return { root, workspace, external, source: join(external, 'report.html'), app, c, model, steps, opened, pending, approve,
    get mountId() { return mountId; }, get candidateId() { return candidateId; }, get csId() { return csId; }, get openAttempts() { return openAttempts; },
    async deliver() {
      steps.push(call('discover_resource', { path: join(external, 'report.html') }), r => {
        candidateId = data(r).candidates[0].id;
        return call('request_resource', { candidateId, access: 'edit', purpose: '跨轮打开验收' });
      }, r => { mountId = data(r).mountId; return call('read_file', { mountId, path: 'report.html' }); }, r => {
        const d = data(r); return call('edit_file', { mountId, path: 'report.html', readExecutionId: d.readExecutionId,
          expectedReadHash: d.hash, oldText: 'OLD', newText: 'NEW' });
      }, () => call('build_changeset', { mountId }), r => {
        csId = data(r).changeSetId; return call('deliver_changeset', { changeSetId: csId });
      }, text('已交付'));
      const run = app.send(c.conversationId, uid(), '修改并交付');
      await approve('request_resource'); await approve('deliver_changeset'); await app.wait(run.runId);
      assert.equal(app.store.getRun(run.runId).status, 'completed');
      assert.equal(app.files.repo.authorized(candidateId, c.environmentId), false);
      assert.equal(readFileSync(join(external, 'report.html'), 'utf8'), '<p>NEW</p>');
    },
    openSteps() { steps.push(call('open_delivered_file', { changeSetId: csId, path: 'report.html' }), text('已请求打开')); },
    async close() { await app.close(); removeTestRoot(root); } };
}
function html(f: ReturnType<typeof setup>) {
  return renderToStaticMarkup(createElement(Timeline, { snapshot: new DesktopService(f.app).snapshot(f.c.conversationId), onPreview: () => {}, onError: () => {} }));
}

test('跨轮打开：旧临时权限失效后仅批准打开，不新建副本、不重新写回', async () => {
  const f = setup();
  try {
    await f.deliver(); const oldHash = readFileSync(f.source);
    f.openSteps(); const run = f.app.send(f.c.conversationId, uid(), '打开它');
    const approval = await f.pending('open_delivered_file'); assert.equal(f.opened.length, 0);
    assert.equal(f.app.files.repo.authorized(f.candidateId, f.c.environmentId), false);
    f.app.approve(f.c.conversationId, approval, 'allow'); await f.app.wait(run.runId);
    assert.equal(f.opened.length, 1); assert.equal(f.app.store.getRun(run.runId).status, 'completed');
    assert.deepEqual(readFileSync(f.source), oldHash);
    assert.deepEqual(f.app.store.tools(run.runId).map(t => t.name), ['open_delivered_file']);
    const context = f.app.store.readArtifact<any>(f.app.store.tools(run.runId)[0]!.context_ref!);
    assert.equal(context.locations[0].physicalRoot, f.external);
    assert.equal(f.app.files.repo.authorized(f.candidateId, f.c.environmentId), false);
    const service = new DesktopService(f.app);
    const target = await service.handle({ type: 'open_delivered', conversationId: f.c.conversationId, changeSetId: f.csId, path: 'report.html' });
    assert.equal((target as DocumentTarget).hash, f.opened[0]!.hash);
  } finally { await f.close(); }
});

test('跨轮打开：重启和重新发现得到的新资源不必接回旧挂载', async () => {
  const f = setup();
  try {
    await f.deliver(); await f.app.close();
    const steps: Step[] = [call('discover_resource', { path: f.source }), r => {
      assert.notEqual(data(r).candidates[0].id, f.candidateId);
      return call('open_delivered_file', { changeSetId: f.csId, path: 'report.html' });
    }, text('已请求打开')];
    const opened: DocumentTarget[] = [], app = new UmiApplication(join(f.root, 'data'), new ScriptModel(steps), {
      openDocument: async target => { verifiedDocumentPath(target); opened.push(target); } });
    try {
      const run = app.send(f.c.conversationId, uid(), '继续打开');
      const id = await eventually(() => Object.entries(app.store.snapshot(f.c.conversationId).approvals).find(([, a]) => a.status === 'pending')?.[0]);
      app.approve(f.c.conversationId, id, 'allow'); await app.wait(run.runId);
      assert.equal(opened.length, 1); assert.equal(app.files.repo.authorized(f.candidateId, f.c.environmentId), false);
    } finally { await app.close(); }
  } finally { await f.close(); }
});

test('跨轮打开：批准前内容变化仍需版本核验，失败不转为未知、不重新交付', async () => {
  const f = setup();
  try {
    await f.deliver(); writeFileSync(f.source, '<p>EXTERNAL</p>'); f.openSteps();
    const run = f.app.send(f.c.conversationId, uid(), '打开'); await f.approve('open_delivered_file'); await f.app.wait(run.runId);
    const t = f.app.store.tools(run.runId)[0]!;
    assert.equal(t.state, 'failed'); assert.equal(f.opened.length, 0);
    assert.equal(f.app.store.readArtifact<any>(t.result_ref!).data.code, 'RESOURCE_CHANGED');
    assert.equal(f.app.store.unresolvedEnvironment(f.c.environmentId).length, 0);
    assert.equal(readFileSync(f.source, 'utf8'), '<p>EXTERNAL</p>');
  } finally { await f.close(); }
});

test('跨轮打开：等待中同字节替换文件必须重新批准当前对象', async () => {
  const f = setup();
  try {
    await f.deliver(); f.openSteps(); const run = f.app.send(f.c.conversationId, uid(), '打开');
    const old = await f.pending('open_delivered_file');
    const replacement = join(f.external, 'replacement.html'); writeFileSync(replacement, readFileSync(f.source)); renameSync(replacement, f.source);
    const fresh = await f.pending('open_delivered_file', old);
    assert.equal(f.app.store.snapshot(f.c.conversationId).approvals[old]!.status, 'invalidated');
    assert.equal(f.opened.length, 0); f.app.approve(f.c.conversationId, fresh, 'allow'); await f.app.wait(run.runId);
    assert.equal(f.opened.length, 1);
  } finally { await f.close(); }
});

test('跨轮打开：跨会话、未交付、根替换和硬链接不能冒充原对象', async () => {
  const f = setup();
  try {
    await f.deliver(); const other = f.app.createConversation(f.workspace);
    assert.throws(() => deliveredTarget(f.app.files, other.conversationId, f.csId, 'report.html'), /不属于|不存在/);
    assert.throws(() => deliveredTarget(f.app.files, f.c.conversationId, f.csId, 'neighbor.html'));
    linkSync(f.source, join(f.external, 'hardlink.html'));
    assert.throws(() => deliveredTarget(f.app.files, f.c.conversationId, f.csId, 'report.html'), /链接/);
    renameSync(f.external, f.external + '-old'); mkdirSync(f.external); writeFileSync(f.source, '<p>NEW</p>');
    assert.throws(() => deliveredTarget(f.app.files, f.c.conversationId, f.csId, 'report.html'), /目录身份/);
  } finally { await f.close(); }
});

test('跨轮打开：用户拒绝不发系统请求，系统明确拒绝保持已知失败', async () => {
  for (const mode of ['deny', 'OPEN_REJECTED']) {
    const f = setup(mode === 'deny' ? undefined : mode);
    try {
      await f.deliver(); f.openSteps(); const run = f.app.send(f.c.conversationId, uid(), '打开');
      f.app.approve(f.c.conversationId, await f.pending('open_delivered_file'), mode === 'deny' ? 'deny' : 'allow'); await f.app.wait(run.runId);
      assert.equal(f.opened.length, 0); assert.equal(f.app.store.tools(run.runId)[0]!.state, mode === 'deny' ? 'denied' : 'failed');
      assert.equal(f.app.store.unresolvedEnvironment(f.c.environmentId).length, 0);
    } finally { await f.close(); }
  }
});

test('跨轮打开：回执丢失保持未知，新消息和恢复不会自动重放打开', async () => {
  const f = setup('OPEN_UNKNOWN');
  try {
    await f.deliver(); f.openSteps(); const run = f.app.send(f.c.conversationId, uid(), '打开'); await f.approve('open_delivered_file'); await f.app.wait(run.runId);
    assert.equal(f.app.store.getRun(run.runId).status, 'recovery_required'); assert.equal(f.app.store.tools(run.runId)[0]!.state, 'unknown');
    f.steps.length = 0; f.steps.push(text('原打开回执未知，先保留结果等待核验'));
    assert.equal(f.openAttempts, 1);
    const next = f.app.send(f.c.conversationId, uid(), '解释状态，先不打开'); await f.app.wait(next.runId);
    assert.equal(f.openAttempts, 1);
    assert.equal(f.app.store.tools(next.runId).filter(t => t.name === 'open_delivered_file').length, 1);
    assert.equal(f.app.store.unresolvedEnvironment(f.c.environmentId).length, 1);
  } finally { await f.close(); }
});

function repeatMissing(f: ReturnType<typeof setup>) {
  const mount = f.app.files.repo.mounts(f.c.environmentId)[0]!;
  for (let i = 0; i < 4; i++) f.steps.push(call('read_file', { mountId: mount.id, path: 'missing.txt' }, '', `repeat-${i}`));
}

test('停滞收尾：只多请求一次无工具总结，状态仍failed/blocked，正文和重放完整', async () => {
  const f = setup();
  try {
    repeatMissing(f); f.steps.push(r => { assert.deepEqual(r.body.tools, []); validatePairs(r.body.messages as any);
      assert(JSON.stringify(r.body).includes('不得声称任务已完成')); return text('文件没有找到，读取仍未完成；本轮已停止重复请求。'); });
    const run = f.app.send(f.c.conversationId, uid(), '读取文件'); await f.app.wait(run.runId);
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.equal(f.model.requests.length, 5); assert.equal(f.app.store.getRun(run.runId).status, 'failed');
    assert.equal(state.runs[run.runId]!.acceptance!.status, 'blocked');
    assert.equal(f.app.store.tools(run.runId).length, 4);
    assert(html(f).includes('文件没有找到')); assert(html(f).includes('执行受阻')); assert(!html(f).includes('存在未完成的操作'));
    assert.equal(state.blocks.filter(b => b.runId === run.runId && b.kind === 'text' && b.displayRole === 'final').at(-1)!.text, '文件没有找到，读取仍未完成；本轮已停止重复请求。');
    const replay = f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch));
    assert.deepEqual(replay, state);
  } finally { await f.close(); }
});

test('停滞收尾：模型错误、空正文、违规工具均用持久本地正文，不再请求或执行', async () => {
  for (const mode of ['error', 'empty', 'tool']) {
    const f = setup();
    try {
      repeatMissing(f); f.steps.push(() => { if (mode === 'error') throw new UmiError('PROVIDER_QUOTA', '模拟额度不足');
        return mode === 'empty' ? text('') : call('discover_resource', { path: f.source }); });
      const run = f.app.send(f.c.conversationId, uid(), '读取文件'); await f.app.wait(run.runId);
      const state = f.app.store.snapshot(f.c.conversationId), summary = state.runs[run.runId]!.failureSummary!;
      assert.equal(f.model.requests.length, 5); assert.equal(f.app.store.tools(run.runId).length, 4);
      assert(summary.text.includes('这一步仍未完成')); assert(html(f).includes('这一步仍未完成'));
      const m = f.app.store.messageById(f.c.conversationId, summary.messageId)!;
      assert.equal(m.payload.content, summary.text); assert.equal(m.modelTurnId, null);
      assert.equal(f.app.store.getRun(run.runId).status, 'failed');
      validatePairs(f.app.store.messages(f.c.conversationId).map(m => m.payload));
      assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)), state);
    } finally { await f.close(); }
  }
});

test('停滞收尾：同批剩余工具被取消，模型总结期间新原话优先', async () => {
  const f = setup();
  try {
    const mount = f.app.files.repo.mounts(f.c.environmentId)[0]!;
    for (let i = 0; i < 3; i++) f.steps.push(call('read_file', { mountId: mount.id, path: 'missing.txt' }));
    const fourth = call('read_file', { mountId: mount.id, path: 'missing.txt' });
    fourth.tool_calls!.push(...call('discover_resource', { path: f.source }, '', 'never-dispatched').tool_calls!);
    f.steps.push(fourth, text('旧总结'), text('按新要求解释工具'));
    let next: ReturnType<UmiApplication['send']> | undefined;
    f.model.beforeResponse = async r => { if ((r.body.tools as any[]).length === 0) {
      f.model.beforeResponse = undefined; next = f.app.send(f.c.conversationId, uid(), '改为解释工具');
    } };
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    await eventually(() => next); await f.app.wait(next!.runId);
    const tools = f.app.store.tools(run.runId);
    assert.equal(tools.find(t => t.name === 'discover_resource')!.state, 'cancelled');
    assert.equal(f.app.store.getRun(next!.runId).status, 'completed'); assert(html(f).includes('按新要求解释工具'));
    assert.equal(f.model.requests.length, 6);
  } finally { await f.close(); }
});

test('停滞收尾：已开始请求后退出，恢复只生成本地说明，不重复模型请求', async () => {
  const f = setup();
  try {
    repeatMissing(f); f.steps.push(text('尚未提交的总结'));
    f.model.beforeResponse = async r => { if ((r.body.tools as any[]).length === 0) f.app.requestStop(f.c.conversationId,
      f.app.store.environment(f.c.environmentId).active_run_id!); };
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    assert.equal(f.app.store.getRun(run.runId).status, 'stopped'); await f.app.close();
    const model = new ScriptModel([]), app = new UmiApplication(join(f.root, 'data'), model);
    try {
      app.resume(f.c.conversationId, run.runId); await app.wait(run.runId);
      assert.equal(model.requests.length, 0); assert.equal(app.store.getRun(run.runId).status, 'failed');
      assert(app.store.snapshot(f.c.conversationId).runs[run.runId]!.failureSummary);
    } finally { await app.close(); }
  } finally { await f.close(); }
});

test('活动摘要：失败、拒绝、取消与未知分开，未知不会被成功摘要挤掉', async () => {
  const f = setup();
  try {
    repeatMissing(f); const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    const state = f.app.store.snapshot(f.c.conversationId), [id, tool] = Object.entries(state.tools)[0]!;
    for (const [status, label] of [['failed', '操作失败'], ['denied', '操作已拒绝'], ['cancelled', '操作已取消'], ['unknown', '结果待核验']] as const) {
      const changed = { ...state, tools: { ...state.tools, [id]: { ...tool, status } } };
      assert.equal(activityLabel([{ kind: 'tool', id, sequence: tool.sequence }], changed), label);
    }
  } finally { await f.close(); }
});

test('停滞收尾：本地说明提交后收到新要求，旧说明不能遮住新答复', async () => {
  const f = setup();
  try {
    repeatMissing(f); f.steps.push(() => { throw new UmiError('PROVIDER_QUOTA', '模拟收尾失败'); }, text('新要求的完整答复'));
    const complete = f.app.tasks.complete.bind(f.app.tasks);
    let next: ReturnType<UmiApplication['send']> | undefined;
    f.app.tasks.complete = (...args) => {
      if (args[4] && !next) next = f.app.send(f.c.conversationId, uid(), '改为解释架构');
      return complete(...args);
    };
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    await eventually(() => next); await f.app.wait(next!.runId);
    assert.equal(f.app.store.getRun(next!.runId).status, 'completed');
    assert(html(f).includes('新要求的完整答复')); assert(!html(f).includes('这一步仍未完成'));
  } finally { await f.close(); }
});

test('停滞收尾：完整模型正文已保存而终态事务失败，恢复复用正文不重新请求', async () => {
  const f = setup();
  try {
    repeatMissing(f); f.steps.push(text('文件仍未找到，受阻结果已说明'));
    const complete = f.app.tasks.complete.bind(f.app.tasks);
    let failed = false;
    f.app.tasks.complete = (...args) => {
      if (args[4] && !failed) { failed = true; throw new UmiError('PERSISTENCE_FAILED', '模拟终态事务失败'); }
      return complete(...args);
    };
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    assert.equal(f.app.store.getRun(run.runId).status, 'interrupted');
    const count = f.model.requests.length;
    f.app.resume(f.c.conversationId, run.runId); await f.app.wait(run.runId);
    assert.equal(f.model.requests.length, count); assert.equal(f.app.store.getRun(run.runId).status, 'failed');
    assert(html(f).includes('文件仍未找到，受阻结果已说明'));
  } finally { await f.close(); }
});

test('停滞收尾：编码后超预算直接保存本地说明，不发额外模型请求', async () => {
  const f = setup();
  try {
    repeatMissing(f);
    const prepare = f.model.prepare.bind(f.model);
    f.model.prepare = (...args) => {
      const request = prepare(...args);
      if (!args[1].length) request.body = { ...request.body, oversized: '正文'.repeat(600000) };
      return request;
    };
    const run = f.app.send(f.c.conversationId, uid(), '读取'); await f.app.wait(run.runId);
    assert.equal(f.model.requests.length, 4);
    assert(f.app.store.snapshot(f.c.conversationId).runs[run.runId]!.failureSummary);
    assert.equal(f.app.store.getRun(run.runId).status, 'failed');
  } finally { await f.close(); }
});
