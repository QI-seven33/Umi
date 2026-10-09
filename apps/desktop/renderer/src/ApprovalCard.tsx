import {useEffect,useRef,useState} from 'react';
import {FileText} from 'lucide-react';
import type {ConversationState} from '../../../../packages/protocol/src/reducer.js';
import type {FileTarget} from './Timeline.js';
type Delivery={kind:'delivery';changeSet:{id:string;mountId:string};preview:{targetDirectory:string;changes:{path:string;operation:'create'|'modify'|'delete';binary:boolean;previewTruncated:boolean}[]}};
type Detail=Delivery|{kind:'operation';description:string};
const labels={create:'新增',modify:'修改',delete:'删除'};
export function ApprovalCard({id,state,conversationId,onPreview,onError}:{id:string;state:ConversationState;conversationId:string;onPreview:(file:FileTarget)=>void;onError:(error:string)=>void}){
  const approval=state.approvals[id]!,delivery=state.tools[approval.callId]?.name==='deliver_changeset';
  const [detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),lock=useRef(false);
  useEffect(()=>{let live=true;void window.umi.request({type:'approval_detail',conversationId,approvalId:id}).then(data=>{if(live)setDetail(data as Detail);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[id,conversationId]);
  const decide=(decision:'allow'|'deny')=>{
    if(lock.current)return;lock.current=true;setBusy(true);
    void window.umi.request({type:'approve',conversationId,approvalId:id,decision}).catch(e=>{lock.current=false;setBusy(false);onError(e.message);});
    // 成功后等待同一事件流移除卡片，避免回执与下一次 poll 之间重复点击。
  };
  return <section className="umi-approval" aria-label={delivery?'交付批准':'操作批准'}><strong>{delivery?'确认交付范围':'确认本次操作'}</strong>
    {delivery?detail?.kind==='delivery'?<>
      <p>将以下修改写回 <span className="delivery-target">{detail.preview.targetDirectory}</span></p>
      <ul className="delivery-file-list">{detail.preview.changes.map(file=><li key={file.path}><button type="button" className="umi-file-row" onClick={()=>onPreview({mountId:detail.changeSet.mountId,path:file.path,changeSetId:detail.changeSet.id})}><FileText size={14}/><span>{file.path}</span><small>{labels[file.operation]}</small></button></li>)}</ul>
      {detail.preview.changes.some(file=>file.operation==='delete')&&<p className="delivery-warning">删除项会永久删除源文件，不进入系统回收站。</p>}
      <small>点击文件查看已冻结的变化。本次批准仅覆盖这份变更集。</small>
    </>:<p>{error?'无法读取交付范围，请拒绝本次交付后重新检查。':'正在读取交付范围…'}</p>:<p className="operation-description">{approval.description}</p>}
    {error&&<p role="alert">{error}</p>}
    <div className="umi-approval-actions" aria-busy={busy}><span className="approval-decision-status" role="status">{busy?'正在提交决定…':''}</span><button type="button" className="approval-deny" disabled={busy} onClick={()=>decide('deny')}>拒绝</button><button type="button" className="approval-allow" disabled={busy||(delivery&&detail?.kind!=='delivery')} onClick={()=>decide('allow')}>允许本次</button></div>
  </section>;
}
