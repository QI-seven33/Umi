import type { ConversationState } from '../../../protocol/src/reducer.js';

type Tokens = { known: number; missing: number };
const fields = { input: 'prompt_tokens', output: 'completion_tokens', hit: 'prompt_cache_hit_tokens', miss: 'prompt_cache_miss_tokens', reasoning: 'reasoning_tokens' } as const;
type Usage = Record<string, unknown>;
const valid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// 只聚合已有投影和usage小资料，不重扫model.delta，不估算账单/价格，不进入模型上下文。
export function runDiagnostics(state: ConversationState, read: (ref: string) => unknown) {
  const latest = state.latestRunId && state.runs[state.latestRunId]
    ? [state.latestRunId, state.runs[state.latestRunId]!] as const : Object.entries(state.runs).at(-1);
  if (!latest) return null;
  const [runId, run] = latest;
  const attempts = Object.values(state.attempts).filter(a => a.runId === runId);
  const requests = Object.values(state.turns).filter(t => t.runId === runId);
  const maintenance = Object.values(state.memory.maintenance).filter(m => m.runId === runId);
  const usages: (Usage | null)[] = attempts.filter(a => a.status !== 'running' || a.usageRef).map(a => a.usageRef ? read(a.usageRef) as Usage : null);
  let maintenancePlans = 0, localMaintenance = 0, maintenanceMissing = 0;
  for (const m of maintenance) {
    const plan = read(m.planRef) as { request?: unknown };
    if (plan.request == null) { localMaintenance++; continue; }
    maintenancePlans++;
    if (!m.usageRef) maintenanceMissing++;
    usages.push(m.usageRef ? read(m.usageRef) as Usage : null);
  }
  const tokens = Object.fromEntries(Object.entries(fields).map(([name, field]) => {
    const total: Tokens = { known: 0, missing: 0 };
    for (const usage of usages) {
      const value = field === 'reasoning_tokens'
        ? (usage?.completion_tokens_details as Usage | undefined)?.reasoning_tokens : usage?.[field];
      if (valid(value) && Number.isSafeInteger(total.known + value)) total.known += value;
      else total.missing++;
    }
    return [name, total];
  })) as Record<keyof typeof fields, Tokens>;
  const measurements = attempts.flatMap(a => a.measurement ? [a.measurement] : []);
  const tools = Object.values(state.tools).filter(t => t.runId === runId);
  const measuredTools = tools.flatMap(t => t.measurement ? [t.measurement] : []);
  let approvalWaitMs = 0, approvalUnknown = 0, approvalPending = 0;
  for (const a of Object.values(state.approvals).filter(a => state.tools[a.callId]?.runId === runId)) {
    if (a.status === 'pending') { approvalPending++; continue; }
    const elapsed = Date.parse(a.decidedAt ?? '') - Date.parse(a.requestedAt ?? '');
    if (Number.isFinite(elapsed) && elapsed >= 0) approvalWaitMs += elapsed;
    else approvalUnknown++;
  }
  const cacheKnown = tokens.hit.known + tokens.miss.known;
  return { scope: 'latest-run' as const, runId, status: run.status,
    requests: requests.length, attempts: attempts.length,
    retries: requests.reduce((n, t) => n + Math.max(0, t.attemptIds.length - 1), 0),
    truncated: attempts.filter(a => a.finishReason === 'length').length,
    pendingAttempts: attempts.filter(a => a.status === 'running').length,
    missingUsage: attempts.filter(a => a.status !== 'running' && !a.usageRef).length,
    maintenancePlans, maintenanceMissing, localMaintenance, tokens,
    cacheRate: !tokens.hit.missing && !tokens.miss.missing && cacheKnown > 0 ? tokens.hit.known / cacheKnown : null,
    modelMs: measurements.reduce((n, m) => n + m.elapsedMs, 0), modelUnmeasured: attempts.length - measurements.length,
    toolMs: measuredTools.reduce((n, m) => n + m.executeMs, 0), toolUnmeasured: tools.length - measuredTools.length,
    approvalWaitMs, approvalUnknown, approvalPending,
    interpretation: '最近运行的已记录服务端用量，包含有请求计划的上下文维护；未知值可能未派发或未返回。模型耗时只含主循环/收尾已有测量，不含维护；各耗时不直接相加。官方账单为实际扣费依据。' };
}
