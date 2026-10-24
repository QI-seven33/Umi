import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {messageGroups,validateArchive} from '../packages/agent/src/context/projection.js';
import {SqliteStore} from '../packages/adapters/src/sqlite/store.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';
import {validatePairs,settingsSchema,UmiError} from '../packages/protocol/src/model.js';
import type {WireMessage} from '../packages/protocol/src/model.js';
import type {MaintenancePlan} from '../packages/protocol/src/memory.js';
import {hash,uid} from '../packages/agent/src/identity.js';
import {ScriptModel,text,call,removeTestRoot,eventually,projectedFacts} from './fixtures.js';
import {hostContext} from '../packages/adapters/src/host-files/scratch.js';

import {contextFixture,appendResponse} from './context-fixture.js';
function summaryFor(request:import('../packages/agent/src/ports.js').PreparedRequest){const input=JSON.parse((request.body.messages as WireMessage[])[1]!.content);return text(JSON.stringify({items:[{kind:'decision',text:'旧资料仅作参考；方案 B 已否决，继续按用户原文处理。',sourceIds:[input.sources[0].sourceId]}]}));}
function planFor(f:ReturnType<typeof contextFixture>,ids:string[]):MaintenancePlan{return {id:uid(),conversationId:f.c.conversationId,runId:f.runId,baseVersion:f.app.store.contextMemory(f.c.conversationId).window.version,sourceFingerprint:f.app.store.contextSourceFingerprint(f.runId),mode:'compact',reason:'测试维护',archiveIds:ids,sourceHashes:Object.fromEntries(f.app.store.messages(f.c.conversationId).filter(m=>ids.includes(m.id)).map(m=>[m.id,hash(m.payload)])),beforeEstimate:90000,candidateEstimate:40000,summaryInput:{},request:null,resetEntryId:null};}

test('S4-01：完整消息组边界与用户原文保护，拒绝退休半个工具组',()=>{
  const rows=[{id:'u',payload:{role:'user' as const,content:'细节'},applied:true,projectionSequence:'1'},
    {id:'a',payload:call('x',{},'原思考','c'),applied:true,projectionSequence:'2'},
    {id:'t',payload:{role:'tool' as const,tool_call_id:'c',content:'结果'},applied:true,projectionSequence:'3'}];
  assert.deepEqual(messageGroups(rows).map(g=>g.map(m=>m.id)),[['u'],['a','t']]);
  const hashes=Object.fromEntries(rows.map(m=>[m.id,hash(m.payload)]));assert.throws(()=>validateArchive(rows,['a'],hashes),/拆开/);assert.throws(()=>validateArchive(rows,['u'],hashes),/用户原话/);validateArchive(rows,['a','t'],hashes);
});

test('S4-02：自动压缩、要求原文、原始 reasoning 回传、快照和重放一致',async()=>{
  const f=contextFixture();try{
    const original=f.app.store.messages(f.c.conversationId);appendResponse(f.app,f.runId,f.generation,call('search_history',{query:'方案 B'},'继续核对','reasoning-call'));
    const t=f.app.store.tools(f.runId).at(-1)!;f.app.store.settle(t.id,{outcome:'succeeded',content:'已找到原文',data:null},f.generation);
    const model=new ScriptModel([summaryFor]),ctx=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);
    assert.equal(ctx.contextVersion,2);assert(ctx.metrics.archivedMessages>0);assert(ctx.estimatedInputTokens<ctx.metrics.rawInputTokens);validatePairs(ctx.messages);
    assert(ctx.messages.some(m=>m.role==='user'&&m.content===original[0]!.payload.content));
    const kept=f.app.store.messages(f.c.conversationId).find(m=>m.payload.tool_calls?.[0]?.id==='reasoning-call')!;
    assert.equal(ctx.messages.find(m=>m.tool_calls?.[0]?.id==='reasoning-call')?.reasoning_content,kept.payload.reasoning_content);
    const wire=new DeepSeekAdapter(()=>'', 'https://api.deepseek.com').prepare(ctx.messages,[{name:'x',description:'工具',parameters:{type:'object'}}],settingsSchema.parse({thinking:'high'}),1024);
    assert.equal((wire.body.messages as WireMessage[]).find(m=>m.tool_calls?.[0]?.id==='reasoning-call')?.reasoning_content,kept.payload.reasoning_content);
    assert.deepEqual(f.app.store.messages(f.c.conversationId).slice(0,original.length),original);const state=f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)),state);
    assert(Object.values(state.memory.maintenance)[0]?.responseRef);assert(Object.values(state.memory.maintenance)[0]?.usageRef);
    const id=uid(),scope={conversationId:f.c.conversationId,runId:f.runId,modelTurnId:uid(),modelAttemptId:uid()};f.app.store.persistRequest(scope,id,uid(),wire,ctx,f.generation);
    assert.equal(f.app.store.snapshot(f.c.conversationId).context.metrics?.contextVersion,2);assert.equal(f.app.store.all('SELECT version FROM context_snapshots').at(-1)!.version,2);
  }finally{await f.close();}
});

