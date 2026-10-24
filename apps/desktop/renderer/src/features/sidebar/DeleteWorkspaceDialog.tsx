import {useEffect,useRef,useState} from 'react';
import type {Workspace} from '../../types/index.js';
import {userFacingError} from '../../ui-error.js';

export type WorkspaceDeletionResult = {conversationIds:string[];cleanupPending:boolean};
export function DeleteWorkspaceDialog({workspace,onCancel,onDeleted}:{workspace:Workspace;onCancel:()=>void;onDeleted:(result:WorkspaceDeletionResult)=>Promise<void>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const cancel=useRef<HTMLButtonElement>(null),lock=useRef(false);
  useEffect(()=>{cancel.current?.focus();},[]);
  const reconcile=async()=>{
    const status=await window.umi.request({type:'workspace_deletion_status',workspaceId:workspace.workspaceId}) as WorkspaceDeletionResult&{deleted:boolean};
    if(status.deleted){await onDeleted(status);return true;}
    return false;
  };
  const [uncertain,setUncertain]=useState(false);
  const remove=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try {
      if(uncertain){if(!await reconcile())setError('尚无删除完成凭据；可稍后再次查询。');return;}
      const result=await window.umi.request({type:'delete_workspace',workspaceId:workspace.workspaceId,confirm:true}) as WorkspaceDeletionResult;
      await onDeleted(result);
    } catch(e) {
      try{
        if(await reconcile())return;
        const timedOut=(e as {code?:string})?.code==='COMMAND_TIMEOUT';
        if(timedOut)setUncertain(true);
        setError(userFacingError(e)||'尚未确认删除完成；请稍后查询删除结果。');
      }
      catch{setUncertain(true);setError('删除响应中断，结果尚未确认；请查询删除结果。不会重复派发删除。');}
    }
    finally {lock.current=false;setBusy(false);}
  };
  return <div className="umi-confirm archive-delete-confirm workspace-delete-confirm" onKeyDown={event=>{
    if(event.key==='Escape'){event.stopPropagation();if(!lock.current)onCancel();}
    if(event.key==='Tab'){
      const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const next=event.shiftKey?buttons.at(-1):buttons[0],edge=event.shiftKey?buttons[0]:buttons.at(-1);
      if(document.activeElement===edge){event.preventDefault();next?.focus();}
    }
  }}><section role="dialog" aria-modal="true" aria-labelledby="workspace-delete-title" aria-describedby="workspace-delete-description">
    <h3 id="workspace-delete-title">删除这个工作区？</h3><p className="archive-delete-name">{workspace.name}</p>
    <p className="archive-delete-name">{workspace.path}</p>
    <p id="workspace-delete-description">该工作区的全部会话（含已归档）、历史记录、恢复备份和目录授权将永久删除，无法恢复。磁盘上的源文件与已导出文件会保留。</p>
    {error&&<p role="alert">{error}</p>}
    <div className="umi-confirm-actions"><button ref={cancel} disabled={busy} onClick={onCancel}>取消</button>
      <button className="archive-delete workspace-delete" disabled={busy} onClick={()=>void remove()}>{busy?'正在处理…':uncertain?'查询删除结果':'删除工作区'}</button></div>
  </section></div>;
}
