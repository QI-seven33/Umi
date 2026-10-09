import {registerAttachments} from '../../../packages/agent/src/tools/attachments.js';
import { SqliteStore } from '../../../packages/adapters/src/sqlite/store.js';
import { AgentEngine } from '../../../packages/agent/src/loop/engine.js';
import { ToolRegistry, registerHistory } from '../../../packages/agent/src/tools/registry.js';
import {registerMemory} from '../../../packages/agent/src/tools/memory.js';
import { ContextManager } from '../../../packages/agent/src/context/manager.js';
import type { EngineLimits } from '../../../packages/agent/src/loop/engine.js';
import type { ModelPort } from '../../../packages/agent/src/ports.js';
import type { Cursor, Settings } from '../../../packages/protocol/src/model.js';
import { UmiError } from '../../../packages/protocol/src/model.js';
import { hostContext, registerScratch } from '../../../packages/adapters/src/host-files/scratch.js';
import { registerWebSearch } from '../../../packages/adapters/src/deepseek-search/search.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ResourceRepository } from '../../../packages/adapters/src/sqlite/resources.js';
import { ResourceFiles } from '../../../packages/adapters/src/host-files/resources.js';
import { registerFiles } from '../../../packages/adapters/src/host-files/tools.js';
import { registerRecycle } from '../../../packages/adapters/src/host-files/recycle.js';
import { DeliveryFiles } from '../../../packages/adapters/src/host-files/delivery.js';
import type { DeliveryBoundary } from '../../../packages/adapters/src/host-files/delivery.js';
import {CommandTools,registerCommands} from '../../../packages/adapters/src/host-process/tools.js';
import type {ProcessBoundary} from '../../../packages/adapters/src/host-process/tools.js';

