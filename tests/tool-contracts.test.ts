import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid} from '../packages/agent/src/identity.js';
import {validatePairs} from '../packages/protocol/src/model.js';
import {ScriptModel,call,text,removeTestRoot,type Step} from './fixtures.js';

function fixture(original?:string,context?:ContextManager){
  const root=mkdtempSync(join(tmpdir(),'umi-contracts-')),source=join(root,'source');mkdirSync(source);
  if(original!==undefined)writeFileSync(join(source,'a.txt'),original);
  const steps:Step[]=[],model=new ScriptModel(steps),app=new UmiApplication(join(root,'data'),model,context?{context}:{}),c=app.createConversation(source),mount=app.files.repo.mounts(c.environmentId)[0]!;
  const args={mountId:mount.id,path:'a.txt'};
  return {root,source,steps,model,app,c,mount,args,file:join(mount.root,'a.txt'),
    async run(input='按要求修改副本'){const r=app.send(c.conversationId,uid(),input);await app.wait(r.runId);return r;},
    async close(){await app.close();removeTestRoot(root);}};
}
const lastData=(request:any)=>JSON.parse([...request.body.messages].reverse().find((m:any)=>m.role==='tool').content).data;

test('工具契约：lineCount单独传入从第1行读；错误字段一次反馈后可修正',async()=>{
  const f=fixture('第一行\r\n第二行\r\n第三行');
  try{
    const spec=f.app.registry.specs().find(t=>t.name==='read_file')!.parameters;
    assert(spec.not,'模型规格必须表达行/字节互斥');
    f.steps.push(call('read_file',{...f.args,lineCount:0}),r=>{
      const feedback=lastData(r);assert.equal(feedback.code,'TOOL_ARGUMENTS_INVALID');assert.equal(feedback.issues[0].path,'lineCount');
      assert.match(JSON.stringify(r.body.messages),/lineCount/);
      return call('read_file',{...f.args,lineCount:2});
    },r=>{assert.equal(lastData(r).text,'第一行\r\n第二行\r\n');assert.equal(lastData(r).lineSelection.startLine,1);return text('读取完成');});
    const r=await f.run('读取开头两行');assert.deepEqual(f.app.store.tools(r.runId).map(t=>t.state),['failed','succeeded']);
    assert.equal(f.model.requests.length,3);
    assert.throws(()=>f.app.registry.parse('read_file',JSON.stringify({...f.args,startByte:0,lineCount:2})),/startByte.*startLine\/lineCount/);
  }finally{await f.close();}
});

test('工具契约：写入→连续编辑→整文替换不需要读回或搬运回执',async()=>{
  const f=fixture();
  try{
    f.steps.push(call('write_file',{...f.args,content:'\uFEFF前🙂 唯一目标\r\n末尾'}),
      call('edit_file',{...f.args,oldText:'唯一目标',newText:'新片段'}),
      call('edit_file',{...f.args,edits:[{oldText:'前🙂',newText:'开头🙂'},{oldText:'新片段',newText:'最终片段'}]}),
      call('write_file',{...f.args,mode:'replace',content:'最终全文\r\n'}),text('已完成副本修改'));
    const r=await f.run();assert.equal((await f.app.wait(r.runId)).status,'completed');
    assert.deepEqual(f.app.store.tools(r.runId).map(t=>[t.name,t.state]),[['write_file','succeeded'],['edit_file','succeeded'],['edit_file','succeeded'],['write_file','succeeded']]);
    assert.equal(readFileSync(f.file,'utf8'),'最终全文\r\n');assert.equal(f.model.requests.length,5);
    assert.equal(f.app.store.snapshot(f.c.conversationId).approvals && Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,0);
    validatePairs(f.app.store.messages(f.c.conversationId).filter(m=>m.applied).map(m=>m.payload));
  }finally{await f.close();}
});

test('已见版本：同一工具批次内成功自写后可以精确修改',async()=>{
  const f=fixture();
  try{
    f.steps.push({role:'assistant',content:'创建并完善文件',tool_calls:[call('write_file',{...f.args,content:'主体'}).tool_calls![0]!,call('edit_file',{...f.args,oldText:'主体',newText:'完善主体'},'',uid()).tool_calls![0]!]},text('完成'));
    const r=await f.run();assert.deepEqual(f.app.store.tools(r.runId).map(t=>t.state),['succeeded','succeeded']);
    assert.equal(readFileSync(f.file,'utf8'),'完善主体');assert.equal(f.model.requests.length,2);
  }finally{await f.close();}
});

