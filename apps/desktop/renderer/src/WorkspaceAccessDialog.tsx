import {useEffect,useRef,useState} from 'react';
import {FolderOpen,ShieldCheck} from 'lucide-react';
import {Dialog} from './components/ui/Dialog.js';
import { t as uiText} from './ui-language.js';
import {userFacingError} from './ui-error.js';

type Grant={id:string;root:string;access:string;revoked:boolean};
export function WorkspaceAccessDialog({conversationId,name,onClose}:{conversationId:string;name:string;onClose:()=>void}) {
 const [grants,setGrants]=useState<Grant[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0);
 const lock=useRef(false);
 useEffect(()=>{let live=true;setLoading(true);setError('');void window.umi.request({type:'list_directory_access',conversationId}).then(result=>{if(live)setGrants(result as Grant[]);}).catch(e=>{if(live)setError(userFacingError(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[conversationId,attempt]);
 const revoke=async(id:string)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{await window.umi.request({type:'revoke_directory_access',conversationId,grantId:id});setGrants(rows=>rows.map(row=>row.id===id?{...row,revoked:true}:row));}catch(e){setError(userFacingError(e));}finally{lock.current=false;setBusy(false);}
 };
 return <Dialog className="workspace-access-dialog" title={uiText('目录权限')} busy={busy} onClose={onClose}>
  <div className="access-workspace"><FolderOpen size={17}/><strong>{name}</strong></div>
  <p>{uiText('这些授权在工作区内持续有效，重启后仍可使用。')}</p>
  <div className="workspace-grants">{loading?<p role="status">{uiText('正在读取权限…')}</p>:grants.map(grant=><div className="workspace-grant-row" key={grant.id}>
    <div className="grant-main"><span className={`grant-badge${grant.revoked?' revoked':''}`}><ShieldCheck size={12}/>{grant.revoked?uiText('已撤销'):grant.access==='edit'?uiText('读取与修改'):uiText('只读')}</span><code title={grant.root}>{grant.root}</code></div>
    <button disabled={busy||grant.revoked} onClick={()=>void revoke(grant.id)}>{grant.revoked?uiText('已撤销'):uiText('撤销')}</button>
  </div>)}</div>
  {!loading&&!grants.length&&<p>{uiText('没有持续的目录授权。')}</p>}
  <p className="access-footnote">{uiText('撤销会阻止后续文件访问并请求停止任务；已经完成的修改会保留。命令执行另行批准。')}</p>
  {error&&<p role="alert">{error}<button disabled={busy||loading} onClick={()=>setAttempt(x=>x+1)}>{uiText('重试')}</button></p>}
  <div className="umi-confirm-actions"><button autoFocus className="ui-primary" disabled={busy} onClick={onClose}>{uiText('完成')}</button></div>
 </Dialog>;
}