test('S4-03：低压力稳定前缀及原历史只追加，不触发维护调用',async()=>{
  const f=contextFixture(1,100);try{const model=new ScriptModel([]),ctx=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);
    assert.equal(model.requests.length,0);assert.equal(ctx.contextVersion,1);assert.equal(f.app.store.maintenanceCount(f.runId),0);
    const prefix=ctx.messages[0];appendResponse(f.app,f.runId,f.generation,text('新事实'));const after=f.manager.prepare(f.facts(),[]);assert.deepEqual(after.messages[0],prefix);assert.deepEqual(after.messages.slice(1,ctx.messages.length-1),ctx.messages.slice(1,-1));
  }finally{await f.close();}
});

for(const failure of ['bad-json','bad-source','provider-quota'])test(`S4-04：${failure} 维护失败不删除原文；硬预算用明示原文片段恢复`,async()=>{
  const f=contextFixture(12);try{const model=new ScriptModel([request=>{if(failure==='provider-quota')throw new UmiError('PROVIDER_QUOTA','额度耗尽');if(failure==='bad-json')return text('无效摘要');return text(JSON.stringify({items:[{kind:'decision',text:'假的来源',sourceIds:['outside']}]}));}]);
    const original=f.app.store.messages(f.c.conversationId),ctx=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);
    assert.equal(ctx.contextVersion,2);assert(ctx.messages.some(m=>m.content.includes('原始 assistant 记录片段')));assert.deepEqual(f.app.store.messages(f.c.conversationId),original);
    const states=Object.values(f.app.store.snapshot(f.c.conversationId).memory.maintenance);assert.equal(states.filter(m=>m.status==='failed').length,1);assert.equal(states.filter(m=>m.status==='completed').length,1);
    if(failure!=='provider-quota')assert(states.find(m=>m.status==='failed')!.usageRef);
  }finally{await f.close();}
});

test('S4-05：维护期间新用户更正，旧摘要候选丢弃并重建',async()=>{
  const f=contextFixture();let first=true;try{const model=new ScriptModel([summaryFor,summaryFor]);model.beforeResponse=async()=>{if(first){first=false;f.app.store.acceptInput(f.c.conversationId,uid(),'最新更正：不要改红色，使用灰色');}};
    const facts=()=>{f.app.store.applyInputs(f.runId);return f.facts();},ctx=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],facts,new AbortController().signal);
    assert(ctx.messages.some(m=>m.content==='最新更正：不要改红色，使用灰色'));assert.equal(ctx.contextVersion,2);assert.equal(model.requests.length,2);
    assert(Object.values(f.app.store.snapshot(f.c.conversationId).memory.maintenance).some(m=>m.code==='CONTEXT_SOURCE_CHANGED'));
  }finally{await f.close();}
});

