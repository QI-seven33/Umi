export type SendShortcut='enter'|'mod-enter';
export const sendShortcutKey='umi.sendShortcut';
export function readSendShortcut(storage:Pick<Storage,'getItem'>):SendShortcut{
  try{return storage.getItem(sendShortcutKey)==='mod-enter'?'mod-enter':'enter';}catch{return 'enter';}
}
export function shouldSend(event:{key:string;shiftKey:boolean;altKey:boolean;ctrlKey:boolean;metaKey:boolean;isComposing:boolean;keyCode:number},mode:SendShortcut){
  if(event.key!=='Enter'||event.shiftKey||event.altKey||event.isComposing||event.keyCode===229)return false;
  return mode==='enter'||event.ctrlKey||event.metaKey;
}
