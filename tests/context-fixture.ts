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
import {ScriptModel,text,call,removeTestRoot,eventually} from './fixtures.js';
import {hostContext} from '../packages/adapters/src/host-files/scratch.js';

const budgets={off:1024,normal:1024,high:1024};
export function contextFixture(count=10,size=8000){
  const root=mkdtempSync(join(tmpdir(),'umi-context-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const app=new UmiApplication(join(root,'data'),new ScriptModel([])),c=app.createConversation(workspace,{thinking:'high'});
  const receipt=app.store.acceptInput(c.conversationId,uid(),'原要求：只能修改颜色，不得改变权限。方案 B 已被我否决。'),generation=app.store.claim(receipt.runId);app.store.applyInputs(receipt.runId);
  for(let i=0;i<count;i++)appendResponse(app,receipt.runId,generation,text(`${i}:`+'历史资料'.repeat(Math.ceil(size/12))));
  const manager=new ContextManager(80000,1024,budgets),facts=()=>({messages:app.store.messages(c.conversationId),settings:app.store.settings(c.conversationId),memory:app.store.contextMemory(c.conversationId),state:{phase:'execute',environmentRevision:app.store.environment(c.environmentId).revision}});
  return {root,workspace,app,c,runId:receipt.runId,generation,manager,facts,async close(){await app.close();removeTestRoot(root);}};
}
export function appendResponse(app:UmiApplication,runId:string,generation:number,message:WireMessage){
  const scope={conversationId:app.store.getRun(runId).conversation_id,runId,modelTurnId:uid(),modelAttemptId:uid()},requestId=uid();
  const request=new ScriptModel([]).prepare([],[],app.store.settings(scope.conversationId),1024);
  app.store.persistRequest(scope,requestId,uid(),request,{estimatedInputTokens:1,inputCeiling:100000,estimator:'fixture'},generation);
  app.store.commit(scope,{type:'model.attempt_started',payload:{requestId}});
  for(const kind of ['reasoning','text'] as const){const content=kind==='reasoning'?message.reasoning_content??'':message.content;if(!content)continue;const blockId=uid();
    app.store.commit(scope,{type:'model.block_started',payload:{blockId,kind,displayRole:'commentary'}});
    app.store.commit(scope,{type:'model.delta',payload:{blockId,kind,deltaIndex:0,text:content}});app.store.commit(scope,{type:'model.block_completed',payload:{blockId}});
  }
  return app.store.persistResponse(scope,message,{message},null,requestId,generation,message.tool_calls?.length?'tool_calls':'stop');
}
