import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call, text, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid, hash } from '../packages/agent/src/identity.js';
import { bytesHash } from '../packages/adapters/src/host-files/paths.js';
import { inspectObservedImage } from '../packages/adapters/src/host-files/image-format.js';
import { imageObservationViews } from '../packages/agent/src/context/image-observations.js';
import type { HistoryRow } from '../packages/agent/src/context/projection.js';
import { imageObservationSchema } from '../packages/protocol/src/image-observation.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { UmiError, settingsSchema, validatePairs, type WireMessage } from '../packages/protocol/src/model.js';
import { estimateInput } from '../packages/agent/src/context/estimate.js';

function chunk(name: string, data: Buffer) {
  const block = Buffer.alloc(data.length + 12); block.writeUInt32BE(data.length); block.write(name,4,'ascii'); data.copy(block,8);
  block.writeUInt32BE(crc32(block.subarray(4,-4)),block.length-4); return block;
}
function png(width=48,height=32,red=200) {
  const header=Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) { const n=y*(width*3+1)+1+x*3; pixels[n]=red; pixels[n+1]=30; pixels[n+2]=80; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const messages=(r:PreparedRequest)=>r.body.messages as WireMessage[];
const images=(r:PreparedRequest)=>messages(r).flatMap(m=>m.images??[]);
const lastResult=(r:PreparedRequest)=>JSON.parse(messages(r).filter(m=>m.role==='tool').at(-1)!.content);
function fixture(steps:Step[], files:Record<string,Buffer>={'图.png':png()}) {
  const root=mkdtempSync(join(tmpdir(),'umi-image-')), workspace=join(root,'source'); mkdirSync(workspace);
  for(const [name,bytes] of Object.entries(files)) writeFileSync(join(workspace,name),bytes);
  const model=new ScriptModel(steps), app=new UmiApplication(join(root,'data'),model), c=app.createConversation(workspace,{thinking:'normal'}), mount=app.files.repo.mounts(c.environmentId)[0]!;
  return {root,workspace,model,app,c,mount,steps,async run(prompt='检查图片中的内容') { const r=app.send(c.conversationId,uid(),prompt); await app.wait(r.runId); return r; }, async close(){await app.close();removeTestRoot(root);} };
}

test('图片观察：真实PNG容器/CRC/尺寸，伪后缀、损坏、截断和像素炸弹在持久化前拒绝',()=>{
  const bytes=png(); assert.deepEqual(inspectObservedImage(bytes),{mime:'image/png',width:48,height:32});
  const damaged=Buffer.from(bytes); damaged[45]=damaged[45]!^1;
  for(const value of [Buffer.from('<svg>不是PNG</svg>'),damaged,bytes.subarray(0,-1),Buffer.alloc(1_000_001)]) assert.throws(()=>inspectObservedImage(value));
  const header=Buffer.alloc(13);header.writeUInt32BE(8193);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const oversized=Buffer.concat([bytes.subarray(0,8),chunk('IHDR',header),bytes.subarray(33)]);
  assert.throws(()=>inspectObservedImage(oversized),e=>e instanceof UmiError&&e.code==='IMAGE_LIMIT');
});

test('图片观察：唯一循环传真实图片，原话/工具组/思考保持，重复读取复用，carry不重复加图',async()=>{
  let id=''; const first=png();
  const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}), r=>{
    assert.equal(lastResult(r).outcome,'succeeded'); assert.equal(images(r).length,1);
    assert.equal(images(r)[0]!.dataUrl,`data:image/png;base64,${first.toString('base64')}`);
    validatePairs(messages(r)); assert(messages(r).some(m=>m.images?.length&&m.content.includes('不是用户新发言')));
    return call('read_image',{mountId:id,path:'图.png'});
  },r=>{assert.equal(images(r).length,1);return text('已收到图片资料');},text('继续分析已有版本')]); id=f.mount.id;
  try {
    const run=await f.run(); assert.equal(f.app.store.getRun(run.runId).status,'completed');
    const receipts=f.app.store.tools(run.runId).map(t=>f.app.store.readArtifact<any>(t.result_ref!).data);
    assert.equal(receipts[0].imageRef,receipts[1].imageRef);
    assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,0);
    const raw=f.app.store.messages(f.c.conversationId);assert.equal(raw.filter(m=>m.role==='user').length,1);assert(!raw.some(m=>m.payload.images?.length));
    assert(raw.filter(m=>m.role==='assistant'&&m.payload.tool_calls).every(m=>m.payload.reasoning_content==='我先核实必要的信息。'));
    const previous=messages(f.model.requests.at(-1)!); await f.run('继续');
    const next=messages(f.model.requests.at(-1)!); assert.deepEqual(next.slice(0,previous.length),previous); assert.equal(images(f.model.requests.at(-1)!).length,1);
    const request=f.app.store.all('SELECT artifact_id FROM model_requests ORDER BY rowid DESC LIMIT 1')[0]!;
    assert.deepEqual(f.app.store.readArtifact<PreparedRequest>(request.artifact_id as string).body,f.model.requests.at(-1)!.body);
  }finally{await f.close();}
});