test('S4-06：维护事务失败不发布窗口；响应和 usage 与提交一起回滚',async()=>{
  const f=contextFixture();try{const p=planFor(f,f.app.store.messages(f.c.conversationId).filter(m=>m.role==='assistant').slice(0,4).map(m=>m.id));f.app.store.startMaintenance(p,f.generation);
    f.app.store.db.exec("CREATE TRIGGER fail_window BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='context.window_committed' BEGIN SELECT RAISE(ABORT,'维护事务故障'); END;");
    assert.throws(()=>f.app.store.finishMaintenance(p,{items:[{kind:'decision',text:'旧资料',sourceIds:[p.archiveIds[0]!]}]},{raw:1},{prompt_tokens:12},f.generation),/事务故障/);
    assert.equal(f.app.store.contextMemory(f.c.conversationId).window.version,1);const m=f.app.store.snapshot(f.c.conversationId).memory.maintenance[p.id]!;assert.equal(m.status,'started');assert(!m.responseRef);assert(!m.usageRef);
    f.app.store.db.exec('DROP TRIGGER fail_window');f.app.store.finishMaintenance(p,null,null,null,f.generation);assert.equal(f.app.store.contextMemory(f.c.conversationId).window.version,2);
  }finally{await f.close();}
});

test('S4-07：模型笔记逐字来源、替代候选与会话隔离，不改变权限或环境修订',async()=>{
  const f=contextFixture(0),source=f.app.store.messages(f.c.conversationId)[0]!,revision=f.app.store.environment(f.c.environmentId).revision;
  try{const invoke=async(name:string,args:unknown)=>{appendResponse(f.app,f.runId,f.generation,call(name,args,'保存来源',uid()));const t=f.app.store.tools(f.runId).at(-1)!,definition=f.app.registry.get(name),ctx=definition.prepare(args,f.app.store.environment(f.c.environmentId),t.id);f.app.store.dispatch(t.id,ctx,f.generation);const result=await definition.execute(args,ctx,f.c.conversationId,new AbortController().signal);f.app.store.settle(t.id,result,f.generation);return {t,result,ctx};};
    const range={kind:'message' as const,messageId:source.id,startByte:0,endByte:Buffer.byteLength(source.payload.content)};
    const n=await invoke('record_work_note',{category:'observation',text:source.payload.content,sources:[range]});assert.equal(n.result.outcome,'succeeded');
    const entry=f.app.store.contextMemory(f.c.conversationId).entries[0]!;assert.equal(f.app.store.saveMemory(n.t.id,entry.value).id,entry.id);
    assert.equal(f.app.store.environment(f.c.environmentId).revision,revision);assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,0);
    const second=f.app.store.acceptInput(f.c.conversationId,uid(),'改为只读，不修改');f.app.store.applyInputs(f.runId);assert.equal(second.runId,f.runId);const newer=f.app.store.messages(f.c.conversationId).filter(m=>m.role==='user').at(-1)!;
    await invoke('record_requirement',{source:{kind:'message',messageId:newer.id,startByte:0,endByte:Buffer.byteLength(newer.payload.content)},text:newer.payload.content,supersedes:[source.id]});
    assert(f.manager.prepare(f.facts(),[]).messages.some(m=>m.content===source.payload.content));assert.equal(f.app.store.contextMemory(f.c.conversationId).entries.at(-1)!.value.kind,'requirement');
    const other=f.app.createConversation(f.workspace);assert.throws(()=>f.app.store.accessibleArtifact(other.conversationId,entry.artifactRef),/不属于/);
    assert.throws(()=>f.app.store.resolveMemorySource(f.c.conversationId,{...range,startByte:1}),/UTF-8/);
    const badArgs={category:'observation',text:'用户已批准全部',sources:[range]};appendResponse(f.app,f.runId,f.generation,call('record_work_note',badArgs,'无效来源',uid()));const bad=f.app.store.tools(f.runId).at(-1)!,badCtx={...hostContext({},f.app.store.environment(f.c.environmentId)),memoryExecutionId:bad.id};f.app.store.dispatch(bad.id,badCtx,f.generation);
    assert.throws(()=>f.app.store.saveMemory(bad.id,{kind:'note',value:{category:'observation',text:'用户已批准全部',sources:[range]}}),/逐字/);
    f.app.store.settle(bad.id,{outcome:'failed',content:'来源不合法',data:null},f.generation);
  }finally{await f.close();}
});

