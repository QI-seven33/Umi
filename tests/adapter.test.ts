import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { readSse } from '../packages/adapters/src/deepseek/sse.js';
import { settingsSchema } from '../packages/protocol/src/model.js';
import { ToolRegistry } from '../packages/agent/src/tools/registry.js';
import { registerWebSearch } from '../packages/adapters/src/deepseek-search/search.js';
import type { ModelFrame } from '../packages/agent/src/ports.js';
import { z } from 'zod';

function bytes(text:string,size=1) {
  const value=new TextEncoder().encode(text);let start=0;
  return new ReadableStream<Uint8Array>({pull(c){if(start===value.length){c.close();return;}c.enqueue(value.slice(start,start+size));start=Math.min(value.length,start+size);}});
}
const event=(delta:unknown,finish:string|null=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\r\n\r\n`;
const fixtureFetch=(body:string,status=200):typeof fetch=>async()=>new Response(bytes(body),{status});
async function collect(adapter:DeepSeekAdapter) {
  const frames:ModelFrame[]=[];
  for await(const f of adapter.stream(adapter.prepare([{role:'user',content:'测试'}],[],settingsSchema.parse({thinking:'normal'}),4096),new AbortController().signal))frames.push(f);
  return frames;
}
test('A04/A06：SSE 中文字节拆分、多行、CRLF 和注释',async()=>{
  const results=[];for await(const d of readSse(bytes(':心跳\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata: 完整\n\n'),new AbortController().signal))results.push(d);
  assert.deepEqual(results,['第一行\n第二行','完整']);
  const frames=await collect(new DeepSeekAdapter(()=> 'test-only','https://api.deepseek.com',fixtureFetch(event({reasoning_content:'先核实',content:'阶段正文'})+event({content:'。'},'stop')+'data: [DONE]\n\n')));
  assert.deepEqual(frames.filter(f=>f.kind==='delta').map(f=>f.kind==='delta'?[f.channel,f.text]:[]),[['reasoning','先核实'],['text','阶段正文'],['text','。']]);
  const final=frames.at(-1)!;assert.equal(final.kind,'response');if(final.kind==='response'){assert.equal(final.message.reasoning_content,'先核实');assert.equal(final.message.content,'阶段正文。');}
});
test('A09：流式工具参数完整重组，多调用按提供方 index 归属',async()=>{
  const input=event({tool_calls:[{index:1,id:'call-b',function:{name:'second',arguments:'{"b":'}},{index:0,id:'call-a',function:{name:'first',arguments:'{"a":'}}]})+
    event({tool_calls:[{index:0,function:{arguments:'1}'}},{index:1,function:{arguments:'2}'}}]},'tool_calls')+'data: [DONE]\n\n';
  const frames=await collect(new DeepSeekAdapter(()=> 'test-only','https://api.deepseek.com',fixtureFetch(input)));
  const last=frames.at(-1)!;assert(last.kind==='response');assert.deepEqual(last.message.tool_calls?.map(c=>[c.id,c.function.name,JSON.parse(c.function.arguments)]),[['call-a','first',{a:1}],['call-b','second',{b:2}]]);
});
test('A09：缺少 DONE、截断及错误结构不提交完整模型响应',async()=>{
  for(const input of [event({content:'部分'},'stop'),event({content:'截断'},'length')+'data: [DONE]\n\n','data: {not-json}\n\n',
    event({tool_calls:[{index:0,function:{name:'write_scratch',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n']) {
    await assert.rejects(()=>collect(new DeepSeekAdapter(()=> 'test-only','https://api.deepseek.com',fixtureFetch(input))));
  }
});
test('A17/A19：挂起的流可取消，厂商错误不回显认证与响应原文',async()=>{
  const controller=new AbortController(),stream=new ReadableStream<Uint8Array>();const pending=(async()=>{for await(const _ of readSse(stream,controller.signal))void _;})();
  controller.abort();await assert.rejects(()=>pending);
  await assert.rejects(()=>collect(new DeepSeekAdapter(()=> 'secret-test','https://api.deepseek.com',fixtureFetch('不应显示的厂商原文',429))),
    e=>e instanceof Error&&e.message==='模型接口返回 HTTP 429');
});
test('A07/A32：带工具回传所有历史 raw reasoning，配置与输入原件不变',()=>{
  const adapter=new DeepSeekAdapter(()=> 'test-only'),settings=settingsSchema.parse({thinking:'high'});
  const history=[{role:'user' as const,content:'原要求'},{role:'assistant' as const,content:'旧正文',reasoning_content:'raw 旧思考'}];
  const specs=[{name:'test',description:'测试',parameters:z.toJSONSchema(z.object({}))}];
  const request=adapter.prepare(history,specs,settings,65536);history[1]!.reasoning_content='被外部修改';
  assert.equal((request.body.messages as typeof history)[1]?.reasoning_content,'raw 旧思考');assert.equal(request.body.reasoning_effort,'high');assert.equal(request.body.max_tokens,65536);
  const off=adapter.prepare(history,specs,{...settings,thinking:'off'},8192);assert.equal((off.body.messages as typeof history)[1]?.reasoning_content,undefined);
  assert.equal(history[1]?.reasoning_content,'被外部修改');
});
test('联网搜索：结构化来源才算证据，普通模型文本不能伪装搜索成功',async()=>{
  const ctx={schemaVersion:1 as const,runtimeId:'fixture',environmentId:'test',environmentRevision:0,bindingRoot:'unused',rootIdentity:'fixture',locations:[],webReadExecutionId:'execution-test'};
  for(const verified of [true,false]) {
    let sent:Record<string,unknown>|undefined,saves=0;
    const transport:typeof fetch=async(url,init)=>{assert.equal(url,'https://api.deepseek.com/v1/tools/search');sent=JSON.parse(String(init?.body));
      return Response.json(verified?{results:[{title:'参考',url:'https://example.org/reference',summary:'最新资料',snippet:'资料',content:'',date:null,site_name:null,site_icon:null,authority:-1,rerank_score:2}]}:{content:[{type:'text',text:'最新资料'}]});};
    const registry=new ToolRegistry();registerWebSearch(registry,{save:()=>{saves++;return 'snapshot-test';}},()=> 'test-only','https://api.deepseek.com',transport);
    const result=await registry.get('search_web').execute({query:'测试'},ctx,'test',new AbortController().signal);
    assert.equal(result.outcome,verified?'succeeded':'failed');assert.equal(saves,verified?1:0);
    assert.deepEqual(sent,{query:'测试',count:5,need_content:false});
  }
});
