import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { NativeOpenClient } from '../apps/desktop/native-open-client.js';
import { verifiedDocumentPath } from '../packages/adapters/src/host-files/document-open.js';
import { fileDiff } from '../packages/adapters/src/host-files/text-diff.js';

import { UmiError, validatePairs } from '../packages/protocol/src/model.js';
import type { WireMessage } from '../packages/protocol/src/model.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import type { DocumentTarget } from '../packages/protocol/src/native-open.js';
import { uid } from '../packages/agent/src/identity.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';

const question = { questions: [{ id: 'style', prompt: '报告采用哪种风格？', options: [{ label: '紧凑' }, { label: '宽松' }] }] };
function fixture(content = '原文', native = false, rejectOpen = false) {
  const root = mkdtempSync(join(tmpdir(), 'umi-stage-a-')), source = join(root, 'source');
  mkdirSync(source); writeFileSync(join(source, 'report.html'), content);
  const steps: Step[] = [], model = new ScriptModel(steps), opened: DocumentTarget[] = [];
  const app = new UmiApplication(join(root, 'data'), model, native ? {
    openDocument: async (target, signal) => { signal.throwIfAborted(); verifiedDocumentPath(target); if (rejectOpen) throw new UmiError('OPEN_REJECTED', '系统没有关联应用'); opened.push(target); },
  } : {});
  const conversation = app.createConversation(source), mount = app.files.repo.mounts(conversation.environmentId)[0]!;
  return { root, source, app, model, steps, opened, conversation, mount,
    async close() { await app.close(); removeTestRoot(root); } };
}
function toolData(request: PreparedRequest) {
  const messages = request.body.messages as WireMessage[];
  validatePairs(messages);
  return JSON.parse(messages.filter(m => m.role === 'tool').at(-1)!.content).data;
}
async function pendingQuestion(f: ReturnType<typeof fixture>) {
  return eventually(() => Object.entries(f.app.store.snapshot(f.conversation.conversationId).questions ?? {}).find(([, q]) => q.status === 'pending')?.[0]);
}
async function pendingApproval(f: ReturnType<typeof fixture>, name: string) {
  return eventually(() => {
    const state = f.app.store.snapshot(f.conversation.conversationId);
    return Object.entries(state.approvals).find(([, a]) => a.status === 'pending' && state.tools[a.callId]?.name === name)?.[0];
  });
}

test('阶段A：问答等待不请求模型，选项规范化、幂等且回答不创建批准', async () => {
  const f = fixture();
  try {
    f.steps.push(call('ask_user_question', question), request => {
      assert.deepEqual(toolData(request).answers, [{ questionId: 'style', optionIndex: 0, text: '紧凑' }]);
      return text('采用紧凑风格');
    });
    const run = f.app.send(f.conversation.conversationId, uid(), '设计报告');
    const id = await pendingQuestion(f);
    await delay(70); assert.equal(f.model.requests.length, 1);
    assert.equal(f.app.registry.get('ask_user_question').executionTimeoutMs?.({}), null);
    const answer = [{ questionId: 'style', optionIndex: 0, text: '伪造选项文字' }];
    f.app.questions.answer(f.conversation.conversationId, id, answer);
    f.app.questions.answer(f.conversation.conversationId, id, answer);
    assert.throws(() => f.app.questions.answer(f.conversation.conversationId, id, [{ questionId: 'style', optionIndex: 1, text: '' }]), /不再接收/);
    await f.app.wait(run.runId);
    assert.equal(f.app.store.getRun(run.runId).status, 'completed');
    assert.deepEqual(f.app.store.snapshot(f.conversation.conversationId).approvals, {});
  } finally { await f.close(); }
});

test('阶段A：自定义回答支持多问题，越界和跨会话拒绝', async () => {
  const f = fixture();
  try {
    const questions = [...question.questions, { ...question.questions[0]!, id: 'language', prompt: '使用什么语言？' }];
    f.steps.push(call('ask_user_question', { questions }), request => { assert.equal(toolData(request).answers[0].text, '我希望蓝色主题'); return text('已理解'); });
    const run = f.app.send(f.conversation.conversationId, uid(), '设计报告'), id = await pendingQuestion(f);
    assert.throws(() => f.app.questions.answer(f.conversation.conversationId, id, [{ questionId: 'style', optionIndex: 5, text: '' }]), /回答每个/);
    const other = f.app.createConversation(f.source);
    assert.throws(() => f.app.questions.answer(other.conversationId, id, [{ questionId: 'style', optionIndex: null, text: '蓝色' }]), /不属于/);
    f.app.questions.answer(f.conversation.conversationId, id, [
      { questionId: 'style', optionIndex: null, text: '我希望蓝色主题' },
      { questionId: 'language', optionIndex: 1, text: '' },
    ]);
    await f.app.wait(run.runId);
    assert.equal(f.app.store.snapshot(f.conversation.conversationId).questions?.[id]?.status, 'answered');
  } finally { await f.close(); }
});

