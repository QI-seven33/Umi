import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { DesktopService } from '../apps/desktop/service.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';
import { settingsSchema, UmiError, validatePairs } from '../packages/protocol/src/model.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { ScriptModel, removeTestRoot, eventually, text, call } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';

const sse = (delta: unknown, finish: string, usage?: unknown) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\ndata: [DONE]\n\n';
const truncated = () => sse({ reasoning_content: '已有推理必须保留', content: '开始写入。', tool_calls: [{ index: 0, id: 'partial', function: { name: 'write_scratch', arguments: '{"relativePath":"scene.html","content":"未写完' } }] }, 'length', { prompt_tokens: 40, completion_tokens: 32768, total_tokens: 32808 });
function fixture(model: DeepSeekAdapter | ScriptModel, maxTurns=12) {
  const root=mkdtempSync(join(tmpdir(),'umi-length-')),app=new UmiApplication(join(root,'data'),model,{limits:{maxTurns,maxRetries:2,modelTimeoutMs:3000,retryDelayMs:1}}),c=app.createConversation(root,{thinking:'normal'});
  return {root,app,c,async close(){await app.close();removeTestRoot(root);}};
}

test('length是带usage的真实终止，残缺参数只进入草稿', async()=>{
  const model=new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>new Response(truncated()));
  const frames:ModelFrame[]=[];
  for await(const frame of model.stream(model.prepare([{role:'user',content:'写文件'}],[],settingsSchema.parse({}),32768),new AbortController().signal))frames.push(frame);
  const last=frames.at(-1)!;assert.equal(last.kind,'response');
  if(last.kind==='response') {
    assert.equal(last.finishReason,'length');assert.equal(last.message.tool_calls,undefined);
    assert.equal(last.message.reasoning_content,'已有推理必须保留');assert.equal(last.usage?.completion_tokens,32768);
    assert.equal((last.raw as any).draft.toolCalls[0].function.name,'write_scratch');
  }
});

test('截断续作携带宿主事实和历史思考，仅完整新调用批准后执行一次', async()=>{
  const requests:any[]=[];
  const model=new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async(_url,init)=>{
    const request=JSON.parse(String(init?.body));requests.push(request);
    if(requests.length===1)return new Response(truncated());
    validatePairs(request.messages);
    assert(request.messages.some((m:any)=>m.reasoning_content==='已有推理必须保留'));
    assert(JSON.stringify(request.messages).includes('此前响应达到输出上限'));
    assert(!JSON.stringify(request.messages).includes('未写完'));
    return new Response(requests.length===2?sse({content:'先写主体。',tool_calls:[{index:0,id:'complete',function:{name:'write_scratch',arguments:JSON.stringify({relativePath:'scene.html',content:'<html>完整主体</html>'})}}]},'tool_calls'):sse({content:'主体已保存到托管副本。'},'stop'));
  });
  const f=fixture(model);
  try {
    const r=f.app.send(f.c.conversationId,uid(),'创建页面');
    const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    assert.equal(f.app.store.tools(r.runId).length,1);f.app.approve(f.c.conversationId,approval,'allow');
    assert.equal((await f.app.wait(r.runId)).status,'completed');assert.equal(requests.length,3);
    assert.equal(requests[0].reasoning_effort,'low');assert.equal(requests[0].max_tokens,65536);
    const state=f.app.store.snapshot(f.c.conversationId),limit=Object.values(state.attempts).find(a=>a.finishReason==='length')!;
    const draft=await f.app.registry.get('read_artifact').execute({artifactId:limit.responseRef,startByte:0,byteLength:8192},f.app.registry.get('read_artifact').prepare({},f.app.store.environment(f.c.environmentId)),f.c.conversationId,new AbortController().signal);
    assert(JSON.stringify(draft).includes('未写完'));
    const other=f.app.createConversation(f.root);
    assert.throws(()=>f.app.store.accessibleArtifact(other.conversationId,limit.responseRef!),/不属于/);
    assert.equal(readFileSync(join(f.app.store.environment(f.c.environmentId).root,'task/scratch/scene.html'),'utf8'),'<html>完整主体</html>');
    const usageEvents=f.app.store.events(f.c.conversationId).filter(e=>e.type==='usage.recorded');assert.equal(usageEvents.length,1);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)),state);
  } finally {await f.close();}
});

