import {SqliteStore} from '../packages/adapters/src/sqlite/store.js';
import {ScriptModel} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
const [data,workspace,mode]=process.argv.slice(2);if(!data||!workspace)throw Error('missing fixture roots');
const s=new SqliteStore(data),c=s.createConversation(workspace),input=s.acceptInput(c.conversationId,uid(),'硬退出分块验证'),generation=s.claim(input.runId);s.applyInputs(input.runId);
const scope={conversationId:c.conversationId,runId:input.runId,modelTurnId:uid(),modelAttemptId:uid()},requestId=uid(),blockId=uid();
s.persistRequest(scope,requestId,uid(),new ScriptModel([]).prepare([],[],s.settings(c.conversationId),1024),{estimatedInputTokens:1,inputCeiling:100000,estimator:'fixture'},generation);
s.commit(scope,{type:'model.attempt_started',payload:{requestId}});s.commit(scope,{type:'model.block_started',payload:{blockId,kind:'text',displayRole:'commentary'}});
if(mode==='inflight'){
 const prepare=s.db.prepare.bind(s.db);s.db.prepare=(sql:string)=>{
  const statement=prepare(sql);if(sql==='INSERT INTO events VALUES(?,?,?,?,?,?)'){
   const run=statement.run.bind(statement);statement.run=(...args)=>{const result=Reflect.apply(run,statement,args);process.send?.({...c,runId:input.runId});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
  }return statement;
 };
}
s.commitModelDeltas(scope,generation,[0,1].map(deltaIndex=>({type:'model.delta',payload:{blockId,kind:'text',deltaIndex,text:'保留🌱'+deltaIndex}})));
process.send?.({...c,runId:input.runId,events:s.events(c.conversationId).filter(e=>e.type==='model.delta')});setInterval(()=>{},1000);
