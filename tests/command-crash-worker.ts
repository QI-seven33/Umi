import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,eventually} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
const [data,workspace,mode]=process.argv.slice(2);if(!data||!workspace||!mode)throw new Error('缺少参数');let mountId='',conversationId='',runId='',environmentId='';
const code="const fs=require('fs');let n=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8')):0;fs.writeFileSync('count.txt',String(n+1));process.stdout.write('副作用已发生'+'.'.repeat(200));"+(mode==='receipt'?'':'setInterval(()=>{},1000)');
const app=new UmiApplication(data,new ScriptModel([()=>call('run_command',{program:'node',argv:['-e',code],cwd:{kind:'mount',mountId},timeoutMs:20000})]),{
  processBoundary(point,executionId){if(point===mode){process.send?.({conversationId,runId,environmentId,mountId,executionId});if(point==='planned'||point==='ready'||point==='released'||point==='receipt')return new Promise(()=>{});}}
});
const c=app.createConversation(workspace);conversationId=c.conversationId;environmentId=c.environmentId;mountId=app.files.repo.mounts(environmentId)[0]!.id;runId=app.send(conversationId,uid(),'实际进程崩溃验收').runId;
const a=await eventually(()=>Object.entries(app.store.snapshot(conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);app.approve(conversationId,a,'allow');setInterval(()=>{},1000);
