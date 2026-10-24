import type {SqliteStore} from './store.js';
import type {ToolRow} from '../../../agent/src/persistence.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import {UmiError,executionContextSchema} from '../../../protocol/src/model.js';
import {hash} from '../../../agent/src/identity.js';
import {taskCommandCandidate} from '../../../agent/src/tools/command-permission.js';

type Authorization={version:1;kind:'grant'|'reuse';executionId:string;approvalId:string;sourceApprovalId:string;
 instanceId:string;runId:string;generation:number;inputId:string;settingsVersion:number;grantsHash:string;commandHash:string};

// 许可事实复用不可变artifact与批准事件；实例/输入/租约变化后只保留历史，不恢复许可。
export class CommandPermissions {
 constructor(readonly store:SqliteStore){}
 private stamp(t:ToolRow){
  const s=this.store,r=s.getRun(t.run_id),c=s.conversation(r.conversation_id);
  return {instanceId:s.instanceId,runId:r.id,generation:r.generation,
   inputId:s.latestUserInputId(r.conversation_id,r.id),
   settingsVersion:Number(c.settings_version),
   grantsHash:hash(s.all('SELECT id,root,root_identity,scope,access,revision,revoked FROM workspace_file_grants WHERE workspace_id=? ORDER BY id',String(c.workspace_id)))};
 }
 private key(t:ToolRow,ctx:ExecutionContext){
  const {executionId:_id,leaseGeneration:_lease,...process}=ctx.process!;
  return hash({name:t.name,environmentId:ctx.environmentId,bindingRoot:ctx.bindingRoot,rootIdentity:ctx.rootIdentity,runtimeId:ctx.runtimeId,process});
 }
 eligible(t:ToolRow,ctx:ExecutionContext){
  return this.store.settings(this.store.getRun(t.run_id).conversation_id).executionPolicy==='auto'&&taskCommandCandidate(t.name,ctx);
 }
 private records(kind:'grant'|'reuse',value:string){
  // 固定种类/JSON路径与迁移索引一致；路径参数化不能命中表达式部分。
  const sql=kind==='grant'
   ? "SELECT id FROM artifacts WHERE kind='command-task-grant' AND json_extract(content,'$.runId')=?"
   : "SELECT id FROM artifacts WHERE kind='command-task-reuse' AND json_extract(content,'$.executionId')=?";
  return this.store.all(sql,value)
   .map(row=>({ref:String(row.id),value:this.store.readArtifact<Authorization>(String(row.id))}));
 }
 private active(a:Authorization,t:ToolRow,ctx:ExecutionContext){
  if(!this.eligible(t,ctx)||a.commandHash!==this.key(t,ctx))return false;
  const s=this.store,r=s.getRun(t.run_id),source=s.approval(a.sourceApprovalId);
  if(r.stop_requested||!['running','waiting_permission'].includes(r.status)||!source.valid||source.decision!=='allow'||source.run_id!==t.run_id)return false;
  const current=this.stamp(t);
  return Object.entries(current).every(([key,value])=>a[key as keyof Authorization]===value);
 }
 grant(t:ToolRow,ctx:ExecutionContext,approvalId:string){
  if(!this.eligible(t,ctx))throw new UmiError('PERMISSION_DENIED','此操作不能授予任务内复用许可，仍需逐次批准');
  const value:Authorization={version:1,kind:'grant',executionId:t.id,approvalId,sourceApprovalId:approvalId,...this.stamp(t),commandHash:this.key(t,ctx)};
  return this.store.artifact(value,'command-task-grant');
 }
 reuse(toolId:string,ctx:ExecutionContext,generation:number):boolean{
  const s=this.store,t=s.tool(toolId);
  if(t.approval_id||!this.eligible(t,ctx))return false;
  const grant=this.records('grant',t.run_id).find(a=>this.active(a.value,t,ctx));
  if(!grant)return false;
  // 先持久化待决定请求；中断在两事务之间时仅留下待用户处理的请求，不自动执行。
  const id=s.requestApproval(toolId,ctx,'按本任务具体命令许可再次执行；来源批准：'+grant.value.sourceApprovalId,generation);
  return s.transaction(()=>{
   s.checkLease(t.run_id,generation);
   if(!this.active(grant.value,s.tool(toolId),ctx))return false;
   const authorizationRef=s.artifact({...grant.value,kind:'reuse',executionId:toolId,approvalId:id} satisfies Authorization,'command-task-reuse');
   s.run("UPDATE approval_requests SET decision='allow' WHERE id=?",id);
   s.append(s.preparedToolScope(s.tool(toolId)),{type:'approval.decided',payload:{approvalId:id,decision:'allow',decisionSource:'task-grant',sourceApprovalId:grant.value.sourceApprovalId,authorizationRef}});
   return true;
  });
 }
 hasGrant(approvalId:string){return Boolean(this.store.get("SELECT id FROM artifacts WHERE kind='command-task-grant' AND json_extract(content,'$.approvalId')=?",approvalId));}
 assert(t:ToolRow,ctx:ExecutionContext){
  if(!ctx.process)return;
  const record=this.records('reuse',t.id)[0];if(!record)return;
  if(record.value.approvalId!==t.approval_id||!this.active(record.value,t,ctx))
   throw new UmiError('APPROVAL_STALE','任务命令许可已失效；旧批准未升级，不会释放原程序');
 }
 grantRef(conversationId:string,approvalId:string){
  const s=this.store,a=s.approval(approvalId),t=s.tool(a.execution_id);
  if(s.getRun(a.run_id).conversation_id!==conversationId||!t.context_ref)throw new UmiError('PROTOCOL_INVALID','批准不属于当前会话或缺少执行快照');
  return this.grant(t,executionContextSchema.parse(s.readArtifact(t.context_ref)),approvalId);
 }
}
