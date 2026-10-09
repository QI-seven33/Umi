import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { uid } from '../packages/agent/src/identity.js';
import { eventually } from '../tests/fixtures.js';

const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';if(!key())throw new Error('未配置 DEEPSEEK_API_KEY；未执行真实 API 验证。');
const directory=resolve(process.env.UMI_VERIFY_DATA||`.umi/verify-${uid()}`);mkdirSync(directory,{recursive:true});
const base=process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com';
const app=new UmiApplication(directory,new DeepSeekAdapter(key,base),{
  context:new ContextManager(1_000_000,16384,{off:1024,normal:4096,high:4096}),
  limits:{maxTurns:10,maxRetries:0,modelTimeoutMs:120000,retryDelayMs:1000},search:{key,baseUrl:base}});
try{
  const c=app.createConversation(directory,{thinking:'normal'});
  const first=app.send(c.conversationId,uid(),'本次验收原始要求：颜色是蓝色。仅简短确认，不调用工具、不操作文件。');
  assert.equal((await app.wait(first.runId)).status,'completed');
  const second=app.send(c.conversationId,uid(),'现在更正颜色为绿色。请先实际调用 search_history 找回包含“颜色是蓝色”的用户原话，再调用 write_scratch 在托管临时区的 live-check.txt 写入恰好“绿色”。不得操作用户项目目录。工具获准并成功后说明新要求已生效。');
  const approvalId=await eventually(()=>{const status=app.store.getRun(second.runId).status;if(['failed','interrupted','recovery_required'].includes(status))throw new Error(`真实验证运行未完成：${status}`);
    return Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0];},180000);
  assert.equal(app.store.getRun(second.runId).status,'waiting_permission');
  const approvedTool=app.store.tool(app.store.approval(approvalId).execution_id);assert.equal(approvedTool.name,'write_scratch');
  assert.deepEqual(JSON.parse(approvedTool.args),{relativePath:'live-check.txt',content:'绿色'});
  app.approve(c.conversationId,approvalId,'allow');assert.equal((await app.wait(second.runId)).status,'completed');
  const env=app.store.environment(c.environmentId);assert.equal(readFileSync(join(env.root,'task','scratch','live-check.txt'),'utf8'),'绿色');
  const tools=app.store.tools(second.runId);assert(tools.some(t=>t.name==='search_history'&&t.state==='succeeded'));
  const messages=app.store.messages(c.conversationId);assert(messages.some(m=>m.payload.role==='assistant'&&Boolean(m.payload.reasoning_content)));
  const requests=app.store.all('SELECT artifact_id FROM model_requests ORDER BY rowid').map(r=>app.store.readArtifact<{body:{messages:{reasoning_content?:string}[]}}>(r.artifact_id as string));
  assert(requests.some(r=>r.body.messages.some(m=>Boolean(m.reasoning_content))));
  const events=app.store.events(c.conversationId),usages=events.filter(e=>e.type==='usage.recorded').map(e=>e.type==='usage.recorded'?app.store.readArtifact(e.payload.usageRef):null);
  const returnedModels=[...new Set(app.store.all("SELECT id FROM artifacts WHERE kind='provider-response'").flatMap(r=>
    app.store.readArtifact<{model?:string}[]>(r.id as string).flatMap(item=>item.model?[item.model]:[])))];
  const search=app.registry.get('deepseek_server_web_search'),searchInput={query:'查询 DeepSeek 官方文档当前 deepseek-flash 对应的模型版本。给出官方文档的网页来源。'};
  const searchResult=await search.execute(searchInput,search.prepare(searchInput,env),c.conversationId,AbortSignal.timeout(60000));
  assert.equal(searchResult.outcome,'succeeded','Anthropic 兼容搜索未取得可核验网页来源');
  const searchData=searchResult.data as {sources:unknown[];usage:unknown;latency_ms:number};
  const report={name:'Umi',verifiedAt:new Date().toISOString(),requestedModel:'deepseek-flash',returnedModels,adapterVersion:'1',thinking:'normal',
    calls:requests.length,status:'passed',checks:['真实思考流','带工具原始思考回传','历史原话检索','批准等待','托管写入回读','最终回复'],usage:usages,
    search:{protocol:'anthropic-compatible',status:searchResult.outcome,sources:searchData.sources,usage:searchData.usage,latencyMs:searchData.latency_ms},
    conversationId:c.conversationId,runs:[first.runId,second.runId],environmentId:c.environmentId};
  writeFileSync(join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app.close();}
