import type {SqliteStore} from './store.js';
import {hash,canonical,uid} from '../../../agent/src/identity.js';
import {UmiError} from '../../../protocol/src/model.js';
import {memorySourceSchema,memoryValueSchema,summarySchema,maintenancePlanSchema} from '../../../protocol/src/memory.js';
import {validateArchive,ordered} from '../../../agent/src/context/projection.js';
import type {MemorySource,MemoryValue,MemoryEntry,ContextMemory,MaintenancePlan,Summary} from '../../../protocol/src/memory.js';

type Manifest={version:number;archiveIds:string[];sourceHashes:Record<string,string>;sourceFingerprint:string;reason:string};
export class MemoryRepository {
  constructor(private readonly store:SqliteStore){}
  fingerprint(runId:string):string {
    const run=this.store.getRun(runId),environment=this.store.environment(run.environment_id);
    return hash({messages:this.store.messages(run.conversation_id).map(m=>({id:m.id,hash:hash(m.payload),applied:m.applied,sequence:m.projectionSequence})),
      settings:this.store.settings(run.conversation_id),environmentRevision:environment.revision,phase:run.phase,
      entries:this.store.all('SELECT id,artifact_ref FROM memory_entries WHERE conversation_id=? ORDER BY rowid',run.conversation_id),
      window:this.store.snapshot(run.conversation_id).memory.window});
  }
  load(conversationId:string):ContextMemory {
    const window=this.store.snapshot(conversationId).memory.window;
    const manifest=window.manifestRef?this.store.readArtifact<Manifest>(window.manifestRef):null;
    if(manifest){if(manifest.version!==window.version||!Array.isArray(manifest.archiveIds))throw new UmiError('PROTOCOL_INVALID','上下文清单版本错误');
      const rows=ordered(this.store.messages(conversationId)),positions=new Map(rows.map((m,index)=>[m.id,index]));let last=-1;
      for(const id of manifest.archiveIds)last=Math.max(last,positions.get(id)??-1);
      // 读取笔记可发生在当前工具组尚未结算时；只核验已退休前缀，不能要求正在运行的组提前有结果。
      validateArchive(rows.slice(0,last+1),manifest.archiveIds,manifest.sourceHashes);}
    const entries=this.store.all('SELECT * FROM memory_entries WHERE conversation_id=? ORDER BY rowid',conversationId).map(row=>({id:row.id as string,executionId:row.execution_id as string,
      artifactRef:row.artifact_ref as string,value:memoryValueSchema.parse(this.store.readArtifact(row.artifact_ref as string))}));
    return {window,archivedIds:manifest?.archiveIds??[],summary:window.summaryRef?summarySchema.parse(this.store.readArtifact(window.summaryRef)):null,entries};
  }
  accessible(conversationId:string,artifactId:string):unknown {
    this.store.conversation(conversationId);
    const owned=this.store.get(`SELECT id FROM tool_executions WHERE result_ref=? AND run_id IN(SELECT id FROM runs WHERE conversation_id=?)
      UNION ALL SELECT id FROM context_snapshots WHERE artifact_id=? AND conversation_id=?
      UNION ALL SELECT id FROM memory_entries WHERE artifact_ref=? AND conversation_id=?
      UNION ALL SELECT p.execution_id FROM process_outputs p JOIN tool_executions t ON t.id=p.execution_id JOIN runs r ON r.id=t.run_id WHERE p.artifact_ref=? AND r.conversation_id=?
      UNION ALL SELECT p.execution_id FROM process_executions p JOIN tool_executions t ON t.id=p.execution_id JOIN runs r ON r.id=t.run_id WHERE p.receipt_ref=? AND r.conversation_id=?
      UNION ALL SELECT id FROM context_maintenance WHERE (plan_ref=? OR summary_ref=? OR manifest_ref=?) AND conversation_id=? LIMIT 1`,
      artifactId,conversationId,artifactId,conversationId,artifactId,conversationId,artifactId,conversationId,artifactId,conversationId,artifactId,artifactId,artifactId,conversationId);
    if(!owned)throw new UmiError('PERMISSION_DENIED','资料不属于当前会话的可读记录');
    return this.store.readArtifact(artifactId);
  }
  source(conversationId:string,input:MemorySource):string {
    const source=memorySourceSchema.parse(input);
    const text=source.kind==='message'?this.store.messageById(conversationId,source.messageId)?.payload.content:canonical(this.accessible(conversationId,source.artifactId));
    if(text===undefined)throw new UmiError('PERMISSION_DENIED','记忆引用不属于当前会话');
    const bytes=Buffer.from(text);
    if(source.endByte>bytes.length||[source.startByte,source.endByte].some(i=>i<bytes.length&&(bytes[i]!&0xc0)===0x80))throw new UmiError('PROTOCOL_INVALID','来源范围越界或切开 UTF-8 字符');
    return bytes.subarray(source.startByte,source.endByte).toString('utf8');
  }
  save(executionId:string,input:MemoryValue):MemoryEntry {
    const value=memoryValueSchema.parse(input),tool=this.store.tool(executionId),run=this.store.getRun(tool.run_id);
    const names={note:'record_work_note',requirement:'record_requirement',reset:'request_context_reset'};
    const original=memoryValueSchema.parse({kind:value.kind,value:JSON.parse(tool.args)});
    if(tool.name!==names[value.kind]||hash(original)!==hash(value))throw new UmiError('PROTOCOL_INVALID','记忆与原工具参数不一致');
    const old=this.store.get('SELECT * FROM memory_entries WHERE execution_id=?',executionId);
    if(old){const existing=memoryValueSchema.parse(this.store.readArtifact(old.artifact_ref as string));if(hash(existing)!==hash(value))throw new UmiError('PROTOCOL_INVALID','同一工具执行的记忆内容改变');
      return {id:old.id as string,executionId,artifactRef:old.artifact_ref as string,value:existing};}
    if(tool.state!=='dispatched')throw new UmiError('PROTOCOL_INVALID','记忆必须来自已派发的原工具');
    if(value.kind==='requirement'){
      const source=value.value.source;if(source.kind!=='message')throw new UmiError('PROTOCOL_INVALID','要求候选只能引用用户原话');
      const message=this.store.messageById(run.conversation_id,source.messageId);
      if(message?.role!=='user'||!message.applied||this.source(run.conversation_id,source)!==value.value.text)throw new UmiError('PROTOCOL_INVALID','要求候选不是用户原文');
      const rows=this.store.messages(run.conversation_id),sourceIndex=rows.findIndex(m=>m.id===message.id);
      for(const priorId of value.value.supersedes){const prior=this.store.messageById(run.conversation_id,priorId),priorIndex=rows.findIndex(m=>m.id===priorId);
        if(prior?.role!=='user'||!prior.applied||priorIndex<0||priorIndex>=sourceIndex)throw new UmiError('PROTOCOL_INVALID','替代候选必须指向更早的用户原文');}
    }else if(value.kind==='note'){
      const sources=value.value.sources.map(s=>this.source(run.conversation_id,s));
      if(value.value.category==='observation'&&(sources.length!==1||sources[0]!==value.value.text))throw new UmiError('PROTOCOL_INVALID','观察笔记必须是单一来源的逐字引用；判断请使用 inference');
    }else for(const source of value.value.keepSources)this.source(run.conversation_id,source);
    return this.store.transaction(()=>{const entryId=uid(),artifactRef=this.store.artifact(value,'model-memory');
      this.store.run('INSERT INTO memory_entries VALUES(?,?,?,?,?)',entryId,run.conversation_id,executionId,value.kind,artifactRef);
      this.store.append(this.store.preparedToolScope(tool),{type:'memory.recorded',payload:{entryId,kind:value.kind,artifactRef}});
      return {id:entryId,executionId,artifactRef,value};});
  }
  start(plan:MaintenancePlan,generation:number):boolean {
    maintenancePlanSchema.parse(plan);
    return this.store.transaction(()=>{this.store.checkLease(plan.runId,generation);
      if(this.store.getRun(plan.runId).conversation_id!==plan.conversationId)throw new UmiError('PERMISSION_DENIED','维护不属于此会话');
      validateArchive(this.store.messages(plan.conversationId),plan.archiveIds,plan.sourceHashes);
      const memory=this.load(plan.conversationId);if(memory.archivedIds.some(id=>!plan.archiveIds.includes(id)))throw new UmiError('PROTOCOL_INVALID','维护不能隐式恢复旧窗口');
      if(plan.resetEntryId&&!memory.entries.some(e=>e.id===plan.resetEntryId&&e.value.kind==='reset'))throw new UmiError('PROTOCOL_INVALID','窗口切换没有原始请求来源');
      if(this.fingerprint(plan.runId)!==plan.sourceFingerprint||this.load(plan.conversationId).window.version!==plan.baseVersion)throw new UmiError('CONTEXT_SOURCE_CHANGED','维护来源已变化');
      if(this.store.get('SELECT id FROM context_maintenance WHERE conversation_id=? AND base_version=? AND source_fingerprint=? AND mode=?',plan.conversationId,plan.baseVersion,plan.sourceFingerprint,plan.mode))return false;
      const ref=this.store.artifact(plan,'context-maintenance-plan');this.store.run("INSERT INTO context_maintenance VALUES(?,?,?,?,?,?,'started',?,NULL,NULL)",plan.id,plan.conversationId,plan.runId,plan.baseVersion,plan.sourceFingerprint,plan.mode,ref);
      this.store.append({conversationId:plan.conversationId,runId:plan.runId},{type:'context.maintenance_started',payload:{maintenanceId:plan.id,planRef:ref,baseVersion:plan.baseVersion,mode:plan.mode}});return true;});
  }
  finish(plan:MaintenancePlan,summary:Summary|null,raw:unknown,usage:unknown,generation:number):void {
    this.store.transaction(()=>{this.store.checkLease(plan.runId,generation);if(this.fingerprint(plan.runId)!==plan.sourceFingerprint)throw new UmiError('CONTEXT_SOURCE_CHANGED','摘要生成期间来源改变，候选未应用');
      const row=this.store.get('SELECT * FROM context_maintenance WHERE id=?',plan.id);if(row?.state!=='started'||hash(this.store.readArtifact(row.plan_ref as string))!==hash(plan))throw new UmiError('PROTOCOL_INVALID','维护计划或状态不匹配');
      validateArchive(this.store.messages(plan.conversationId),plan.archiveIds,plan.sourceHashes);
      if(summary&&summarySchema.parse(summary).items.some(item=>item.sourceIds.some(id=>!plan.archiveIds.includes(id))))throw new UmiError('PROTOCOL_INVALID','摘要没有对应的原始来源');
      const summaryRef=summary?this.store.artifact(summarySchema.parse(summary),'context-summary'):null,version=plan.baseVersion+1;
      const manifestRef=this.store.artifact({version,archiveIds:plan.archiveIds,sourceHashes:plan.sourceHashes,sourceFingerprint:plan.sourceFingerprint,reason:plan.reason},'context-manifest');
      this.auditResponse(plan,raw,usage);
      this.store.run("UPDATE context_maintenance SET state='completed',summary_ref=?,manifest_ref=? WHERE id=?",summaryRef,manifestRef,plan.id);
      this.store.append({conversationId:plan.conversationId,runId:plan.runId},{type:'context.window_committed',payload:{maintenanceId:plan.id,version,summaryRef,manifestRef,resetEntryId:plan.resetEntryId}});});
  }
  private auditResponse(plan:MaintenancePlan,raw:unknown,usage:unknown){
    const scope={conversationId:plan.conversationId,runId:plan.runId};
    if(raw!==null&&raw!==undefined){const responseRef=this.store.artifact(raw,'maintenance-response');this.store.append(scope,{type:'context.maintenance_response',payload:{maintenanceId:plan.id,responseRef}});}
    if(usage!==null&&usage!==undefined){const usageRef=this.store.artifact(usage,'maintenance-usage');this.store.append(scope,{type:'context.maintenance_usage',payload:{maintenanceId:plan.id,usageRef}});}
  }
  fail(plan:MaintenancePlan,code:string,generation:number,raw:unknown=null,usage:unknown=null):void {
    const run=this.store.getRun(plan.runId);if(run.generation!==generation)throw new UmiError('LEASE_LOST','维护结算来自旧执行者');
    this.store.transaction(()=>{if(this.store.get('SELECT state FROM context_maintenance WHERE id=?',plan.id)?.state!=='started')return;
      this.auditResponse(plan,raw,usage);
      this.store.run("UPDATE context_maintenance SET state='failed' WHERE id=?",plan.id);
      this.store.append({conversationId:plan.conversationId,runId:plan.runId},{type:'context.maintenance_failed',payload:{maintenanceId:plan.id,code}});});
  }
}