test('图片观察：版本变更与expectedHash失配不返回旧观察，新读取有新快照',async()=>{
  let id='',root='';const old=png(),changed=png(48,32,10);
  const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}),()=>{
    writeFileSync(join(root,'图.png'),changed);return call('read_image',{mountId:id,path:'图.png',expectedHash:bytesHash(old)});
  },r=>{assert.equal(lastResult(r).outcome,'failed');assert.equal(images(r).length,1);return call('read_image',{mountId:id,path:'图.png'});},r=>{assert.equal(images(r).length,2);return text('新旧版本可区分');}]);id=f.mount.id;root=f.mount.root;
  try{await f.run();const results=f.app.store.tools(f.app.store.snapshot(f.c.conversationId).latestRunId!).filter(t=>t.state==='succeeded').map(t=>f.app.store.readArtifact<any>(t.result_ref!).data);assert.notEqual(results[0].imageRef,results[1].imageRef);assert.equal(results[0].metadata.hash,bytesHash(old));assert.equal(results[1].metadata.hash,bytesHash(changed));}finally{await f.close();}
});

test('图片观察：重启且工作图片删除后，已保存版本仍可回传，不重新读宿主文件',async()=>{
  let id='';const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}),text('记录已保存')]);id=f.mount.id;
  try{
    await f.run(); const original=images(f.model.requests.at(-1)!)[0]; await f.app.close(); unlinkSync(join(f.mount.root,'图.png'));
    const model=new ScriptModel([r=>{assert.deepEqual(images(r),[original]);return text('依据原保存版本');}]), reopened=new UmiApplication(join(f.root,'data'),model);
    try{const run=reopened.send(f.c.conversationId,uid(),'继续依据保存版本');assert.equal((await reopened.wait(run.runId)).status,'completed');}finally{await reopened.close();}
  }finally{await f.close();}
});

test('图片观察：冻结成果来源可看图，跨会话output/mount和原始绝对路径均拒绝',async()=>{
  let outputId='';const f=fixture([call('capture_output',{path:'chart.png',name:'chart.png',mime:'image/png'}),r=>{outputId=lastResult(r).data.outputId;return call('read_image',{outputId});},r=>{assert.equal(images(r).length,1);return text('成果图片可读');}]);
  try{
    writeFileSync(join(f.app.store.environment(f.c.environmentId).root,'task/artifacts/chart.png'),png());await f.run();
    const c2=f.app.createConversation(f.workspace);
    f.steps.push(call('read_image',{outputId}),r=>{assert.equal(lastResult(r).outcome,'failed');assert.equal(images(r).length,0);return call('read_image',{mountId:f.mount.id,path:'图.png'});},r=>{assert.equal(lastResult(r).outcome,'failed');return text('越权已拒绝');});
    const r=f.app.send(c2.conversationId,uid(),'读取别的会话');await f.app.wait(r.runId);assert.equal(images(f.model.requests.at(-1)!).length,0);
    const schema=f.app.registry.get('read_image').schema;
    for(const args of [{path:'C:/private/a.png',mountId:f.mount.id},{path:'../a.png',mountId:f.mount.id},{outputId,mountId:f.mount.id,path:'图.png'},{outputId,untrusted:true}]) assert.equal(schema.safeParse(args).success,false);
  }finally{await f.close();}
});

