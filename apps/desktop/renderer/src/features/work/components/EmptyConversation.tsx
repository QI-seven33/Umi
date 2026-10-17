import { TextPressure } from '../../../components/ui/TextPressure.js';

export function EmptyConversation({ready,workspace}:{ready:boolean;workspace:boolean}) {
  return <section className="empty-conversation" aria-label="开始对话">
    <TextPressure text="hello" />
    {!workspace && <small>{ready ? '先选择一个工作区，再告诉 Umi 你的想法。' : '正在连接 Umi 核心…'}</small>}
  </section>;
}
