import {useEffect,useState} from 'react';
import {ArchiveRestore} from 'lucide-react';
type Archived={id:string;title:string;workspace:string};
export function ArchiveSettings({onRestore,onError}:{onRestore:()=>void;onError:(error:unknown)=>void}){
  const [rows,setRows]=useState<Archived[]|null>(null),[busy,setBusy]=useState<string|null>(null);
  useEffect(()=>{let live=true;void window.umi.request({type:'list',archived:true}).then(data=>{if(live)setRows(data as Archived[]);}).catch(onError);return()=>{live=false;};},[]);
  return <section className="umi-settings-group"><h2>已归档会话</h2><p>归档保留消息、事件与工作副本，可随时恢复到工作区列表。</p>{rows===null?<p>正在读取…</p>:rows.length===0?<p>暂无已归档会话</p>:<ul className="archive-list">{rows.map(row=><li key={row.id}><span><strong>{row.title}</strong><small>{row.workspace}</small></span><button disabled={busy!==null} onClick={()=>{if(busy)return;setBusy(row.id);void window.umi.request({type:'restore',conversationId:row.id}).then(()=>{setRows(current=>current?.filter(r=>r.id!==row.id)??[]);onRestore();}).catch(onError).finally(()=>setBusy(null));}}><ArchiveRestore size={14}/>恢复</button></li>)}</ul>}</section>;
}
