import {mkdirSync,readdirSync,readFileSync,statSync,lstatSync,renameSync,rmSync,existsSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UmiError} from '../../../protocol/src/model.js';
import {githubSkillInput,importId,importRecord,importOrigin} from '../../../protocol/src/skill-import.js';
import type {GithubSkillInput,SkillImportRecord,SkillImportSnapshot,SkillImportSummary} from '../../../protocol/src/skill-import.js';
import {atomicWrite,bytesHash,safeRoot,safeFile} from '../host-files/paths.js';
import {LocalSkillLibrary} from './library.js';
import {GithubSkillSource,githubCoordinates} from './github.js';

const digest=(snapshot:SkillImportSnapshot)=>bytesHash(Buffer.from(JSON.stringify(snapshot)));
export class SkillImports {
  private jobs=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private closing=false;
  constructor(private readonly dataRoot:string,private readonly library:LocalSkillLibrary,private readonly source=new GithubSkillSource()){}
  private root(){
    safeRoot(this.dataRoot);
    const path=join(this.dataRoot,'skill-imports');
    if(!existsSync(path))mkdirSync(path);
    return safeRoot(path);
  }
  private folder(id:string){importId.parse(id);return safeRoot(join(this.root(),id));}
  private save(record:SkillImportRecord){
    const r=importRecord.parse(record);
    atomicWrite(this.folder(r.id),'record.json',Buffer.from(JSON.stringify(r)));
  }
  detail(id:string):SkillImportRecord {
    const file=safeFile(this.folder(id),'record.json');
    if(statSync(file).size>200000)throw new UmiError('RESOURCE_LIMIT','导入记录超过大小上限');
    let r=importRecord.parse(JSON.parse(readFileSync(file,'utf8')));
    if(r.id!==id||r.snapshot&&r.planHash!==digest(r.snapshot))throw new UmiError('RESOURCE_CHANGED','导入记录身份或内容已变化');
    if(!this.jobs.has(id)&&r.state==='fetching'){
      r={...r,state:'failed',progress:'获取已中断',error:'上次获取已中断；未自动重新联网。请移除此草稿后重新获取。',updatedAt:new Date().toISOString()};this.save(r);
    }
    if(!this.jobs.has(id)&&r.state==='installing'){
      // 恢复只检查已有目标，不再下载、复制或覆盖未知结果。
      try{this.verifyInstalled(r);r={...r,state:'installed',progress:'已核对原导入结果',updatedAt:new Date().toISOString()};}
      catch{r={...r,state:'failed',progress:'导入结果待核对',error:'上次导入未完整结算；保留原目录，请先核对技能库。',updatedAt:new Date().toISOString()};}
      this.save(r);this.library.refresh();
    }
    return r;
  }
  list():{records:SkillImportSummary[];issues:string[]} {
    const records:SkillImportSummary[]=[],issues:string[]=[];
    const dirs=readdirSync(this.root(),{withFileTypes:true});
    if(dirs.length>32)issues.push('导入记录超过32份，超出部分未读取。');
    for(const dir of dirs.slice(0,32)){
      if(!importId.safeParse(dir.name).success||!dir.isDirectory()||dir.isSymbolicLink()){issues.push('存在无效导入记录，请检查应用数据中的skill-imports目录。');continue;}
      try{const r=this.detail(dir.name),{snapshot,...rest}=r;
        records.push({...rest,...(snapshot?{name:snapshot.name,files:snapshot.files.length,bytes:snapshot.totalBytes}:{})});
      }catch{issues.push('有导入记录无法核对，未执行其内容。');}
    }
    records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {records,issues};
  }
  start(input:GithubSkillInput){
    if(this.closing)throw new UmiError('RUN_STATE','应用正在关闭');
    const a=githubSkillInput.parse(input);githubCoordinates(a);
    const list=this.list();
    if(list.issues.length||list.records.length>=32||list.records.filter(r=>['fetching','staged','installing'].includes(r.state)).length>=3)
      throw new UmiError('RESOURCE_LIMIT','最多保留3份待处理草稿、32份记录；请先处理或移除已有记录');
    const id=randomUUID(),now=new Date().toISOString(),folder=join(this.root(),id);
    mkdirSync(folder);
    let record:SkillImportRecord={id,createdAt:now,updatedAt:now,input:a,state:'fetching',progress:'准备获取'};
    this.save(record); // 先保存管理动作，后台获取不会占住桌面的20秒命令队列。
    const controller=new AbortController();
    const done=(async()=>{
      // 延迟一拍，确保控制器登记后再进入恢复检查/网络。
      await new Promise<void>(resolve=>setImmediate(resolve));
      try{
        const result=await this.source.download(a,controller.signal,message=>{
          if(controller.signal.aborted)return;
          record={...record,progress:message,updatedAt:new Date().toISOString()};this.save(record);
        });
        controller.signal.throwIfAborted();
        const payload=join(this.folder(id),'payload');mkdirSync(payload);
        for(const [path,bytes] of result.files){controller.signal.throwIfAborted();atomicWrite(payload,path,bytes);}
        record={...record,state:'staged',snapshot:result.snapshot,planHash:digest(result.snapshot),progress:'已获取，等待确认',updatedAt:new Date().toISOString()};
        this.save(record);
      }catch(error){
        const cancelled=controller.signal.aborted;controller.abort();
        record={...record,state:cancelled?'cancelled':'failed',progress:cancelled?'已停止获取':'获取失败',
          error:cancelled?'用户或应用已停止获取；未安装。':error instanceof UmiError?error.message:'技能来源或响应不符合要求，未安装。',updatedAt:new Date().toISOString()};
        this.save(record);
      }finally{this.jobs.delete(id);}
    })();
    // done 始终有观察者；落盘失败也不会产生未处理拒绝。
    this.jobs.set(id,{controller,done:done.catch(()=>{})});
    return {id};
  }
  cancel(id:string){
    importId.parse(id);const job=this.jobs.get(id);
    if(job)job.controller.abort();
    return {requested:Boolean(job)};
  }
  private verifyPayload(root:string,snapshot:SkillImportSnapshot,origin?:string){
    safeRoot(root);const expected=new Map(snapshot.files.map(f=>[f.path,f]));let count=0,total=0,sawOrigin=origin===undefined;
    const walk=(dir:string,prefix='')=>{
      for(const e of readdirSync(dir,{withFileTypes:true})){
        if(++count>400||e.isSymbolicLink())throw new UmiError('RESOURCE_CHANGED','导入目录含链接或超过上限');
        const path=prefix?prefix+'/'+e.name:e.name;
        if(e.isDirectory()){safeRoot(join(dir,e.name));walk(join(dir,e.name),path);continue;}
        const file=safeFile(root,path),size=statSync(file).size;
        if(path==='.umi-origin.json'&&origin!==undefined){
          if(size>200000||readFileSync(file,'utf8')!==origin)throw new UmiError('RESOURCE_CHANGED','来源记录已变化');
          sawOrigin=true;continue;
        }
        const item=expected.get(path);if(!item||size!==item.bytes)throw new UmiError('RESOURCE_CHANGED','包文件清单或大小已变化');
        total+=size;if(total>8388608||bytesHash(readFileSync(file))!==item.sha256)throw new UmiError('RESOURCE_CHANGED','包文件字节已变化');
        expected.delete(path);
      }
    };
    walk(root);
    if(!sawOrigin||expected.size||total!==snapshot.totalBytes)throw new UmiError('RESOURCE_CHANGED','技能包不完整，未安装');
  }
  private origin(record:SkillImportRecord){
    return JSON.stringify(importOrigin.parse({schemaVersion:1,importId:record.id,planHash:record.planHash,snapshot:record.snapshot}));
  }
  private verifyInstalled(record:SkillImportRecord){
    if(!record.snapshot)throw new UmiError('RESOURCE_CHANGED','缺少导入快照');
    const root=safeRoot(join(this.library.library().directory,record.snapshot.name));
    this.verifyPayload(root,record.snapshot,this.origin(record));
  }
  install(id:string,planHash:string){
    const r=this.detail(id);
    if(r.planHash!==planHash||!r.snapshot)throw new UmiError('RESOURCE_CHANGED','确认不属于此冻结包，请重新查看');
    if(r.state==='installed'){this.verifyInstalled(r);return this.library.refresh();}
    if(r.state!=='staged')throw new UmiError('RUN_STATE','当前草稿尚未就绪或已失败');
    const libraryRoot=safeRoot(this.library.library().directory),target=join(libraryRoot,r.snapshot.name);
    // Windows目录rename不覆盖已有目标；同名技能必须显式另行处理。
    try{lstatSync(target);throw new UmiError('SKILL_CONFLICT','已存在同名技能；未覆盖。请先核对原技能。');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const payload=safeRoot(join(this.folder(id),'payload'));
    this.verifyPayload(payload,r.snapshot,existsSync(join(payload,'.umi-origin.json'))?this.origin(r):undefined);
    atomicWrite(payload,'.umi-origin.json',Buffer.from(this.origin(r)));
    this.verifyPayload(payload,r.snapshot,this.origin(r));
    const installing={...r,state:'installing' as const,progress:'正在保存冻结包',updatedAt:new Date().toISOString()};this.save(installing);
    renameSync(payload,target);
    this.verifyInstalled(installing);
    this.save({...installing,state:'installed',progress:'已导入，默认停用',updatedAt:new Date().toISOString()});
    return this.library.refresh();
  }
  remove(id:string){
    if(this.jobs.has(id))throw new UmiError('RUN_STATE','请先停止获取，再移除记录');
    const root=this.root(),target=this.folder(id),rel=relative(root,target);
    if(rel!==id||rel.includes(sep))throw new UmiError('PERMISSION_DENIED','记录目录不属于导入区域');
    // 只删除明确ID的托管记录/草稿。已安装的技能目录不在此路径中。
    let count=0;const check=(dir:string)=>{safeRoot(dir);for(const e of readdirSync(dir,{withFileTypes:true})){
      if(++count>405||e.isSymbolicLink())throw new UmiError('PERMISSION_DENIED','草稿目录含链接或异常内容，保留供核对');
      if(e.isDirectory())check(join(dir,e.name));else safeFile(dir,e.name);
    }};check(target);rmSync(target,{recursive:true,force:false});return this.list();
  }
  async close(){
    this.closing=true;for(const job of this.jobs.values())job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j=>j.done));
  }
}