test('再次length后有真实正文、两次usage，既不无限重试也不执行草稿', async()=>{
  let requests=0;const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{requests++;return new Response(truncated());}));
  try {
    const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'failed');assert.equal(requests,2);
    const state=f.app.store.snapshot(f.c.conversationId);assert.equal(state.runs[r.runId]?.code,'PROVIDER_TRUNCATED');assert.match(state.runs[r.runId]?.failureSummary?.text??'',/再次达到输出上限/);
    assert.equal(f.app.store.tools(r.runId).length,0);assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root,'task/scratch/scene.html')));
    assert.equal(f.app.store.events(f.c.conversationId).filter(e=>e.type==='usage.recorded').length,2);
    const html=renderToStaticMarkup(createElement(Timeline,{snapshot:new DesktopService(f.app).snapshot(f.c.conversationId),onPreview:()=>{},onError:()=>{}}));assert.match(html,/再次达到输出上限/);
  } finally {await f.close();}
});

test('轮次不足时length直接本地收尾，不谎称已再次恢复', async()=>{
  let requests=0;const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{requests++;return new Response(truncated());}),1);
  try {const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'failed');assert.equal(requests,1);assert.match(f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary?.text??'',/已无续作轮次/);}
  finally{await f.close();}
});

test('服务端未完整DONE时仍是断流，不能进入length恢复', async()=>{
  let requests=0;const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{requests++;return new Response(truncated().replace('data: [DONE]\n\n',''));}));
  try {const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'interrupted');assert.equal(requests,1);assert.equal(f.app.store.tools(r.runId).length,0);}
  finally{await f.close();}
});

test('停止优先于length续作', async()=>{
  let requests=0;const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{requests++;return new Response(truncated());}));
  const original=f.app.store.persistResponse.bind(f.app.store);
  f.app.store.persistResponse=(...args)=>{const id=original(...args);void f.app.stop(f.c.conversationId,args[0].runId!);return id;};
  try {const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'stopped');assert.equal(requests,1);}
  finally{await f.close();}
});

test('一次length后退出重启，恢复次数仍绑定原话而非进程内计数', async()=>{
  let count=0;const first=new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{if(++count===1)return new Response(truncated());return new Response('',{status:402});});
  const f=fixture(first);
  try {
    const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'interrupted');await f.app.close();
    let resumed=0;const app=new UmiApplication(join(f.root,'data'),new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>{resumed++;return new Response(truncated());}));
    try{app.resume(f.c.conversationId,r.runId);assert.equal((await app.wait(r.runId)).status,'failed');assert.equal(resumed,1);}finally{await app.close();}
  }finally{await f.close();}
});

test('启动无需重放已闭合的上万分片；冷投影仍与全量归约一致', async()=>{
  // 长流加载使用不同编号，保留一万分片而不伪装成应被暂停的逐字循环。
  const chunks = Array.from({length:10000}, (_, i) => "片段" + i + ';');
  class LongInterrupted extends ScriptModel {
    override async *stream(request:PreparedRequest):AsyncGenerator<ModelFrame>{this.requests.push(request);for(const chunk of chunks)yield {kind:'delta',channel:'reasoning',key:'r',text:chunk};throw new UmiError('PROVIDER_INTERRUPTED','测试断流',true);}
  }
  const f=fixture(new LongInterrupted([]));
  try {
    const r=f.app.send(f.c.conversationId,uid(),'长任务');await f.app.wait(r.runId);await f.app.close();
    let eager=0;const original=SqliteStore.prototype.events;SqliteStore.prototype.events=function(...args){eager++;return original.apply(this,args);};
    let app:UmiApplication|undefined;
    try {app=new UmiApplication(join(f.root,'data'),new ScriptModel([]));assert.equal(eager,0);const snap=app.store.snapshot(f.c.conversationId);assert.equal(eager,0);assert.equal(snap.blocks[0]?.text,chunks.join(''));
      const all=app.store.events(f.c.conversationId);assert.equal(all.filter(e=>e.type==='model.delta').length,10000);assert.deepEqual(all.reduce(reduceConversation,initialState(f.c.conversationId,snap.cursor.logEpoch)),snap);
      const list=app.store.listConversations();assert.equal(list[0]?.updatedAt,all.at(-1)?.occurredAt);
    }finally{SqliteStore.prototype.events=original;await app?.close();}
  }finally{await f.close();}
});

