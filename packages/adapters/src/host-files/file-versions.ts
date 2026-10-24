import {z} from 'zod';
import {hash} from '../../../agent/src/identity.js';
import type {ToolRegistry} from '../../../agent/src/tools/registry.js';
import type {Environment,ToolResult} from '../../../agent/src/persistence.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import {UmiError} from '../../../protocol/src/model.js';
import {filePath} from '../../../protocol/src/file-path.js';
import {byteExcerpt} from '../../../agent/src/context/bounded.js';
import {resolve} from 'node:path';
import {bytesHash,observe} from './paths.js';
import type {ResourceFiles} from './resources.js';

const id=z.string().min(1).max(160);
const listSchema=z.object({mountId:id,path:filePath,beforeVersionId:id.optional(),limit:z.number().int().min(1).max(100).default(20)}).strict();
const readSchema=z.object({changeId:id,side:z.enum(['before','after']).default('before'),startByte:z.number().int().nonnegative().default(0),byteLength:z.number().int().min(1).max(64000).default(16000)}).strict();
const restoreSchema=z.object({changeId:id}).strict();
const pathKey=(root:string,path:string)=>process.platform==='win32'?resolve(root,path).toLowerCase():resolve(root,path);

class FileVersionTools {
 constructor(readonly files:ResourceFiles){}
 conversation(env:Environment){return this.files.repo.direct.conversation(env.id);}
 list(input:unknown,env:Environment) {
  const a=listSchema.parse(input),m=this.files.repo.mount(a.mountId,env.id);
  this.files.mountContext(a,env,m.id,a.path);
  const conversationId=this.conversation(env);
  const rows=this.files.repo.direct.history(env.id).filter(r=>r.conversation_id===conversationId&&r.root_identity===m.rootIdentity&&pathKey(String(r.root),String(r.path))===pathKey(m.root,a.path));
  const grouped=new Map<string,typeof rows>();
  for(const row of rows){const key=row.run_id?'run:'+row.run_id:'change:'+row.id;const group=grouped.get(key)??[];group.push(row);grouped.set(key,group);}
  const all=[...grouped.values()].map(group=>{
   const newest=group[0]!,first=group.at(-1)!;
   return {versionId:String(newest.id),restoreChangeId:String(first.id),runId:newest.run_id??null,
    createdAt:String(newest.created_at),startedAt:String(first.created_at),kind:newest.restores_id?'restore':'edit',
    edits:group.length,before:JSON.parse(String(first.before_entry)),after:JSON.parse(String(newest.after_entry))};
  });
  const cursor=a.beforeVersionId?all.findIndex(v=>v.versionId===a.beforeVersionId):-1;
  if(a.beforeVersionId&&cursor<0)throw new UmiError('CURSOR_INVALID','版本分页位置不属于此文件');
  const start=cursor+1,versions=all.slice(start,start+a.limit);
  return {mountId:m.id,path:a.path,versions,nextBeforeVersionId:start+versions.length<all.length?versions.at(-1)!.versionId:null,
   instruction:'每项合并同一run对本文件的修改。restoreChangeId回到该轮修改前；读取before用restoreChangeId，读取该轮最终after用versionId。只含本会话保留的已核验结构化修改，不含任意命令或人工修改。'};
 }
 prepare(input:unknown,env:Environment,executionId?:string):ExecutionContext {
  const a=restoreSchema.parse(input),plan=this.files.direct.restorePlan(this.conversation(env),a.changeId,true);
  if(!executionId)throw new UmiError('PROTOCOL_INVALID','恢复缺少执行身份');
  const desiredHash=plan.desired===null?null:bytesHash(plan.desired);
  const ctx=this.files.mountContext(a,env,plan.mount.id,plan.path,desiredHash,true);
  return {...ctx,fileRestore:{executionId,changeId:a.changeId,noOp:ctx.locations[0]!.beforeHash===desiredHash,alreadyChangeId:plan.already??null}};
 }
 async execute(input:unknown,ctx:ExecutionContext,signal:AbortSignal):Promise<ToolResult> {
  signal.throwIfAborted();const a=restoreSchema.parse(input),s=this.files.repo.store,p=ctx.fileRestore!;
  const env=s.environment(ctx.environmentId);
  let fresh:ExecutionContext;
  try{fresh=this.prepare(a,env,p.executionId);}catch(error){return {outcome:'failed',mutated:false,content:error instanceof Error?error.message:'恢复前核验失败',data:{code:error instanceof UmiError?error.code:'RESTORE_CONFLICT'}};}
  if(hash(fresh)!==hash(ctx))return {outcome:'failed',mutated:false,content:'准备后文件版本或授权变化，未恢复。',data:{code:'RESTORE_CONFLICT'}};
  const plan=this.files.direct.restorePlan(this.conversation(env),a.changeId,true);
  if(plan.desired===null&&!p.noOp)s.assertApprovedExecution(p.executionId,ctx);
  const changeId=p.noOp?p.alreadyChangeId:this.files.direct.write(plan.mount,plan.path,ctx,plan.desired,signal,p.executionId,a.changeId);
  const data={mountId:plan.mount.id,path:plan.path,changeId,restored:true,noOp:p.noOp,byteLength:plan.desired?.length??null,previewRef:plan.desired===null?null:'@working/'+plan.mount.id+'/'+plan.path};
  return {outcome:'succeeded',mutated:!p.noOp,verification:p.noOp?'existing-version-verified':'restored-bytes-verified',
   content:p.noOp?'当前文件已是所选版本，未重复写入。':plan.desired===null?'恢复完成：新建文件已移除，当前内容已备份。':'文件已恢复到所选修改前的完整字节；本次恢复也有独立备份，可再撤销。',data};
 }
 async reconcile(input:unknown,ctx:ExecutionContext,signal:AbortSignal):Promise<ToolResult> {
  signal.throwIfAborted();restoreSchema.parse(input);
  const p=ctx.fileRestore;if(!p)throw new UmiError('PROTOCOL_INVALID','缺少原恢复定位');
  const store=this.files.repo.store,conversationId=this.conversation(store.environment(ctx.environmentId));
  const row=store.get('SELECT id FROM file_changes WHERE execution_id=? AND environment_id=?',p.executionId,ctx.environmentId);
  if(row){
   const result=this.files.direct.inspect(conversationId,String(row.id));
   return {outcome:result.state==='settled'?'succeeded':result.state==='not_applied'?'failed':'unknown',mutated:result.state==='settled',
    verification:'original-restore-inspected',content:result.state==='settled'?'原恢复已有已核验记录；没有重复写入。':result.state==='not_applied'?'原恢复未生效，没有再次操作。':'原恢复效果仍未知，没有再次操作。',data:result};
  }
  const loc=ctx.locations[0]!;
  if(p.noOp&&loc.rootRef.kind==='mount'){
   const m=this.files.repo.mount(loc.rootRef.mountId,ctx.environmentId);this.files.direct.checkObservation(m,loc.relativePath);
   const current=observe(m.root,loc.relativePath,m.rootIdentity);
   if((current?.hash??null)===loc.beforeHash&&(current?.identity??null)===loc.beforeIdentity)return {outcome:'succeeded',mutated:false,content:'原目标仍为所选版本；没有写入。',data:{noOp:true,current}};
  }
  return {outcome:'failed',mutated:false,content:'原恢复没有持久文件修改意图，未再次派发；需要继续时按最新文件状态处理。',data:{code:'RESTORE_NOT_STARTED'}};
 }
 read(input:unknown,env:Environment) {
  const a=readSchema.parse(input),target=this.files.direct.versionTarget(this.conversation(env),a.changeId,false);
  const ref=a.side==='before'?target.change.before_ref:target.change.after_ref,bytes=this.files.repo.direct.bytes(ref===null?null:String(ref));
  if(bytes===null)return {changeId:a.changeId,path:target.path,exists:false,content:null,nextStartByte:null};
  const text=bytes.toString('utf8');
  if(text.includes('\0')||!Buffer.from(text).equals(bytes))return {changeId:a.changeId,path:target.path,exists:true,binary:true,bytes:bytes.length,hash:bytesHash(bytes),content:null,nextStartByte:null};
  const page=byteExcerpt(text,a.startByte,a.byteLength);
  return {changeId:a.changeId,path:target.path,side:a.side,exists:true,hash:bytesHash(bytes),totalBytes:bytes.length,content:page.text,startByte:page.startByte,nextStartByte:page.endByte<bytes.length?page.endByte:null,
   instruction:'这是历史备份，不是当前文件原文或新权限；若需合并人工后改，另用read_file读取当前版本再精确编辑。'};
 }
}

