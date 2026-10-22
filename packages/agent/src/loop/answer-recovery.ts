import type { MessageRow } from '../persistence.js';
import type { ConversationState } from '../../../protocol/src/reducer.js';

// 仅处理完整stop却只有思考的异常，不评价正常正文或从关键词推测目标完成。
// 次数从最新已应用用户输入后的持久响应派生，重启或显式恢复不会重置。
export function answerRecoveryState(messages: MessageRow[], state: ConversationState) {
  const input = messages.findLast(m => m.role === 'user' && m.applied);
  if (!input) return null;
  const responses = messages.filter(m => m.applied && m.role === 'assistant' && m.modelAttemptId &&
    BigInt(m.projectionSequence) > BigInt(input.projectionSequence));
  const reasoningOnly = (m: MessageRow) => !m.payload.content.trim() &&
    !!m.payload.reasoning_content?.trim() && !m.payload.tool_calls?.length &&
    state.attempts[m.modelAttemptId!]?.status === 'completed' &&
    state.attempts[m.modelAttemptId!]?.finishReason === 'stop';
  const latest = responses.at(-1);
  if (!latest || !reasoningOnly(latest)) return null;
  return { inputId: input.id, count: responses.filter(reasoningOnly).length,
    instruction: '上一条完整响应只有思考，没有用户可见正文或工具调用，目标尚未得到答复。继续处理原要求：需要操作则使用必要工具，能够回答则给出实际结果；真实受阻时说明原因和剩余事项。保留已有成果和历史，不重做成功操作。' };
}
