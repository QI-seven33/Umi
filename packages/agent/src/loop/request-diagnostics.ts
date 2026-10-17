import type { WorkEvent } from '../../../protocol/src/events.js';
import type { PreparedRequest } from '../ports.js';
import type { WireMessage, ToolSpec } from '../../../protocol/src/model.js';
import { estimateInput } from '../context/estimate.js';

// 只存入 context artifact，不发送给模型，也不把本地字节估算冒充计费 token。
export function requestDiagnostics(request: PreparedRequest, messages: WireMessage[], tools: ToolSpec[], appliedUserMessageId: string | null, tasks: unknown) {
  const byRole: Record<string, { bytes: number; estimatedTokens: number; messages: number }> = {};
  const encodedMessages = Array.isArray(request.body.messages) ? request.body.messages as WireMessage[] : messages;
  for (const message of encodedMessages) {
    const row = byRole[message.role] ??= { bytes: 0, estimatedTokens: 0, messages: 0 };
    row.bytes += Buffer.byteLength(JSON.stringify(message)); row.estimatedTokens += estimateInput(message); row.messages++;
  }
  const taskIds = tasks && typeof tasks === 'object' && 'tasks' in tasks && Array.isArray(tasks.tasks)
    ? tasks.tasks.map((t: { taskId?: string }) => t.taskId).filter(Boolean) : [];
  return { schemaVersion: 1, appliedUserMessageId, taskIds,
    model: request.model, adapterId: request.adapterId,
    reasoningEffort: request.body.reasoning_effort ?? (request.settings.thinking === 'off' ? 'disabled' : request.settings.thinking),
    encodedRequestBytes: Buffer.byteLength(JSON.stringify(request.body)), toolSchemaBytes: Buffer.byteLength(JSON.stringify(request.body.tools ?? tools)),
    byRole, estimateBasis: 'local-utf8-estimate-not-billing', preparedAt: new Date().toISOString(),
  };
}

// 用户决定等待用持久请求/决定时间计算；不能把后台轮询睡眠当成人工耗时。
// 它包括批准卡显示、用户思考和提交决定，系统时钟倒退时明确未知。
export function approvalDecisionWaits(events: readonly WorkEvent[]) {
  const pending = new Map<string, { occurredAt: string; executionId: string }>();
  const waits: { approvalId: string; executionId: string; decision: string; waitMs: number | null }[] = [];
  for (const event of events) {
    if (event.type === 'approval.requested') pending.set(event.payload.approvalId, { occurredAt: event.occurredAt, executionId: event.executionId! });
    if (event.type !== 'approval.decided' && event.type !== 'approval.invalidated') continue;
    const original = pending.get(event.payload.approvalId);
    if (!original) continue;
    const elapsed = Date.parse(event.occurredAt) - Date.parse(original.occurredAt);
    waits.push({ approvalId: event.payload.approvalId, executionId: original.executionId,
      decision: event.type === 'approval.decided' ? event.payload.decision : 'invalidated', waitMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null });
    pending.delete(event.payload.approvalId);
  }
  return waits;
}
