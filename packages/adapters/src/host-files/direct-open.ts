import {z} from 'zod';
import {filePath} from '../../../protocol/src/file-path.js';
import {UmiError} from '../../../protocol/src/model.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import type {DocumentOpener,DocumentTarget} from '../../../protocol/src/native-open.js';
import type {ToolRegistry} from '../../../agent/src/tools/registry.js';
import type {ResourceFiles} from './resources.js';
import {verifiedDocumentPath} from './delivered-open.js';

const schema=z.object({mountId:z.string().min(1),path:filePath}).strict();
function targetOf(context:ExecutionContext):DocumentTarget {
 const location=context.locations[0];
 if(!location?.beforeHash||!location.beforeIdentity||!location.physicalRootIdentity||!location.physicalRoot)throw new UmiError('NOT_FOUND','要打开的文件不存在');
 return {root:location.physicalRoot,rootIdentity:location.physicalRootIdentity,path:location.relativePath,hash:location.beforeHash,identity:location.beforeIdentity};
}
// 与旧交付打开复用同一个窄端口和主进程核验；不创建脱离Job的命令入口。
export function registerDirectOpen(registry:ToolRegistry,files:ResourceFiles,open:DocumentOpener){
 registry.register({
  name:'open_file',available:env=>files.repo.direct.enabled(env.id),
  description:'按用户要求用系统默认应用打开已授权真实目录中的文档、HTML或图片。传真实mountId和相对文件路径，仍需本次具体批准，不需要交付。打开请求通过桌面通道交给系统，不属于运行命令的子进程，任务结束不会主动关闭该应用；不要用run_shell或Start-Process代替普通打开。系统接收不证明窗口、页面渲染或交互成功。不可指定程序、参数、URL或启动持续服务。',
  schema,effect:'host-code',
  prepare:(input,env)=>{
   const a=schema.parse(input);if(!files.repo.mount(a.mountId,env.id).direct)throw new UmiError('PERMISSION_DENIED','旧副本保持原交付打开规则');
   const context=files.mountContext(input,env,a.mountId,a.path);
   verifiedDocumentPath(targetOf(context));return context;
  },
  approvalDescription:(_input,context)=>`用系统默认应用打开：${context.locations[0]!.physicalRoot}/${context.locations[0]!.relativePath}。默认应用可处理文档内容或联网；本次不授予任意程序、脚本或持续服务权限。`,
  execute:async(input,context,_conversationId,signal)=>{
   const a=schema.parse(input);let target:DocumentTarget;
   try{
    const env=files.repo.store.environment(context.environmentId);
    if(!files.repo.mount(a.mountId,env.id).direct)throw new UmiError('PERMISSION_DENIED','旧副本保持原交付打开规则');
    const current=files.mountContext(input,env,a.mountId,a.path);target=targetOf(current);
    const planned=targetOf(context);
    if(target.hash!==planned.hash||target.identity!==planned.identity||target.rootIdentity!==planned.rootIdentity||target.root!==planned.root||current.directoryGrant?.id!==context.directoryGrant?.id||current.directoryGrant?.revision!==context.directoryGrant?.revision)
     throw new UmiError('RESOURCE_CHANGED','打开前文件或目录授权已变化');
    verifiedDocumentPath(target);signal.throwIfAborted();
   }catch(e){return {outcome:signal.aborted?'cancelled':'failed',content:e instanceof Error?e.message:'打开前核验失败',data:{systemAccepted:false},mutated:false};}
   try{await open(target,signal);}catch(e){
    if(e instanceof UmiError&&e.code==='OPEN_REJECTED')return {outcome:'failed',content:e.message,data:{systemAccepted:false},mutated:false};
    throw e; // 回执丢失保持未知；不重新打开。
   }
   return {outcome:'succeeded',content:'',data:{mountId:a.mountId,path:a.path,hash:target.hash,systemAccepted:true,instruction:'系统已接收文档打开请求；不证明窗口呈现、页面渲染或交互。'},mutated:false};
  },
  inspect:async()=>({outcome:'unknown',content:'打开回执未确认，可能已经打开，未再次请求。',data:null,mutated:false}),
  reconcile:async()=>({outcome:'unknown',content:'打开结果未知，未重放系统动作。',data:null,mutated:false}),
 });
}
