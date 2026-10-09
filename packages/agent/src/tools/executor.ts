import { hash } from '../identity.js';
import type { PersistencePort, ToolResult } from '../persistence.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import type { ToolRegistry } from './registry.js';
import { setTimeout as delay } from 'node:timers/promises';

export class ToolExecutor {
  constructor(private readonly store:PersistencePort,private readonly registry:ToolRegistry) {}
  async execute(toolId:string,generation:number,signal:AbortSignal):Promise<void> {
    let t=this.store.tool(toolId);this.store.checkLease(t.run_id,generation);
    let args:unknown;
    try{args=this.registry.parse(t.name,t.args);}catch(e){this.store.settle(toolId,{outcome:'failed',content:e instanceof UmiError?e.message:'工具参数无效',data:null},generation);return;}
    const definition=this.registry.get(t.name),mutating=!['read','network','memory'].includes(definition.effect);
    if(t.state==='dispatched'||t.state==='unknown') {
      let result:ToolResult;
      try {
        if(!t.context_ref||!definition.reconcile)result={outcome:'unknown',content:'中断前的执行结果无法自动核验',data:null,verification:'unknown'};
        else result=await definition.reconcile(args,executionContextSchema.parse(this.store.readArtifact(t.context_ref)),this.store.getRun(t.run_id).conversation_id,signal);
      }catch{result={outcome:'unknown',content:'原执行位置或结果无法核验，未重复执行工具',data:null,verification:'unknown'};}
      this.store.settle(toolId,result,generation,true,result.mutated??(mutating&&result.outcome==='succeeded'));
      if(result.outcome==='unknown')throw new UmiError('TOOL_OUTCOME_UNKNOWN','存在无法核验的副作用，需要检查原环境');return;
    }
    if(t.state!=='prepared')return;
    const previous=this.store.tools(t.run_id).filter(x=>x.id!==t.id&&x.name===t.name&&x.args===t.args);
    if(previous.some(x=>x.state==='denied')){this.store.settle(toolId,{outcome:'denied',content:'相同操作已被拒绝，未重复请求或执行。',data:null},generation);return;}
    if(previous.length>=3){this.store.settle(toolId,{outcome:'failed',content:'相同工具请求重复且没有新信息，已阻止继续执行。',data:null},generation);throw new UmiError('TASK_STALLED','重复操作未取得进展');}
    let context:ExecutionContext;
    while(true) {
      signal.throwIfAborted();this.store.checkLease(t.run_id,generation);
      try{context=executionContextSchema.parse(definition.prepare(args,this.store.environment(t.environment_id),t.id));}
      catch(e){if(t.approval_id)this.store.invalidateApproval(toolId,'原对象无法核验');
        this.store.settle(toolId,{outcome:'failed',content:e instanceof UmiError?e.message:'无法准备工具执行位置',data:null},generation);return;}
      const needsApproval=definition.approvalRequired?.(args,context)??['scratch-write','resource','source-write','host-code'].includes(definition.effect);
      if(!needsApproval)break;
      t=this.store.tool(toolId);
      if(t.approval_id) {
        const approval=this.store.approval(t.approval_id);
        if(approval.decision==='deny'){definition.denied?.(args,context);this.store.settle(toolId,{outcome:'denied',content:'用户拒绝了本次操作，未执行。',data:null},generation);return;}
        if(!approval.valid||approval.request_hash!==hash({name:t.name,args:t.args,context})) {
          this.store.invalidateApproval(toolId,'批准对象、内容或环境版本已变化');continue;
        }
        if(approval.decision==='allow')break;
      } else {
        const location=context.locations[0];this.store.requestApproval(toolId,context,definition.approvalDescription?.(args,context)??`需要在 Umi 托管 scratch 区写入 ${location?.relativePath??'文件'}，用于当前任务；不会写入用户项目。`,generation);
      }
      // 等待只检查持久决定，不请求模型。断线不会使 signal 中止。
      await delay(definition.approvalPollMs??25,undefined,{signal});
    }
    this.store.checkLease(t.run_id,generation);
    const scope=this.store.preparedToolScope(t);
    this.store.commit({conversationId:scope.conversationId,runId:t.run_id},{type:'run.resumed',payload:{}});
    this.store.commit({conversationId:scope.conversationId,runId:t.run_id},{type:'run.phase_changed',payload:{phase:'execute'}});
    this.store.dispatch(toolId,context,generation);
    this.store.commit(scope,{type:'tool.started',payload:{}});
    let result:ToolResult;
    const executionSignal=AbortSignal.any([signal,AbortSignal.timeout(definition.executionTimeoutMs?.(args)??60000)]);
    try {result=await definition.execute(args,context,scope.conversationId,executionSignal);}
    catch(e) {
      if(mutating){result={outcome:'unknown',content:'操作执行中断或失败，实际效果需核验。',data:{code:e instanceof UmiError?e.code:'EXECUTION_ERROR'}};}
      else {result={outcome:signal.aborted?'cancelled':'failed',content:e instanceof UmiError?e.message:'工具执行失败',data:{code:e instanceof UmiError?e.code:'EXECUTION_ERROR'}};}
    }
    this.store.settle(toolId,result,generation,false,result.mutated??(mutating&&result.outcome==='succeeded'));
    if(result.outcome==='unknown')throw new UmiError('TOOL_OUTCOME_UNKNOWN','工具副作用未知，未自动重试');
  }
}