test('已见版本：部分原文编辑后范围随Unicode长短平移，未见尾部仍受保护',async()=>{
  const original='\uFEFF开头🙂\r\n唯一目标\r\n隐藏尾部不得覆盖',f=fixture(original);
  try{
    f.steps.push(call('read_file',{...f.args,lineCount:2}),call('edit_file',{...f.args,oldText:'唯一目标',newText:'更长🙂的新片段'}),
      call('edit_file',{...f.args,oldText:'更长🙂的新片段',newText:'短'}),call('edit_file',{...f.args,oldText:'隐藏尾部',newText:'越界修改'}),text('保留未见范围'));
    const r=await f.run();assert.deepEqual(f.app.store.tools(r.runId).map(t=>t.state),['succeeded','succeeded','succeeded','failed']);
    assert.equal(readFileSync(f.file,'utf8'),original.replace('唯一目标','短'));
    assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),original);
    const last=f.app.store.tools(r.runId).at(-1)!;assert.match(f.app.store.readArtifact<any>(last.result_ref!).content,/读取范围/);
  }finally{await f.close();}
});

test('已见版本：空文件和删除后的空范围可用于显式整文替换',async()=>{
  const f=fixture();
  try{
    f.steps.push(call('write_file',{...f.args,content:''}),call('write_file',{...f.args,mode:'replace',content:'唯一内容'}),
      call('edit_file',{...f.args,oldText:'唯一内容',newText:''}),call('write_file',{...f.args,mode:'replace',content:'从空文件重写'}),text('完成'));
    const r=await f.run();assert(f.app.store.tools(r.runId).every(t=>t.state==='succeeded'));assert.equal(readFileSync(f.file,'utf8'),'从空文件重写');
  }finally{await f.close();}
});

test('已见版本：分页读取自动合并完整覆盖，可替换超过单页预算的原文',async()=>{
  const original='长🙂'.repeat(15000),f=fixture(original);
  try{
    f.steps.push(call('read_file',{...f.args,byteLength:64000}),r=>call('read_file',{...f.args,startByte:lastData(r).nextStartByte,byteLength:64000,expectedHash:lastData(r).hash}),
      call('write_file',{...f.args,mode:'replace',content:'完整已见后替换'}),text('完成'));
    const r=await f.run();assert(f.app.store.tools(r.runId).every(t=>t.state==='succeeded'));assert.equal(readFileSync(f.file,'utf8'),'完整已见后替换');
  }finally{await f.close();}
});

test('已见版本：stat/search不授予正文编辑依据，猜中原文也不覆盖',async()=>{
  const f=fixture('唯一目标');
  try{
    f.steps.push(call('stat_file',f.args),call('search_text',{...f.args,query:'唯一目标'}),call('edit_file',{...f.args,oldText:'唯一目标',newText:'不能写'}),text('需要原文'));
    const r=await f.run();assert.equal(f.app.store.tools(r.runId).at(-1)!.state,'failed');assert.equal(readFileSync(f.file,'utf8'),'唯一目标');
  }finally{await f.close();}
});

test('已见版本：隐藏于旧投影的读取不自动成为完整可见依据',async()=>{
  class Hidden extends ContextManager{override prepare(...a:Parameters<ContextManager['prepare']>){const p=super.prepare(...a);return {...p,messages:p.messages.map(m=>m.role==='tool'?{...m,content:'{"truncated":true}'}:m)};}}
  const f=fixture('保留正文',new Hidden());
  try{
    f.steps.push(call('read_file',f.args),call('write_file',{...f.args,mode:'replace',content:'不得覆盖'}),text('无法确认完整原文'));
    const r=await f.run();assert.equal(f.app.store.tools(r.runId).at(-1)!.state,'failed');assert.equal(readFileSync(f.file,'utf8'),'保留正文');
  }finally{await f.close();}
});

