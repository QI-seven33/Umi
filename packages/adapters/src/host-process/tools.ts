import {hash} from '../../../agent/src/identity.js';
import type {ToolRegistry} from '../../../agent/src/tools/registry.js';
import type {ToolResult} from '../../../agent/src/persistence.js';
import {UmiError} from '../../../protocol/src/model.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import {directCommandSchema,shellCommandSchema,processSnapshotSchema} from '../../../protocol/src/process.js';
import type {ProcessSnapshot,ProcessReceipt} from '../../../protocol/src/process.js';
import {ResourceFiles} from '../host-files/resources.js';
import {ProcessRepository} from '../sqlite/processes.js';
import {CommandPreparation,fingerprint} from './prepare.js';
import {WindowsProcessRunner} from './runner.js';
import {z} from 'zod';
import {hostContext} from '../host-files/scratch.js';

export type ProcessBoundary='planned'|'ready'|'released'|'started'|'output'|'receipt';
export class CommandTools {
  readonly repo:ProcessRepository;readonly preparation:CommandPreparation;
  constructor(readonly files:ResourceFiles,readonly runner=new WindowsProcessRunner(),private readonly boundary?:(point:ProcessBoundary,executionId:string)=>void|Promise<void>){this.repo=new ProcessRepository(files.repo.store);this.preparation=new CommandPreparation(files,this.repo);}
  private snapshot(ctx:ExecutionContext){if(!ctx.process)throw new UmiError('PROTOCOL_INVALID','命令缺少冻结执行快照');return processSnapshotSchema.parse(ctx.process);}
  private result(r:ProcessReceipt):ToolResult {
    const stdout=this.repo.store.readArtifact<{text:string}>(r.stdoutRef).text,stderr=this.repo.store.readArtifact<{text:string}>(r.stderrRef).text;
    const excerpt=(s:string)=>s.slice(0,/[\uD800-\uDBFF]/.test(s[7999]??'')?7999:8000);
    const outcome=!r.jobInactive?'unknown':r.reason==='exited'&&r.exitCode===0?'succeeded':['stopped','parent_closed'].includes(r.reason)?'cancelled':'failed';
    return {outcome,mutated:r.gateReleased,verification:r.reason==='interrupted'?'termination-confirmed-effects-unverified':'native-exit-receipt',
      content:JSON.stringify({exitCode:r.exitCode,reason:r.reason,jobInactive:r.jobInactive,stdout:excerpt(stdout),stderr:excerpt(stderr),truncated:r.truncated||stdout.length>8000||stderr.length>8000,
        instruction:r.reason==='interrupted'?'原命令已终止，但副作用和退出结果不明。没有重复执行；请检查相关文件后再决定后续操作。':'退出码仅表示程序退出结果，不能单独证明用户任务或外部副作用完成。'}),data:r};
  }
  async execute(args:unknown,ctx:ExecutionContext,signal:AbortSignal):Promise<ToolResult>{
    const s=this.snapshot(ctx),store=this.repo.store,t=store.tool(s.executionId);store.checkLease(t.run_id,s.leaseGeneration);store.assertApprovedExecution(s.executionId,ctx);
    const mode=s.mode==='direct'?'direct':'shell';const fresh=this.preparation.prepare(args,mode,s.executionId,true,false);
    if(hash(fresh)!==hash(ctx))return {outcome:'failed',content:'派发后程序或工作目录已变化，原命令没有启动。需要重新准备具体请求。',data:null};
    this.repo.plan(s);await this.boundary?.('planned',s.executionId);
    const exit=await this.runner.run(s,{
      owner:bridge=>{store.checkLease(t.run_id,s.leaseGeneration);this.repo.owner(s.executionId,bridge);},
      ready:async(bridge,child)=>{this.repo.ready(s.executionId,bridge,child);await this.boundary?.('ready',s.executionId);store.checkLease(t.run_id,s.leaseGeneration);
        const now=this.preparation.prepare(args,mode,s.executionId,true,false);if(hash(now)!==hash(ctx))throw new UmiError('APPROVAL_STALE','启动释放前对象已变化，挂起进程不会运行');
        store.assertApprovedExecution(s.executionId,ctx);this.repo.release(s.executionId);await this.boundary?.('released',s.executionId);},
      started:()=>{this.repo.started(s.executionId);const hook=this.boundary?.('started',s.executionId);if(hook instanceof Promise)throw new UmiError('PROTOCOL_INVALID','started 测试边界只能同步注入');},
      output:(channel,text)=>{this.repo.output(s.executionId,channel,text);if(text){const hook=this.boundary?.('output',s.executionId);if(hook instanceof Promise)throw new UmiError('PROTOCOL_INVALID','output 测试边界只能同步注入');}},
    },signal);
    let cwdAfter:string|null=null,inspectionError:string|null=null;try{cwdAfter=fingerprint(s.cwd);}catch{inspectionError='执行后工作目录无法完整核验；结构化文件操作需重新检查';}
    const receipt=this.repo.finish({schemaVersion:1,executionId:s.executionId,exitCode:exit.exitCode,reason:exit.reason,jobInactive:exit.jobInactive,gateReleased:exit.gateReleased,observedAt:new Date().toISOString(),
      stdoutBytes:exit.stdoutBytes,stderrBytes:exit.stderrBytes,truncated:exit.truncated,byteCountBasis:'native-observed',cwdAfter,inspectionError});await this.boundary?.('receipt',s.executionId);return this.result(receipt);
  }
  async reconcile(ctx:ExecutionContext):Promise<ToolResult>{
    const s=this.snapshot(ctx),r=this.repo.receipt(s.executionId);
    if(r&&r.executionId!==s.executionId)throw new UmiError('PROTOCOL_INVALID','回执与原执行身份不一致');
    if(r?.jobInactive)return this.result(r);
    const p=this.repo.row(s.executionId);
    if(!p)return {outcome:'failed',content:'工具派发已记录，但未创建进程计划；原命令没有释放执行。',data:null,verification:'no-process-plan'};
    if(hash(processSnapshotSchema.parse(this.repo.store.readArtifact(p.snapshot_ref as string)))!==hash(s))throw new UmiError('PROTOCOL_INVALID','原进程快照与执行定位不一致');
    if(p.bridge_pid){const state=await this.runner.probe({pid:Number(p.bridge_pid),birth:p.bridge_birth as string},true);
      if(state==='inaccessible'||state==='same')return {outcome:'unknown',content:'原桥接进程身份或清理无法核验，未杀死不相关 PID，也未重启命令。',data:null,verification:'unknown'};
      if(p.child_pid){const child=await this.runner.probe({pid:Number(p.child_pid),birth:p.child_birth as string});if(child==='same'||child==='inaccessible')return {outcome:'unknown',content:'原子进程可能仍存活，禁止新的环境执行。',data:null,verification:'unknown'};}
    }
    if(r)return this.result(this.repo.confirmCleanup(s.executionId));
    let cwdAfter:string|null=null,inspectionError:string|null=null;try{cwdAfter=fingerprint(s.cwd);}catch{inspectionError='恢复后工作目录无法完整核验';}
    const receipt=this.repo.finish({schemaVersion:1,executionId:s.executionId,exitCode:null,reason:p.released===1?'interrupted':'not_started',jobInactive:true,gateReleased:p.released===1,
      observedAt:new Date().toISOString(),stdoutBytes:Buffer.byteLength(this.repo.readOutput(s.executionId,'stdout')),stderrBytes:Buffer.byteLength(this.repo.readOutput(s.executionId,'stderr')),truncated:true,byteCountBasis:'archived-lower-bound',cwdAfter,inspectionError});return this.result(receipt);
  }
}
export function registerCommands(registry:ToolRegistry,commands:CommandTools){
  const read=z.object({executionId:z.string().min(1).max(160),channel:z.enum(['stdout','stderr']),startByte:z.number().int().nonnegative().default(0),byteLength:z.number().int().min(1).max(64000).default(8192)}).strict();
  registry.register({name:'read_process_output',description:'按 UTF-8 字节范围读取当前会话已保存的脱敏进程输出。保留原执行身份、范围及截断说明，不能读取其他会话。',schema:read,effect:'read',prepare:hostContext,
    async execute(input,_ctx,conversationId,signal){signal.throwIfAborted();const a=read.parse(input),t=commands.repo.store.tool(a.executionId);if(commands.repo.store.getRun(t.run_id).conversation_id!==conversationId)throw new UmiError('PERMISSION_DENIED','进程输出不属于当前会话');
      if(!commands.repo.row(a.executionId))throw new UmiError('NOT_FOUND','指定执行没有进程记录');
      const bytes=Buffer.from(commands.repo.readOutput(a.executionId,a.channel)),start=Math.min(a.startByte,bytes.length);let end=Math.min(start+a.byteLength,bytes.length);if(start<bytes.length&&(bytes[start]!&0xc0)===0x80)throw new UmiError('PROTOCOL_INVALID','读取起点切开 UTF-8 字符');while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;
      const data={executionId:a.executionId,channel:a.channel,startByte:start,endByte:end,totalBytes:bytes.length,truncated:end<bytes.length,text:bytes.subarray(start,end).toString('utf8')};return {outcome:'succeeded',content:JSON.stringify(data),data};},async reconcile(a,ctx,c,s){return this.execute(a,ctx,c,s);}});
  for(const mode of ['direct','shell'] as const){const schema=mode==='direct'?directCommandSchema:shellCommandSchema;
    registry.register({name:mode==='direct'?'run_command':'run_shell',description:mode==='direct'?'在获准副本或 task/scratch、research 目录运行明确程序与 argv。每次都需具体宿主代码执行批准，包含 Git、测试和构建；cwd 不是磁盘沙箱。npm 等批处理请用 run_shell 的 CMD 模式。结果含有界输出与原退出回执。':'执行完整 PowerShell 或 CMD 脚本，需具体宿主代码执行批准。PowerShell 不加载 profile；CMD 禁用 AutoRun。脚本可以访问当前用户能访问的宿主资源，不能把工作目录当成安全隔离。',
      schema,effect:'host-code',approvalPollMs:500,executionTimeoutMs:a=>schema.parse(a).timeoutMs+30000,
      prepare(a,_env,id){if(!id)throw new UmiError('PROTOCOL_INVALID','命令缺少原执行身份');return commands.preparation.prepare(a,mode,id);},
      approvalDescription(_a,ctx){const s=ctx.process!;return `我需要执行此次宿主命令，用于当前任务。\n程序：${s.program}\n工作目录：${s.cwd}\n${s.script!==undefined?`完整脚本：\n${s.script}`:`实际参数：${JSON.stringify(s.argv)}`}\n范围：${s.scope}；超时 ${s.timeoutMs}ms；输出上限 ${s.maxOutputBytes} 字节。\n这不是文件或网络沙箱，程序可能访问工作目录以外的真实文件和网络。批准仅绑定本次程序、参数、脚本、环境修订与目录指纹。是否允许？`;},
      async execute(a,ctx,_c,signal){return commands.execute(a,ctx,signal);},async reconcile(_a,ctx){return commands.reconcile(ctx);}});
  }
}
