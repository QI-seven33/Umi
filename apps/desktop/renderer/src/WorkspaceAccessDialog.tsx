import {useEffect,useRef,useState} from 'react';
import {FolderOpen,ShieldCheck} from 'lucide-react';
import {Dialog} from './components/ui/Dialog.js';
import {t as uiText} from './ui-language.js';
import {userFacingError} from './ui-error.js';
import type {DirectoryAccessView} from '../../../../packages/protocol/src/resources.js';

export function WorkspaceAccessDialog({conversationId,name,onClose}:{conversationId:string;name:string;onClose:()=>void}) {
 const [grants,setGrants]=useState<DirectoryAccessView[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 const lock=useRef(false),refreshButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  let live=true;setLoading(true);setError('');
  void window.umi.request({type:'list_directory_access',conversationId})
   .then(result=>{if(live)setGrants(result as DirectoryAccessView[]);})
   .catch(e=>{if(live){setGrants([]);setError(userFacingError(e));}})
   .finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[conversationId,attempt]);
 useEffect(()=>{
  const refresh=()=>{if(!lock.current)setAttempt(n=>n+1);};
  window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);
 },[]);
 const revoke=async(id:string)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try {
   await window.umi.request({type:'revoke_directory_access',conversationId,grantId:id});
   setGrants(rows=>rows.map(row=>row.id===id?{...row,revoked:true,status:'revoked'}:row));
   requestAnimationFrame(()=>refreshButton.current?.focus());
  } catch(e){setError(userFacingError(e));} finally{lock.current=false;setBusy(false);}
 };
 const active=grants.filter(g=>!g.revoked&&g.status==='available');
 const inactive=grants.filter(g=>g.revoked||g.status!=='available');
 const badge=(g:DirectoryAccessView)=>g.revoked?uiText('已撤销')
  :g.status==='missing'?uiText('路径不存在'):g.status==='changed'?uiText('路径对象已变化')
  :g.status!=='available'?uiText('暂不可用'):g.access==='edit'?uiText('读取与修改'):uiText('只读');
 const row=(grant:DirectoryAccessView)=><div className="workspace-grant-row" key={grant.id}>
  <div className="grant-main"><span className={'grant-badge'+(grant.status!=='available'?' revoked':'')}><ShieldCheck size={12}/>{badge(grant)}</span><code title={grant.path}>{grant.path}</code></div>
  <button disabled={busy||loading||grant.revoked} onClick={()=>void revoke(grant.id)}>{grant.revoked?uiText('已撤销'):uiText('撤销')}</button>
 </div>;
 return <Dialog className="workspace-access-dialog" title={uiText('目录权限')} busy={busy} onClose={onClose}>
  <div className="access-workspace"><FolderOpen size={17}/><strong>{name}</strong></div>
  <p>{uiText('同一工作区的所有会话共享这些目录授权，直到撤销；重启后保留。')}</p>
  {loading?<p role="status">{uiText('正在读取权限…')}</p>:<>
   <div className="workspace-grants current-grants">{active.map(row)}</div>
   {!active.length&&<p>{uiText('当前没有可用的目录授权。')}</p>}
   {inactive.length>0&&<details className="access-history"><summary>{uiText('失效与已撤销')} · {inactive.length}</summary>
    <p>{uiText('历史记录用于保留授权来源，不代表当前仍可访问。')}</p>
    <div className="workspace-grants">{inactive.map(row)}</div>
   </details>}
  </>}
  <p className="access-footnote">{uiText('撤销会阻止后续文件访问并请求停止任务；已经完成的修改会保留。命令执行另行批准。')}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="umi-confirm-actions"><button ref={refreshButton} className="access-refresh" disabled={busy||loading} onClick={()=>setAttempt(n=>n+1)}>{uiText('刷新')}</button><button autoFocus className="ui-primary" disabled={busy} onClick={onClose}>{uiText('完成')}</button></div>
 </Dialog>;
}
