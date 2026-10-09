import {contextFixture,appendResponse} from './context-fixture.js';
import {hash,uid} from '../packages/agent/src/identity.js';
import {call,text,ScriptModel} from './fixtures.js';
import type {MaintenancePlan} from '../packages/protocol/src/memory.js';
const [mode]=process.argv.slice(2),f=contextFixture(mode==='maintenance-started'?12:10);
const ids=f.app.store.messages(f.c.conversationId).filter(m=>m.role==='assistant').slice(0,4).map(m=>m.id);
const plan:MaintenancePlan={id:uid(),conversationId:f.c.conversationId,runId:f.runId,baseVersion:1,sourceFingerprint:f.app.store.contextSourceFingerprint(f.runId),mode:'compact',reason:'真实硬退出',archiveIds:ids,
  sourceHashes:Object.fromEntries(f.app.store.messages(f.c.conversationId).filter(m=>ids.includes(m.id)).map(m=>[m.id,hash(m.payload)])),beforeEstimate:90000,candidateEstimate:40000,summaryInput:{},request:null,resetEntryId:null};
let executionId:string|null=null;
if(mode==='maintenance-started'){
  const model=new ScriptModel([()=>text('{}')]);model.beforeResponse=async()=>{const maintenanceId=f.app.store.all('SELECT id FROM context_maintenance').at(-1)!.id as string;
    process.send?.({root:f.root,conversationId:f.c.conversationId,runId:f.runId,environmentId:f.c.environmentId,maintenanceId,executionId});await new Promise<void>(()=>{});};
  void f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],f.facts,new AbortController().signal);
}else if(mode==='memory-recorded'){
  const user=f.app.store.messages(f.c.conversationId)[0]!,args={category:'observation' as const,text:user.payload.content,sources:[{kind:'message' as const,messageId:user.id,startByte:0,endByte:Buffer.byteLength(user.payload.content)}]};
  appendResponse(f.app,f.runId,f.generation,call('record_work_note',args));const t=f.app.store.tools(f.runId).at(-1)!,definition=f.app.registry.get(t.name),ctx=definition.prepare(args,f.app.store.environment(f.c.environmentId),t.id);f.app.store.dispatch(t.id,ctx,f.generation);
  await definition.execute(args,ctx,f.c.conversationId,new AbortController().signal);executionId=t.id;
}else{
  f.app.store.startMaintenance(plan,f.generation);
  if(mode==='window-committed')f.app.store.finishMaintenance(plan,{items:[{kind:'decision',text:'旧记录需原话核验',sourceIds:[ids[0]!]}]},{response:'已响应'},{prompt_tokens:20},f.generation);
}
if(mode!=='maintenance-started')process.send?.({root:f.root,conversationId:f.c.conversationId,runId:f.runId,environmentId:f.c.environmentId,maintenanceId:plan.id,executionId});setInterval(()=>{},1000);
