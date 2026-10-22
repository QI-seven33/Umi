import { streamWithIdleTimeout } from '../model-stream.js';
import { requestDiagnostics } from './request-diagnostics.js';
import { UmiError, type WireMessage } from '../../../protocol/src/model.js';
import type { EventScope } from '../../../protocol/src/events.js';
import type { PersistencePort, ToolRow } from '../persistence.js';
import type { ModelPort } from '../ports.js';
import type { ContextFacts, ContextManager } from '../context/manager.js';
import type { TaskPort } from '../tasks.js';
import { estimateInput } from '../context/estimate.js';
import { uid } from '../identity.js';
import { StreamBuffer } from './stream-buffer.js';
import { setImmediate as yieldToHost } from 'node:timers/promises';

// 停滞事实来自已结算工具，并绑定当前原话；新输入不继承旧收尾。
export function currentStall(store: PersistencePort, runId: string): ToolRow | undefined {
  const run = store.getRun(runId);
  const inputId = store.messages(run.conversation_id).filter(m => m.role === 'user' && m.applied).at(-1)?.id;
  return store.tools(runId).findLast(t => {
    if (t.state !== 'failed' || !t.result_ref) return false;
    const result = store.readArtifact<{ data?: { code?: string; inputId?: string } }>(t.result_ref);
    return result.data?.code === 'TASK_STALLED' && result.data.inputId === inputId;
  });
}

export async function finalizeStalled(
  store: PersistencePort, model: ModelPort, contextManager: ContextManager, tasks: TaskPort | undefined,
  stall: ToolRow, generation: number, signal: AbortSignal, facts: () => ContextFacts,
  modelTimeoutMs: number,
) {
  const runId = stall.run_id, run = store.getRun(runId);
  const scope = { conversationId: run.conversation_id, runId };
  const checkCurrent = () => {
    signal.throwIfAborted(); store.checkLease(runId, generation);
    if (store.messages(scope.conversationId).some(m => m.runId === runId && !m.applied) ||
        currentStall(store, runId)?.id !== stall.id)
      throw new UmiError('CONTEXT_SOURCE_CHANGED', '收尾期间收到新要求，先交模型重新判断');
  };
  checkCurrent();
  // 同批其余工具尚未派发：闭合工具消息组，不让总结阶段触发任何新操作。
  for (const tool of store.tools(runId).filter(t => t.state === 'prepared')) {
    if (tool.approval_id) store.invalidateApproval(tool.id, '重复请求已停止，未执行其余工具');
    store.settle(tool.id, { outcome: 'cancelled', content: '本轮转入受阻说明，此操作未派发。', data: null }, generation);
  }
  store.commit(scope, { type: 'run.phase_changed', payload: { phase: 'finalize' } });
  const state = store.snapshot(scope.conversationId);
  const turns = Object.entries(state.turns).filter(([, t]) => t.runId === runId).map(([id]) => id);
  const laterTurns = turns.slice(turns.indexOf(stall.turn_id) + 1);
  // 请求事实已持久化就算用过一次机会；崩溃后的恢复不能再次收费请求。
  const notice = state.runs[runId]?.failureSummary;
  const latestInputId = store.messages(scope.conversationId).filter(m => m.role === 'user' && m.applied).at(-1)?.id;
  let messageId = (notice?.inputId === latestInputId ? notice?.messageId : undefined) ?? store.messages(scope.conversationId)
    .findLast(m => m.role === 'assistant' && m.modelTurnId && laterTurns.includes(m.modelTurnId) &&
      m.payload.content.trim() && !m.payload.tool_calls?.length &&
      state.attempts[m.modelAttemptId!]?.finishReason !== 'length')?.id;
  if (!messageId && !laterTurns.length) {
    try {
      const current = facts();
      current.state = { ...current.state, instruction:
        '本轮因相同请求没有进展而停止执行。只给用户一段最终说明：已完成什么、哪一步失败及真实原因、重复尝试仍失败、需要什么条件改变后继续。不得声称任务已完成；不得要求无关改动重建权限；不得再调用工具。' };
      // 只投影现有完整消息组；不为收尾另发上下文维护模型请求。
      const context = contextManager.inspect(current, []);
      const maxOutputTokens = Math.min(context.maxOutputTokens, 4096);
      const request = model.prepare(context.messages, [], current.settings, maxOutputTokens);
      context.estimatedInputTokens = Math.max(context.estimatedInputTokens,
        estimateInput(request.body) + 64 * context.messages.length + 128);
      if (context.estimatedInputTokens > context.inputCeiling)
        throw new UmiError('CONTEXT_BUDGET_EXCEEDED', '收尾请求超过预算，改用本地说明');
      checkCurrent();
      const frozen = JSON.parse(JSON.stringify(request)) as typeof request;
      const turnScope = { ...scope, modelTurnId: uid(), modelAttemptId: uid() };
      const requestId = uid();
      store.persistRequest(turnScope, requestId, uid(), frozen,
        { ...context, maxOutputTokens, sourceFingerprint: store.contextSourceFingerprint(runId),
          diagnostics: requestDiagnostics(frozen, context.messages, [], latestInputId ?? null, current.state.taskAcceptance ?? null) }, generation);
      messageId = await streamSummary(store, model, turnScope, requestId, frozen, generation,
        signal, checkCurrent, Math.min(modelTimeoutMs, 30000));
    } catch (error) {
      checkCurrent(); // 停止、新输入和租约错误仍交给原循环处理，不转成本地“完成”。
      if (String((error as { code?: string }).code ?? '').includes('SQLITE') ||
          (error instanceof UmiError && error.code === 'PERSISTENCE_FAILED')) throw error;
    }
  }
  checkCurrent();
  if (!messageId) {
    const previous = store.tools(runId).filter(t => t.id !== stall.id && t.name === stall.name &&
      t.args === stall.args && t.result_ref).at(-1);
    const result = previous?.result_ref ? store.readArtifact<{ content: string }>(previous.result_ref) : null;
    const reason = result?.content?.slice(0, 600) || '相同请求没有取得新信息';
    messageId = store.persistFailureSummary(runId,
      `这一步仍未完成，本轮已停止重复请求；最近一次请求仍失败。\n\n上次操作的结果：${reason}。\n\n已有操作结果和交付回执保留。需要先解决上述阻塞条件才能继续；不会自动重跑结果未知的操作。`, generation);
  }
  checkCurrent();
  const failure = { code: 'TASK_STALLED', reason: '重复请求已停止，本轮仍有未完成步骤。' };
  if (tasks) tasks.complete(runId, messageId, generation, [], failure);
  else store.commit(scope, { type: 'run.failed', payload: { ...failure, messageId } });
}

