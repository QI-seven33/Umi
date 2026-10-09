import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { TextDecoder } from 'node:util';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { hostContext } from './scratch.js';
import { atomicWrite, bytesHash, observe, rootIdentity, safeFile, safeRoot, scan, sameEntry } from './paths.js';
import { ResourceRepository } from '../sqlite/resources.js';
import type { Environment } from '../../../agent/src/persistence.js';
import type { Candidate, Mount, Manifest } from '../../../protocol/src/resources.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';
import { hash } from '../../../agent/src/identity.js';

export class ResourceFiles {
  constructor(readonly repo:ResourceRepository) {}
  initialize(environmentId:string):void {
    const c=this.repo.store.get('SELECT id FROM conversations WHERE environment_id=?',environmentId)!,conversationId=c.id as string;
    const candidates=this.repo.store.all('SELECT id FROM resource_candidates WHERE environment_id=? AND initial=1',environmentId);
    if(candidates.some(r=>this.repo.mounts(environmentId).some(m=>m.resourceId===r.id)||this.repo.store.snapshot(conversationId).resources[r.id as string]?.materializationError))return;
    try {this.bindInitial(conversationId);}catch(e) {
      const resource=this.repo.store.get('SELECT id FROM resource_candidates WHERE environment_id=? AND initial=1',environmentId);
      if(!resource)throw e;
      this.repo.store.commit(this.repo.scope(environmentId),{type:'resource.materialization_failed',payload:{resourceId:resource.id as string,
        code:e instanceof UmiError?e.code:'MATERIALIZATION_FAILED',reason:e instanceof UmiError?e.message:'初始工作区未完成物化；其他已获准工具仍可使用'}});
    }
  }
  bindInitial(conversationId:string):Mount {
    const c=this.repo.store.conversation(conversationId),env=this.repo.store.environment(c.environment_id as string);
    const path=this.repo.store.get('SELECT source_root FROM workspaces WHERE id=?',c.workspace_id as string)!.source_root as string;
    const candidate=this.repo.candidate(env.id,safeRoot(path),rootIdentity(path),true);this.repo.grant(candidate,'edit');return this.materialize(candidate);
  }
  discover(env:Environment,query:string,path?:string) {
    const candidates:Candidate[]=[],visited=new Set<string>(),coverage:{root:string;depth:number;visited:number;limited:boolean}[]=[];
    const add=(p:string)=>{try{const root=safeRoot(p);if(!visited.has(root)){visited.add(root);if(!query||root.toLocaleLowerCase().includes(query.toLocaleLowerCase()))candidates.push(this.repo.candidate(env.id,root,rootIdentity(root)));}}catch{}};
    if(path) {const p=resolve(path);if(existsSync(p)&&lstatSync(p).isFile())add(dirname(p));else add(p);
      return {candidates,coverage:[{root:p,depth:0,visited:1,limited:false}],contentRead:false,exactPath:true};}
    const c=this.repo.store.get('SELECT w.source_root FROM conversations c JOIN workspaces w ON w.id=c.workspace_id WHERE c.environment_id=?',env.id)!;
    const home=homedir(),roots=[c.source_root as string,dirname(c.source_root as string),join(home,'Desktop'),join(home,'Documents'),join(home,'Projects'),
      join(home,'OneDrive','Desktop'),join(home,'OneDrive','Documents'),...(process.env.OneDrive?[join(process.env.OneDrive,'Desktop'),join(process.env.OneDrive,'Documents')]:[])];
    const start=Date.now();let total=0;
    for(const root of [...new Set(roots)]) {
      let count=0,limited=false;
      const walk=(p:string,depth:number)=>{if(total>=2000||Date.now()-start>1500||candidates.length>=20){limited=true;return;}
        add(p);count++;total++;if(depth===2)return;
        let entries;try{safeRoot(p);entries=readdirSync(p,{withFileTypes:true});}catch{return;}
        for(const e of entries){if(e.isDirectory()&&!e.isSymbolicLink()&&!['.git','node_modules','.venv','environments'].includes(e.name))walk(join(p,e.name),depth+1);if(limited)break;}
      };walk(root,0);coverage.push({root,depth:2,visited:count,limited});
    }
    return {candidates,coverage,contentRead:false,exactPath:false};
  }
  resourceContext(input:unknown,env:Environment,candidateId:string,access:'read'|'edit',executionId?:string):ExecutionContext {
    const c=this.repo.getCandidate(candidateId,env.id);if(this.repo.denied(c,access))throw new UmiError('RESOURCE_DENIED','这个来源的等价资源权限已被拒绝；请改用获准资源');
    safeRoot(c.path,c.identity);const ctx=hostContext(input,env);
    const old=this.repo.mounts(env.id).find(m=>m.resourceId===c.id),mountId=old?.id??`mount-${hash({environmentId:env.id,resourceId:c.id,executionId:executionId??'initial'}).slice(0,40)}`;
    const root=join(env.root,'working',mountId);
    return {...ctx,locations:[{schemaVersion:1,environmentId:env.id,rootRef:{kind:'source',resourceId:c.id,bindingVersion:1},relativePath:'resource',
      beforeHash:null,desiredHash:null,physicalRoot:c.path,physicalRootIdentity:c.identity},
      {schemaVersion:1,environmentId:env.id,rootRef:{kind:'mount',mountId,area:'working',bindingVersion:1},relativePath:'resource',beforeHash:null,desiredHash:null,
        physicalRoot:root,...(old?{physicalRootIdentity:old.rootIdentity}:{})}]};
  }
  mountContext(input:unknown,env:Environment,mountId:string,path?:string,desiredHash?:string|null,edit=false):ExecutionContext {
    const m=this.repo.mount(mountId,env.id);if(!this.repo.authorized(m.resourceId,env.id,edit))throw new UmiError('PERMISSION_DENIED','当前任务没有该工作副本所需权限');
    safeRoot(m.root,m.rootIdentity);const ctx=hostContext(input,env);
    if(!path)return ctx;
    const before=observe(m.root,path,m.rootIdentity);
    return {...ctx,locations:[{schemaVersion:1,environmentId:env.id,rootRef:{kind:'mount',mountId:m.id,area:'working',bindingVersion:m.bindingVersion},relativePath:path,
      beforeHash:before?.hash??null,desiredHash:desiredHash===undefined?before?.hash??null:desiredHash,physicalRoot:m.root,physicalRootIdentity:m.rootIdentity,beforeIdentity:before?.identity??null}]};
  }
  materialize(c:Candidate,plannedMountId?:string):Mount {
    const steps=this.materializationSteps(c,plannedMountId);
    while(true){const step=steps.next();if(step.done)return step.value;}
  }
  async materializeAsync(c:Candidate,plannedMountId:string,signal:AbortSignal):Promise<Mount> {
    const steps=this.materializationSteps(c,plannedMountId,signal),start=Date.now();let count=0;
    while(true){
      signal.throwIfAborted();
      if(Date.now()-start>30000)throw new UmiError('RESOURCE_LIMIT','物化超过本次时间限额；已保存计划，可核验部分副本');
      const step=steps.next();if(step.done)return step.value;
      if(++count%16===0)await yieldIO(undefined,{signal});
    }
  }
  private *materializationSteps(c:Candidate,plannedMountId?:string,signal?:AbortSignal):Generator<void,Mount> {
    if(!this.repo.authorized(c.id,c.environmentId))throw new UmiError('PERMISSION_DENIED','来源尚未授权，未读取正文');
    const old=this.repo.mounts(c.environmentId).find(m=>m.resourceId===c.id);
    if(old){safeRoot(old.root,old.rootIdentity);safeRoot(c.path,c.identity);return old;}
    const env=this.repo.store.environment(c.environmentId);hostContext({},env);safeRoot(c.path,c.identity);
    // 托管数据不能递归成为自身的来源。运行数据库与环境目录也不作为用户资料物化。
    const excluded=[this.repo.store.dataRoot,join(this.repo.store.dataRoot,'environments'),join(this.repo.store.dataRoot,'umi.sqlite'),
      join(this.repo.store.dataRoot,'umi.sqlite-wal'),join(this.repo.store.dataRoot,'umi.sqlite-shm'),join(this.repo.store.dataRoot,'writer.lock')];
    const scanned=scan(c.path,excluded),mountId=plannedMountId??`mount-${hash({environmentId:env.id,resourceId:c.id,executionId:'initial'}).slice(0,40)}`,root=join(env.root,'working',mountId);
    if(existsSync(root))throw new UmiError('RESOURCE_CHANGED','计划物化位置已经存在，不能覆盖旧副本；请核验原执行');
    this.repo.beginMaterialization(c,mountId,root,scanned.manifest,scanned.excluded);mkdirSync(root,{recursive:true});
    this.repo.bindMaterializationRoot(mountId,env.id,rootIdentity(root));
    const manifest:Manifest={};
    for(const [path,entry] of Object.entries(scanned.manifest)) {
      signal?.throwIfAborted();
      const file=safeFile(c.path,path,c.identity),bytes=readFileSync(file);
      if(!sameEntry(observe(c.path,path,c.identity),entry)||bytesHash(bytes)!==entry.hash)throw new UmiError('RESOURCE_CHANGED','物化时来源文件已变化');
      this.saveBlob(env,bytes);atomicWrite(root,path,bytes);manifest[path]=entry;
      yield;
    }
    const after=scan(c.path,excluded).manifest;
    if(Object.keys(after).length!==Object.keys(manifest).length||Object.entries(manifest).some(([p,e])=>!sameEntry(after[p]??null,e)))
      throw new UmiError('RESOURCE_CHANGED','物化期间来源目录变化，未发布挂载');
    this.repo.addMount({id:mountId,environmentId:env.id,resourceId:c.id,root,rootIdentity:rootIdentity(root),bindingVersion:1,sourceRoot:c.path,sourceIdentity:c.identity},manifest,scanned.excluded);
    return this.repo.mount(mountId,env.id);
  }
  reconcileMaterialization(c:Candidate,ctx:ExecutionContext):Mount|undefined {
    const location=ctx.locations.find(l=>l.rootRef.kind==='mount');if(!location||location.rootRef.kind!=='mount')return undefined;
    const record=this.repo.materialization(location.rootRef.mountId,c.environmentId);if(!record?.rootIdentity)return undefined;
    const env=this.repo.store.environment(c.environmentId);hostContext({},env);
    if(record.resourceId!==c.id||record.plan.sourceRoot!==c.path||record.plan.sourceIdentity!==c.identity||record.plan.root!==location.physicalRoot)return undefined;
    safeRoot(record.plan.root,record.rootIdentity);const current=scan(record.plan.root).manifest;
    if(Object.keys(current).length!==Object.keys(record.plan.manifest).length||Object.entries(record.plan.manifest).some(([p,e])=>!sameEntry(current[p]??null,e,false)))return undefined;
    for(const e of Object.values(record.plan.manifest))this.blob(env,e.hash);
    this.repo.addMount({id:record.id,environmentId:env.id,resourceId:c.id,root:record.plan.root,rootIdentity:record.rootIdentity,bindingVersion:1,sourceRoot:c.path,sourceIdentity:c.identity},record.plan.manifest,record.plan.excluded);
    return this.repo.mount(record.id,env.id);
  }
  saveBlob(env:Environment,bytes:Uint8Array):string {
    hostContext({},env);const digest=bytesHash(bytes),root=join(env.root,'task','artifacts','content');mkdirSync(root,{recursive:true});safeRoot(root);
    const path=`${digest}.bin`,file=safeFile(root,path);
    if(!existsSync(file))atomicWrite(root,path,bytes);else if(bytesHash(readFileSync(file))!==digest)throw new UmiError('PROTOCOL_INVALID','内容资料指纹不一致');return digest;
  }
  blob(env:Environment,digest:string):Buffer {
    if(!/^[a-f0-9]{64}$/.test(digest))throw new UmiError('PROTOCOL_INVALID','内容资料标识无效');hostContext({},env);
    const data=readFileSync(safeFile(join(env.root,'task','artifacts','content'),`${digest}.bin`));if(bytesHash(data)!==digest)throw new UmiError('PROTOCOL_INVALID','内容资料被修改');return data;
  }
  read(m:Mount,path:string,startByte=0,byteLength=8192) {
    const entry=observe(m.root,path,m.rootIdentity);if(!entry)throw new UmiError('NOT_FOUND','工作副本文件不存在');
    const bytes=readFileSync(safeFile(m.root,path,m.rootIdentity));if(bytesHash(bytes)!==entry.hash)throw new UmiError('RESOURCE_CHANGED','预览期间文件改变');
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new Error('binary');}
    catch{return {mountId:m.id,path,kind:'binary',size:bytes.length,hash:entry.hash,previewSupported:false};}
    const start=Math.min(startByte,bytes.length);let end=Math.min(start+byteLength,bytes.length);
    if(start<bytes.length&&(bytes[start]!&0xc0)===0x80)throw new UmiError('PROTOCOL_INVALID','起点切开 UTF-8 字符');
    while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;
    return {mountId:m.id,path,kind:'text',encoding:'utf-8',hash:entry.hash,size:bytes.length,startByte:start,endByte:end,truncated:end<bytes.length,text:bytes.subarray(start,end).toString('utf8')};
  }
}
