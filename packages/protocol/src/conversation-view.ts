// 修订只改变当前对话视图；区间中的原始消息、工具事实和磁盘效果仍然保留。
export type ConversationRevision = {
  id: string;
  sequence: string;
  targetMessageId: string;
  messageId: string;
  userCutoff: string;
  contextCutoff: string;
  replacementSequence: string;
};
export function currentSequence(
  state: { revisions?: ConversationRevision[] },
  sequence: string,
  kind: 'user' | 'context' = 'context',
): boolean {
  const value = BigInt(sequence);
  return !(state.revisions ?? []).some(revision =>
    value >= BigInt(kind === 'user' ? revision.userCutoff : revision.contextCutoff) &&
    value < BigInt(revision.replacementSequence));
}