async function streamSummary(
  store: PersistencePort, model: ModelPort, scope: EventScope, requestId: string,
  request: ReturnType<ModelPort['prepare']>, generation: number, signal: AbortSignal,
  checkCurrent: () => void, timeoutMs: number,
): Promise<string> {
  store.commit(scope, { type: 'model.attempt_started', payload: { requestId } });
  const stream = new StreamBuffer(deltas => store.commitModelDeltas(scope, generation, deltas));
  const blocks: { id: string; channel: 'reasoning' | 'text' | 'tool'; key: string; index: number }[] = [];
  let answer: WireMessage | undefined, messageId: string | undefined, yieldedAt = Date.now();
  let lengthLimited = false;
  const started = performance.now();
  let firstFrameMs: number | null = null, firstReasoningMs: number | null = null, firstTextMs: number | null = null, measured = false;
  const measure = (outcome: 'completed' | 'interrupted') => {
    if (measured || store.getRun(scope.runId!).generation !== generation) return;
    store.commit(scope, { type: 'model.attempt_measured', payload: { requestId, outcome,
      elapsedMs: performance.now() - started, firstFrameMs, firstReasoningMs, firstTextMs } });
    measured = true;
  };
  try {
    for await (const frame of streamWithIdleTimeout(model, request, signal, timeoutMs)) {
      checkCurrent();
      if (Date.now() - yieldedAt >= 8) { stream.flush(); await yieldToHost(); checkCurrent(); yieldedAt = Date.now(); }
      firstFrameMs ??= performance.now() - started;
      if (answer) throw new UmiError('PROTOCOL_INVALID', '完整收尾响应后仍返回数据');
      if (frame.kind === 'delta') {
        if (frame.channel === 'reasoning') firstReasoningMs ??= performance.now() - started;
        if (frame.channel === 'text') firstTextMs ??= performance.now() - started;
        if (frame.channel === 'tool') throw new UmiError('PROTOCOL_INVALID', '受阻收尾不得调用工具');
        let block = blocks.at(-1);
        if (!block || block.channel !== frame.channel || block.key !== frame.key) {
          stream.flush(); block = { id: uid(), channel: frame.channel, key: frame.key, index: 0 }; blocks.push(block);
          store.commit(scope, { type: 'model.block_started', payload: { blockId: block.id,
            kind: block.channel, displayRole: 'final' } });
        }
        stream.push({ type: 'model.delta', payload: { blockId: block.id, kind: block.channel,
          deltaIndex: block.index++, text: frame.text } });
      } else {
        stream.flush();
        if ((frame.finishReason !== 'length' && !frame.message.content.trim()) || frame.message.tool_calls?.length)
          throw new UmiError('PROTOCOL_INVALID', '受阻收尾需要无工具的可见正文');
        answer = frame.message;
        lengthLimited = frame.finishReason === 'length';
        for (const block of blocks) store.commit(scope, { type: 'model.block_completed', payload: { blockId: block.id } });
        measure('completed');
        messageId = store.persistResponse(scope, answer, frame.raw, frame.usage, requestId, generation, frame.finishReason);
      }
    }
    stream.flush();
    if (lengthLimited) throw new UmiError('PROVIDER_TRUNCATED', '收尾响应达到输出上限，改用本地说明');
    if (!messageId) throw new UmiError('PROVIDER_INTERRUPTED', '模型收尾没有形成完整响应');
    return messageId;
  } catch (error) {
    stream.flush(); measure('interrupted');
    if (!messageId) store.commit(scope, { type: 'model.attempt_failed', payload: {
      code: error instanceof UmiError ? error.code : 'PROVIDER_INTERRUPTED', reason: '模型收尾未完成，保留已收到的文字。' } });
    // 完整响应已提交后断流，直接采用已有正文；不重复请求。
    if (messageId && !lengthLimited) return messageId;
    throw error;
  }
}
