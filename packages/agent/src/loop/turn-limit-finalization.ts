import type { PersistencePort } from '../persistence.js';
import type { TaskPort } from '../tasks.js';
import { UmiError } from '../../../protocol/src/model.js';

// 本地终态正文只使用宿主回执，不增加模型请求，也不把文件/交付结果猜成目标完成。
export function finalizeTurnLimit(store: PersistencePort, tasks: TaskPort | undefined,
  runId: string, generation: number, signal: AbortSignal) {
  signal.throwIfAborted(); store.checkLease(runId, generation);
  const run = store.getRun(runId), scope = { conversationId: run.conversation_id, runId };
  if (store.unresolvedEnvironment(run.environment_id).length)
    throw new UmiError('TOOL_OUTCOME_UNKNOWN', '历史操作结果仍待核验，未标为普通轮次结束。');
  for (const tool of store.tools(runId).filter(t => t.state === 'prepared')) {
    if (tool.approval_id) store.invalidateApproval(tool.id, '本轮已达到轮次上限，工具未派发');
    store.settle(tool.id, { outcome: 'cancelled', content: '本轮达到轮次上限，此操作未执行。', data: null }, generation);
  }
  const tools = store.tools(runId);
  const count = (status: string) => tools.filter(t => t.state === status).length;
  const text = `本轮已达到模型轮次上限，已停止继续执行。\n\n本轮工具回执：成功 ${count('succeeded')} 项、失败 ${count('failed')} 项、拒绝 ${count('denied')} 项、取消 ${count('cancelled')} 项。已有工作文件和回执保留；这些计数不证明用户要求已全部完成。\n\n剩余工作尚未确认完成。可以直接发消息继续或修改要求；后续会先判断当前要求和已有结果，不自动重跑结果未知的操作。`;
  const messageId = store.persistFailureSummary(runId, text, generation, 'TASK_LIMIT');
  signal.throwIfAborted(); store.checkLease(runId, generation);
  const failure = { code: 'TASK_LIMIT', reason: '已达到本次运行的模型轮次上限' };
  if (tasks) tasks.complete(runId, messageId, generation, [], failure);
  else store.commit(scope, { type: 'run.failed', payload: { ...failure, messageId } });
}
