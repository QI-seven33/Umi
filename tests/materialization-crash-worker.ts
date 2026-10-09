import { writeFileSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel,call,eventually } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';

const [data,workspace,mode]=process.argv.slice(2);if(!data||!workspace||!mode)throw new Error('缺少测试参数');const outside=join(dirname(workspace),'external');
const lastData=(r:PreparedRequest)=>JSON.parse((r.body.messages as {role:string;content:string}[]).filter(m=>m.role==='tool').at(-1)!.content).data;
const app=new UmiApplication(data,new ScriptModel([call('discover_resource',{path:outside}),r=>call('request_resource',{candidateId:lastData(r).candidates[0].id,access:'edit',purpose:'物化验收'})]));
const c=app.createConversation(workspace);let runId='';
function crash() {
  const t=app.store.tools(runId).find(t=>t.name==='request_resource')!;
  writeFileSync(join(data!,'checkpoint.json'),JSON.stringify({...c,runId,executionId:t.id}));
  process.exit(137);
}
if(mode==='complete') {const original=app.files.repo.addMount.bind(app.files.repo);app.files.repo.addMount=(m,manifest,excluded)=>{if(m.sourceRoot===outside)crash();return original(m,manifest,excluded);};}
else {const original=app.files.saveBlob.bind(app.files);let count=0;app.files.saveBlob=(env,bytes)=>{if(env.active_run_id===runId&&++count===2)crash();return original(env,bytes);};}
runId=app.send(c.conversationId,uid(),'物化外部资源').runId;const a=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);app.approve(c.conversationId,a,'allow');
setInterval(()=>{},1000);
