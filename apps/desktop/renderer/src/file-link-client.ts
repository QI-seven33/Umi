import {fileReferencePath} from '../../../../packages/protocol/src/file-reference.js';
import type {FileReferenceTarget} from '../../../../packages/protocol/src/file-reference.js';
type Reply={reference:string;target:FileReferenceTarget|null};
// 每个会话/文件事实代次最多256个不同引用，同批去重；流式文本不逐字发送IPC。
export class FileLinkClient {
 private readonly cache=new Map<string,Promise<FileReferenceTarget|null>>();
 private readonly queue:{reference:string;finish:(value:FileReferenceTarget|null)=>void}[]=[];
 private active=false;
 constructor(private readonly request:(references:string[])=>Promise<unknown>) {}
 resolve(reference:string):Promise<FileReferenceTarget|null>{
  if(!fileReferencePath(reference))return Promise.resolve(null);
  const existing=this.cache.get(reference);if(existing)return existing;
  if(this.cache.size>=256)return Promise.resolve(null);
  const pending=new Promise<FileReferenceTarget|null>(finish=>this.queue.push({reference,finish}));
  this.cache.set(reference,pending);if(!this.active){this.active=true;setTimeout(()=>void this.flush(),0);}return pending;
 }
 private async flush(){
  const batch=this.queue.splice(0,32);
  try{
   const response=await this.request(batch.map(item=>item.reference));
   for(const item of batch){const entry=Array.isArray(response)?(response as Reply[]).find(r=>r.reference===item.reference):null;item.finish(entry?.target??null);}
  }catch{for(const item of batch)item.finish(null);}
  finally{if(this.queue.length)setTimeout(()=>void this.flush(),0);else this.active=false;}
 }
}