test('阶段A：停止使待答问题即时失效，新消息先交模型，不重问旧问题', async () => {
  const f = fixture();
  try {
    f.steps.push(call('ask_user_question', question));
    const run = f.app.send(f.conversation.conversationId, uid(), '设计报告'), id = await pendingQuestion(f);
    f.app.requestStop(f.conversation.conversationId, run.runId);
    assert.equal(f.app.store.snapshot(f.conversation.conversationId).questions?.[id]?.status, 'cancelled');
    assert.throws(() => f.app.questions.answer(f.conversation.conversationId, id, [{ questionId: 'style', optionIndex: 0, text: '' }]), /不再接收/);
    await f.app.wait(run.runId);
    f.steps.push(request => { assert((request.body.messages as WireMessage[]).some(m => m.role === 'user' && m.content === '改为解释项目')); return text('解释项目'); });
    const next = f.app.send(f.conversation.conversationId, uid(), '改为解释项目'); await f.app.wait(next.runId);
    assert.equal(f.app.store.getRun(next.runId).status, 'completed');
    assert.equal(f.model.requests.length, 2);
    assert.equal(f.app.questions.inspect(f.conversation.conversationId, id).outcome, 'cancelled');
  } finally { await f.close(); }
});

test('阶段A：等待问答时新目标取消问题；已回答事实可重启核验而不重问', async () => {
  const f = fixture();
  try {
    f.steps.push(call('ask_user_question', question), text('按新要求解释'));
    const run = f.app.send(f.conversation.conversationId, uid(), '设计报告'), id = await pendingQuestion(f);
    const next = f.app.send(f.conversation.conversationId, uid(), '不用设计，解释工具');
    await f.app.wait(run.runId); await f.app.wait(next.runId);
    assert.equal(f.app.store.snapshot(f.conversation.conversationId).questions?.[id]?.status, 'cancelled');
    assert.equal(f.model.requests.length, 2);
    f.steps.push(call('ask_user_question', question, '', 'another-question'), text('采用回答'));
    const answered = f.app.send(f.conversation.conversationId, uid(), '新的报告'), answerId = await pendingQuestion(f);
    f.app.questions.answer(f.conversation.conversationId, answerId, [{ questionId: 'style', optionIndex: null, text: '中文' }]);
    await f.app.wait(answered.runId); await f.app.close();
    const restarted = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try { assert.equal(restarted.questions.inspect(f.conversation.conversationId, answerId).outcome, 'succeeded'); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('阶段A：冻结对照的大变化段完整呈现', () => {
  const before = Array.from({ length: 1000 }, (_, i) => `旧${i}`).join('\n');
  const after = Array.from({ length: 1000 }, (_, i) => `新${i}`).join('\n');
  const diff = fileDiff(before, after);
  assert(diff.includes('-旧999')); assert(diff.includes('+新999'));
});

test('阶段A：系统打开客户端一次派发、错实例忽略、停止不重放', async () => {
  const sent: any[] = [], client = new NativeOpenClient(message => sent.push(message), () => 'instance');
  const target = { root: 'C:/sample', rootIdentity: 'root', path: 'report.html', hash: 'a'.repeat(64), identity: 'file' };
  const controller = new AbortController(), waiting = client.open(target, controller.signal);
  const message = sent[0]; assert.equal(sent.length, 1);
  assert.equal(client.receive({ kind: 'open_document_result', instanceId: 'wrong', correlationId: message.correlationId }), false);
  client.receive({ kind: 'open_document_result', instanceId: 'instance', correlationId: message.correlationId }); await waiting;
  const stopped = new AbortController(), second = client.open(target, stopped.signal);
  stopped.abort(); await assert.rejects(second, /中断/); assert.equal(sent.length, 2);
  client.receive({ kind: 'open_document_result', instanceId: 'instance', correlationId: sent[1].correlationId }); assert.equal(sent.length, 2);
});
