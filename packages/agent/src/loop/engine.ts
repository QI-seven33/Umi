import {estimateInput} from '../context/estimate.js';
import {ContextBudgetError} from '../../../protocol/src/budget.js';
import {hash} from '../identity.js';
import { setTimeout as delay } from 'node:timers/promises';
import { uid } from '../identity.js';
import type { ModelPort, EnvironmentInitializer } from '../ports.js';
import type { PersistencePort } from '../persistence.js';
import type { EventScope } from '../../../protocol/src/events.js';
import type { WireMessage } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';
import { ContextManager } from '../context/manager.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';

export type EngineLimits={maxTurns:number;maxRetries:number;modelTimeoutMs:number;retryDelayMs:number};
export class AgentEngine {
  private readonly executor:ToolExecutor;
  constructor(private readonly store:PersistencePort,private readonly model:ModelPort,private readonly registry:ToolRegistry,
    private readonly context=new ContextManager(),private readonly limits:EngineLimits={maxTurns:24,maxRetries:2,modelTimeoutMs:180000,retryDelayMs:1000},
    private readonly environmentInitializer?:EnvironmentInitializer) {
    this.executor=new ToolExecutor(store,registry);
  }
  private facts(runId:string,includePending=false){
    const run=this.store.getRun(runId),environment=this.store.environment(run.environment_id),tools=this.store.tools(runId);
    return {messages:this.store.messages(run.conversation_id).map(m=>({...m,...(includePending?{applied:true}:{}),payload:{...m.payload,...(m.role==='user'&&this.store.settings(run.conversation_id).model==='deepseek-flash'?{images:this.store.messageImages(run.conversation_id,m.id)}:{})}})),settings:this.store.settings(run.conversation_id),memory:this.store.contextMemory(run.conversation_id),
      state:{runId,environmentId:environment.id,environmentRevision:environment.revision,phase:run.phase,resources:this.store.runtimeFacts(environment.id),attachments:this.store.messages(run.conversation_id).flatMap(m=>this.store.messageAttachments(run.conversation_id,m.id).map(a=>({...a,messageId:m.id}))),
        tools:tools.slice(-32).map(t=>({executionId:t.id,name:t.name,status:t.state,resultRef:t.result_ref})),toolCount:tools.length,
        instruction:run.phase==='finalize'?'必要操作已经结算。直接回应用户要求，依据真实结果给出最终答复，不再执行工具；不主动汇报内部挂载身份。':'自然回应当前用户要求。无需工具的寒暄、解释或讨论可以直接给出完整答复。需要实际操作时先简短说明进展，再使用必要工具；内部运行状态仅用于判断，不是需要复述的回复模板。'}};
  }
  recoveryBudget(runId:string){
    const r=this.store.getRun(runId),block=this.store.snapshot(r.conversation_id).runs[runId]?.budgetBlock;
    if(!block)return {blocked:false,canResume:true,reason:null,details:null};
    const facts=this.facts(runId,true),specs=r.phase==='finalize'&&!this.store.messages(r.conversation_id).some(m=>!m.applied)?[]:this.registry.specs();
    try{
      const c=this.context.inspect(facts,specs),policyFingerprint=hash(this.context.policy(facts.settings)),sourceFingerprint=this.store.contextSourceFingerprint(runId);
      const unchanged=policyFingerprint===block.policyFingerprint&&sourceFingerprint===block.sourceFingerprint;
      const protectedOver=c.metrics.protectedInputTokens>c.inputCeiling;
      const prepared=this.model.prepare(c.messages,specs,facts.settings,c.maxOutputTokens);
      c.estimatedInputTokens=Math.max(c.estimatedInputTokens,estimateInput(prepared.body)+64*c.messages.length+128);
      const fits=c.estimatedInputTokens<=c.inputCeiling;
      const canResume=!protectedOver&&(!unchanged||fits);
      return {blocked:true,canResume,reason:canResume?'预算或上下文条件已改变，恢复后仍会重新核验。':protectedOver?'完整用户要求和必需状态仍超过预算；增加消息或直接重试不能解除阻塞。':'请求条件没有变化，直接恢复会再次超预算。',details:this.context.budgetDetails(c,'projection')};
    }catch(e){return {blocked:true,canResume:false,reason:e instanceof UmiError?e.message:'预算恢复检查失败',details:e instanceof ContextBudgetError?e.details:null};}
  }
  async run(runId:string,signal:AbortSignal,recovery=false):Promise<void> {
    const run=this.store.getRun(runId),scope={conversationId:run.conversation_id,runId};let generation=run.generation;
    try {
      if(recovery&&!this.recoveryBudget(runId).canResume)return;
      generation=this.store.claim(runId,recovery);
      // 重启后先结算已派发/准备的完整工具组，禁止重新调用模型绕过未知副作用。
      for(const t of this.store.tools(runId).filter(t=>['prepared','dispatched','unknown'].includes(t.state)))await this.executor.execute(t.id,generation,signal);
      this.environmentInitializer?.initialize(run.environment_id);
      if(recovery){const state=this.store.snapshot(scope.conversationId),events=state.blocks.filter(b=>b.runId===runId&&b.status==='running');
        for(const attemptId of new Set(events.map(b=>b.attemptId))){const b=events.find(b=>b.attemptId===attemptId)!;
          this.store.commit({...scope,modelTurnId:b.turnId,modelAttemptId:b.attemptId},{type:'model.attempt_failed',payload:{code:'PROVIDER_INTERRUPTED',reason:'旧进程未提交完整模型响应，保留已显示前缀'}});}}
      if(recovery)this.store.commit(scope,{type:'run.resumed',payload:{}});
      while(true) {
        signal.throwIfAborted();this.store.checkLease(runId,generation);
        if(this.store.getRun(runId).phase==='waiting') {
          this.store.commit(scope,{type:'run.resumed',payload:{}});
          this.store.commit(scope,{type:'run.phase_changed',payload:{phase:'execute'}});
        }
        if(this.store.getRun(runId).model_turns>=this.limits.maxTurns)throw new UmiError('TASK_LIMIT','已达到本次运行的模型轮次上限');
        const pending=this.store.messages(scope.conversationId).some(m=>m.runId===runId&&!m.applied);
        if(pending&&this.store.getRun(runId).phase==='finalize')this.store.commit(scope,{type:'run.phase_changed',payload:{phase:'execute'}});
        this.store.applyInputs(runId);
        const current=this.store.getRun(runId),env=this.store.environment(current.environment_id),finalizing=current.phase==='finalize';
        const specs=finalizing?[]:this.registry.specs();
        const facts=()=>{
          if(this.store.messages(scope.conversationId).some(m=>!m.applied)&&this.store.getRun(runId).phase==='finalize')this.store.commit(scope,{type:'run.phase_changed',payload:{phase:'execute'}});
          this.store.applyInputs(runId);const latest=this.store.getRun(runId),environment=this.store.environment(latest.environment_id);
          if(latest.phase!==current.phase)throw new UmiError('CONTEXT_SOURCE_CHANGED','维护期间收到新用户指令，重新进入执行阶段');
          return this.facts(runId);
        };
        let context:Awaited<ReturnType<ContextManager['prepareTurn']>>;
        try{context=await this.context.prepareTurn(this.store,this.model,runId,generation,specs,facts,signal,this.limits.modelTimeoutMs);}
        catch(error){if(error instanceof UmiError&&error.code==='CONTEXT_SOURCE_CHANGED')continue;throw error;}
        const prepared=this.model.prepare(context.messages,specs,this.store.settings(scope.conversationId),context.maxOutputTokens);
        // 编码后再核对实际请求体，不能仅依语义消息估算放行。
        context.estimatedInputTokens=Math.max(context.estimatedInputTokens,estimateInput(prepared.body)+64*context.messages.length+128);
        if(context.estimatedInputTokens>context.inputCeiling)throw new ContextBudgetError('编码后的实际请求超过预算，未派发模型。',this.context.budgetDetails(context,'encoded'));
        // JSON 往返切断引用，后续配置变化不能修改本轮快照。
        const frozen=JSON.parse(JSON.stringify(prepared)) as typeof prepared;
        const turnScope:EventScope={...scope,modelTurnId:uid(),modelAttemptId:uid()},requestId=uid(),contextId=uid();
        if(this.store.snapshot(scope.conversationId).runs[runId]?.budgetBlock)this.store.commit(scope,{type:'context.budget_cleared',payload:{}});
        this.store.persistRequest(turnScope,requestId,contextId,frozen,context,generation);
        let answer:WireMessage|undefined,messageId:string|undefined;
        for(let retry=0;retry<=this.limits.maxRetries;retry++) {
          if(retry)turnScope.modelAttemptId=uid();
          this.store.checkLease(runId,generation);this.store.commit(turnScope,{type:'model.attempt_started',payload:{requestId}});
          const blocks:{id:string;channel:'reasoning'|'text'|'tool';key:string;deltaIndex:number}[]=[];
          try {
            const attemptSignal=AbortSignal.any([signal,AbortSignal.timeout(this.limits.modelTimeoutMs)]);
            let sawResponse=false;
            for await(const frame of this.model.stream(frozen,attemptSignal)) {
              this.store.checkLease(runId,generation);signal.throwIfAborted();
              if(sawResponse)throw new UmiError('PROTOCOL_INVALID','完成响应后仍返回模型数据');
              if(frame.kind==='delta') {
                let block=blocks.at(-1);
                if(!block||block.channel!==frame.channel||block.key!==frame.key) {
                  block={id:uid(),channel:frame.channel,key:frame.key,deltaIndex:0};blocks.push(block);
                  this.store.commit(turnScope,{type:'model.block_started',payload:{blockId:block.id,kind:block.channel,displayRole:finalizing?'final':'commentary'}});
                }
                this.store.commit(turnScope,{type:'model.delta',payload:{blockId:block.id,kind:block.channel,deltaIndex:block.deltaIndex++,text:frame.text}});
              } else {
                sawResponse=true;answer=frame.message;
                if(finalizing&&answer.tool_calls?.length)throw new UmiError('PROTOCOL_INVALID','总结阶段不得派发新的工具');
                for(const block of blocks)this.store.commit(turnScope,{type:'model.block_completed',payload:{blockId:block.id}});
                messageId=this.store.persistResponse(turnScope,answer,frame.raw,frame.usage,requestId,generation,frame.finishReason);
              }
            }
            if(!sawResponse||!answer||!messageId)throw new UmiError('PROVIDER_INTERRUPTED','模型未形成完整响应',true);
            break;
          }catch(error) {
            const sqliteFailure=String((error as {code?:string}).code??'').includes('SQLITE');
            const e=error instanceof UmiError?error:new UmiError(sqliteFailure?'PERSISTENCE_FAILED':signal.aborted?'STOPPED':'PROVIDER_INTERRUPTED',sqliteFailure?'数据库提交失败':signal.aborted?'执行已中断':'模型请求中断',!signal.aborted&&!sqliteFailure);
            if(!messageId)this.store.commit(turnScope,{type:'model.attempt_failed',payload:{code:e.code,reason:e.message}});
            if(signal.aborted||!e.retryable||retry===this.limits.maxRetries||messageId)throw e;
            await delay(this.limits.retryDelayMs,undefined,{signal});
          }
        }
        const calls=this.store.tools(runId).filter(t=>t.attempt_id===turnScope.modelAttemptId);
        for(const t of calls)await this.executor.execute(t.id,generation,signal);
        if(calls.length)continue;
        if(!answer?.content.trim())throw new UmiError('PROTOCOL_INVALID','模型未给出可用正文');
        if(this.store.messages(scope.conversationId).some(m=>m.runId===runId&&!m.applied))continue;
        if(this.store.tools(runId).some(t=>['prepared','dispatched','unknown'].includes(t.state)))throw new UmiError('TOOL_OUTCOME_UNKNOWN','仍存在未结算的工具');
        if(!finalizing){
          this.store.commit(scope,{type:'run.phase_changed',payload:{phase:'finalize'}});
          // 完整工具组已结算且无新调用：本次正文就是最终答复，不再强制请求重复总结。
        }
        this.store.checkLease(runId,generation);this.store.commit(scope,{type:'run.completed',payload:{messageId:messageId!}});return;
      }
    }catch(error) {
      const r=this.store.getRun(runId),sqliteFailure=String((error as {code?:string}).code??'').includes('SQLITE');
      const e=error instanceof UmiError?error:new UmiError(sqliteFailure?'PERSISTENCE_FAILED':'EXECUTION_ERROR',sqliteFailure?'数据库提交失败，未继续派发副作用':'执行发生异常');
      if(e.code==='RUN_TERMINAL')return;
      if(r.stop_requested) {
        for(const t of this.store.tools(runId).filter(t=>t.state==='prepared')){
          if(t.approval_id)this.store.invalidateApproval(t.id,'用户已停止任务');
          this.store.settle(t.id,{outcome:'cancelled',content:'用户停止任务，工具尚未派发。',data:null},generation);
        }
        this.store.commit(scope,{type:'run.stopped',payload:{reason:'用户明确停止任务'}});
      }else if(signal.aborted)this.store.commit(scope,{type:'run.interrupted',payload:{reason:'应用执行器退出；任务未被用户停止'}});
      else if(e.code==='TOOL_OUTCOME_UNKNOWN'||this.store.tools(runId).some(t=>['dispatched','unknown'].includes(t.state)))
        this.store.commit(scope,{type:'run.recovery_required',payload:{reason:e.message}});
      else if(e instanceof ContextBudgetError){this.store.commit(scope,{type:'context.budget_blocked',payload:{...e.details,sourceFingerprint:this.store.contextSourceFingerprint(runId),policyFingerprint:hash(this.context.policy(this.store.settings(scope.conversationId)))}});this.store.commit(scope,{type:'run.interrupted',payload:{reason:e.message,code:e.code}});}
      else if(['PROVIDER_QUOTA','PROVIDER_INTERRUPTED','CONTEXT_BUDGET_EXCEEDED','CONTEXT_SOURCE_CHANGED'].includes(e.code))this.store.commit(scope,{type:'run.interrupted',payload:{reason:e.message}});
      else this.store.commit(scope,{type:'run.failed',payload:{code:e.code,reason:e.message}});
    }
  }
}
