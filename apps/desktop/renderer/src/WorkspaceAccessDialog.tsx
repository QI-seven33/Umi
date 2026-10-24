import {useEffect,useRef,useState} from 'react';
import {userFacingError} from './ui-error.js';

type Grant={id:string;root:string;access:string;revoked:boolean};
export function WorkspaceAccessDialog({conversationId,name,onClose}:{conversationId:string;name:string;onClose:()=>void}) {
 const [grants,setGrants]=useState<Grant[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  close.current?.focus();let live=true;
  void window.umi.request({type:'list_directory_access',conversationId}).then(result=>{if(live)setGrants(result as Grant[]);}).catch(e=>{if(live)setError(userFacingError(e));}).finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[conversationId]);
 const revoke=async(id:string)=>{
  if(busy)return;setBusy(true);setError('');
  try{await window.umi.request({type:'revoke_directory_access',conversationId,grantId:id});setGrants(rows=>rows.map(row=>row.id===id?{...row,revoked:true}:row));}catch(e){setError(userFacingError(e));}finally{setBusy(false);}
 };
 return <div className="umi-confirm workspace-access-dialog" onKeyDown={event=>{
  if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
  if(event.key==='Tab'){
   const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),first=buttons[0],last=buttons.at(-1);
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
 }}><section role="dialog" aria-modal="true" aria-labelledby="workspace-access-title">
  <h3 id="workspace-access-title">{name} · 目录权限</h3>
  <p>授权在此工作区的会话和重启后继续使用。撤销会阻止后续文件访问并请求停止任务，已完成的修改会保留。</p>
  {loading&&<p role="status">正在读取权限…</p>}
  {grants.map(grant=><div className="workspace-grant-row" key={grant.id}><span>{grant.root}<small>{grant.revoked?'已撤销':grant.access==='edit'?'允许读取和修改':'允许读取'}</small></span><button disabled={busy||grant.revoked} onClick={()=>void revoke(grant.id)}>{grant.revoked?'已撤销':'撤销授权'}</button></div>)}
  {!loading&&!grants.length&&<p>没有持续的目录直改授权；旧副本保持原权限。</p>}
  {error&&<p role="alert">{error}</p>}
  <div className="umi-confirm-actions"><button ref={close} disabled={busy} onClick={onClose}>完成</button></div>
 </section></div>;
}
