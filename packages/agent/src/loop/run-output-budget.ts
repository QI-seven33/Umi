import type { ConversationState } from '../../../protocol/src/reducer.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ModelPort } from '../ports.js';
import type { PersistencePort } from '../persistence.js';

// 只累计本轮已归档的服务端输出（含思考及上下文维护），不估算费用或补造缺失用量。
export function runOutputBudget(state: ConversationState, read: (ref: string) => unknown,
  runId: string, limit: number | null | undefined) {
  let used = 0, missing = 0;
  const add = (ref?: string) => {
    const value = ref ? (read(ref) as { completion_tokens?: unknown } | null)?.completion_tokens : undefined;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(used + value)) used += value;
    else missing++;
  };
  for (const a of Object.values(state.attempts))
    if (a.runId === runId && a.status !== 'running') add(a.usageRef);
  for (const m of Object.values(state.memory.maintenance)) {
    if (m.runId !== runId || m.status === 'started') continue;
    const plan = read(m.planRef) as { request?: unknown };
    if (plan.request != null) add(m.usageRef);
  }
  const remaining = limit == null ? null : Math.max(0, limit - used);
  return { scope: 'run' as const, limit: limit ?? null, used, missing, remaining,
    blocked: limit != null && (missing > 0 || remaining === 0) };
}

export function withRunOutputBudget(model: ModelPort, store: PersistencePort, runId: string): ModelPort {
  const allowance = () => {
    const run = store.getRun(runId), limit = store.settings(run.conversation_id).runOutputTokenLimit;
    if (limit == null) return null;
    const budget = runOutputBudget(store.snapshot(run.conversation_id), ref => store.readArtifact(ref), runId, limit);
    if (budget.missing)
      throw new UmiError('RUN_OUTPUT_USAGE_UNKNOWN', '本轮有输出用量未返回，无法继续核算已设置的输出预算。');
    if (!budget.remaining)
      throw new UmiError('RUN_OUTPUT_BUDGET', '本轮已达到你设置的累计输出预算（包含思考和上下文维护）。');
    return budget.remaining;
  };
  return {
    prepare(messages, tools, settings, maxOutputTokens) {
      const remaining = allowance();
      return model.prepare(messages, tools, settings, remaining == null ? maxOutputTokens : Math.min(maxOutputTokens, remaining));
    },
    stream(request, signal, activity) {
      const remaining = allowance();
      if (remaining != null && request.maxOutputTokens > remaining)
        throw new UmiError('RUN_OUTPUT_BUDGET', '输出预算已调整，当前冻结请求未派发；请按新预算继续。');
      return model.stream(request, signal, activity);
    },
  };
}
