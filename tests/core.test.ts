import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { removeTestRoot, ScriptModel, call, text, eventually } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { settingsSchema, validatePairs, executionContextSchema } from '../packages/protocol/src/model.js';
import type { WireMessage } from '../packages/protocol/src/model.js';
import { reduceConversation, initialState } from '../packages/protocol/src/reducer.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import type { ModelPort, PreparedRequest, ModelFrame } from '../packages/agent/src/ports.js';
import { UmiError } from '../packages/protocol/src/model.js';
import { setTimeout as delay } from 'node:timers/promises';

function setup(model:ModelPort) {
  const root=mkdtempSync(join(tmpdir(),'umi-core-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const app=new UmiApplication(join(root,'data'),model,{limits:{maxTurns:12,maxRetries:0,modelTimeoutMs:3000,retryDelayMs:1}});
  const c=app.createConversation(workspace);return {root,workspace,app,...c};
}
test('A01/A03：输入幂等、冲突回滚以及配置持久化',async()=>{
  const model=new ScriptModel([text('阶段完成'),text('最终完成')]),f=setup(model);
  try {
    const receipt=f.app.send(f.conversationId,'command-1','原始要求');assert.deepEqual(f.app.send(f.conversationId,'command-1','原始要求'),receipt);
    assert.throws(()=>f.app.send(f.conversationId,'command-1','另一要求'),/不同输入/);
    assert.equal((await f.app.wait(receipt.runId)).status,'completed');const count=model.requests.length;
    f.app.send(f.conversationId,'command-1','原始要求');assert.equal(model.requests.length,count);
    const settings=settingsSchema.parse({thinking:'high',executionPolicy:'auto'});f.app.store.updateSettings(f.conversationId,settings);
    await f.app.close();const next=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    assert.deepEqual(next.store.settings(f.conversationId),settings);assert.equal(next.store.messages(f.conversationId).filter(m=>m.role==='user').length,1);await next.close();
  }finally{await f.app.close();removeTestRoot(f.root);}
});
test('A05/A06/A14/A15/A16/A44：正文即时提交、归属、重放与游标隔离',async()=>{
  const model=new ScriptModel([call('search_history',{query:'原文'}),text('最终答复')]);
  const f=setup(model);let release!:()=>void;let first=true;
  model.beforeResponse=async()=>{if(first){first=false;await new Promise<void>(r=>{release=r;});}};
  try {
    const receipt=f.app.send(f.conversationId,uid(),'原文要求');await eventually(()=>release);
    const middle=f.app.store.snapshot(f.conversationId);assert(middle.blocks.some(b=>b.kind==='text'&&b.text==='先执行这项操作。'));
    assert.equal(Object.values(middle.tools).length,0);release();assert.equal((await f.app.wait(receipt.runId)).status,'completed');
    const events=f.app.store.events(f.conversationId),snap=f.app.store.snapshot(f.conversationId);
    const replay=events.reduce(reduceConversation,initialState(f.conversationId,snap.cursor.logEpoch));assert.deepEqual(snap,replay);
    assert.equal(snap.blocks.filter(b=>b.kind==='text').map(b=>b.text).join('|'),'先执行这项操作。|最终答复');
    assert.equal(Object.values(snap.tools)[0]?.status,'succeeded');assert.equal(reduceConversation(snap,events.at(-1)!),snap);
    assert.throws(()=>reduceConversation(initialState(f.conversationId,snap.cursor.logEpoch),events[1]!),/缺口/);
    assert.throws(()=>f.app.store.events(f.conversationId,{...snap.cursor,streamId:'other'}),/不一致/);
    assert.throws(()=>f.app.store.events(f.conversationId,{...snap.cursor,logEpoch:'other'}),/不一致/);
    assert.equal(f.app.store.events(f.conversationId,snap.cursor).length,0);
    const base={...snap.cursor,sequence:'1'};assert.equal(f.app.store.events(f.conversationId,base).length,events.length-1);
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));assert.deepEqual(reopened.store.snapshot(f.conversationId),snap);await reopened.close();
  }finally{release?.();await f.app.close();removeTestRoot(f.root);}
});
test('A11/A12/A20/A42：批准阻塞、拒绝、同会话原话查询及中途纠正',async()=>{
  const model=new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'old'}),request=>{
    const messages=request.body.messages as WireMessage[];validatePairs(messages);
    assert(messages.at(-2)?.content.includes('改成新的要求'));return call('search_history',{query:'原始要求'},'读取原始来源。','history-call');
  },text('已核实拒绝与新要求'),text('最终依据新要求答复')]);const f=setup(model);
  try {
    const receipt=f.app.send(f.conversationId,uid(),'原始要求');const approvalId=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    assert.equal(f.app.store.getRun(receipt.runId).status,'waiting_permission');assert.equal(model.requests.length,1);
    const revised=f.app.send(f.conversationId,uid(),'改成新的要求，拒绝写入后只查原文');assert.equal(revised.runId,receipt.runId);
    f.app.approve(f.conversationId,approvalId,'deny');f.app.approve(f.conversationId,approvalId,'deny');
    assert.throws(()=>f.app.approve(f.conversationId,approvalId,'allow'),/已提交/);
    assert.equal((await f.app.wait(receipt.runId)).status,'completed');
    const env=f.app.store.environment(f.environmentId);assert(!existsSync(join(env.root,'task','scratch','test.txt')));
    const tool=f.app.store.tools(receipt.runId).find(t=>t.name==='search_history')!;
    const result=f.app.store.readArtifact<{data:{matches:{text:string;messageId:string}[]}}>(tool.result_ref!);assert.equal(result.data.matches[0]?.text,'原始要求');
    const evil=f.app.registry.parse('read_history',JSON.stringify({messageId:'outside'}));
    await assert.rejects(()=>f.app.registry.get('read_history').execute(evil,f.app.registry.get('read_history').prepare(evil,env),f.conversationId,new AbortController().signal),/不属于当前会话/);
  }finally{await f.app.close();removeTestRoot(f.root);}
});
test('A17/A18：订阅断线继续工作；明确停止不会自动恢复',async()=>{
  const model=new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'stop'})]);const f=setup(model);
  try {
    const receipt=f.app.send(f.conversationId,uid(),'准备写入');const a=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    const subscription=new AbortController();const iterator=f.app.subscribe(f.conversationId,{...f.app.store.snapshot(f.conversationId).cursor,sequence:'0'},subscription.signal);
    assert(!(await iterator.next()).done);subscription.abort();await iterator.return();assert.equal(f.app.store.getRun(receipt.runId).status,'waiting_permission');
    await f.app.stop(f.conversationId,receipt.runId);assert.equal(f.app.store.getRun(receipt.runId).status,'stopped');
    assert.equal(f.app.store.tools(receipt.runId)[0]?.state,'cancelled');assert.throws(()=>f.app.approve(f.conversationId,a,'allow'),/失效/);
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));assert.equal(reopened.store.getRun(receipt.runId).status,'stopped');
    assert.equal(reopened.store.settings(f.conversationId).model,'deepseek-flash');await reopened.close();
  }finally{await f.app.close();removeTestRoot(f.root);}
});
test('A11/A18/A45：应用退出保留原批准，重启后恢复同环境完成写入',async()=>{
  const f=setup(new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'hello'})]));
  try {
    const receipt=f.app.send(f.conversationId,uid(),'写入托管测试文件');const a=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    await f.app.close();const model=new ScriptModel([text('已核实写入'),text('托管测试已完成')]);const reopened=new UmiApplication(join(f.root,'data'),model);
    assert.equal(reopened.store.getRun(receipt.runId).status,'interrupted');reopened.approve(f.conversationId,a,'allow');
    assert.equal((await reopened.wait(receipt.runId)).status,'completed');const env=reopened.store.environment(f.environmentId);
    assert.equal(readFileSync(join(env.root,'task','scratch','test.txt'),'utf8'),'hello');assert.equal(env.revision,1);
    const record=reopened.store.tools(receipt.runId)[0]!;const ctx=executionContextSchema.parse(reopened.store.readArtifact(record.context_ref!));
    assert.equal(ctx.environmentId,f.environmentId);assert.equal(ctx.locations[0]?.relativePath,'test.txt');assert.equal(ctx.locations[0]?.rootRef.kind,'task');
    await reopened.close();
  }finally{await f.app.close();removeTestRoot(f.root);}
});
test('A12：批准后文件变化使旧批准失效，等待新的具体决定',async()=>{
  const f=setup(new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'desired'}),text('阶段核验'),text('结束')]));
  try {
    const receipt=f.app.send(f.conversationId,uid(),'写入测试');const first=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    writeFileSync(join(f.app.store.environment(f.environmentId).root,'task','scratch','test.txt'),'external');f.app.approve(f.conversationId,first,'allow');
    const second=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([id,a])=>id!==first&&a.status==='pending')?.[0]);
    assert.equal(f.app.store.snapshot(f.conversationId).approvals[first]?.status,'invalidated');assert.equal(f.app.store.tools(receipt.runId)[0]?.state,'prepared');
    f.app.approve(f.conversationId,second,'deny');assert.equal((await f.app.wait(receipt.runId)).status,'completed');
    assert.equal(readFileSync(join(f.app.store.environment(f.environmentId).root,'task','scratch','test.txt'),'utf8'),'external');
  }finally{await f.app.close();removeTestRoot(f.root);}
});
test('A19：配额有限失败保留可恢复状态',async()=>{
  const model=new ScriptModel([()=>{throw new UmiError('PROVIDER_QUOTA','额度不足');}]);const f=setup(model);
  try{const receipt=f.app.send(f.conversationId,uid(),'执行任务');assert.equal((await f.app.wait(receipt.runId)).status,'interrupted');assert.equal(model.requests.length,1);}
  finally{await f.app.close();removeTestRoot(f.root);}
});
test('A34/A35：预算不足不截断用户原文，也不派发模型',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-budget-')),model=new ScriptModel([]),app=new UmiApplication(join(root,'data'),model,{context:new ContextManager(900,32,{off:64,normal:64,high:64})});
  try{const c=app.createConversation(root),receipt=app.send(c.conversationId,uid(),'复杂要求'.repeat(1000));assert.equal((await app.wait(receipt.runId)).status,'interrupted');
    assert.equal(app.store.messages(c.conversationId)[0]?.payload.content,'复杂要求'.repeat(1000));assert.equal(model.requests.length,0);}
  finally{await app.close();removeTestRoot(root);}
});
test('A09：非法工具参数不执行，并回填明确失败',async()=>{
  const malformed=call('write_scratch',{relativePath:'../escape',content:'x'});const f=setup(new ScriptModel([malformed,text('参数失败'),text('未修改文件')]));
  try{const receipt=f.app.send(f.conversationId,uid(),'测试参数');assert.equal((await f.app.wait(receipt.runId)).status,'completed');assert.equal(f.app.store.tools(receipt.runId)[0]?.state,'failed');
    assert.equal(Object.keys(f.app.store.snapshot(f.conversationId).approvals).length,0);}
  finally{await f.app.close();removeTestRoot(f.root);}
});
test('A12：已完成运行的迟到批准重发不重启、不改写最终状态',async()=>{
  const model=new ScriptModel([call('write_scratch',{relativePath:'test.txt',content:'x'}),text('阶段核验'),text('最终完成')]),f=setup(model);
  try {
    const r=f.app.send(f.conversationId,uid(),'一次批准写入');const a=await eventually(()=>Object.entries(f.app.store.snapshot(f.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    f.app.approve(f.conversationId,a,'allow');assert.equal((await f.app.wait(r.runId)).status,'completed');
    const cursor=f.app.store.snapshot(f.conversationId).cursor,count=model.requests.length;
    f.app.approve(f.conversationId,a,'allow');await f.app.wait(r.runId);
    assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(model.requests.length,count);assert.deepEqual(f.app.store.snapshot(f.conversationId).cursor,cursor);
  }finally{await f.app.close();removeTestRoot(f.root);}
});

