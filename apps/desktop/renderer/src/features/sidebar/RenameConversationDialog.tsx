import { useRef, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog.js';
import { t as uiText } from '../../ui-language.js';
import { userFacingError } from '../../ui-error.js';
export function RenameConversationDialog({ id, title, onClose, onSaved }: {id:string;title:string;onClose:()=>void;onSaved:()=>Promise<unknown>}) {
  const [value,setValue]=useState(title),[busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false);
  return <Dialog title={uiText('重命名会话')} onClose={onClose} busy={busy} className="rename-dialog"><form onSubmit={async e=>{
    e.preventDefault();if(lock.current||!value.trim())return;lock.current=true;setBusy(true);setError('');
    try{await window.umi.request({type:'rename',conversationId:id,title:value.trim()});await onSaved();onClose();}
    catch(e){setError(userFacingError(e));}finally{lock.current=false;setBusy(false);}
  }}><p>{uiText('只修改标题，会话内容保持不变。')}</p><input autoFocus aria-label={uiText('会话标题')} value={value} maxLength={120} disabled={busy} onChange={e=>setValue(e.target.value)} onFocus={e=>e.target.select()}/>
    {error&&<p role="alert">{error}</p>}<div className="umi-confirm-actions"><button type="button" disabled={busy} onClick={onClose}>{uiText('取消')}</button><button className="ui-primary" disabled={busy||!value.trim()} type="submit">{busy?uiText('正在保存…'):uiText('保存')}</button></div></form></Dialog>;
}
