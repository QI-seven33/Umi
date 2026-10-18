// 只清除此会话的待发请求/本机反馈；不动资料、模型设置或其他会话。
export function clearConversationStorage(storage:Pick<Storage,'length'|'key'|'getItem'|'removeItem'>,conversationId:string) {
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index)).filter((key):key is string=>key!==null);
  for(const key of keys)
    if(key==='umi.pending.'+conversationId||key.startsWith('umi.feedback.'+conversationId+'.'))storage.removeItem(key);
  if(storage.getItem('umi.work.activeThread')===conversationId)storage.removeItem('umi.work.activeThread');
}