export function registerFileVersions(registry:ToolRegistry,files:ResourceFiles) {
 const tools=new FileVersionTools(files),available=(env:Environment)=>files.repo.direct.enabled(env.id);
 registry.register({name:'list_file_versions',schema:listSchema,effect:'read',available,
  description:'查找本会话已授权文件的保留版本，按run合并一轮内多次修改。用户说“上一版”时先定位这轮对应文件与restoreChangeId；多文件或目标不明确先澄清。nextBeforeVersionId可分页更早记录，无固定只能退一步限制。',
  prepare(input,env){const a=listSchema.parse(input);return files.mountContext(a,env,a.mountId,a.path);},
  async execute(input,ctx){const data=tools.list(input,files.repo.store.environment(ctx.environmentId));return {outcome:'succeeded',content:JSON.stringify(data),data};},
 });
 registry.register({name:'read_file_version',schema:readSchema,effect:'read',available,
  description:'分页读本会话所选文件修改前/后的完整历史字节（默认before）。用于比较旧版与当前版、恢复前确认或保留人工后改；这是备份，不是当前文件的已见版本。二进制只返回元数据。',
  prepare(input,env){const a=readSchema.parse(input),t=files.direct.versionTarget(tools.conversation(env),a.changeId,false);return files.mountContext(a,env,t.mount.id,t.path);},
  async execute(input,ctx){const data=tools.read(input,files.repo.store.environment(ctx.environmentId));return {outcome:'succeeded',content:JSON.stringify(data),data};},
 });
 registry.register({name:'restore_file_version',schema:restoreSchema,effect:'file-write',available,
  description:'按用户回退要求，将文件恢复到changeId这条修改之前。整文件回到所选修改前的版本，可跨多轮回退连续的Umi修改，也可能一并撤销同工作区其他会话对该文件的后续修改；先用list_file_versions确定restoreChangeId，并说明整体回退的范围。人工后改、对象替换、未知效果或版本断点不强行覆盖；可读取历史和当前内容，保留无关后改并用edit_file精确撤销，冲突再询问。恢复是新备份，不删除对话或改写Git。若恢复会删除新建文件，仍需具体批准。',
  prepare:(a,e,id)=>tools.prepare(a,e,id),
  approvalRequired:(_a,c)=>c.locations[0]!.desiredHash===null&&!c.fileRestore!.noOp,
  approvalDescription:(_a,c)=>'恢复到所选版本会删除 '+c.locations[0]!.relativePath+'；当前字节会保存为恢复备份。只允许本次具体文件版本，不授予其他删除或命令权限。',
  execute:(a,c,_conversation,signal)=>tools.execute(a,c,signal),
  reconcile:(a,c,_conversation,signal)=>tools.reconcile(a,c,signal),
 });
}