export class UmiApplication {
  readonly store:SqliteStore;readonly registry:ToolRegistry;readonly engine:AgentEngine;readonly files:ResourceFiles;readonly commands:CommandTools;
  private readonly running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(dataRoot:string,model:ModelPort,options:{limits?:EngineLimits;context?:ContextManager;clock?:()=>string;search?:{key:()=>string;baseUrl:string};deliveryBoundary?:(point:DeliveryBoundary,path:string)=>void|Promise<void>;processBoundary?:(point:ProcessBoundary,executionId:string)=>void|Promise<void>}={}) {
    this.store=new SqliteStore(dataRoot,options.clock);this.registry=new ToolRegistry();
    registerHistory(this.registry,this.store,hostContext);registerScratch(this.registry);
    registerMemory(this.registry,this.store,hostContext);
    registerAttachments(this.registry,this.store);
    this.files=new ResourceFiles(new ResourceRepository(this.store));registerFiles(this.registry,this.files,new DeliveryFiles(this.files,options.deliveryBoundary));registerRecycle(this.registry,this.files);
    this.commands=new CommandTools(this.files,undefined,options.processBoundary);registerCommands(this.registry,this.commands);
    if(options.search)registerWebSearch(this.registry,options.search.key,options.search.baseUrl);
    this.engine=new AgentEngine(this.store,model,this.registry,options.context,options.limits,this.files);
  }
  createConversation(workspace:string,settings:Partial<Settings>={}){const c=this.store.createConversation(workspace,settings);this.files.initialize(c.environmentId);return c;}
  contextStatistics(conversationId:string){const state=this.store.snapshot(conversationId);return {latestRequest:state.context,
    lastActualUsage:state.context.lastUsageRef?this.store.readArtifact(state.context.lastUsageRef):null,
    window:state.memory.window,maintenance:Object.entries(state.memory.maintenance).map(([id,m])=>({id,...m,usage:m.usageRef?this.store.readArtifact(m.usageRef):null})),
    interpretation:'estimatedInputTokens 为 UTF-8 保守估算；实际用量来自对应 API 响应，维护费用单独展示。'};}
  previewFile(conversationId:string,mountId:string,path:string,startByte=0,byteLength=8192) {
    if(!Number.isInteger(startByte)||startByte<0||!Number.isInteger(byteLength)||byteLength<1||byteLength>64000)throw new UmiError('PROTOCOL_INVALID','预览字节范围无效');
    const c=this.store.conversation(conversationId);return this.files.read(this.files.repo.mount(mountId,c.environment_id as string),path,startByte,Math.min(byteLength,64000));
  }
  previewChangeSet(conversationId:string,changeSetId:string) {
    const c=this.store.conversation(conversationId),cs=this.files.repo.changeSet(changeSetId,c.environment_id as string);
    const env=this.store.environment(c.environment_id as string),m=this.files.repo.mount(cs.mountId,env.id);
    return {changeSet:cs,preview:new DeliveryFiles(this.files).preview(cs,m,env),receipts:this.files.repo.items(cs.id).map(i=>i.receipt_ref?this.store.readArtifact(i.receipt_ref as string):{path:i.path,outcome:'unknown'})};
  }
  previewProcess(conversationId:string,executionId:string,channel:'stdout'|'stderr',startByte=0,byteLength=8192){
    const t=this.store.tool(executionId);if(this.store.getRun(t.run_id).conversation_id!==conversationId)throw new UmiError('PERMISSION_DENIED','进程输出不属于当前会话');
    if(!['stdout','stderr'].includes(channel)||!this.commands.repo.row(executionId))throw new UmiError('PROTOCOL_INVALID','输出通道或进程记录无效');
    if(!Number.isInteger(startByte)||startByte<0||!Number.isInteger(byteLength)||byteLength<1||byteLength>64000)throw new UmiError('PROTOCOL_INVALID','输出读取范围无效');
    const bytes=Buffer.from(this.commands.repo.readOutput(executionId,channel)),start=Math.min(startByte,bytes.length);let end=Math.min(start+byteLength,bytes.length);
    if(start<bytes.length&&(bytes[start]!&0xc0)===0x80)throw new UmiError('PROTOCOL_INVALID','输出起点切开 UTF-8 字符');while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;
    return {executionId,channel,startByte:start,endByte:end,totalBytes:bytes.length,truncated:end<bytes.length,text:bytes.subarray(start,end).toString('utf8'),receipt:this.commands.repo.receipt(executionId)??null};
  }
  send(conversationId:string,commandId:string,text:string,attachmentIds:string[]=[]) {
    const receipt=this.store.acceptInput(conversationId,commandId,text,attachmentIds);
    // 幂等接收只返回原记录；不会因重发已完成命令而再次启动任务。
    if(['queued','running','waiting_permission'].includes(this.store.getRun(receipt.runId).status))this.start(receipt.runId,false);
    return receipt;
  }
  private start(runId:string,recovery:boolean) {
    if(this.running.has(runId))return;
    const controller=new AbortController();
    const done=Promise.resolve().then(()=>this.engine.run(runId,controller.signal,recovery)).finally(()=>this.running.delete(runId));
    this.running.set(runId,{controller,done});void done.catch(()=>{});
  }
  async wait(runId:string){await this.running.get(runId)?.done;return this.store.getRun(runId);}
  approve(conversationId:string,approvalId:string,decision:'allow'|'deny') {
    this.store.decideApproval(conversationId,approvalId,decision);
    const a=this.store.approval(approvalId);
    const run=this.store.getRun(a.run_id),tool=this.store.tool(a.execution_id);
    // 已完成决定的迟到重发只确认接收，不重启已结算运行。
    if(tool.state==='prepared'&&['queued','running','waiting_permission','interrupted','recovery_required'].includes(run.status)&&!this.running.has(a.run_id))
      this.start(a.run_id,true);
  }
  async stop(conversationId:string,runId:string) {
    const r=this.store.getRun(runId);if(r.conversation_id!==conversationId)throw new UmiError('PROTOCOL_INVALID','运行不属于当前会话');
    if(['completed','failed','stopped'].includes(r.status))return;
    this.store.commit({conversationId,runId},{type:'run.stop_requested',payload:{reason:'用户点击停止'}});
    const task=this.running.get(runId);
    if(task){task.controller.abort();await task.done;}
    else {
      for(const t of this.store.tools(runId).filter(t=>t.state==='prepared')){
        if(t.approval_id)this.store.invalidateApproval(t.id,'用户已停止任务');
        this.store.settle(t.id,{outcome:'cancelled',content:'用户停止任务，工具尚未派发。',data:null},r.generation);
      }
      this.store.commit({conversationId,runId},{type:'run.stopped',payload:{reason:'任务已停止；派发记录仍保留以供恢复核验'}});
    }
  }
  resume(conversationId:string,runId:string) {
    const r=this.store.getRun(runId);if(r.conversation_id!==conversationId)throw new UmiError('PROTOCOL_INVALID','运行不属于当前会话');
    if(!['queued','interrupted','stopped','recovery_required','waiting_permission'].includes(r.status))throw new UmiError('RUN_STATE','当前状态不能恢复');
    const budget=this.engine.recoveryBudget(runId);if(!budget.canResume)throw new UmiError('CONTEXT_BUDGET_BLOCKED',budget.reason??'上下文预算阻塞尚未解除');
    this.start(runId,true);
  }
  inspectRecovery(conversationId:string,runId:string) {
    const r=this.store.getRun(runId);if(r.conversation_id!==conversationId)throw new UmiError('PROTOCOL_INVALID','运行不属于当前会话');
    return {run:r,budget:this.engine.recoveryBudget(runId),tools:this.store.tools(runId).map(t=>({executionId:t.id,name:t.name,state:t.state,contextRef:t.context_ref})),
      unresolvedEnvironment:this.store.unresolvedEnvironment(r.environment_id).map(t=>({runId:t.run_id,executionId:t.id,state:t.state})),
      materializations:this.store.runtimeFacts(r.environment_id),
      commandExecutions:Object.entries(this.store.snapshot(conversationId).commandExecutions).filter(([,p])=>p.runId===runId),
      pendingApprovals:Object.entries(this.store.snapshot(conversationId).approvals).filter(([,a])=>a.status==='pending')};
  }
  async* subscribe(conversationId:string,cursor:Cursor,signal:AbortSignal) {
    // 读取固定快照后用同一日志补齐；订阅只观察，无权取消运行。
    this.store.events(conversationId,cursor);
    let current={...cursor};
    while(!signal.aborted) {
      for(const e of this.store.events(conversationId,current)){current={streamId:e.streamId,logEpoch:e.logEpoch,sequence:e.sequence};yield e;}
      try{await delay(25,undefined,{signal});}catch{break;}
    }
  }
  async close() {
    // 应用退出保存中断，不把窗口/订阅关闭伪装成用户停止。
    const tasks=[...this.running.values()];for(const task of tasks)task.controller.abort(new UmiError('APP_SHUTDOWN','应用正在退出'));
    await Promise.allSettled(tasks.map(t=>t.done));this.store.close();
  }
}