test('图片观察：链接、硬链接、损坏文件和准备后变化都不进入图像快照',async()=>{
  let id='';const f=fixture([],{'图.png':png(),'bad.png':Buffer.from('not an image at all')});id=f.mount.id;
  try{
    symlinkSync(f.workspace,join(f.mount.root,'linked'),'junction');linkSync(join(f.mount.root,'图.png'),join(f.mount.root,'hard.png'));
    f.steps.push(...['linked/图.png','hard.png','bad.png'].map(path=>call('read_image',{mountId:id,path})),r=>{assert.equal(images(r).length,0);return text('拒绝不合规对象');});
    await f.run();assert.equal(f.app.store.get("SELECT count(*) n FROM artifacts WHERE kind='image-observation-snapshot'")!.n,0);
    unlinkSync(join(f.mount.root,'hard.png')); // 恢复普通文件后测试prepare/execute之间变化。
    const definition=f.app.registry.get('read_image'),prepare=definition.prepare;
    definition.prepare=(args,env,executionId)=>{const ctx=prepare(args,env,executionId);writeFileSync(join(f.mount.root,'图.png'),png(48,32,1));return ctx;};
    f.steps.push(call('read_image',{mountId:id,path:'图.png'}),r=>{assert.equal(lastResult(r).outcome,'failed');assert.equal(images(r).length,0);return text('变化对象已拒绝');});await f.run('检查变化');
  }finally{await f.close();}
});

test('图片观察：8张活跃预算超限明确失败，重复内容不占新名额，不自动丢图或新增请求',async()=>{
  let id='';const files=Object.fromEntries(Array.from({length:9},(_,i)=>[`i${i}.png`,png(24,20,i*20)]));
  const f=fixture([],files);id=f.mount.id;
  try{
    f.steps.push(...Array.from({length:9},(_,i)=>call('read_image',{mountId:id,path:`i${i}.png`})),r=>{assert.equal(lastResult(r).outcome,'failed');assert.match(lastResult(r).content,/8张/);assert.equal(images(r).length,8);return call('read_image',{mountId:id,path:'i0.png'});},r=>{assert.equal(lastResult(r).outcome,'succeeded');assert.equal(images(r).length,8);return text('预算有界');});
    const run=await f.run();assert.equal(f.app.store.getRun(run.runId).status,'completed');assert.equal(f.model.requests.length,11);
    assert.equal(f.app.store.get("SELECT count(*) n FROM artifacts WHERE kind='image-observation-snapshot'")!.n,8);
  }finally{await f.close();}
});

test('图片观察：Pro明确失败，历史观察切换到Pro时不传图，不自动切换模型',async()=>{
  let id='';const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}),text('图片已存')]);id=f.mount.id;
  try{
    await f.run();f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),model:'deepseek-v4-pro'});
    f.steps.push(call('read_image',{mountId:id,path:'图.png'}),r=>{assert.equal(lastResult(r).outcome,'failed');assert.equal(images(r).length,0);return text('当前模型不支持图片');});
    await f.run('尝试继续看图');assert.equal(f.app.store.settings(f.c.conversationId).model,'deepseek-v4-pro');
  }finally{await f.close();}
});

test('图片观察：并行工具结果先全部闭合，再形成宿主观察；原工具顺序和私有思考不变',()=>{
  const receipt=imageObservationSchema.parse({kind:'image-observation',schemaVersion:1,imageRef:'image-ref',metadata:{hash:bytesHash(png()),mime:'image/png',width:48,height:32,size:png().length},source:{kind:'output',outputId:'output-id',path:'task/artifacts/a.png'}});
  const assistant={...call('read_image',{outputId:'output-id'},'先观察','first'),tool_calls:[...call('read_image',{},'', 'first').tool_calls!,...call('stat_file',{},'','second').tool_calls!]};
  const payloads:WireMessage[]=[assistant,{role:'tool',tool_call_id:'first',content:'image result'},{role:'tool',tool_call_id:'second',content:'other result'}];
  const rows:HistoryRow[]=payloads.map((payload,i)=>({id:String(i),payload,applied:true,projectionSequence:String(i+1),...(i===1?{imageObservation:{receipt,image:{mime:'image/png',dataUrl:`data:image/png;base64,${png().toString('base64')}`}}}:{})}));
  const views=imageObservationViews(rows,payloads);assert.equal(views[1]!.length,1);assert.equal(views[2]!.length,2);assert.deepEqual(views[0]![0],assistant);validatePairs(views.flat());
});

test('图片观察：适配器使用真实user图片块，估算按图像计费而非base64文本，不越48MiB',()=>{
  const adapter=new DeepSeekAdapter(()=> 'test-only'),dataUrl=`data:image/png;base64,${png().toString('base64')}`;
  const request=adapter.prepare([{role:'user',content:'宿主观察',images:[{mime:'image/png',dataUrl}]}],[],settingsSchema.parse({thinking:'normal'}),1024);
  const content=(request.body.messages as any[])[0].content;assert.equal(content[1].image_url.url,dataUrl);assert.equal(content[0].text,'宿主观察');
  assert(estimateInput(request.body)>=1024);assert(estimateInput(request.body)<2048);
});

