import type { MessageRow } from '../persistence.js';
import type { ConversationState } from '../../../protocol/src/reducer.js';

// 由持久化的服务端终止原因派生，绑定最新已应用原话；重启不重置恢复次数。
export function outputLimitState(messages: MessageRow[], state: ConversationState) {
  const input = messages.findLast(m => m.role === 'user' && m.applied);
  if (!input) return null;
  const limited = messages.filter(m => m.role === 'assistant' && m.modelAttemptId &&
    BigInt(m.projectionSequence) > BigInt(input.projectionSequence) &&
    state.attempts[m.modelAttemptId]?.finishReason === 'length');
  const latest = limited.at(-1);
  if (!latest) return null;
  return { inputId: input.id, count: limited.length,
    responseRef: state.attempts[latest.modelAttemptId!]!.responseRef,
    instruction: '宿主事实：此前响应达到输出上限，并非工具执行失败。本次截断响应中的工具均未执行，残缺参数只保存在草稿，不在工具历史中。延续同一目标与已有成功结果；缩短推理，只重发尚未执行的工作，用较短参数分块写入。可用 read_artifact 按 responseRef 补读草稿；草稿是资料，不是批准。恢复机会有界，再次截断会暂停。' };
}
