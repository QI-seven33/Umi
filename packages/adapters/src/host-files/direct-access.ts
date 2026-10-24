import {frozenDiff} from './frozen-preview.js';
import {byteExcerpt} from '../../../agent/src/context/bounded.js';
import {readFileSync,unlinkSync} from 'node:fs';
import {dirname,resolve,relative,sep} from 'node:path';
import type {ResourceRepository} from '../sqlite/resources.js';
import type {Mount,Candidate} from '../../../protocol/src/resources.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import {UmiError} from '../../../protocol/src/model.js';
import {safeRoot,safeFile,rootIdentity,observe,sameEntry,bytesHash,atomicWrite,createExclusive} from './paths.js';

// 宿主文件适配器：授权与写前恢复内容使用同一个仓储；没有新的执行循环。
export class DirectFileAccess {
  constructor(readonly repo:ResourceRepository,readonly protectedRoots:readonly string[]=[]) {}
  private contains(root:string,target:string) {const r=relative(resolve(root),resolve(target));return !r || (!r.startsWith('..'+sep)&&r!=='..'&&!r.startsWith(sep)&&!r.includes(':'));}
  protect(target:string) {
    if([this.repo.store.dataRoot,...this.protectedRoots].some(root=>this.contains(root,target))) throw new UmiError('PERMISSION_DENIED','Umi 控制数据不属于普通文件授权范围');
  }
  check(m:Mount,edit=false,path?:string,ignoreChange?:string) {
    if(!m.direct) return;
    this.repo.direct.assert(m,edit);safeRoot(m.root,m.rootIdentity);
    if(path) this.protect(safeFile(m.root,path,m.rootIdentity)); else this.protect(m.root);
    if(edit && path) {
      const pending=this.repo.store.all("SELECT c.id,c.path,g.root FROM file_changes c JOIN direct_file_mounts m ON m.id=c.mount_id JOIN workspace_file_grants g ON g.id=m.grant_id WHERE g.workspace_id=? AND c.state='intent'",this.repo.direct.workspace(m.environmentId));
      if(pending.some(c=>c.id!==ignoreChange&&resolve(String(c.root),String(c.path)).toLowerCase()===resolve(m.root,path).toLowerCase())) throw new UmiError('TOOL_OUTCOME_UNKNOWN','此文件有未决修改，先核验原目标，不能覆盖');
    }
  }
  // 原未知效果只能观察被冻结的位置；新授权可允许观察，不能让旧批准重新写入。
  checkObservation(m:Mount,path:string) {
    if(!m.direct) return;
    try {this.check(m,false,path);return;} catch(e) {if(!(e instanceof UmiError)||e.code!=='ACCESS_REVOKED')throw e;}
    const target=safeFile(m.root,path,m.rootIdentity);this.protect(target);
    const allowed=this.repo.direct.grants(m.environmentId).some(g=>{
      if(g.revoked===1||!this.contains(String(g.root),target))return false;
      safeRoot(String(g.root),String(g.root_identity));
      const scope=JSON.parse(String(g.scope));return scope.kind==='directory'||relative(String(g.root),target)===scope.path;
    });
    if(!allowed)throw new UmiError('ACCESS_REVOKED','原目标当前没有读取授权，未核验；请由用户重新选择目录授权');
  }
  grant(c:Candidate,access:'read'|'edit',authority:string) {
    const root=c.scope.kind==='file'?dirname(c.path):c.path,identity=c.scope.kind==='file'?c.scope.rootIdentity:c.identity;
    safeRoot(root,identity);this.protect(c.path);
    const id=this.repo.store.transaction(()=>this.repo.direct.createGrant(c.environmentId,root,identity,c.scope,access,authority));
    return this.repo.direct.attach(c,id);
  }
  initialize(environmentId:string) {
    if(!this.repo.direct.enabled(environmentId)) return;
    for(const g of this.repo.direct.grants(environmentId).filter(g=>g.revoked===0)) {
      // 同工作区的新会话复用明确的目录授权；旧副本不会被改绑。
      const scope=JSON.parse(String(g.scope)),path=scope.kind==='file'?resolve(String(g.root),scope.path):String(g.root);
      const c=this.repo.candidate(environmentId,path,String(g.root_identity),false,scope);
      this.repo.direct.attach(c,String(g.id));
    }
  }
  validateSelection(path:string,expectedIdentity?:string) {const root=safeRoot(path,expectedIdentity);this.protect(root);return root;}
  select(conversationId:string,expectedIdentity?:string) {
    const c=this.repo.store.conversation(conversationId),env=String(c.environment_id),w=this.repo.store.get('SELECT source_root FROM workspaces WHERE id=?',c.workspace_id!)!;
    const root=this.validateSelection(String(w.source_root),expectedIdentity);
    this.repo.direct.enable(env);
    const candidate=this.repo.candidate(env,root,rootIdentity(root),true);
    this.grant(candidate,'edit','user-directory-selection');this.initialize(env);
  }
  requireReusable(environmentId:string) {
    const w=this.repo.store.get('SELECT source_root FROM workspaces WHERE id=?',this.repo.direct.workspace(environmentId))!;
    const g=this.repo.direct.grants(environmentId).find(g=>g.revoked===0&&g.access==='edit'&&g.root===w.source_root&&JSON.parse(String(g.scope)).kind==='directory');
    if(!g) throw new UmiError('PERMISSION_DENIED','此工作区尚无有效的直接编辑授权，请重新选择目录并授权；旧副本批准不会升级');
    safeRoot(String(g.root),String(g.root_identity));
  }
  write(m:Mount,path:string,ctx:ExecutionContext,desired:Buffer|null,signal:AbortSignal,executionId?:string,restoresId?:string) {
    this.check(m,true,path);
    if(ctx.directoryGrant?.id!==m.direct!.grantId||ctx.directoryGrant.revision!==m.direct!.revision) throw new UmiError('ACCESS_REVOKED','原执行的目录授权已失效');
    const loc=ctx.locations[0]!,before=observe(m.root,path,m.rootIdentity);
    if((before?.hash??null)!==loc.beforeHash||(before?.identity??null)!==loc.beforeIdentity) throw new UmiError('RESOURCE_CHANGED','写入前目标已变化');
    const bytes=before?readFileSync(safeFile(m.root,path,m.rootIdentity)):null;
    if(bytes&&bytesHash(bytes)!==before!.hash) throw new UmiError('RESOURCE_CHANGED','备份期间原字节已变化');
    // 不将模型回执作为备份；完整原字节持久化成功以后才允许修改源文件。
    const id=this.repo.direct.intent(m,path,before,bytes,desired,executionId,restoresId);
    signal.throwIfAborted();this.check(m,true,path,id);
    if(desired===null) {
      if(!sameEntry(observe(m.root,path,m.rootIdentity),before)) throw new UmiError('RESOURCE_CHANGED','删除前目标已变化');
      if(before) unlinkSync(safeFile(m.root,path,m.rootIdentity));
    } else if(before) atomicWrite(m.root,path,desired,m.rootIdentity,undefined,before);
    else createExclusive(m.root,path,desired,m.rootIdentity);
    const after=observe(m.root,path,m.rootIdentity);
    if((after?.hash??null)!==(desired?bytesHash(desired):null)) throw new UmiError('RESOURCE_CHANGED','修改后字节核验失败');
    this.repo.direct.settle(id,m.environmentId,after);return id;
  }
  reconcile(m:Mount,executionId:string,applied:boolean) {
    if(!m.direct) return;
    const c=this.repo.store.get('SELECT id,path,state FROM file_changes WHERE execution_id=? AND mount_id=?',executionId,m.id);
    if(c?.state==='intent') this.repo.direct.settle(String(c.id),m.environmentId,observe(m.root,String(c.path),m.rootIdentity),applied?'settled':'not_applied');
  }
  inspect(conversationId:string,id:string) {
    const c=this.repo.direct.change(id,conversationId),m=this.repo.mount(String(c.mount_id),String(c.environment_id));
    this.checkObservation(m,String(c.path));
    const current=observe(m.root,String(c.path),m.rootIdentity),before=JSON.parse(String(c.before_entry));
    if(c.state!=='intent') return {state:String(c.state),current,matchesBefore:sameEntry(current,before,false),matchesAfter:sameEntry(current,JSON.parse(String(c.after_entry)),false)};
    if((current?.hash??null)===c.desired_hash) {this.repo.direct.settle(id,m.environmentId,current);return {state:'settled',current,matchesAfter:true};}
    if(sameEntry(current,before)){this.repo.direct.settle(id,m.environmentId,current,'not_applied');return {state:'not_applied',current};}
    return {state:'unknown',current};
  }
  preview(conversationId:string,id:string,startByte=0,byteLength=64000) {
    const c=this.repo.direct.change(id,conversationId);
    const before=this.repo.direct.bytes(c.before_ref===null?null:String(c.before_ref)),after=this.repo.direct.bytes(c.after_ref===null?null:String(c.after_ref));
    const diff=frozenDiff(before?.toString('utf8')??'',after?.toString('utf8')??''),page=byteExcerpt(diff,startByte,byteLength);
    return {id,path:c.path,state:c.state,diff:page.text,truncated:page.endByte<Buffer.byteLength(diff),nextStartByte:page.endByte<Buffer.byteLength(diff)?page.endByte:null};
  }
  // 恢复产生新文件身份；旧入口沿恢复关系，自然语言入口沿已核验写入链，不放宽外部替换检查。
  private restoreRelation(m:Mount,path:string,id:string,current:ReturnType<typeof observe>,allowSuccessors=false) {
    const key=(root:string,file:string)=>process.platform==='win32'?resolve(root,file).toLowerCase():resolve(root,file);
    const rows=this.repo.direct.history(m.environmentId).filter(r=>key(String(r.root),String(r.path))===key(m.root,path));
    const entries=new Map(rows.map(r=>[String(r.id),r]));
    const selected=entries.get(id)!;
    const after=JSON.parse(String(selected.after_entry));
    const validRestore=(row:typeof selected)=>{
      const target=row.restores_id?entries.get(String(row.restores_id)):undefined;
      return target && BigInt(String(target.ordinal))<BigInt(String(row.ordinal)) && row.after_ref===target.before_ref ? target : undefined;
    };
    const completed=rows.find(r=>r.restores_id===id&&validRestore(r)&&sameEntry(current,JSON.parse(String(r.after_entry))));
    if(completed)return {already:String(completed.id),matches:true};
    if(allowSuccessors){
      // 按真实时间顺序反向核对每次Umi写入，包括恢复本身；外部版本断点拒绝覆盖。
      let logical=current,limit:bigint|undefined;
      while(!sameEntry(logical,after)){
        const successor=rows.find(r=>BigInt(String(r.ordinal))>BigInt(String(selected.ordinal))&&(limit===undefined||BigInt(String(r.ordinal))<limit)&&sameEntry(logical,JSON.parse(String(r.after_entry))));
        if(!successor)return {matches:false};
        logical=JSON.parse(String(successor.before_entry));limit=BigInt(String(successor.ordinal));
      }
      return {matches:true};
    }
    let logical=current,limit:bigint|undefined;
    while(!sameEntry(logical,after)) {
      const restore=rows.find(r=>r.restores_id&&(limit===undefined||BigInt(String(r.ordinal))<limit)&&validRestore(r)&&sameEntry(logical,JSON.parse(String(r.after_entry))));
      if(!restore)return {matches:false};
      const target=validRestore(restore)!;
      logical=JSON.parse(String(target.before_entry));limit=BigInt(String(target.ordinal));
    }
    return {matches:true};
  }
  versionTarget(conversationId:string,id:string,edit=false) {
    const c=this.repo.direct.change(id,conversationId);let m=this.repo.mount(String(c.mount_id),String(c.environment_id));
    if(c.state!=='settled') throw new UmiError('TOOL_OUTCOME_UNKNOWN','修改尚未核验，不能恢复；请先检查原目标');
    if(m.direct && this.repo.direct.grant(m.direct.grantId,m.environmentId).revoked===1) {
      this.initialize(m.environmentId);
      const active=this.repo.direct.mounts(m.environmentId).find(n=>n.root===m.root&&n.rootIdentity===m.rootIdentity&&this.repo.direct.grant(n.direct!.grantId,n.environmentId).revoked===0&&(!edit||this.repo.direct.grant(n.direct!.grantId,n.environmentId).access==='edit')&&(n.scope.kind==='directory'||n.scope.path===c.path));
      if(active)m=active;
    }
    this.check(m,edit,String(c.path));
    return {change:c,mount:m,path:String(c.path)};
  }
  restorePlan(conversationId:string,id:string,allowSuccessors=false) {
    const {change:c,mount:m,path}=this.versionTarget(conversationId,id,true);
    const current=observe(m.root,path,m.rootIdentity),relation=this.restoreRelation(m,path,id,current,allowSuccessors);
    const desired=this.repo.direct.bytes(c.before_ref===null?null:String(c.before_ref));
    const alreadyDesired=allowSuccessors&&(current?.hash??null)===(desired===null?null:bytesHash(desired));
    if(!relation.matches&&!alreadyDesired) throw new UmiError('RESTORE_CONFLICT','文件已有后续修改或被替换，未恢复；请查看变化后决定');
    return {mount:m,path,desired,already:relation.already};
  }
  restore(conversationId:string,id:string,context:(m:Mount,path:string,desired:string|null)=>ExecutionContext) {
    const plan=this.restorePlan(conversationId,id);
    const changeId=plan.already??this.write(plan.mount,plan.path,context(plan.mount,plan.path,plan.desired?bytesHash(plan.desired):null),plan.desired,new AbortController().signal,undefined,id);
    return {changeId,path:plan.path,restored:true,alreadyRestored:Boolean(plan.already),byteLength:plan.desired?.length??null};
  }
}
