import {statSync} from 'node:fs';
import {fileReferenceCandidates} from '../../../protocol/src/file-reference.js';
import type {FileReferenceTarget} from '../../../protocol/src/file-reference.js';
import type {ResourceFiles} from './resources.js';
import {safeFile} from './paths.js';

// 只查有界的近期文件事实和候选元数据，不扫描项目、不读取正文、不签发权限。
export function resolvePreviewReferences(files:ResourceFiles,conversationId:string,references:readonly string[]) {
 const store=files.repo.store,env=store.environment(String(store.conversation(conversationId).environment_id));
 const mounts=files.repo.mounts(env.id).filter(m=>files.repo.authorized(m.resourceId,env.id));
 const previewMounts=mounts.map(m=>({mountId:m.id,resourceId:m.resourceId,sourceRoot:m.direct?m.root:m.sourceRoot,resourceScope:m.scope}));
 const known:FileReferenceTarget[]=[];
 for(const row of store.all(`SELECT t.args FROM tool_executions t JOIN runs r ON r.id=t.run_id
  WHERE r.conversation_id=? AND t.state='succeeded' AND t.name IN ('read_file','edit_file','write_file','restore_file_version','open_file')
  ORDER BY t.rowid DESC LIMIT 128`,conversationId)){
  try{const a=JSON.parse(String(row.args));if(typeof a.mountId==='string'&&typeof a.path==='string')known.push({mountId:a.mountId,path:a.path});}catch{}
 }
 let remaining=256;
 return references.map(reference=>{
  const candidates=fileReferenceCandidates(reference,previewMounts,known);
  if(candidates.length>32||candidates.length>remaining)return {reference,target:null};
  remaining-=candidates.length;
  const found=new Map<string,FileReferenceTarget>();
  for(const target of candidates){
   try{
    const m=mounts.find(m=>m.id===target.mountId)!;files.assertPath(m.scope,target.path);files.direct.check(m,false,target.path);
    const absolute=safeFile(m.root,target.path,m.rootIdentity),stat=statSync(absolute);
    if(!stat.isFile()||stat.size>4*1024*1024)continue;
    found.set(process.platform==='win32'?absolute.toLowerCase():absolute,target);
   }catch{/* 缺失、撤销、身份替换、链接和受保护目录均不可生成按钮。 */}
  }
  return {reference,target:found.size===1?[...found.values()][0]!:null};
 });
}
