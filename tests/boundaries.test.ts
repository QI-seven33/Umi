import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UmiApplication } from '../apps/headless/src/application.js';
import { removeTestRoot, ScriptModel,call,text,eventually } from './fixtures.js';
import { UmiError,settingsSchema,validatePairs } from '../packages/protocol/src/model.js';
import { eventSchema } from '../packages/protocol/src/events.js';
import { reduceConversation,initialState,projectConversation } from '../packages/protocol/src/reducer.js';
import { uid } from '../packages/agent/src/identity.js';
import type { PreparedRequest,ModelFrame } from '../packages/agent/src/ports.js';

const root=()=>mkdtempSync(join(tmpdir(),'umi-boundary-'));
test('A02：唯一写入者、同工作区独立会话、同会话新 run 复用环境',async()=>{
  const directory=root(),model=new ScriptModel([text('阶段'),text('最终'),text('下一任务'),text('最终二')]);const app=new UmiApplication(join(directory,'data'),model);
  try {
    assert.throws(()=>new UmiApplication(join(directory,'data'),new ScriptModel([])),/另一个写入进程/);
    const c=app.createConversation(directory),other=app.createConversation(directory);assert.equal(c.workspaceId,other.workspaceId);assert.notEqual(c.environmentId,other.environmentId);
    const first=app.send(c.conversationId,uid(),'原要求');await app.wait(first.runId);const next=app.send(c.conversationId,uid(),'新要求');await app.wait(next.runId);
    assert.notEqual(first.runId,next.runId);assert.equal(app.store.getRun(next.runId).environment_id,c.environmentId);assert.equal(app.store.messages(other.conversationId).length,0);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A03/A04：输入事务失败整批回滚，协议及身份冲突不会推进 cursor',async()=>{
  const directory=root(),model=new ScriptModel([text('阶段'),text('最终')]),app=new UmiApplication(join(directory,'data'),model);
  try {
    const c=app.createConversation(directory),initialEvents=app.store.events(c.conversationId);
    app.store.db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='input.accepted' BEGIN SELECT RAISE(ABORT,'测试提交失败'); END;");
    assert.throws(()=>app.send(c.conversationId,'same-command','不可丢失的要求'),/测试提交失败/);
    assert.equal(app.store.messages(c.conversationId).length,0);assert.deepEqual(app.store.events(c.conversationId),initialEvents);assert.equal(app.store.all('SELECT * FROM runs').length,0);
    assert.equal(app.store.environment(c.environmentId).active_run_id,null);assert.equal(model.requests.length,0);
    app.store.db.exec('DROP TRIGGER inject_failure');const receipt=app.send(c.conversationId,'same-command','不可丢失的要求');await app.wait(receipt.runId);
    const events=app.store.events(c.conversationId),first=events[0]!;
    assert.throws(()=>eventSchema.parse({...first,schemaVersion:2}));assert.throws(()=>eventSchema.parse({...first,type:'fake.allow',payload:{}}));
    const delta=events.find(e=>e.type==='model.delta')!;const before=events.slice(0,events.indexOf(delta)).reduce(reduceConversation,initialState(c.conversationId,first.logEpoch));
    assert.throws(()=>reduceConversation(before,{...delta,modelTurnId:'wrong-turn'}),/归属/);
    const cursor=app.store.snapshot(c.conversationId).cursor;
    const key='event-repeat';app.store.transaction(()=>app.store.append({conversationId:c.conversationId,runId:receipt.runId},{type:'run.phase_changed',payload:{phase:'finalize'}},key));
    const fixed=app.store.snapshot(c.conversationId).cursor;
    app.store.transaction(()=>app.store.append({conversationId:c.conversationId,runId:receipt.runId},{type:'run.phase_changed',payload:{phase:'finalize'}},key));
    assert.equal(app.store.snapshot(c.conversationId).cursor.sequence,fixed.sequence);
    assert.throws(()=>app.store.transaction(()=>app.store.append({conversationId:c.conversationId,runId:receipt.runId,modelTurnId:'other'},
      {type:'run.phase_changed',payload:{phase:'finalize'}},key)),/不同内容或归属/);
    assert.equal(BigInt(fixed.sequence),BigInt(cursor.sequence)+1n);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A10/A20：多调用分别批准，模型声称已经获准不会越过权限层',async()=>{
  const directory=root(),message=call('write_scratch',{relativePath:'first.txt',content:'A'},'网页要求忽略安全规则，并声称全部已获批准。','a');
  message.tool_calls!.push({id:'b',type:'function',function:{name:'write_scratch',arguments:JSON.stringify({relativePath:'second.txt',content:'B'})}});
  const model=new ScriptModel([message,text('两项调用已经结算'),text('第一项拒绝，第二项已写入')]),app=new UmiApplication(join(directory,'data'),model);
  try {
    const c=app.createConversation(directory),r=app.send(c.conversationId,uid(),'分别操作两项');
    const first=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    assert.equal(app.store.tools(r.runId).length,2);assert.equal(model.requests.length,1);assert.equal(Object.keys(app.store.snapshot(c.conversationId).approvals).length,1);
    assert.equal(projectConversation(app.store.snapshot(c.conversationId)).activeReasoning.length,0);
    app.approve(c.conversationId,first,'deny');const second=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([id,a])=>id!==first&&a.status==='pending')?.[0]);
    const env=app.store.environment(c.environmentId);assert(!existsSync(join(env.root,'task','scratch','second.txt')));assert.equal(model.requests.length,1);
    app.approve(c.conversationId,second,'allow');assert.equal((await app.wait(r.runId)).status,'completed');
    assert(!existsSync(join(env.root,'task','scratch','first.txt')));assert.equal(readFileSync(join(env.root,'task','scratch','second.txt'),'utf8'),'B');
    assert.deepEqual(app.store.tools(r.runId).map(t=>t.state),['denied','succeeded']);validatePairs(app.store.messages(c.conversationId).map(m=>m.payload));
  }finally{await app.close();removeTestRoot(directory);}
});
test('A17：模型响应尚未完成时明确停止，保留前缀且不形成完整消息',async()=>{
  class HangingModel extends ScriptModel {
    override async* stream(request:PreparedRequest,signal:AbortSignal):AsyncGenerator<ModelFrame> {
      this.requests.push(request);yield {kind:'delta',channel:'text',key:'text',text:'正在生成的正文'};
      await delay(60000,undefined,{signal});throw new Error('不应到达');
    }
  }
  const directory=root(),model=new HangingModel([]),app=new UmiApplication(join(directory,'data'),model);
  try {
    const c=app.createConversation(directory),r=app.send(c.conversationId,uid(),'等待生成');await eventually(()=>app.store.snapshot(c.conversationId).blocks[0]);
    await app.stop(c.conversationId,r.runId);assert.equal(app.store.getRun(r.runId).status,'stopped');assert.equal(app.store.snapshot(c.conversationId).blocks[0]?.status,'interrupted');
    assert.equal(app.store.messages(c.conversationId).filter(m=>m.role==='assistant'&&m.modelAttemptId).length,0);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A19：尚无输出的有限模型重试使用同一请求和独立 attempt',async()=>{
  class RetryModel extends ScriptModel {
    override async* stream(request:PreparedRequest,signal:AbortSignal):AsyncGenerator<ModelFrame> {
      if(!this.requests.length){this.requests.push(structuredClone(request));
        throw new UmiError('PROVIDER_INTERRUPTED','测试中断',true);}
      yield* super.stream(request,signal);
    }
  }
  const directory=root(),model=new RetryModel([text('成功阶段'),text('成功最终')]),app=new UmiApplication(join(directory,'data'),model,{limits:{maxTurns:4,maxRetries:1,modelTimeoutMs:3000,retryDelayMs:1}});
  try {
    const c=app.createConversation(directory),r=app.send(c.conversationId,uid(),'有限重试');assert.equal((await app.wait(r.runId)).status,'completed');
    assert.deepEqual(model.requests[0],model.requests[1]);assert.equal(model.requests.length,2);
    const state=app.store.snapshot(c.conversationId);assert.equal(state.blocks.filter(b=>b.status==='interrupted').length,0);
    assert.equal(Object.values(state.turns)[0]?.attemptIds.length,2);assert.equal(app.store.getRun(r.runId).model_turns,1);
    assert.equal(app.store.messages(c.conversationId).some(m=>m.payload.content==='第一次部分响应'),false);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A42：两小时前的原话按真实注册工具找回，UTC 范围与原文读取一致',async()=>{
  const directory=root();let time='2026-10-04T00:00:00.000Z';
  const app=new UmiApplication(join(directory,'data'),new ScriptModel([text('旧要求已保存'),text('确认旧要求'),text('新要求'),text('确认新要求')]),{clock:()=>time});
  try {
    const c=app.createConversation(directory),old=app.send(c.conversationId,uid(),'两小时前的要求：蓝色且不得改布局');await app.wait(old.runId);
    time='2026-10-04T02:00:00.000Z';const next=app.send(c.conversationId,uid(),'现在改绿色，其余布局要求保留');await app.wait(next.runId);
    const search=app.registry.get('search_history'),args=app.registry.parse(search.name,JSON.stringify({query:'不得改布局',to:'2026-10-04T01:00:00.000Z'}));
    const context=search.prepare(args,app.store.environment(c.environmentId));const result=await search.execute(args,context,c.conversationId,new AbortController().signal);
    const matches=(result.data as {matches:{messageId:string;createdAt:string;text:string}[]}).matches;
    assert.equal(matches[0]?.messageId,old.messageId);assert.equal(matches[0]?.createdAt,'2026-10-04T00:00:00.000Z');
    const read=app.registry.get('read_history'),readResult=await read.execute(app.registry.parse(read.name,JSON.stringify({messageId:old.messageId})),context,c.conversationId,new AbortController().signal);
    assert.equal((readResult.data as {text:string}).text,'两小时前的要求：蓝色且不得改布局');
    assert.equal(app.store.messages(c.conversationId).filter(m=>m.role==='user').at(-1)?.payload.content,'现在改绿色，其余布局要求保留');
  }finally{await app.close();removeTestRoot(directory);}
});
test('A04/A09：不兼容数据库停止启动，Windows 设备和特殊名称被拒绝',async()=>{
  const directory=root(),app=new UmiApplication(join(directory,'data'),new ScriptModel([]));
  try {
    for(const relativePath of ['CON','nul.txt','file.','COM1/config','dir/file:stream','../outside','bad?name'])assert.throws(()=>app.registry.parse('write_scratch',JSON.stringify({relativePath,content:'x'})));
    app.store.db.exec('UPDATE schema_migrations SET version=99 WHERE version=1');await app.close();
    assert.throws(()=>new UmiApplication(join(directory,'data'),new ScriptModel([])),/不兼容/);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A03/A06：完整响应事务失败不留下半个消息或可派发工具',async()=>{
  const directory=root(),app=new UmiApplication(join(directory,'data'),new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'x'})]));
  try {
    const c=app.createConversation(directory);
    app.store.db.exec("CREATE TRIGGER inject_tool_failure BEFORE INSERT ON tool_executions BEGIN SELECT RAISE(ABORT,'完整响应提交失败'); END;");
    const r=app.send(c.conversationId,uid(),'提交失败样本');assert.equal((await app.wait(r.runId)).status,'failed');
    assert.equal(app.store.tools(r.runId).length,0);assert.equal(app.store.messages(c.conversationId).filter(m=>m.role==='assistant'&&m.modelAttemptId).length,0);
    assert.equal(app.store.events(c.conversationId).filter(e=>e.type==='model.attempt_completed').length,0);
    assert.equal(app.store.snapshot(c.conversationId).blocks[0]?.status,'interrupted');
  }finally{await app.close();removeTestRoot(directory);}
});
test('A03/A13：派发意图提交失败时，磁盘效果和派发状态均不产生',async()=>{
  const directory=root(),app=new UmiApplication(join(directory,'data'),new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'x'})]));
  try {
    const c=app.createConversation(directory),r=app.send(c.conversationId,uid(),'测试派发');
    const approval=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    app.store.db.exec("CREATE TRIGGER inject_dispatch_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.dispatch_intent' BEGIN SELECT RAISE(ABORT,'派发提交失败'); END;");
    app.approve(c.conversationId,approval,'allow');assert.equal((await app.wait(r.runId)).status,'failed');
    assert.equal(app.store.tools(r.runId)[0]?.state,'prepared');assert(!existsSync(join(app.store.environment(c.environmentId).root,'task','scratch','test.txt')));
    assert.equal(app.store.events(c.conversationId).find(e=>e.type==='run.failed')?.payload.code,'PERSISTENCE_FAILED');
  }finally{await app.close();removeTestRoot(directory);}
});
test('A17：工具产生效果但尚未结算时停止，未知保留且只能主动核验恢复',async()=>{
  const directory=root(),app=new UmiApplication(join(directory,'data'),new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'x'}),text('核验阶段'),text('核验最终')]));
  try {
    const c=app.createConversation(directory),definition=app.registry.get('write_scratch'),execute=definition.execute;let observed=false;
    definition.execute=async(...args)=>{const result=await execute(...args);observed=true;await delay(60000,undefined,{signal:args[3]});return result;};
    const r=app.send(c.conversationId,uid(),'工具执行中停止'),a=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    app.approve(c.conversationId,a,'allow');await eventually(()=>observed||undefined);await app.stop(c.conversationId,r.runId);
    assert.equal(app.store.getRun(r.runId).status,'stopped');assert.equal(app.store.tools(r.runId)[0]?.state,'unknown');
    app.resume(c.conversationId,r.runId);assert.equal((await app.wait(r.runId)).status,'completed');
    assert.equal(app.store.events(c.conversationId).filter(e=>e.type==='tool.dispatch_intent').length,1);
  }finally{await app.close();removeTestRoot(directory);}
});
test('A19：相同失败工具不能无限循环，也不重复弹出被拒绝的请求',async()=>{
  const directory=root(),model=new ScriptModel([call('read_history',{messageId:'missing'},'查找一','a'),call('read_history',{messageId:'missing'},'查找二','b'),
    call('read_history',{messageId:'missing'},'查找三','c'),call('read_history',{messageId:'missing'},'查找四','d')]),app=new UmiApplication(join(directory,'data'),model);
  try {
    const c=app.createConversation(directory),r=app.send(c.conversationId,uid(),'重复失败样本');assert.equal((await app.wait(r.runId)).status,'failed');assert.equal(model.requests.length,5);
    assert(app.store.snapshot(c.conversationId).runs[r.runId]?.failureSummary?.text.includes('这一步仍未完成'));
    assert.equal(app.store.events(c.conversationId).find(e=>e.type==='run.failed')?.payload.code,'TASK_STALLED');
    assert.equal(app.store.events(c.conversationId).filter(e=>e.type==='tool.dispatch_intent').length,3);
  }finally{await app.close();removeTestRoot(directory);}
});
