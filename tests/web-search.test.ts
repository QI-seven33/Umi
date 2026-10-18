import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../packages/agent/src/tools/registry.js';
import { registerWebSearch } from '../packages/adapters/src/deepseek-search/search.js';
import { SEARCH_ARCHIVE_BYTES, SEARCH_VIEW_BYTES } from '../packages/agent/src/tools/web-search.js';
import type { WebSearchArchive, SearchSnapshot } from '../packages/agent/src/tools/web-search.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { uid, canonical } from '../packages/agent/src/identity.js';
import { ScriptModel, call, text, removeTestRoot } from './fixtures.js';

const item = (summary='官方摘要') => ({ title:'参考标题',url:'https://example.org/reference',summary,snippet:'短摘要',content:'',date:null,site_name:null,site_icon:null,authority:-1,rerank_score:2 });
const context={schemaVersion:1 as const,runtimeId:'test',environmentId:'test',environmentRevision:0,bindingRoot:'unused',rootIdentity:'test',locations:[],webReadExecutionId:'execution-test'};
function unit(transport:typeof fetch) {
  const saved:SearchSnapshot[]=[];const archive:WebSearchArchive={save:(_id,value)=>{saved.push(value);return 'snapshot-test';}};
  const registry=new ToolRegistry();registerWebSearch(registry,archive,()=> 'local-secret','https://api.deepseek.com',transport);
  const definition=registry.get('search_web');
  return {definition,saved,registry,execute:(args:unknown={query:'测试'},signal=new AbortController().signal)=>definition.execute(args,context,'cid',signal)};
}
test('Search：直接 JSON/Bearer，无模型和历史，保留操作符，完整存档不进入反馈',async()=>{
  const source=item('中🙂'.repeat(6000)+'ARCHIVE_TAIL');
  const f=unit(async(url,init)=>{assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.equal((init?.headers as any).Authorization,'Bearer local-secret');assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{query:'最新 "精确词" site:example.org after:2026',count:5,need_content:false});return Response.json({results:[source],extraProviderMetadata:{keep:true}});});
  const result=await f.execute({query:'最新 "精确词" site:example.org after:2026'}),data=result.data as any;
  assert.equal(result.outcome,'succeeded');assert.equal(f.saved.length,1);assert.equal(f.saved[0]?.response.results[0]?.summary,source.summary);assert.deepEqual(f.saved[0]?.response.extraProviderMetadata,{keep:true});assert(data.sources[0].summaryTruncated);assert(!JSON.stringify(result).includes('ARCHIVE_TAIL'));assert(!JSON.stringify(result).includes('local-secret'));assert.equal(data.archiveTruncated,false);assert(Buffer.byteLength(JSON.stringify(result))<SEARCH_VIEW_BYTES);
});
test('Search：128 Unicode 字符可用，超长/空白/越界 count 拒绝且不发送请求',async()=>{
  let requests=0;const f=unit(async()=>{requests++;return Response.json({results:[]});});
  assert.equal((await f.execute({query:'🙂'.repeat(128)})).outcome,'succeeded');
  for(const args of [{query:'🙂'.repeat(129)},{query:'x'.repeat(129)},{query:'x'.repeat(128)+'\n'},{query:' \n\t'},{query:'x',count:11},{query:'x',count:0},{query:'x',need_content:true}])
    await assert.rejects(()=>f.execute(args));
  assert.equal(requests,1);const spec=f.registry.specs()[0]!;assert.equal(spec.parameters.type,'object');
});
test('Search：空结果是成功无命中，普通模型文本/坏结构不能伪装来源',async()=>{
  const empty=unit(async()=>Response.json({results:[]})),r=await empty.execute();
  assert.equal(r.outcome,'succeeded');assert.equal((r.data as any).evidence_status,'empty');assert.equal(empty.saved.length,1);
  for(const response of [{content:[{type:'text',text:'有很多来源'}]},{results:[{title:'没链接'}]},{results:[{...item(),url:'file:///C:/secret'}]},{results:[{...item(),url:'https://user:pass@example.org/'}]},{results:[{...item(),url:'http://127.0.0.1/'}]}]){
    const f=unit(async()=>Response.json(response));assert.equal((await f.execute()).outcome,'failed');assert.equal(f.saved.length,0);
  }
});
for(const status of [400,401,402,403,404,408,413,429,500,504])test('Search HTTP '+status+'：明确失败原因，不重试和回显错误原文',async()=>{
  let requests=0;const f=unit(async()=>{requests++;return new Response('private echoed local-secret',{status});}),r=await f.execute();
  assert.equal(r.outcome,'failed');assert.equal(requests,1);assert.equal(f.saved.length,0);assert.equal((r.data as any).retryable,[408,429,500,504].includes(status));assert(!JSON.stringify(r).includes('private echoed'));assert(!JSON.stringify(r).includes('local-secret'));
});
test('Search：视图总字节有界，未展示条目/原始 content 仍完整归档',async()=>{
  const response={results:Array.from({length:10},(_,i)=>({...item('中文字🙂'.repeat(3000)),url:'https://example.org/'+i+'x'.repeat(7000),content:'UNREQUESTED_BODY_'+i}))};
  const f=unit(async()=>Response.json(response)),r=await f.execute({query:'测试',count:10}),data=r.data as any;
  assert.equal(r.outcome,'succeeded');assert(Buffer.byteLength(JSON.stringify(r))<=SEARCH_VIEW_BYTES);assert(data.resultsTruncated);assert(data.shownResults<10);assert.equal(f.saved[0]?.response.results.length,10);assert(!JSON.stringify(r).includes('UNREQUESTED_BODY'));
});
test('Search：无效 UTF-8/超限响应明确失败，用户停止取消读取且不建快照',async()=>{
  for(const response of [new Response(new Uint8Array([0xff])),Response.json({results:[item('x'.repeat(SEARCH_ARCHIVE_BYTES))]})]){
    const f=unit(async()=>response);assert.equal((await f.execute()).outcome,'failed');assert.equal(f.saved.length,0);
  }
  let cancelled=false;const controller=new AbortController(),f=unit(async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}})));
  const pending=f.execute({query:'测试'},controller.signal);await new Promise<void>(r=>setImmediate(r));controller.abort();await assert.rejects(()=>pending);assert(cancelled);assert.equal(f.saved.length,0);
});
test('Search：会话归属、不可变快照、重启无联网配置仍可分页追回未展示内容',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-web-search-')),workspace=join(root,'workspace');mkdirSync(workspace);
  let snapshotId='',network=0;const tail='RAW_TAIL_729',source={results:[item('中文🙂'.repeat(10000)+tail)]};
  const app=new UmiApplication(join(root,'data'),new ScriptModel([call('search_web',{query:'参考'}),request=>{
    const receipt=(request.body.messages as any[]).filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).at(-1);snapshotId=receipt.data.snapshotId;assert(!JSON.stringify(request).includes(tail));return text('已取得摘要，全文保存在快照。');
  }]),{search:{key:()=> 'test-only',baseUrl:'https://api.deepseek.com',transport:async()=>{network++;return Response.json(source);}}});
  const c=app.createConversation(workspace),other=app.createConversation(workspace);
  try{
    const run=app.send(c.conversationId,uid(),'搜索并保留资料');assert.equal((await app.wait(run.runId)).status,'completed');assert.equal(network,1);
    assert.deepEqual((app.store.accessibleArtifact(c.conversationId,snapshotId) as SearchSnapshot).response,source);
    assert.throws(()=>app.store.accessibleArtifact(other.conversationId,snapshotId),/不属于/);
    assert.throws(()=>app.store.db.prepare('UPDATE artifacts SET content=? WHERE id=?').run('{}',snapshotId));
    const full=canonical(app.store.accessibleArtifact(c.conversationId,snapshotId));assert(full.includes(tail));
  }finally{await app.close();}
  const reopened=new UmiApplication(join(root,'data'),new ScriptModel([]));
  try{
    const d=reopened.registry.get('read_artifact'),env=reopened.store.environment(c.environmentId);let bytes='',offset=0;
    while(true){const r=await d.execute({artifactId:snapshotId,startByte:offset,byteLength:64000},d.prepare({},env),c.conversationId,new AbortController().signal);const data=r.data as any;bytes+=data.text; if(data.nextStartByte===null)break;offset=data.nextStartByte;assert(offset>0);}
    assert.deepEqual(JSON.parse(bytes).response,source);assert(bytes.includes(tail));
    assert(canonical(reopened.store.accessibleArtifact(c.conversationId,snapshotId)).includes(tail));
  }finally{await reopened.close();removeTestRoot(root);}
});