for(const mode of ['content','identity','ambiguous','partial-replace'] as const)test('已见版本保护：'+mode,async()=>{
  const f=fixture('唯一目标\n未读尾部');
  try{
    f.steps.push(call('read_file',{...f.args,lineCount:1}),()=>{
      if(mode==='content')writeFileSync(f.file,'外部新版本');
      if(mode==='identity'){renameSync(f.file,f.file+'.old');writeFileSync(f.file,'唯一目标\n未读尾部');}
      if(mode==='ambiguous')return call('edit_file',{...f.args,oldText:'目',newText:'标'});
      return mode==='partial-replace'?call('write_file',{...f.args,mode:'replace',content:'不能覆盖未读全文'}):call('edit_file',{...f.args,oldText:'唯一目标',newText:'不能覆盖'});
    },text('根据实际回执答复'));
    if(mode==='ambiguous'){
      // 在读前形成两个相同定位片段，仍走产品读取与唯一定位检查。
      writeFileSync(f.file,'唯一目标 目标\n未读尾部');
    }
    const r=await f.run();assert.equal(f.app.store.tools(r.runId).at(-1)!.state,'failed');
    assert.equal(readFileSync(f.file,'utf8'),mode==='content'?'外部新版本':mode==='ambiguous'?'唯一目标 目标\n未读尾部':'唯一目标\n未读尾部');
  }finally{await f.close();}
});

test('已见版本：重启后保留成功自写依据，跨文件不能借用',async()=>{
  const f=fixture();
  try{
    f.steps.push(call('write_file',{...f.args,content:'原正文'}),text('已创建'));await f.run();await f.app.close();
    writeFileSync(join(f.mount.root,'other.txt'),'原正文');
    const next=new UmiApplication(join(f.root,'data'),new ScriptModel([call('edit_file',{...f.args,path:'other.txt',oldText:'原正文',newText:'不得借用'}),call('edit_file',{...f.args,oldText:'原正文',newText:'恢复后修改'}),text('完成')]));
    try{const r=next.send(f.c.conversationId,uid(),'继续修改');await next.wait(r.runId);assert.deepEqual(next.store.tools(r.runId).map(t=>t.state),['failed','succeeded']);assert.equal(readFileSync(f.file,'utf8'),'恢复后修改');assert.equal(readFileSync(join(f.mount.root,'other.txt'),'utf8'),'原正文');}
    finally{await next.close();}
  }finally{await f.close();}
});

test('已见版本：自动绑定编辑在写后提交故障，恢复只核验不重复追加',async()=>{
  const f=fixture();
  try{
    f.steps.push(call('write_file',{...f.args,content:'主体'}),call('edit_file',{...f.args,oldText:'主体',newText:'主体+新增'}),text('不应先结束'));
    f.app.store.db.exec("CREATE TRIGGER contracts_fail BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.settled' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='edit_file' BEGIN SELECT RAISE(ABORT,'故障'); END;");
    const r=await f.run();assert.equal(f.app.store.getRun(r.runId).status,'recovery_required');assert.equal(readFileSync(f.file,'utf8'),'主体+新增');
    f.app.store.db.exec('DROP TRIGGER contracts_fail');await f.app.close();
    const next=new UmiApplication(join(f.root,'data'),new ScriptModel([text('核验原目标后答复')]));
    try{next.resume(f.c.conversationId,r.runId);assert.equal((await next.wait(r.runId)).status,'completed');const edit=next.store.tools(r.runId)[1]!;assert.equal(edit.state,'succeeded');assert.equal(readFileSync(f.file,'utf8'),'主体+新增');assert.equal(next.store.events(f.c.conversationId).filter(e=>e.type==='tool.dispatch_intent'&&e.executionId===edit.id).length,1);}
    finally{await next.close();}
  }finally{await f.close();}
});

test('已见版本：省略哈希后相同编辑参数作用于不同原版本，不被误判停滞',async()=>{
  const f=fixture();
  try{
    for(let i=0;i<4;i++)f.steps.push(call('write_file',{...f.args,...(i?{mode:'replace'}:{}),content:`版本${i}\n唯一目标`}),call('edit_file',{...f.args,oldText:'唯一目标',newText:'修改后'}));
    f.steps.push(text('四个不同版本均已修改'));
    const r=await f.run();assert.equal(f.app.store.tools(r.runId).length,8);assert(f.app.store.tools(r.runId).every(t=>t.state==='succeeded'));
    assert.equal(readFileSync(f.file,'utf8'),'版本3\n修改后');
  }finally{await f.close();}
});