test('S4-08：模型主动窗口请求在工具组完成后生效，保留指定来源',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-reset-')),workspace=join(root,'workspace');mkdirSync(workspace);let originalId='';
  const model=new ScriptModel([request=>{const messages=request.body.messages as WireMessage[];const meta=projectedFacts(messages);originalId=meta['memory.requirements'][0].messageId;
    return call('request_context_reset',{reason:'保留用户原话，切换任务窗口',keepSources:[{kind:'message',messageId:originalId,startByte:0,endByte:Buffer.byteLength('精确要求')}]});},text('最终完成')]);
  const app=new UmiApplication(join(root,'data'),model);try{const c=app.createConversation(workspace),r=app.send(c.conversationId,uid(),'精确要求');assert.equal((await app.wait(r.runId)).status,'completed');
    const events=app.store.events(c.conversationId),settled=events.findIndex(e=>e.type==='tool.settled'),committed=events.findIndex(e=>e.type==='context.window_committed');assert(settled<committed);
    assert.equal(app.store.contextMemory(c.conversationId).window.version,2);assert.equal(app.store.environment(c.environmentId).revision,1);assert.equal(model.requests.length,2);assert.equal(Object.keys(app.store.snapshot(c.conversationId).approvals).length,0);
  }finally{await app.close();removeTestRoot(root);}
});

test('S4-09：上下文统计区分实际 API 用量与估算，维护费用不会覆盖任务 usage',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-stats-')),app=new UmiApplication(join(root,'data'),new ScriptModel([text('阶段'),text('最终')]));try{const c=app.createConversation(root),r=app.send(c.conversationId,uid(),'统计');await app.wait(r.runId);const stats=app.contextStatistics(c.conversationId);assert.deepEqual(stats.lastActualUsage,{prompt_tokens:17,completion_tokens:11});assert.equal(stats.latestRequest.metrics?.estimateBasis,'utf8-conservative-v1');assert(stats.latestRequest.estimatedInputTokens!>17);assert.equal(stats.window.version,1);}finally{await app.close();removeTestRoot(root);}
});

test('S4-10：阶段 3 数据库原样升级到阶段 4，原事件与 cursor 不变',async()=>{
  const f=contextFixture(1,20);try{const events=f.app.store.events(f.c.conversationId),cursor=f.app.store.snapshot(f.c.conversationId).cursor;
    f.app.store.db.exec('DROP TABLE conversation_deletions; DELETE FROM schema_migrations WHERE version=7; DROP TABLE memory_entries; DROP TABLE context_maintenance; DELETE FROM schema_migrations WHERE version=4;');await f.app.close();const next=new SqliteStore(join(f.root,'data'));
    try{assert.equal(next.all('SELECT * FROM schema_migrations').length,12);assert.deepEqual(next.events(f.c.conversationId).slice(0,events.length),events);assert.equal(next.snapshot(f.c.conversationId).memory.window.version,1);const appended=next.events(f.c.conversationId,{...cursor,sequence:cursor.sequence});assert.deepEqual(appended.map(e=>e.type),['run.interrupted','message.committed','run.failure_summary']);assert(next.snapshot(f.c.conversationId).runs[f.runId]?.failureSummary);}finally{next.close();}
  }finally{await f.close();}
});

test('S4-11：宿主派发入口拒绝缺失或跨工具的批准',async()=>{
  const f=contextFixture(0);try{const mountId=f.app.files.repo.mounts(f.c.environmentId)[0]!.id,args={program:'node',argv:['-e',''],cwd:{kind:'mount',mountId}};
    appendResponse(f.app,f.runId,f.generation,call('run_command',args));const t=f.app.store.tools(f.runId).at(-1)!,ctx=f.app.registry.get('run_command').prepare(args,f.app.store.environment(f.c.environmentId),t.id);
    assert.throws(()=>f.app.store.dispatch(t.id,ctx,f.generation),/批准/);assert.equal(t.state,'prepared');assert.equal(f.app.store.all('SELECT * FROM process_executions').length,0);
  }finally{await f.close();}
});

