import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {ScriptModel,text,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';

test('S5-01：预算阻塞持久化，无变化 resume 不增加事件、代次或 API 请求',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-budget-block-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const model=new ScriptModel([]),app=new UmiApplication(join(root,'data'),model,{context:new ContextManager(80000,1024,{off:1024,normal:1024,high:1024})});
  try{const c=app.createConversation(workspace,{contextWindow:4096}),r=app.send(c.conversationId,uid(),'禁止修改公开接口。'.repeat(600));await app.wait(r.runId);
    const state=app.store.snapshot(c.conversationId),run=app.store.getRun(r.runId),budget=app.inspectRecovery(c.conversationId,r.runId).budget;
    assert.equal(run.status,'interrupted');assert.equal(state.runs[r.runId]?.code,'CONTEXT_BUDGET_EXCEEDED');assert.equal(state.runs[r.runId]?.budgetBlock?.stage,'protected');assert.equal(budget.canResume,false);
    const count=app.store.events(c.conversationId).length;assert.throws(()=>app.resume(c.conversationId,r.runId),/超过预算/);assert.equal(app.store.events(c.conversationId).length,count);assert.equal(app.store.getRun(r.runId).generation,run.generation);assert.equal(model.requests.length,0);
    assert.deepEqual(app.store.events(c.conversationId).reduce(reduceConversation,initialState(c.conversationId,state.cursor.logEpoch)),state);
  }finally{await app.close();removeTestRoot(root);}
});
test('S5-02：重启不解除预算阻塞；有效窗口扩大后同 run 恢复并保留旧阻塞事实',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-budget-restart-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const options={context:new ContextManager(80000,1024,{off:1024,normal:1024,high:1024})};const app=new UmiApplication(join(root,'data'),new ScriptModel([]),options);
  const c=app.createConversation(workspace,{contextWindow:4096}),raw='完整中文要求：保留文件。'.repeat(400),r=app.send(c.conversationId,uid(),raw);await app.wait(r.runId);await app.close();
  const model=new ScriptModel([text('预算改变后继续'),text('最终结论')]),next=new UmiApplication(join(root,'data'),model,options);
  try{assert.equal(next.inspectRecovery(c.conversationId,r.runId).budget.canResume,false);assert.throws(()=>next.resume(c.conversationId,r.runId));
    next.store.updateSettings(c.conversationId,{...next.store.settings(c.conversationId),contextWindow:80000});assert.equal(next.inspectRecovery(c.conversationId,r.runId).budget.canResume,true);
    next.resume(c.conversationId,r.runId);assert.equal((await next.wait(r.runId)).status,'completed');assert.equal(next.store.messages(c.conversationId)[0]?.payload.content,raw);assert.equal(next.store.snapshot(c.conversationId).runs[r.runId]?.budgetBlock,undefined);
    assert(next.store.events(c.conversationId).some(e=>e.type==='context.budget_blocked'));assert(next.store.events(c.conversationId).some(e=>e.type==='context.budget_cleared'));
  }finally{await next.close();removeTestRoot(root);}
});
test('S5-03：更改主题语言或继续增加用户要求不伪造解除预算阻塞',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-budget-change-')),workspace=join(root,'workspace');mkdirSync(workspace);const app=new UmiApplication(join(root,'data'),new ScriptModel([]));
  try{const c=app.createConversation(workspace,{contextWindow:64000}),r=app.send(c.conversationId,uid(),'原话'.repeat(30000));await app.wait(r.runId);app.store.updateSettings(c.conversationId,{...app.store.settings(c.conversationId),uiLocale:'en'});app.send(c.conversationId,uid(),'继续');assert.equal(app.inspectRecovery(c.conversationId,r.runId).budget.canResume,false);assert.throws(()=>app.resume(c.conversationId,r.runId));}
  finally{await app.close();removeTestRoot(root);}
});
