import type { RunRow, ToolRow } from '../persistence.js';

// 仅描述宿主已经知道的停止原因和工具回执；不替模型证明用户目标已完成。
export function runConclusion(run: RunRow, reason: string, code: string | undefined, tools: ToolRow[]): string {
  const stopped = run.status === 'stopped';
  const last = tools.findLast(t => t.result_ref && !['prepared', 'dispatched'].includes(t.state));
  let location = '';
  if (last) {
    try {
      const args = JSON.parse(last.args) as { path?: unknown };
      if (typeof args.path === 'string') location = '，文件 ' + JSON.stringify(args.path);
    } catch { /* 旧参数不可解析时仍保留原回执。 */ }
  }
  const unknown = tools.some(t => t.state === 'unknown' || t.state === 'dispatched');
  const next = unknown || run.status === 'recovery_required'
    ? '需要先核验原操作的结果；没有自动重跑结果未知的操作。可以继续发消息安排核验。'
    : code === 'RUN_OUTPUT_BUDGET' || code === 'RUN_OUTPUT_USAGE_UNKNOWN'
      ? (code === 'RUN_OUTPUT_USAGE_UNKNOWN' ? '本轮用量无法完整核算，可在设置 → 会话中解除输出预算后继续。' : '可在设置 → 会话中提高或解除本轮输出预算，再继续。恢复同一运行不会清零已记录用量。')
      : code === 'PROVIDER_CONFIG'
        ? '请先检查模型设置中的连接配置，再发消息继续。'
        : code?.startsWith('CONTEXT_')
          ? '可调整上下文设置或当前输入后继续；直接重试不会自动减少上下文。'
          : stopped ? '目标和已有记录保留；需要继续时可发送新消息。'
            : '已有记录和已生成文件保留。可以发消息继续或调整要求；尚未确认的结果不作为完成。';
  return (stopped ? '你已停止本轮执行，目标未被取消。' : '本轮执行已暂停，任务尚未确认完成。') +
    '\n\n原因：' + reason +
    (last ? '\n\n最近收到的工具回执：' + last.name + location + '。具体结果以该回执为准。' : '') +
    '\n\n' + next;
}
