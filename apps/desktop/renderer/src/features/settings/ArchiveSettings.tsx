import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArchiveRestore,Trash2} from 'lucide-react';
import {userFacingError} from '../../ui-error.js';
type Archived={id:string;title:string;workspace:string};
export function ArchiveSettings({onRestore,onDelete,onError}:{onRestore:()=>void;onDelete:(id:string)=>void;onError:(error:unknown)=>void}){
  const [rows,setRows]=useState<Archived[]|null>(null),[busy,setBusy]=useState<string|null>(null),
    [selected,setSelected]=useState<Archived|null>(null),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const lock=useRef(false),alive=useRef(true),cancel=useRef<HTMLButtonElement>(null),returnFocus=useRef<HTMLElement|null>(null);
  useEffect(()=>{alive.current=true;void window.umi.request({type:'list',archived:true}).then(data=>{if(alive.current)setRows(data as Archived[]);}).catch(onError);return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(selected)cancel.current?.focus();else returnFocus.current?.focus();},[selected]);
  const act=async(row:Archived,remove:boolean)=>{
    if(lock.current)return;lock.current=true;setBusy(row.id);setNotice('');setError('');
    try{
      const result=await window.umi.request(remove?{type:'delete_conversation',conversationId:row.id,confirm:true}:{type:'restore',conversationId:row.id}) as {cleanupPending?:boolean};
      if(remove)onDelete(row.id);
      if(alive.current){
        setRows(current=>current?.filter(r=>r.id!==row.id)??[]);setSelected(null);
        setNotice(remove?(result.cleanupPending?'会话已删除，部分托管文件暂未清理；下次启动会重试。':'会话已永久删除。'):'会话已恢复。');
        if(!remove)onRestore();
      }
    }catch(error){if(alive.current){setError(userFacingError(error)||'操作未完成，请重试。');onError(error);}}
    finally{lock.current=false;if(alive.current)setBusy(null);}
  };
  return <section className="umi-settings-group"><h2>已归档会话</h2><p>归档保留会话，支持恢复或永久删除。</p>
    {rows===null?<p>正在读取…</p>:rows.length===0?<p>暂无已归档会话</p>:<ul className="archive-list">{rows.map(row=><li key={row.id} data-conversation-id={row.id}>
      <span><strong>{row.title}</strong><small title={row.workspace}>{row.workspace}</small></span>
      <div className="archive-actions"><button className="archive-restore" disabled={busy!==null} onClick={()=>void act(row,false)}><ArchiveRestore size={14}/>恢复</button>
      <button className="archive-delete" aria-label={'永久删除：'+row.title} disabled={busy!==null} onClick={event=>{returnFocus.current=event.currentTarget;setError('');setSelected(row);}}><Trash2 size={14}/>删除</button></div>
    </li>)}</ul>}
    {notice&&<p role="status" className="archive-status">{notice}</p>}
    {selected&&createPortal(<div className="umi-confirm archive-delete-confirm" onKeyDown={event=>{
      if(event.key==='Escape'){event.stopPropagation();if(!busy)setSelected(null);}
      if(event.key==='Tab'){
        const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const next=event.shiftKey?buttons.at(-1):buttons[0],edge=event.shiftKey?buttons[0]:buttons.at(-1);
        if(document.activeElement===edge){event.preventDefault();next?.focus();}
      }
    }}><section role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title" aria-describedby="permanent-delete-description">
      <h3 id="permanent-delete-title">永久删除这条会话？</h3><p className="archive-delete-name">{selected.title}</p>
      <p id="permanent-delete-description">消息、网页快照和托管工作副本将被删除，无法恢复。用户源文件和已交付文件会保留。</p>
      {error&&<p role="alert">{error}</p>}<div className="umi-confirm-actions"><button ref={cancel} disabled={busy!==null} onClick={()=>setSelected(null)}>取消</button>
      <button className="archive-delete" disabled={busy!==null} onClick={()=>void act(selected,true)}>{busy?'正在删除…':'永久删除'}</button></div>
    </section></div>,document.body)}
  </section>;
}