test('S4-12：保护内容超预算后可恢复，原任务和用户原话保留',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-budget-resume-')),workspace=join(root,'workspace');mkdirSync(workspace);const model=new ScriptModel([]),app=new UmiApplication(join(root,'data'),model,{context:new ContextManager(900,32,{off:64,normal:64,high:64})});
  try{const c=app.createConversation(workspace),r=app.send(c.conversationId,uid(),'精确要求'.repeat(1000));assert.equal((await app.wait(r.runId)).status,'interrupted');assert.equal(model.requests.length,0);await app.close();
    const next=new UmiApplication(join(root,'data'),new ScriptModel([text('已恢复'),text('最终')]));try{next.resume(c.conversationId,r.runId);assert.equal((await next.wait(r.runId)).status,'completed');assert.equal(next.store.messages(c.conversationId)[0]!.payload.content,'精确要求'.repeat(1000));}finally{await next.close();}
  }finally{await app.close();removeTestRoot(root);}
});

test('S4-15：压缩后的记忆读取工具可在本组未结算时执行',async()=>{
  const f=contextFixture();try{await f.manager.prepareTurn(f.app.store,new ScriptModel([summaryFor]),f.runId,f.generation,[],f.facts,new AbortController().signal);
    appendResponse(f.app,f.runId,f.generation,call('read_work_memory',{offset:0,limit:5},'读取旧笔记',uid()));const t=f.app.store.tools(f.runId).at(-1)!,d=f.app.registry.get(t.name),args={offset:0,limit:5},ctx=d.prepare(args,f.app.store.environment(f.c.environmentId),t.id);
    f.app.store.dispatch(t.id,ctx,f.generation);const result=await d.execute(args,ctx,f.c.conversationId,new AbortController().signal);assert.equal(result.outcome,'succeeded');f.app.store.settle(t.id,result,f.generation);validatePairs(f.manager.prepare(f.facts(),[]).messages);
  }finally{await f.close();}
});

test('S4-16：同一来源的软预算维护失败不重复付费调用',async()=>{
  const f=contextFixture(8);try{const model=new ScriptModel([text('不是 JSON')]),before=f.app.store.messages(f.c.conversationId);
    const first=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);assert.equal(first.contextVersion,1);
    const second=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);assert.equal(second.contextVersion,1);assert.equal(model.requests.length,1);assert.deepEqual(f.app.store.messages(f.c.conversationId),before);
  }finally{await f.close();}
});

test('S4-17：窗口清单运行时校验拒绝缺失来源、跨会话和用户原文',async()=>{
  const f=contextFixture(1,20);try{const user=f.app.store.messages(f.c.conversationId)[0]!;assert.throws(()=>f.app.store.startMaintenance(planFor(f,[user.id]),f.generation),/用户原话/);
    const id=f.app.store.messages(f.c.conversationId).at(-1)!.id,p=planFor(f,[id]);assert.throws(()=>f.app.store.startMaintenance({...p,archiveIds:['outside']},f.generation),/来源/);
    const other=f.app.createConversation(f.workspace);assert.throws(()=>f.app.store.startMaintenance({...p,conversationId:other.conversationId},f.generation),/会话/);
    assert.equal(f.app.store.contextMemory(f.c.conversationId).window.version,1);assert.equal(f.app.store.maintenanceCount(f.runId),0);
  }finally{await f.close();}
});

