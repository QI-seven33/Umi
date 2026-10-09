export function EmptyConversation({ready,workspace}:{ready:boolean;workspace:boolean}){
  return <section className="empty-conversation" aria-label="开始对话">
    <img src="/umi-lockup.png" alt="Umi" width={168}/>
    <h1>今天想完成什么？</h1>
    <p>池上听雷阶前看雨花开千年人犹不老，终究是年少时的梦想。</p>
    {!workspace&&<small>{ready?'先选择一个工作区，再告诉 Umi 你的想法。':'正在连接 Umi 核心…'}</small>}
  </section>;
}
