import { readFileSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { ResourceFiles } from './resources.js';
import { DeliveryFiles } from './delivery.js';
import { hostContext } from './scratch.js';
import { atomicWrite, bytesHash, observe, safeFile, scan } from './paths.js';
import { filePath } from '../../../protocol/src/resources.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';

const mountId=z.string().min(1).max(160),readSchema=z.object({mountId,path:filePath,startByte:z.number().int().nonnegative().default(0),byteLength:z.number().int().min(1).max(64000).default(8192)}).strict();
const fileSchema=z.object({mountId,path:filePath}).strict();
function dataResult(data:unknown,content=JSON.stringify(data)){return {outcome:'succeeded' as const,content,data};}
export function registerFiles(registry:ToolRegistry,files:ResourceFiles,delivery=new DeliveryFiles(files)) {
  const repo=files.repo;
  const discover=z.object({query:z.string().max(200).default(''),path:z.string().min(1).max(4096).optional()}).strict();
  registry.register({name:'discover_resource',description:'发现工作区外的目录或指定文件所在目录，仅返回目录身份和元数据，不读取文件正文。默认扫描工作区附近及常用用户目录，返回覆盖范围和上限；指定 path 可定位已知目标。',schema:discover,effect:'read',prepare:hostContext,
    async execute(input,ctx,_conversation,signal){signal.throwIfAborted();const a=discover.parse(input);return dataResult(files.discover(repo.store.environment(ctx.environmentId),a.query,a.path));},
    async reconcile(input,ctx,c,s){return this.execute(input,ctx,c,s);}});
  const request=z.object({candidateId:z.string().min(1),access:z.enum(['read','edit']),purpose:z.string().min(1).max(500)}).strict();
  registry.register({name:'request_resource',description:'申请具体外部来源的读取或工作副本编辑权限，批准后物化到托管副本。一次资源批准可支持多个副本文件连续编辑；不包含源目录交付权限。被拒绝的等价权限不能换名重复申请。',schema:request,effect:'resource',
    prepare(input,env,executionId){const a=request.parse(input);return files.resourceContext(input,env,a.candidateId,a.access,executionId);},
    approvalRequired(input,ctx){const a=request.parse(input);return !repo.authorized(a.candidateId,ctx.environmentId,a.access==='edit');},
    approvalDescription(input,ctx){const a=request.parse(input),c=repo.getCandidate(a.candidateId,ctx.environmentId);
      return `我需要${a.access==='edit'?'读取并在工作副本中修改':'读取'} ${c.path}，用于${a.purpose}。批准仅限本次任务；真实目录写回仍需单独交付确认。`;},
    denied(input,ctx){const a=request.parse(input);repo.recordDenial(repo.getCandidate(a.candidateId,ctx.environmentId),a.access);},
    async execute(input,ctx,_conversation,signal){signal.throwIfAborted();const a=request.parse(input),c=repo.getCandidate(a.candidateId,ctx.environmentId);
      if(!repo.authorized(c.id,c.environmentId,a.access==='edit'))repo.grant(c,a.access);
      const location=ctx.locations.find(l=>l.rootRef.kind==='mount');if(!location||location.rootRef.kind!=='mount')throw new UmiError('PROTOCOL_INVALID','资源派发缺少物化目标');
      const m=await files.materializeAsync(c,location.rootRef.mountId,signal);return dataResult({mountId:m.id,resourceId:m.resourceId,sourceDirectory:m.sourceRoot,excluded:repo.store.snapshot(repo.scope(ctx.environmentId).conversationId).resources[c.id]?.excluded??[]},'资源已获准并物化。后续使用 mountId 和相对路径操作副本；源目录未修改。');},
    async reconcile(input,ctx){const a=request.parse(input),c=repo.getCandidate(a.candidateId,ctx.environmentId),m=repo.mounts(ctx.environmentId).find(m=>m.resourceId===c.id)??files.reconcileMaterialization(c,ctx);
      if(m&&repo.authorized(c.id,ctx.environmentId,a.access==='edit'))return dataResult({mountId:m.id,resourceId:c.id},'原资源权限与挂载已持久化；没有重新读取来源。');
      repo.store.commit(repo.scope(ctx.environmentId),{type:'resource.materialization_failed',payload:{resourceId:c.id,code:'MATERIALIZATION_INCOMPLETE',reason:'原物化未完成；部分托管资料保留，不重新复制'}});
      return {outcome:'failed',content:'资源物化未完成；已保存批准事实和原目标，没有自动重新复制。',data:{candidateId:c.id},verification:'not-materialized'};}});
  registry.register({name:'list_resources',description:'列出当前任务获准的工作副本及 mountId。源目录用于说明交付目标，不是可随意访问的路径。',schema:z.object({}).strict(),effect:'read',prepare:hostContext,
    async execute(_a,ctx,_c,signal){signal.throwIfAborted();return dataResult(repo.store.runtimeFacts(ctx.environmentId));},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  const list=z.object({mountId,prefix:z.string().max(1024).default(''),limit:z.number().int().min(1).max(200).default(100)}).strict();
  registry.register({name:'list_files',description:'列举获准工作副本中的文件，结果含总量和截断说明；不读取原磁盘来源。',schema:list,effect:'read',
    prepare(input,env){const a=list.parse(input);if(a.prefix)filePath.parse(a.prefix);return files.mountContext(input,env,a.mountId);},
    async execute(input,ctx,_c,signal){signal.throwIfAborted();const a=list.parse(input),m=repo.mount(a.mountId,ctx.environmentId),all=Object.entries(scan(m.root).manifest).filter(([p])=>!a.prefix||p===a.prefix||p.startsWith(`${a.prefix}/`));
      return dataResult({mountId:m.id,files:all.slice(0,a.limit).map(([path,e])=>({path,...e})),total:all.length,truncated:all.length>a.limit});},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  registry.register({name:'read_file',description:'按 UTF-8 字节范围读取工作副本。返回文件引用、hash、原文范围和截断信息；二进制仅返回元数据。',schema:readSchema,effect:'read',
    prepare(input,env){const a=readSchema.parse(input);return files.mountContext(input,env,a.mountId,a.path);},
    async execute(input,ctx,_c,signal){signal.throwIfAborted();const a=readSchema.parse(input);return dataResult(files.read(repo.mount(a.mountId,ctx.environmentId),a.path,a.startByte,a.byteLength));},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  registry.register({name:'stat_file',description:'查看获准工作副本中的文件大小、内容 hash 和对象身份；文件缺失明确返回 null。',schema:fileSchema,effect:'read',
    prepare(input,env){const a=fileSchema.parse(input);return files.mountContext(input,env,a.mountId,a.path);},
    async execute(input,ctx,_c,s){s.throwIfAborted();const a=fileSchema.parse(input),m=repo.mount(a.mountId,ctx.environmentId);return dataResult({mountId:m.id,path:a.path,entry:observe(m.root,a.path,m.rootIdentity)});},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  const search=z.object({mountId,query:z.string().min(1).max(500),limit:z.number().int().min(1).max(30).default(10)}).strict();
  registry.register({name:'search_text',description:'在获准工作副本的 UTF-8 文本中搜索原文。返回文件引用、字节范围和短摘录；二进制不搜索。',schema:search,effect:'read',
    prepare(input,env){const a=search.parse(input);return files.mountContext(input,env,a.mountId);},
    async execute(input,ctx,_c,s){const a=search.parse(input),m=repo.mount(a.mountId,ctx.environmentId),matches:unknown[]=[];let total=0;
      for(const path of Object.keys(scan(m.root).manifest)){s.throwIfAborted();const r=files.read(m,path,0,64000);if(r.kind!=='text')continue;
        // 搜索全文件，返回片段有界，不能把前 64 KiB 无命中等同于文件无命中。
        const bytes=readFileSync(safeFile(m.root,path,m.rootIdentity));let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{continue;}const i=text.indexOf(a.query);
        if(i>=0){total++;if(matches.length<a.limit)matches.push({mountId:m.id,path,startByte:Buffer.byteLength(text.slice(0,i)),text:text.slice(i,i+a.query.length+500)});}
      }return dataResult({matches,totalMatches:total,truncated:total>a.limit});},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  const write=z.object({mountId,path:filePath,content:z.string().max(256000)}).strict();
  for(const name of ['write_file','delete_file'] as const) {
    const schema=name==='write_file'?write:fileSchema;
    registry.register({name,description:name==='write_file'?'写入获准工作副本中的 UTF-8 文本。普通副本编辑自动执行，不写回源文件；最终写回使用 build_changeset 和 deliver_changeset。':'删除工作副本中的一个文件，不删除真实来源。真实删除需作为固定变更集交付；移入系统回收站使用 recycle_file。',schema,effect:'copy-write',
      prepare(input,env){const a=schema.parse(input),desired='content' in a?bytesHash(Buffer.from(a.content as string)):null;return files.mountContext(input,env,a.mountId,a.path,desired,true);},
      async execute(input,ctx,_c,s){s.throwIfAborted();const a=schema.parse(input),m=repo.mount(a.mountId,ctx.environmentId),loc=ctx.locations[0]!;
        const before=observe(m.root,a.path,m.rootIdentity);if((before?.hash??null)!==loc.beforeHash||(before?.identity??null)!==loc.beforeIdentity)return {outcome:'failed',content:'副本目标在派发后变化，未修改。',data:null};
        if('content' in a)atomicWrite(m.root,a.path,Buffer.from(a.content as string),m.rootIdentity);else if(before)unlinkSync(safeFile(m.root,a.path,m.rootIdentity));
        const after=observe(m.root,a.path,m.rootIdentity);if((after?.hash??null)!==loc.desiredHash)throw new UmiError('RESOURCE_CHANGED','副本操作后核验失败');
        return dataResult({mountId:m.id,path:a.path,observed:after},'工作副本已修改并回读核验；真实来源未改变。');},
      async reconcile(input,ctx){const a=schema.parse(input),m=repo.mount(a.mountId,ctx.environmentId),loc=ctx.locations[0]!;
        const after=observe(m.root,a.path,m.rootIdentity);return (after?.hash??null)===loc.desiredHash?
          {...dataResult({mountId:m.id,path:a.path,observed:after},'副本目标已满足预期状态；未再次写入，不断言原执行来源。'),verification:'desired-state-verified'}:
          {outcome:'unknown',content:'原副本目标不符合预期，未重复操作。',data:{observed:after},verification:'unknown'};}});
  }
  const build=z.object({mountId,paths:z.array(filePath).min(1).max(200).refine(p=>new Set(p).size===p.length,'不能重复选取同一文件').optional()}).strict();
  registry.register({name:'build_changeset',description:'将选定工作副本变化冻结为不可变变更集，返回真实交付目录、文件操作、前后内容及预览截断信息；不会写回。paths 可由 Agent 选定。',schema:build,effect:'read',
    prepare(input,env){const a=build.parse(input);return files.mountContext(input,env,a.mountId,undefined,undefined,true);},
    async execute(input,ctx,_c,s){s.throwIfAborted();const a=build.parse(input);return dataResult(delivery.build(repo.store.environment(ctx.environmentId),a.mountId,a.paths));},
    async reconcile(input,ctx,c,s){
      const scope=repo.scope(ctx.environmentId),saved=scope.executionId?repo.store.get('SELECT id FROM changesets WHERE execution_id=?',scope.executionId):undefined;
      if(saved){const cs=repo.changeSet(saved.id as string,ctx.environmentId),m=repo.mount(cs.mountId,ctx.environmentId);return {...dataResult(delivery.preview(cs,m,repo.store.environment(ctx.environmentId))),verification:'original-snapshot-reused'};}
      return {...await this.execute(input,ctx,c,s),verification:'recomputed-read'};
    }});
  const deliver=z.object({changeSetId:z.string().min(1)}).strict();
  registry.register({name:'deliver_changeset',description:'申请一次固定变更集交付批准。系统逐项核验源文件和副本、记录写回回执；等待批准时阻塞，不再请求模型。批准不覆盖之后的新变化。',schema:deliver,effect:'source-write',
    prepare(input,env){return delivery.prepare(env,deliver.parse(input).changeSetId);},
    approvalDescription(input,ctx){const cs=repo.changeSet(deliver.parse(input).changeSetId,ctx.environmentId),m=repo.mount(cs.mountId,ctx.environmentId);
      return `以下 ${cs.changes.length} 项修改将写回 ${m.sourceRoot}。\n${cs.changes.slice(0,12).map(c=>c.path).join("、")}${cs.changes.length>12?"等文件，完整范围见批准卡片":""}\n是否交付？delete 项会永久删除源文件，不移入回收站；需要回收时应使用系统回收站工具。本批准仅绑定此变更集。`;},
    async execute(input,ctx,_c,s){return delivery.apply(repo.store.environment(ctx.environmentId),deliver.parse(input).changeSetId,ctx,s);},
    async reconcile(input,ctx){return delivery.reconcile(repo.store.environment(ctx.environmentId),deliver.parse(input).changeSetId,ctx);}});
}
