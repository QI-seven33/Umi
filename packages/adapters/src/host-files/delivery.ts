import { readFileSync, unlinkSync } from 'node:fs';
import { ResourceFiles } from './resources.js';
import { atomicWrite, bytesHash, observe, safeFile, safeRoot, sameEntry } from './paths.js';
import { hostContext } from './scratch.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { ChangeSet, Mount, DeliveryReceipt } from '../../../protocol/src/resources.js';
import { UmiError } from '../../../protocol/src/model.js';
import { uid, hash } from '../../../agent/src/identity.js';
import { scan } from './paths.js';

export type DeliveryBoundary='before-intent'|'after-intent'|'after-effect'|'after-receipt';
export class DeliveryFiles {
  // 注入点只由测试构造函数提供，不是模型工具或公开命令。
  constructor(readonly files:ResourceFiles,private readonly boundary?: (point:DeliveryBoundary,path:string)=>void|Promise<void>) {}
  build(env:Environment,mountId:string,paths?:string[]) {
    const repo=this.files.repo,m=repo.mount(mountId,env.id);this.files.mountContext({},env,m.id,undefined,undefined,true);
    const baseline=repo.baseline(m),current=this.current(m),selected=paths??[...new Set([...Object.keys(baseline),...Object.keys(current)])].sort();
    const changes=selected.filter(p=>(baseline[p]?.hash??null)!==(current[p]?.hash??null)).map(path=>({path,before:baseline[path]??null,after:current[path]??null}));
    if(new Set(changes.map(c=>process.platform==='win32'?c.path.toLowerCase():c.path)).size!==changes.length)throw new UmiError('RESOURCE_CHANGED','变更集包含 Windows 大小写冲突，未创建交付');
    if(!changes.length)return {changeSetId:null,changes:[],message:'工作副本没有选定的内容变化'};
    if(changes.length>200)throw new UmiError('RESOURCE_LIMIT','一次变更集最多包含 200 个文件');
    for(const item of changes)if(item.after)this.files.saveBlob(env,readFileSync(safeFile(m.root,item.path,m.rootIdentity)));
    const cs:ChangeSet={schemaVersion:1,id:uid(),environmentId:env.id,mountId:m.id,baselineRef:m.baselineRef,createdAt:new Date().toISOString(),changes};repo.saveChangeSet(cs);
    return this.preview(cs,m,env);
  }
  private current(m:Mount) {
    // 副本清单同样有界；被忽略的依赖与 Git 内部数据不参与结构化交付。
    return this.filesScan(m);
  }
  private filesScan(m:Mount) {return scan(m.root).manifest;}
  preview(cs:ChangeSet,m:Mount,env:Environment) {
    return {changeSetId:cs.id,mountId:m.id,targetDirectory:m.sourceRoot,changes:cs.changes.map(c=>{
      const before=c.before?this.files.blob(env,c.before.hash):null,after=c.after?this.files.blob(env,c.after.hash):null;
      const text=(b:Buffer|null)=>{if(!b)return null;try{const s=new TextDecoder('utf-8',{fatal:true}).decode(b);return s.includes('\0')?null:s;}catch{return null;}};
      const b=text(before),a=text(after),limit=Math.min(12000,Math.floor(64000/(cs.changes.length*2)));
      return {path:c.path,operation:!c.before?'create':!c.after?'delete':'modify',beforeHash:c.before?.hash??null,afterHash:c.after?.hash??null,
        binary:Boolean(before&&b===null||after&&a===null),beforeText:b?.slice(0,limit)??null,afterText:a?.slice(0,limit)??null,
        beforeContentHash:c.before?.hash??null,afterContentHash:c.after?.hash??null,
        previewTruncated:(b?.length??0)>limit||(a?.length??0)>limit};})};
  }
  prepare(env:Environment,changeSetId:string):ExecutionContext {
    const cs=this.files.repo.changeSet(changeSetId,env.id),m=this.files.repo.mount(cs.mountId,env.id);
    this.files.mountContext({},env,m.id,undefined,undefined,true);safeRoot(m.sourceRoot,m.sourceIdentity);
    for(const t of env.active_run_id?this.files.repo.store.tools(env.active_run_id):[]) {
      if(t.name!=='deliver_changeset'||t.state!=='denied')continue;
      const oldId=(JSON.parse(t.args) as {changeSetId:string}).changeSetId,old=this.files.repo.changeSet(oldId,env.id);
      if(old.mountId===cs.mountId&&hash(old.changes.map(c=>({path:c.path,beforeHash:c.before?.hash??null,afterHash:c.after?.hash??null})))===hash(cs.changes.map(c=>({path:c.path,beforeHash:c.before?.hash??null,afterHash:c.after?.hash??null}))))
        throw new UmiError('OPERATION_DENIED','本次任务的等价交付已被拒绝，不能通过重建变更集重复请求');
    }
    if(this.files.repo.items(cs.id).length)throw new UmiError('CHANGESET_USED','该变更集已有交付记录，不能再次派发；请核验原执行或生成新的变更集');
    if(m.baselineRef!==cs.baselineRef)throw new UmiError('RESOURCE_CHANGED','变更集基线已更新，需要重新预览');
    this.checkAll(cs,m);
    return {...hostContext({},env),locations:cs.changes.flatMap(c=>[
      {schemaVersion:1 as const,environmentId:env.id,rootRef:{kind:'source' as const,resourceId:m.resourceId,bindingVersion:1},relativePath:c.path,
        physicalRoot:m.sourceRoot,physicalRootIdentity:m.sourceIdentity,beforeIdentity:c.before?.identity??null,beforeHash:c.before?.hash??null,desiredHash:c.after?.hash??null},
      {schemaVersion:1 as const,environmentId:env.id,rootRef:{kind:'mount' as const,mountId:m.id,area:'working' as const,bindingVersion:m.bindingVersion},relativePath:c.path,
        physicalRoot:m.root,physicalRootIdentity:m.rootIdentity,beforeIdentity:c.after?.identity??null,beforeHash:c.after?.hash??null,desiredHash:c.after?.hash??null}
    ])};
  }
  private checkAll(cs:ChangeSet,m:Mount) {
    for(const c of cs.changes) {
      if(!sameEntry(observe(m.sourceRoot,c.path,m.sourceIdentity),c.before))throw new UmiError('DELIVERY_CONFLICT',`源文件已变化或被替换：${c.path}；未写回`);
      if(!sameEntry(observe(m.root,c.path,m.rootIdentity),c.after))throw new UmiError('RESOURCE_CHANGED',`预览后工作副本已变化：${c.path}`);
    }
  }
  async apply(env:Environment,changeSetId:string,ctx:ExecutionContext,signal:AbortSignal):Promise<ToolResult> {
    const repo=this.files.repo,cs=repo.changeSet(changeSetId,env.id),m=repo.mount(cs.mountId,env.id);
    const prepared=this.prepare(env,cs.id);
    if(hash(prepared)!==hash(ctx))return {outcome:'failed',content:'交付定位已经失效，未写回。',data:null};
    try {
      for(const c of cs.changes) {
        signal.throwIfAborted();repo.store.checkLease(env.active_run_id!,repo.store.getRun(env.active_run_id!).generation);
        // 每项再次检查，先提交意图，再改变磁盘，最后提交观察与新基线。
        if(!sameEntry(observe(m.sourceRoot,c.path,m.sourceIdentity),c.before)||!sameEntry(observe(m.root,c.path,m.rootIdentity),c.after))
          return {outcome:'failed',content:`交付时出现冲突：${c.path}；已提交部分保留，未继续写入。`,data:{receipts:this.receipts(cs)}};
        if(this.boundary)await this.boundary('before-intent',c.path);repo.intent(cs,c.path);if(this.boundary)await this.boundary('after-intent',c.path);
        if(!sameEntry(observe(m.sourceRoot,c.path,m.sourceIdentity),c.before))throw new UmiError('DELIVERY_CONFLICT','提交意图后源目标变化，未继续写回');
        const file=safeFile(m.sourceRoot,c.path,m.sourceIdentity);
        if(c.after){const bytes=this.files.blob(env,c.after.hash);if(bytesHash(bytes)!==c.after.hash)throw new UmiError('PROTOCOL_INVALID','交付资料变化');atomicWrite(m.sourceRoot,c.path,bytes,m.sourceIdentity,repo.temporaryPath(cs,c.path)!);}
        else unlinkSync(file);
        if(this.boundary)await this.boundary('after-effect',c.path);const observed=observe(m.sourceRoot,c.path,m.sourceIdentity);
        if(!sameEntry(observed,c.after,false))throw new UmiError('DELIVERY_UNKNOWN','写回后观察不符合预期');
        repo.receipt(cs,m,{changeSetId:cs.id,path:c.path,outcome:'applied',observed,reason:'本次写回后逐项核验',observedAt:new Date().toISOString()});
        if(this.boundary)await this.boundary('after-receipt',c.path);
      }
      return {outcome:'succeeded',content:'变更集已获批准并逐项交付核验。',data:{changeSetId:cs.id,targetDirectory:m.sourceRoot,receipts:this.receipts(cs)}};
    }catch(e) {
      const uncertain=repo.items(cs.id).some(i=>i.state==='intent');
      return {outcome:uncertain?'unknown':'failed',content:uncertain?'交付在效果与回执边界中断，需核验原执行；未自动重写。':'交付已中断，已结算项目保留。',
        data:{code:e instanceof UmiError?e.code:'DELIVERY_INTERRUPTED',receipts:this.receipts(cs)}};
    }
  }
  private receipts(cs:ChangeSet) {return this.files.repo.items(cs.id).map(i=>i.receipt_ref?this.files.repo.store.readArtifact<DeliveryReceipt>(i.receipt_ref as string):{path:i.path,outcome:'unknown'});}
  reconcile(env:Environment,changeSetId:string,ctx:ExecutionContext):ToolResult {
    const repo=this.files.repo,cs=repo.changeSet(changeSetId,env.id),m=repo.mount(cs.mountId,env.id);hostContext({},env);safeRoot(m.sourceRoot,m.sourceIdentity);safeRoot(m.root,m.rootIdentity);
    if(ctx.environmentId!==env.id||ctx.locations.length!==cs.changes.length*2||cs.changes.some(c=>!ctx.locations.some(l=>l.rootRef.kind==='source'&&l.rootRef.resourceId===m.resourceId&&l.relativePath===c.path&&l.desiredHash===(c.after?.hash??null)&&l.physicalRootIdentity===m.sourceIdentity)))
      return {outcome:'unknown',content:'交付快照无法对应原变更集。',data:null,verification:'unknown'};
    for(const item of repo.items(cs.id)) {
      const c=cs.changes.find(c=>c.path===item.path)!;
      const observed=observe(m.sourceRoot,c.path,m.sourceIdentity);
      const saved=item.receipt_ref?repo.store.readArtifact<DeliveryReceipt>(item.receipt_ref as string):undefined;
      if(item.state==='settled'&&saved?.outcome!=='unknown') {
        const r=saved!;
        if(!sameEntry(observed,r.observed))return {outcome:'unknown',content:'已有回执的目标后来被修改或替换，需检查原交付。',data:{path:c.path},verification:'unknown'};
      }else {
        let outcome:DeliveryReceipt['outcome']=sameEntry(observed,c.after,false)?'satisfied':sameEntry(observed,c.before)?'not_applied':'unknown';
        if(outcome!=='unknown'&&item.temporary_path) {
          const temp=observe(m.sourceRoot,item.temporary_path as string,m.sourceIdentity);
          if(temp&&temp.hash!==c.after?.hash)outcome='unknown';
          else if(temp)unlinkSync(safeFile(m.sourceRoot,item.temporary_path as string,m.sourceIdentity));
        }
        repo.receipt(cs,m,{changeSetId:cs.id,path:c.path,outcome,observed,reason:outcome==='satisfied'?'预期内容已满足；不据此断言执行来源':'依据原前置条件核验，未重复写回',observedAt:new Date().toISOString()});
      }
    }
    const receipts=this.receipts(cs) as DeliveryReceipt[];
    if(receipts.some(r=>r.outcome==='unknown'))return {outcome:'unknown',content:'部分交付结果未知，禁止自动重写。',data:{receipts},verification:'unknown'};
    const complete=receipts.length===cs.changes.length&&receipts.every(r=>['applied','satisfied'].includes(r.outcome));
    return {outcome:complete?'succeeded':'failed',content:complete?'原变更集所有目标已核验；没有再次写回。':'交付未完整发生；已有结果保留，剩余修改需重新预览并批准。',
      data:{changeSetId:cs.id,receipts},verification:complete?'desired-state-verified':'partial-or-not-applied'};
  }
}
