import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSchema, type EventBody, type WorkEvent } from '../packages/protocol/src/events.js';
import { initialState, reduceConversation, type ConversationState } from '../packages/protocol/src/reducer.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

// 长正文、进程输出与恢复交错；旧快照冻结后仍能重放，防止共享引用破坏历史。
function trace() {
  const events: WorkEvent[] = [];
  const add = (type: EventBody['type'], payload: unknown, extra: Partial<WorkEvent> = {}) => {
    const sequence = String(events.length + 1);
    events.push(eventSchema.parse({ schemaVersion: 1, eventId: `event-${sequence}`, streamId: 'conversation',
      conversationId: 'conversation', workspaceId: 'workspace', logEpoch: 'epoch', sequence,
      occurredAt: '2026-10-22T00:00:00.000Z', producer: 'system', idempotencyKey: `key-${sequence}`,
      runId: 'run', modelTurnId: 'turn', modelAttemptId: 'attempt', callId: 'call', executionId: 'execution',
      type, payload, ...extra }));
  };
  add('run.created', { environmentId: 'environment' });
  add('run.started', { generation: 1 });
  add('model.request_prepared', { requestId: 'request', contextId: 'context' });
  add('model.attempt_started', { requestId: 'request' });
  add('model.block_started', { blockId: 'block', kind: 'text', displayRole: 'commentary' });
  add('model.delta', { blockId: 'block', kind: 'text', deltaIndex: 0, text: '完整正文'.repeat(16000) });
  add('model.repetition_observed', { periodBytes: 12, repetitions: 3, repeatedBytes: 36, observedBytes: 100 });
  add('model.block_completed', { blockId: 'block' });
  add('model.attempt_measured', { requestId: 'request', outcome: 'completed', elapsedMs: 10,
    firstFrameMs: 1, firstReasoningMs: null, firstTextMs: 1 });
  add('model.attempt_completed', { finishReason: 'tool_calls', responseRef: 'response' });
  add('message.committed', { messageId: 'message', hash: 'hash' });
  add('tool.prepared', { name: 'run_command', providerCallId: 'provider-call' });
  add('approval.requested', { approvalId: 'approval', requestHash: 'hash', name: 'run_command', description: '测试' });
  add('run.waiting', { approvalId: 'approval' });
  add('approval.decided', { approvalId: 'approval', decision: 'allow' });
  add('approval.invalidated', { approvalId: 'approval', reason: '测试失效投影' });
  add('run.resumed', {});
  add('tool.dispatch_intent', { contextRef: 'context' });
  add('tool.started', {});
  add('process.planned', { snapshotRef: 'snapshot' });
  add('process.owner_bound', { bridgePid: 100, bridgeBirth: 'bridge' });
  add('process.ready', { bridgePid: 100, bridgeBirth: 'bridge', childPid: 200, childBirth: 'child' });
  add('process.release_intent', {});
  add('process.started', {});
  for (let outputIndex = 0; outputIndex < 20; outputIndex++)
    add('process.output', { outputIndex, channel: 'stdout', artifactRef: `output-${outputIndex}`, byteLength: 100 });
  add('process.exited', { receiptRef: 'exit', exitCode: 0, reason: '退出', jobInactive: false });
  add('run.recovery_required', { reason: '待核验清理' });
  add('run.recovery_started', { generation: 2 });
  add('process.reconciled', { receiptRef: 'reconciled', jobInactive: true });
  add('tool.settled', { outcome: 'succeeded', resultRef: 'result', messageId: 'result-message' });
  add('tool.measured', { elapsedMs: 10, prepareMs: 1, approvalPollingMs: 1, executeMs: 8 });
  add('run.phase_changed', { phase: 'finalize' });
  add('run.completed', { messageId: 'message' });
  return events;
}

test('长会话投影：冻结的旧快照可安全重放输出、批准、恢复和最终答复', () => {
  let state = initialState('conversation', 'epoch');
  const history: { state: ConversationState; json: string }[] = [];
  for (const event of trace()) {
    history.push({ state: freeze(state), json: JSON.stringify(state) });
    state = reduceConversation(state, freeze(event));
  }
  for (const prior of history) assert.equal(JSON.stringify(prior.state), prior.json);
  assert.equal(state.blocks[0]!.text, '完整正文'.repeat(16000));
  assert.equal(state.blocks[0]!.displayRole, 'final');
  assert.equal(state.tools.call!.status, 'succeeded');
  assert.equal(state.commandExecutions.execution!.outputs.length, 20);
  assert.equal(state.commandExecutions.execution!.jobInactive, true);
  assert.equal(state.runs.run!.status, 'completed');
  assert.equal(state.approvals.approval!.status, 'invalidated');
});

test('长会话投影：错误归属和乱序输出拒绝后，旧快照仍完整且可继续', () => {
  let state = initialState('conversation', 'epoch');
  const events = trace();
  for (const event of events) {
    freeze(state);
    const before = JSON.stringify(state);
    if (event.type === 'process.output') {
      assert.throws(() => reduceConversation(state, { ...event, payload: { ...event.payload, outputIndex: 999 } }), /顺序/);
      assert.throws(() => reduceConversation(state, { ...event, executionId: 'foreign-execution' }), /归属/);
    }
    if (event.type === 'model.block_completed')
      assert.throws(() => reduceConversation(state, { ...event, modelAttemptId: 'foreign-attempt' }), /归属/);
    if (event.type === 'tool.started')
      assert.throws(() => reduceConversation(state, { ...event, modelTurnId: 'foreign-turn' }), /归属/);
    assert.equal(JSON.stringify(state), before);
    state = reduceConversation(state, event);
  }
  assert.equal(state.runs.run!.status, 'completed');
});