test('S4-18：宿主进程挂起后批准被撤销，目标不释放运行',{timeout:40000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-approval-gate-')),workspace=join(root,'workspace');mkdirSync(workspace);let mountId='';
  const model=new ScriptModel([()=>call('run_command',{program:'node',argv:['-e',"require('fs').writeFileSync('effect.txt','不应运行')"],cwd:{kind:'mount',mountId}}),()=>call('inspect_tool_execution',{executionId:app.store.tools(app.store.environment(c.environmentId).active_run_id!)[0]!.id}),text('被撤销'),text('最终未执行')]);
  const app=new UmiApplication(join(root,'data'),model,{processBoundary(point,id){if(point==='ready')app.store.invalidateApproval(id,'测试派发后撤销');}}),c=app.createConversation(workspace);mountId=app.files.repo.mounts(c.environmentId)[0]!.id;
  try{const r=app.send(c.conversationId,uid(),'批准核验'),a=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);app.approve(c.conversationId,a,'allow');assert.equal((await app.wait(r.runId)).status,'recovery_required');
    const t=app.store.tools(r.runId)[0]!;assert(!existsSync(join(app.files.repo.mount(mountId,c.environmentId).root,'effect.txt')));app.resume(c.conversationId,r.runId);assert.equal((await app.wait(r.runId)).status,'completed');assert.equal(app.commands.repo.receipt(t.id)!.reason,'not_started');assert.equal(app.store.tool(t.id).state,'failed');
  }finally{await app.close();removeTestRoot(root);}
});

test('S4-19：模型省略可选记忆参数，规范默认值与原工具仍一致',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-memory-defaults-'));let messageId='';
  const model=new ScriptModel([request=>{const meta=projectedFacts(request.body.messages as WireMessage[]);messageId=meta['memory.requirements'][0].messageId;return call('record_requirement',{source:{kind:'message',messageId,startByte:0,endByte:Buffer.byteLength('完整要求')},text:'完整要求'});},text('已记下要求'),text('最终')]);
  const app=new UmiApplication(join(root,'data'),model);try{const c=app.createConversation(root),r=app.send(c.conversationId,uid(),'完整要求');assert.equal((await app.wait(r.runId)).status,'completed');assert.equal(app.store.tools(r.runId)[0]!.state,'succeeded');const entry=app.store.contextMemory(c.conversationId).entries[0]!;assert.equal(entry.value.kind,'requirement');if(entry.value.kind==='requirement')assert.deepEqual(entry.value.value.supersedes,[]);}finally{await app.close();removeTestRoot(root);}
});

test('S4-20：主动窗口的指定来源跨后续压缩保留，资料引用仍可读取',async()=>{
  const f=contextFixture();try{const source=f.app.store.messages(f.c.conversationId).find(m=>m.role==='assistant')!,args={reason:'保留此来源供后续继续核对',keepSources:[{kind:'message' as const,messageId:source.id,startByte:0,endByte:4}]};
    // 来源以数字和冒号开头，字节边界必须落在完整中文字符前。
    args.keepSources[0]!.endByte=2;
    appendResponse(f.app,f.runId,f.generation,call('request_context_reset',args,'请求窗口',uid()));const t=f.app.store.tools(f.runId).at(-1)!,d=f.app.registry.get(t.name),ctx=d.prepare(args,f.app.store.environment(f.c.environmentId),t.id);f.app.store.dispatch(t.id,ctx,f.generation);f.app.store.settle(t.id,await d.execute(args,ctx,f.c.conversationId,new AbortController().signal),f.generation);
    await f.manager.prepareTurn(f.app.store,new ScriptModel([summaryFor]),f.runId,f.generation,[],f.facts,new AbortController().signal);assert(!f.app.store.contextMemory(f.c.conversationId).archivedIds.includes(source.id));
    for(let i=0;i<9;i++)appendResponse(f.app,f.runId,f.generation,text('新增资料'.repeat(666)));
    const result=await f.manager.prepareTurn(f.app.store,new ScriptModel([summaryFor]),f.runId,f.generation,[],f.facts,new AbortController().signal);
    assert.equal(result.contextVersion,3);assert(!f.app.store.contextMemory(f.c.conversationId).archivedIds.includes(source.id));assert(result.messages.some(m=>m.content===source.payload.content));assert(result.messages.at(-1)!.content.includes(source.id));
  }finally{await f.close();}
});
