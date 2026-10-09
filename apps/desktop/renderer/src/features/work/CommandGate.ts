// 在第一处 await 前取得令牌；组件重渲染不能打开第二个提交窗口。
export class CommandGate {
  private readonly active=new Set<string>();
  acquire(conversationId:string):(()=>void)|null {
    if(this.active.has(conversationId))return null;
    this.active.add(conversationId);
    let released=false;
    return ()=>{if(!released){released=true;this.active.delete(conversationId);}};
  }
}
