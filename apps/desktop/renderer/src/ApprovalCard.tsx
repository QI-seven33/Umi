import {t as uiText} from './ui-language.js';
import {useRef,useState} from 'react';
import {ShieldCheck} from 'lucide-react';
import {userFacingError} from './ui-error.js';
import type {ConversationState} from '../../../../packages/protocol/src/reducer.js';

type Props={executionPolicy?:'ask'|'auto';id:string;state:ConversationState;conversationId:string;onError:(error:string)=>void};
export function ApprovalCard({id,state,conversationId,onError,executionPolicy}:Props) {
  const approval=state.approvals[id]!;
  const toolName=state.tools[approval.callId]?.name;
  const command=toolName==='run_command'||toolName==='run_shell';
  const program=/^程序：(.+)$/m.exec(approval.description)?.[1]?.split(/[\\/]/).at(-1);
  const directory=/^工作目录：(.+)$/m.exec(approval.description)?.[1];
  const [description,...operationLines]=[...new Set(approval.description.split("\n").filter(Boolean))];
  const [busy,setBusy]=useState(false),lock=useRef(false);
  const decide=(decision:'allow'|'deny',scope:'once'|'task'='once')=>{
    if(lock.current)return;
    lock.current=true;setBusy(true);
    void window.umi.request({type:'approve',conversationId,approvalId:id,decision,scope})
      .catch(error=>{lock.current=false;setBusy(false);onError(userFacingError(error));});
    // 成功后等待同一事件流移除卡片，避免回执与下一次poll之间重复点击。
  };
  return <section className="umi-approval" aria-label={uiText('操作批准')}>
    <div className="umi-approval-body">
      <div className="approval-heading"><ShieldCheck size={16}/><strong>{uiText('需要你的许可')}</strong></div>
      <p className="operation-description">{command?<>{uiText(toolName==='run_shell'?'运行脚本':'运行命令')}{program&&<span className="approval-program">{program}</span>}</>:description}</p>
      {command&&directory&&<code className="approval-directory" title={directory}>{directory}</code>}
      {(operationLines.length>0||command)&&<details className="approval-operation-detail"><summary>{uiText('查看完整操作')}</summary><pre>{approval.description}</pre></details>}
      {approval.canReuseCommand&&executionPolicy==='auto'&&<small>{uiText('本任务可复用这条命令；停止或新任务后失效。命令没有文件与网络沙箱。')}</small>}
    </div>
    <div className="umi-approval-actions" aria-busy={busy}>
      <span className="approval-decision-status" role="status">{busy?uiText('正在提交决定…'):''}</span>
      <button type="button" className="approval-deny" disabled={busy} onClick={()=>decide('deny')}>{uiText('拒绝')}</button>
      {approval.canReuseCommand&&executionPolicy==='auto'&&<button type="button" className="approval-allow-task" disabled={busy} onClick={()=>decide('allow','task')}>{uiText('本任务允许重复')}</button>}
      <button type="button" className="approval-allow" disabled={busy} onClick={()=>decide('allow')}>{uiText('允许本次')}</button>
    </div>
  </section>;
}
