import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid,hash} from '../packages/agent/src/identity.js';
import {validatePairs} from '../packages/protocol/src/model.js';
import type {WireMessage} from '../packages/protocol/src/model.js';
import {appendResponse} from '../tests/context-fixture.js';
import {text,removeTestRoot} from '../tests/fixtures.js';
// 历史负载为明确标记的合成验收资料；只有维护与后续工作请求调用真实 DeepSeek。
const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';if(!key())throw new Error('未配置 DeepSeek 密钥，未调用 API');
const inspect=process.env.UMI_VERIFY_INSPECT,root=inspect?resolve(inspect):mkdtempSync(join(tmpdir(),'umi-live-context-')),workspace=join(root,'workspace');if(!inspect)mkdirSync(workspace);
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{
  context:new ContextManager(200000,16384,{off:4096,normal:8192,high:8192}),limits:{maxTurns:24,maxRetries:0,modelTimeoutMs:180000,retryDelayMs:1000}});let passed=false;
try{
  let c:{conversationId:string;environmentId:string},input:{runId:string};
  if(!inspect){
  c=app.createConversation(workspace,{thinking:'high'});input=app.store.acceptInput(c.conversationId,uid(),'验收原始要求：使用蓝色，不能修改权限；方案 B 因对比度不足被否决。');const generation=app.store.claim(input.runId);app.store.applyInputs(input.runId);
  for(let i=0;i<12;i++)appendResponse(app,input.runId,generation,text(`【合成历史负载 ${i}，不是实际执行结果】`+'参考资料记录。'.repeat(775)));
  app.store.acceptInput(c.conversationId,uid(),'本次更正颜色为灰色。请先实际调用 search_history 找回包含“验收原始要求”的用户原话。随后调用 record_work_note 保存 observation 笔记，text 使用搜索命中的完整 text，sources 使用该命中的 messageId、startByte、endByte。不得改变权限、文件或运行程序。任务完成后简短说明当前颜色和方案 B 被否决的原因。不要请求额外窗口切换。');app.store.applyInputs(input.runId);
  app.store.commit({conversationId:c.conversationId,runId:input.runId},{type:'run.interrupted',payload:{reason:'合成历史准备完成，开始真实维护验收'}});
  console.log(JSON.stringify({progress:'real-context-maintenance-started',syntheticMessages:12,model:'deepseek-flash',thinking:'high'}));
  app.resume(c.conversationId,input.runId);assert.equal((await app.wait(input.runId)).status,'completed');
  }else{const saved=app.store.all('SELECT id,environment_id FROM conversations')[0]!;c={conversationId:saved.id as string,environmentId:saved.environment_id as string};input={runId:app.store.all('SELECT id FROM runs')[0]!.id as string};assert.equal(app.store.getRun(input.runId).status,'completed');}
  const memory=app.store.contextMemory(c.conversationId),events=app.store.events(c.conversationId),maintenance=Object.values(app.store.snapshot(c.conversationId).memory.maintenance);
  assert(memory.window.version>=2);assert(memory.archivedIds.length>0);assert(maintenance.filter(m=>m.status==='completed').length>=1);assert.equal(maintenance.filter(m=>m.status==='failed').length,0,'真实摘要未成功；不把片段降级当真实摘要验收');
  const tools=app.store.tools(input.runId);assert(tools.some(t=>t.name==='search_history'&&t.state==='succeeded'));assert(tools.some(t=>t.name==='record_work_note'&&t.state==='succeeded'));assert.equal(Object.keys(app.store.snapshot(c.conversationId).approvals).length,0);
  const requests=app.store.all('SELECT artifact_id FROM model_requests ORDER BY rowid').slice(12).map(r=>app.store.readArtifact<{body:{messages:WireMessage[]};settings:{thinking:string}}>(r.artifact_id as string));
  for(const r of requests){validatePairs(r.body.messages);assert(r.body.messages.some(m=>m.role==='user'&&m.content.includes('验收原始要求')));assert(r.body.messages.some(m=>m.role==='user'&&m.content.includes('本次更正颜色为灰色')));}
  assert(requests.some(r=>r.body.messages.some(m=>m.role==='assistant'&&m.reasoning_content)));
  const final=app.store.messages(c.conversationId).at(-1)!.payload.content;assert(final.includes('灰色'));assert(final.includes('对比度'));
  const raw=app.store.all("SELECT id FROM artifacts WHERE kind='provider-response'").slice(12).flatMap(r=>app.store.readArtifact<{model?:string}[]>(r.id as string)),returnedModels=[...new Set(raw.flatMap(r=>r.model?[r.model]:[]))];
  const report={name:'Umi',stage:'4',verifiedAt:new Date().toISOString(),status:'passed',requestedModel:'deepseek-flash',returnedModels,thinking:'high',contextWindow:200000,
    calls:{maintenance:maintenance.length,work:requests.length,total:maintenance.length+requests.length},syntheticHistory:{assistantMessages:12,disclaimer:'历史负载由验收器合成，不是实际模型执行结果'},
    context:{version:memory.window.version,archivedMessages:memory.archivedIds.length,notes:memory.entries.filter(e=>e.value.kind==='note').length,statistics:app.contextStatistics(c.conversationId)},
    tools:tools.map(t=>({name:t.name,status:t.state})),reasoningReplay:true,userOriginalsRetained:true,finalAnswerHash:hash(final),usage:events.filter(e=>e.type==='usage.recorded').map(e=>e.type==='usage.recorded'?app.store.readArtifact(e.payload.usageRef):null),
    evidenceCollection:inspect?'由已完成运行的持久记录核验，不重复调用 API':'运行后直接核验',
    limitation:'一个真实 Flash high 压缩后检索与笔记任务；未验 Pro、1M 实际装满、图片、数小时自治或长期缓存成本。'};
  const path=resolve(process.env.UMI_VERIFY_REPORT||'docs/evidence/deepseek-stage4.json');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');passed=true;console.log(JSON.stringify({status:'passed',path,calls:report.calls,contextVersion:memory.window.version,returnedModels}));
}finally{await app.close();if(passed)removeTestRoot(root);else console.log(JSON.stringify({failedEvidenceDirectory:root}));}