test('图片观察：独立编码器生成的JPEG/GIF/WebP均按真实容器识别，不信任扩展名',()=>{
  const fixtures={"JPEG":"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLooornPjgooooAKKKKACiiigAooooAKKKKAP/2Q==","GIF":"R0lGODdhMAAgAIEAAB+WXAAAAAAAAAAAACwAAAAAMAAgAEAIQQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmQEBADs=","WEBP":"UklGRkoAAABXRUJQVlA4ID4AAAAwAwCdASowACAAPm02l0ikIqIhJWgAgA2JZwDKtA8xNu8AAP7ni/vctEkf/52D/4I/+PfMEJqXcapuQAAAAA=="};
  for(const [kind,base64] of Object.entries(fixtures)) {
    const result=inspectObservedImage(Buffer.from(base64,'base64'));
    assert.equal(result.width,48);assert.equal(result.height,32);
    assert.equal(result.mime,kind==='JPEG'?'image/jpeg':kind==='GIF'?'image/gif':'image/webp');
  }
});
test('图片观察：授权在prepare后撤销，执行时重新检查，未保存/发送图片',async()=>{
  let id='';const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}),r=>{assert.equal(lastResult(r).outcome,'failed');assert.equal(images(r).length,0);return text('已拒绝撤销权限的读取');}]);id=f.mount.id;
  const def=f.app.registry.get('read_image'),original=def.prepare;
  def.prepare=(args,env,executionId)=>{const ctx=original(args,env,executionId);f.app.files.repo.direct.revoke(env.id,f.mount.direct!.grantId);return ctx;};
  try{await f.run();assert.equal(f.app.store.get("SELECT count(*) n FROM artifacts WHERE kind='image-observation-snapshot'")!.n,0);}finally{await f.close();}
});
test('图片观察：维护窗口后释放活跃名额，原始工具组和旧图片仍可追溯',async()=>{
  let id='';const files=Object.fromEntries(Array.from({length:9},(_,i)=>['i'+i+'.png',png(24,20,i*20)])), f=fixture([],files);id=f.mount.id;
  try{
    f.steps.push(...Array.from({length:8},(_,i)=>call('read_image',{mountId:id,path:'i'+i+'.png'})),text('已观察8张'));
    const first=await f.run(),original=f.app.store.tools(first.runId).map(t=>t.result_ref);
    f.steps.push(call('request_context_reset',{reason:'旧图已检查，切换到下一张',keepSources:[]}),text('{"items":[]}'),()=>call('read_image',{mountId:id,path:'i8.png'}),r=>{assert.equal(lastResult(r).outcome,'succeeded');assert.equal(images(r).length,1);return text('新窗口继续观察');});
    const next=await f.run('继续，旧图可以归档');assert.equal(f.app.store.getRun(next.runId).status,'completed');
    assert(f.app.store.contextMemory(f.c.conversationId).archivedIds.length>=8);
    for(const ref of original) {const receipt=f.app.store.readArtifact<any>(ref!).data;assert(f.app.store.readArtifact(receipt.imageRef));}
    assert.equal(f.app.store.get("SELECT count(*) n FROM artifacts WHERE kind='image-observation-snapshot'")!.n,9);
  }finally{await f.close();}
});
test('图片观察：跨会话相同字节可共享快照，永久删除其一不破坏另一会话的图片',async()=>{
  let id='';const f=fixture([()=>call('read_image',{mountId:id,path:'图.png'}),text('保存第一份')]);id=f.mount.id;
  try{
    const first=await f.run(),ref=f.app.store.readArtifact<any>(f.app.store.tools(first.runId)[0]!.result_ref!).data.imageRef;
    const second=f.app.createConversation(f.workspace,{thinking:'normal'}),mount=f.app.files.repo.mounts(second.environmentId)[0]!;
    f.steps.push(call('read_image',{mountId:mount.id,path:'图.png'}),text('保存第二份'));
    const r=f.app.send(second.conversationId,uid(),'检查当前会话图片');await f.app.wait(r.runId);
    assert.equal(f.app.store.readArtifact<any>(f.app.store.tools(r.runId)[0]!.result_ref!).data.imageRef,ref);
    f.app.store.editConversation(f.c.conversationId,null,true);f.app.deleteArchivedConversation(f.c.conversationId);
    assert(f.app.store.readArtifact(ref));
    const ids=f.app.store.messages(second.conversationId).map(m=>m.id);assert.equal(Object.keys(f.app.store.imageObservations(second.conversationId,ids)).length,1);
  }finally{await f.close();}
});
