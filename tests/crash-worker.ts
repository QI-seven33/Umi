import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { ToolRegistry } from '../packages/agent/src/tools/registry.js';
import { registerScratch } from '../packages/adapters/src/host-files/scratch.js';
import { ScriptModel } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import type { WireMessage } from '../packages/protocol/src/model.js';

// 故障注入进程在产品仓储的真实提交边界停住，由父进程强制终止。
const [directory,workspace,mode]=process.argv.slice(2);
if(!directory||!workspace||!mode)throw new Error('缺少故障注入参数');
const store=new SqliteStore(directory),c=store.createConversation(workspace),input=store.acceptInput(c.conversationId,uid(),'崩溃恢复案例');
const generation=store.claim(input.runId);store.applyInputs(input.runId);
const scope={conversationId:c.conversationId,runId:input.runId,modelTurnId:uid(),modelAttemptId:uid()},requestId=uid();
const registry=new ToolRegistry();registerScratch(registry);
const request=new ScriptModel([]).prepare(store.messages(c.conversationId).map(m=>m.payload),registry.specs(),store.settings(c.conversationId),1024);
store.persistRequest(scope,requestId,uid(),request,{estimatedInputTokens:1,inputCeiling:1000,estimator:'fixture'},generation);
store.commit(scope,{type:'model.attempt_started',payload:{requestId}});
let executionId:string|null=null;
if(mode==='partial') {
  const blockId=uid();store.commit(scope,{type:'model.block_started',payload:{blockId,kind:'text',displayRole:'commentary'}});
  store.commit(scope,{type:'model.delta',payload:{blockId,kind:'text',deltaIndex:0,text:'已显示的正文前缀'}});
} else {
  const args={relativePath:'recovery.txt',content:'可核验内容'};
  const message:WireMessage={role:'assistant',content:'',tool_calls:[{id:uid(),type:'function',function:{name:'write_scratch',arguments:JSON.stringify(args)}}]};
  store.persistResponse(scope,message,{message},null,requestId,generation,'tool_calls');
  const t=store.tools(input.runId)[0]!;executionId=t.id;
  const definition=registry.get(t.name),context=definition.prepare(args,store.environment(c.environmentId));
  const a=store.requestApproval(t.id,context,'故障注入批准',generation);store.decideApproval(c.conversationId,a,'allow');
  store.commit({conversationId:c.conversationId,runId:input.runId},{type:'run.resumed',payload:{}});
  store.commit({conversationId:c.conversationId,runId:input.runId},{type:'run.phase_changed',payload:{phase:'execute'}});
  if(mode!=='approved') {
    store.dispatch(t.id,context,generation);
    if(mode==='effect'||mode==='settled') {
      const result=await definition.execute(args,context,c.conversationId,new AbortController().signal);
      if(mode==='settled')store.settle(t.id,result,generation,false,true);
    }
  }
}
process.send?.({...c,runId:input.runId,executionId});
// 不调用 close：保留 WAL 和写入锁，覆盖真实进程硬退出。
setInterval(()=>{},1000);