test('length返回前收到新要求，先交新原话，不把旧恢复说明变成新目标', async()=>{
  let count=0;const requests:any[]=[];const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return new Response(++count===1?truncated():sse({content:'按新要求只解释。'},'stop'));}));
  const original=f.app.store.persistResponse.bind(f.app.store);let sent=false;
  f.app.store.persistResponse=(...args)=>{const id=original(...args);if(!sent){sent=true;f.app.send(f.c.conversationId,uid(),'改为只解释，不创建文件');}return id;};
  try{const r=f.app.send(f.c.conversationId,uid(),'创建页面');assert.equal((await f.app.wait(r.runId)).status,'completed');assert.equal(requests.length,2);assert(JSON.stringify(requests[1].messages).includes('改为只解释，不创建文件'));assert(!JSON.stringify(requests[1].messages).includes('此前响应达到输出上限'));assert.equal(f.app.store.tools(r.runId).length,0);}finally{await f.close();}
});

test('length混合完整头调用与残缺尾调用，整个截断响应均不自动执行',async()=>{
  let count=0;const body=sse({content:'批量草稿',tool_calls:[{index:0,id:'head',function:{name:'write_scratch',arguments:JSON.stringify({relativePath:'head.txt',content:'不应执行'})}},{index:1,id:'tail',function:{name:'write_scratch',arguments:'{"relativePath":"tail.txt","content":"'}}]},'length');
  const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async()=>new Response(++count===1?body:sse({content:'本轮未执行任何草稿调用。'},'stop'))));
  try{const r=f.app.send(f.c.conversationId,uid(),'两个文件');await f.app.wait(r.runId);assert.equal(count,2);assert.equal(f.app.store.tools(r.runId).length,0);assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root,'task/scratch/head.txt')));}finally{await f.close();}
});

test('受阻总结自身length也保留usage并使用完整本地正文',async()=>{
  class SummaryModel extends ScriptModel {
    override async *stream(request:PreparedRequest,signal:AbortSignal):AsyncGenerator<ModelFrame>{
      if((request.body.tools as unknown[]).length){yield* super.stream(request,signal);return;}
      this.requests.push(request);yield {kind:'delta',channel:'text',key:'t',text:'半截总结'};
      yield {kind:'response',message:{role:'assistant',content:'半截总结'},finishReason:'length',usage:{prompt_tokens:7,completion_tokens:4096},raw:{draft:'半截总结'}};
    }
  }
  const f=fixture(new SummaryModel(Array.from({length:4},(_,i)=>call('search_history',{query:'重复'},'查找',String(i)))));
  try{const r=f.app.send(f.c.conversationId,uid(),'查历史');assert.equal((await f.app.wait(r.runId)).status,'failed');const state=f.app.store.snapshot(f.c.conversationId);assert.notEqual(state.runs[r.runId]?.failureSummary?.text,'半截总结');assert.match(state.runs[r.runId]?.failureSummary?.text??'',/停止重复请求/);assert(Object.values(state.attempts).some(a=>a.finishReason==='length'));const usage=f.app.store.events(f.c.conversationId).filter(e=>e.type==='usage.recorded');assert.equal(usage.length,5);}finally{await f.close();}
});

test('只生成思考就length时也能有界续作，原思考仍完整回传',async()=>{
  let count=0;const f=fixture(new DeepSeekAdapter(()=> 'fixture','https://api.deepseek.com',async(_url,init)=>{
    if(++count===1)return new Response(sse({reasoning_content:'只有思考还没形成正文'},'length',{completion_tokens:32768}));
    assert(JSON.stringify(JSON.parse(String(init?.body)).messages).includes('只有思考还没形成正文'));
    return new Response(sse({content:'给用户完整答复。'},'stop'));
  }));
  try{const r=f.app.send(f.c.conversationId,uid(),'解释');assert.equal((await f.app.wait(r.runId)).status,'completed');assert.equal(count,2);assert.equal(f.app.store.tools(r.runId).length,0);}finally{await f.close();}
});
