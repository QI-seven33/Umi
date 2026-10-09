import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,text,removeTestRoot} from './fixtures.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';
import {validatePairs} from '../packages/protocol/src/model.js';
type Checkpoint={root:string;conversationId:string;runId:string;environmentId:string;maintenanceId:string;executionId:string|null};
for(const mode of ['maintenance-started','window-committed','memory-recorded'])test(`S4-14：真实子进程强制退出 ${mode}`,{timeout:20000},async()=>{
  const child=fork(new URL('./context-crash-worker.js',import.meta.url),[mode],{stdio:['ignore','ignore','pipe','ipc']});let errors='',checkpoint:Checkpoint|undefined,app:UmiApplication|undefined;
  child.stderr?.on('data',d=>{errors+=String(d);});
  try{checkpoint=await new Promise<Checkpoint>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors||'维护故障注入超时')),12000);child.once('message',m=>{clearTimeout(timer);resolve(m as Checkpoint);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`提前退出 ${code}: ${errors}`));});});
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;const model=new ScriptModel([text('已核验恢复'),text('最终完成')]);app=new UmiApplication(join(checkpoint.root,'data'),model);
    assert.equal(app.store.getRun(checkpoint.runId).status,'interrupted');const memory=app.store.contextMemory(checkpoint.conversationId);
    if(mode==='maintenance-started'){assert.equal(memory.window.version,1);assert.equal(app.store.snapshot(checkpoint.conversationId).memory.maintenance[checkpoint.maintenanceId]!.code,'MAINTENANCE_INTERRUPTED');}
    if(mode==='window-committed'){assert.equal(memory.window.version,2);assert.equal(memory.archivedIds.length,4);}
    if(mode==='memory-recorded'){assert.equal(memory.entries.length,1);assert.equal(app.store.tool(checkpoint.executionId!).state,'unknown');}
    if(mode==='maintenance-started'){
      const generation=app.store.claim(checkpoint.runId,true),store=app.store,cid=checkpoint.conversationId,maintenanceModel=new ScriptModel([]);
      const facts=()=>({messages:store.messages(cid),settings:store.settings(cid),memory:store.contextMemory(cid),state:{phase:'execute',environmentRevision:store.environment(checkpoint!.environmentId).revision}});
      const ctx=await new ContextManager(80000,1024,{off:1024,normal:1024,high:1024}).prepareTurn(store,maintenanceModel,checkpoint.runId,generation,[],facts,new AbortController().signal);
      assert.equal(maintenanceModel.requests.length,0);assert.equal(ctx.contextVersion,2);assert(ctx.messages.some(m=>m.content.includes('原始 assistant 记录片段')));
      store.commit({conversationId:cid,runId:checkpoint.runId},{type:'run.interrupted',payload:{reason:'测试恢复入口'}});
    }
    app.resume(checkpoint.conversationId,checkpoint.runId);assert.equal((await app.wait(checkpoint.runId)).status,'completed');
    // 重启不重复维护请求。活跃预算可容纳时先继续，原记录仍可查询。
    assert.equal(model.requests.length,1);if(mode==='memory-recorded'){assert.equal(app.store.contextMemory(checkpoint.conversationId).entries.length,1);assert.equal(app.store.tool(checkpoint.executionId!).state,'succeeded');}
    const state=app.store.snapshot(checkpoint.conversationId);assert.deepEqual(app.store.events(checkpoint.conversationId).reduce(reduceConversation,initialState(checkpoint.conversationId,state.cursor.logEpoch)),state);
    validatePairs(app.store.messages(checkpoint.conversationId).filter(m=>m.applied).sort((a,b)=>Number(BigInt(a.projectionSequence)-BigInt(b.projectionSequence))).map(m=>m.payload));
  }finally{if(child.exitCode===null&&!child.killed){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await app?.close();if(checkpoint)removeTestRoot(checkpoint.root);}
});
