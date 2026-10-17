import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { UmiApplication } from '../apps/headless/src/application.js';
import { RequestAdmission } from '../apps/desktop/request-admission.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { hostContext } from '../packages/adapters/src/host-files/scratch.js';
import { ProcessArchiveBudget, PROCESS_ARCHIVE_BYTES } from '../packages/adapters/src/host-process/log-policy.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { uid } from '../packages/agent/src/identity.js';
import { validatePairs } from '../packages/protocol/src/model.js';
import type { WireMessage } from '../packages/protocol/src/model.js';
import type { TaskCheckpointInput } from '../packages/protocol/src/task.js';
import { contextFixture } from './context-fixture.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'umi-natural-turn-')), workspace=join(root,'source');
  mkdirSync(workspace);
  const source='头🙂\r\n'+'保留中段学习注释\r\n'.repeat(310)+'尾🙂';
  writeFileSync(join(workspace,'a.txt'),source);
  const steps:Step[]=[], model=new ScriptModel(steps), app=new UmiApplication(join(root,'data'),model);
  const c=app.createConversation(workspace,{thinking:'high'}), mount=app.files.repo.mounts(c.environmentId)[0]!;
  const latest=()=>app.store.messages(c.conversationId).filter(m=>m.role==='user'&&m.applied).at(-1)!;
  return {root,workspace,source,steps,model,app,c,mount,latest,
    async send(input:string){const r=app.send(c.conversationId,uid(),input);await app.wait(r.runId);return r;},
    async close(){await app.close();removeTestRoot(root);}};
}
const wire=(request:{body:Record<string,unknown>})=>request.body.messages as WireMessage[];

test('自然消息：停止前原话未应用也不阻塞新任务，重发停止原 commandId 不启动',async()=>{
  const f=fixture();try{
    const id=uid(),old=f.app.send(f.c.conversationId,id,'原任务 Y');
    f.app.requestStop(f.c.conversationId,old.runId);
    assert.equal((await f.app.wait(old.runId)).status,'stopped');
    assert(!f.app.store.messageById(f.c.conversationId,old.messageId)!.applied);
    f.app.send(f.c.conversationId,id,'原任务 Y');
    assert.equal(f.model.requests.length,0);
    f.steps.push(request=>{assert(wire(request).some(m=>m.role==='user'&&m.content==='现在处理 X'));return text('处理 X');});
    const next=await f.send('现在处理 X');
    assert.equal(f.app.store.getRun(next.runId).status,'completed');
    assert.notEqual(next.runId,old.runId);
    assert.equal(f.app.store.messageById(f.c.conversationId,old.messageId)!.payload.content,'原任务 Y');
  }finally{await f.close();}
});

test('自然消息：停止清理期间收到新输入，先清理再交模型；旧输入不自动恢复',async()=>{
  const f=fixture();try{
    let entered=false, release!:()=>void;
    f.model.beforeResponse=async()=>{entered=true;await new Promise<void>(r=>release=r);};
    f.steps.push(text('旧任务答复'));
    const old=f.app.send(f.c.conversationId,uid(),'任务 Y');
    await eventually(()=>entered||undefined);
    f.app.requestStop(f.c.conversationId,old.runId);
    assert.equal(f.app.store.getRun(old.runId).status,'stopping');
    f.model.beforeResponse=undefined;
    f.steps.push(request=>{assert(wire(request).some(m=>m.role==='user'&&m.content==='停止 Y，先解释 X'));return text('解释 X');});
    const next=f.app.send(f.c.conversationId,uid(),'停止 Y，先解释 X');
    release();
    assert.equal((await f.app.wait(next.runId)).status,'completed');
    assert.equal(f.model.requests.length,2);
    assert(f.app.store.events(f.c.conversationId).some(e=>e.type==='run.stopped'));
  }finally{await f.close();}
});

test('自然消息：等待批准时改要求，旧批准作废，程序没有执行',async()=>{
  const f=fixture();try{
    f.steps.push(call('run_command',{program:'node',argv:['-e',"throw Error('禁止执行旧命令')"],cwd:{kind:'mount',mountId:f.mount.id}}),request=>{
      assert(wire(request).some(m=>m.role==='user'&&m.content==='改为解释，不执行'));
      return text('解释新要求');
    });
    const old=f.app.send(f.c.conversationId,uid(),'运行 Y');
    const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    const next=f.app.send(f.c.conversationId,uid(),'改为解释，不执行');
    assert.equal(next.runId,old.runId);
    await f.app.wait(next.runId);
    assert.equal(f.app.store.tools(old.runId)[0]!.state,'cancelled');
    assert.throws(()=>f.app.approve(f.c.conversationId,approval,'allow'),/失效/);
    assert.equal(f.app.commands.repo.receipt(f.app.store.tools(old.runId)[0]!.id),undefined);
    assert.equal(f.app.store.getRun(next.runId).status,'completed');
  }finally{await f.close();}
});

test('自然消息：未知旧写入不妨碍答复；新副作用被挡，显式检查只查原执行',async()=>{
  const f=fixture();let executions=0,inspections=0;try{
    f.app.registry.register({name:'test_effect',description:'隔离测试写入',schema:z.object({}).strict(),effect:'copy-write',prepare:hostContext,
      async execute(){executions++;throw Error('模拟派发后中断');},
      async reconcile(){inspections++;return {outcome:'succeeded',content:'只读取原回执',data:{receipt:'原事实'},mutated:false};}});
    f.steps.push(call('test_effect',{}));const old=await f.send('处理 Y');
    assert.equal(f.app.store.getRun(old.runId).status,'recovery_required');
    const target=f.app.store.tools(old.runId)[0]!, originalMessage=f.app.store.messages(f.c.conversationId).find(m=>m.payload.tool_call_id===target.provider_call_id)!;
    f.steps.push(request=>{
      assert.equal(inspections,0);assert(wire(request).some(m=>m.role==='user'&&m.content==='先解释 X'));
      return call('test_effect',{});
    },text('旧操作未核验，当前只能解释'));const explain=await f.send('先解释 X');
    assert.equal(f.app.store.getRun(explain.runId).status,'completed');
    assert.equal(f.app.store.tool(target.id).state,'unknown');assert.equal(executions,1);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[explain.runId]!.acceptance!.status,'blocked');
    f.steps.push({...call('inspect_tool_execution',{executionId:target.id},'', 'inspect'),tool_calls:[
      ...call('inspect_tool_execution',{executionId:target.id},'','inspect').tool_calls!,
      ...call('stat_file',{mountId:f.mount.id,path:'a.txt'},'','stat').tool_calls!,
    ]},request=>{validatePairs(wire(request));assert.equal(inspections,1);return text('根据原回执解释结果');});
    const checked=await f.send('核验原 Y，但不要重跑');
    assert.equal(f.app.store.getRun(checked.runId).status,'completed');
    assert.equal(f.app.store.tool(target.id).state,'succeeded');assert.equal(executions,1);
    assert.deepEqual(f.app.store.messageById(f.c.conversationId,originalMessage.id)!.payload,originalMessage.payload);
  }finally{await f.close();}
});

test('自然消息：新要求在已派发工具失败前收到，也只补启动一次交模型，不重跑',async()=>{
  const f=fixture();let entered=false,release!:()=>void,executions=0;try{
    f.app.registry.register({name:'test_interrupted',description:'隔离延迟写入',schema:z.object({}).strict(),effect:'copy-write',prepare:hostContext,
      async execute(){executions++;entered=true;await new Promise<void>(r=>release=r);throw Error('原执行反馈丢失');}});
    f.steps.push(call('test_interrupted',{}));
    const old=f.app.send(f.c.conversationId,uid(),'任务 Y');await eventually(()=>entered||undefined);
    f.steps.push(request=>{assert(wire(request).some(m=>m.role==='user'&&m.content==='先解释 X'));return text('解释 X，Y 未核验');});
    const next=f.app.send(f.c.conversationId,uid(),'先解释 X');release();
    assert.equal((await f.app.wait(next.runId)).status,'completed');assert.equal(next.runId,old.runId);
    assert.equal(f.model.requests.length,2);assert.equal(executions,1);assert.equal(f.app.store.tools(old.runId)[0]!.state,'unknown');
  }finally{await f.close();}
});

test('自然消息：程序 ready 后的新要求阻止 go，模型先看到新要求，检查不启动原脚本',{timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-input-ready-'));let app!:UmiApplication,cid='',runId='',executionId='';
  const steps:Step[]=[],model=new ScriptModel(steps);
  app=new UmiApplication(join(root,'data'),model,{processBoundary(point,id){if(point==='ready'){executionId=id;app.send(cid,uid(),'改为解释，不运行');}}});
  try{
    const workspace=join(root,'source');mkdirSync(workspace);const c=app.createConversation(workspace);cid=c.conversationId;
    steps.push(call('run_command',{program:process.execPath,argv:['-e',"require('fs').writeFileSync('must-not-exist.txt','旧任务')"],cwd:{kind:'task',area:'scratch'}}),request=>{
      assert(wire(request).some(m=>m.role==='user'&&m.content==='改为解释，不运行'));
      assert.equal(app.commands.repo.receipt(executionId),undefined);
      return call('inspect_tool_execution',{executionId});
    },text('原程序未启动，回应新要求'));
    const r=app.send(cid,uid(),'原命令');runId=r.runId;
    const approval=await eventually(()=>Object.entries(app.store.snapshot(cid).approvals).find(([,a])=>a.status==='pending')?.[0],15000);
    app.approve(cid,approval,'allow');assert.equal((await app.wait(runId)).status,'completed');
    assert.equal(app.commands.repo.receipt(executionId)!.reason,'not_started');
    assert.equal(app.store.tool(executionId).state,'failed');
    assert.equal(app.commands.repo.row(executionId)!.released,0);
    assert(!existsSync(join(app.store.environment(c.environmentId).root,'task','scratch','must-not-exist.txt')));
  }finally{await app.close();removeTestRoot(root);}
});

test('任务关系：Y 挂起→X→Y 继续，原目标和验收不删除，状态引用新原话',async()=>{
  const f=fixture();try{
    const checkpoint=():TaskCheckpointInput=>({baseVersion:0,goal:'任务 Y',source:{messageId:f.latest().id,quote:'任务 Y'},acknowledgedInputId:f.latest().id,
      criteria:[{id:'review',description:'人工确认 Y',check:{kind:'review'}}],progress:[{criterionId:'review',status:'blocked',reason:'等用户安排'}],nextAction:'确认 Y'});
    f.steps.push(()=>call('record_task_checkpoint',checkpoint()),text('Y 等安排'));await f.send('任务 Y');
    const original=f.app.tasks.list(f.c.conversationId)[0]!;
    f.steps.push(()=>call('set_task_state',{taskId:original.taskId,baseVersion:original.version,state:'suspended',source:{messageId:f.latest().id,quote:'先做 X'}}),text('处理 X'));await f.send('先做 X');
    assert.equal(f.app.tasks.assess(f.c.conversationId).tasks[0]!.lifecycle,'suspended');
    assert.equal(f.app.tasks.assess(f.c.conversationId).status,'untracked');
    f.steps.push(()=>call('set_task_state',{taskId:original.taskId,baseVersion:original.version,state:'active',source:{messageId:f.latest().id,quote:'继续 Y'}}),
      ()=>call('record_task_checkpoint',{...original.input,taskId:original.taskId,baseVersion:original.version,acknowledgedInputId:f.latest().id}),text('继续原目标 Y'));
    const resumed=await f.send('继续 Y');assert.equal(f.app.store.getRun(resumed.runId).status,'completed');
    const final=f.app.tasks.list(f.c.conversationId)[0]!;
    assert.equal(final.taskId,original.taskId);assert.equal(final.version,2);assert.deepEqual(final.input.criteria,original.input.criteria);
    assert.equal(f.app.tasks.assess(f.c.conversationId).tasks[0]!.lifecycle,'active');
    assert.equal(f.app.store.events(f.c.conversationId).filter(e=>e.type==='task.state_changed').length,2);
    const state=f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)),state);
  }finally{await f.close();}
});

test('任务关系：取消 Y 后替代为 X，原检查点保留；旧原话不能激活或取消任务',async()=>{
  const f=fixture();try{
    const checkpoint=(goal:string,supersedesTaskId?:string)=>({baseVersion:0,goal,source:{messageId:f.latest().id,quote:f.latest().payload.content},acknowledgedInputId:f.latest().id,
      ...(supersedesTaskId?{supersedesTaskId}:{}),criteria:[{id:'review',description:'用户复核',check:{kind:'review'}}],progress:[{criterionId:'review',status:'blocked',reason:'等复核'}],nextAction:'等新要求'});
    f.steps.push(()=>call('record_task_checkpoint',checkpoint('Y')),text('Y 保留'));await f.send('任务 Y');
    const original=f.app.tasks.list(f.c.conversationId)[0]!;
    f.steps.push(()=>call('set_task_state',{taskId:original.taskId,baseVersion:original.version,state:'cancelled',source:{messageId:f.latest().id,quote:'取消 Y'}}),
      ()=>call('record_task_checkpoint',checkpoint('X',original.taskId)),text('按新要求处理 X'));await f.send('取消 Y，改为 X');
    const all=f.app.tasks.list(f.c.conversationId);assert.equal(all.length,2);
    assert.deepEqual(all.find(t=>t.taskId===original.taskId),original);
    assert.equal(all.find(t=>t.taskId!==original.taskId)!.input.supersedesTaskId,original.taskId);
    assert.equal(f.app.tasks.assess(f.c.conversationId).tasks.find(t=>t.taskId===original.taskId)!.lifecycle,'cancelled');
    f.steps.push(call('set_task_state',{taskId:original.taskId,baseVersion:original.version,state:'active',source:original.input.source}),text('先核对当前要求'));
    const next=await f.send('解释当前任务');
    assert.equal(f.app.store.tools(next.runId)[0]!.state,'failed');
    assert.equal(f.app.tasks.assess(f.c.conversationId).tasks.find(t=>t.taskId===original.taskId)!.lifecycle,'cancelled');
  }finally{await f.close();}
});

test('检查点核验：旧更新结算中断后有新版本，只读原提交而不覆盖新版本',async()=>{
  const f=fixture();try{
    const initial=():TaskCheckpointInput=>({baseVersion:0,goal:'任务 Y',source:{messageId:f.latest().id,quote:'任务 Y'},acknowledgedInputId:f.latest().id,
      criteria:[{id:'review',description:'人工复核',check:{kind:'review'}}],progress:[{criterionId:'review',status:'blocked',reason:'待用户安排'}],nextAction:'等新要求'});
    f.steps.push(()=>call('record_task_checkpoint',initial()),text('已记录'));await f.send('任务 Y');
    const original=f.app.tasks.list(f.c.conversationId)[0]!,settle=f.app.store.settle.bind(f.app.store);let injected=false;
    f.app.store.settle=(...args)=>{if(!injected&&f.app.store.tool(args[0]).name==='record_task_checkpoint'){injected=true;throw Object.assign(Error('结算中断'),{code:'SQLITE_BUSY'});}return settle(...args);};
    const update=()=>{const current=f.app.tasks.list(f.c.conversationId)[0]!;return call('record_task_checkpoint',{...current.input,taskId:original.taskId,baseVersion:current.version,acknowledgedInputId:f.latest().id});};
    f.steps.push(update);const interrupted=await f.send('更新 Y');
    const target=f.app.store.tools(interrupted.runId)[0]!;assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.version,2);
    f.steps.push(update,text('按当前要求更新'));await f.send('重新确认 Y 当前状态');
    assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.version,3);assert.equal(f.app.store.tool(target.id).state,'unknown');
    f.steps.push(call('inspect_tool_execution',{executionId:target.id}),request=>{
      const inspected=JSON.parse(wire(request).filter(m=>m.role==='tool').at(-1)!.content).data;
      assert.equal(inspected.result.data.version,2);return text('原更新已提交，没有重放');
    });await f.send('只核验旧提交，不继续操作');
    assert.equal(f.app.store.tool(target.id).state,'succeeded');assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.version,3);
    assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.taskId,original.taskId);
  }finally{await f.close();}
});

test('原执行核验：即使已有终态回执也不能读取其他会话的执行',async()=>{
  const f=fixture();try{
    f.steps.push(call('stat_file',{mountId:f.mount.id,path:'a.txt'}),text('原会话事实'));const first=await f.send('核对原文件');
    const original=f.app.store.tools(first.runId)[0]!,other=f.app.createConversation(f.workspace);
    f.steps.push(call('inspect_tool_execution',{executionId:original.id}),text('只使用本会话事实'));
    const next=f.app.send(other.conversationId,uid(),'查看另一会话执行');await f.app.wait(next.runId);
    const denied=f.app.store.tools(next.runId)[0]!;assert.equal(denied.state,'failed');
    const result=f.app.store.readArtifact<{data:{code:string}}>(denied.result_ref!);assert.equal(result.data.code,'PERMISSION_DENIED');
    assert.equal(f.app.store.tool(original.id).result_ref,original.result_ref);
  }finally{await f.close();}
});

class WireModel extends ScriptModel {
  override prepare(...args:Parameters<ScriptModel['prepare']>) {return new DeepSeekAdapter(()=>{throw Error('禁止真实 API');}).prepare(...args);}
}
test('缓存前缀：真实 DeepSeek 请求编码跨多轮、重启完整追加；6 KiB 读取不重新缩小',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-cache-prefix-')),workspace=join(root,'source');mkdirSync(workspace);
  const source='中文🙂'+('正文及学习注释\r\n'.repeat(300));writeFileSync(join(workspace,'a.txt'),source);
  for(let i=0;i<7;i++) writeFileSync(join(workspace,`note${i}.txt`),'元数据 '+i);
  const steps:Step[]=[],model=new WireModel(steps);let app=new UmiApplication(join(root,'data'),model);
  try{
    const c=app.createConversation(workspace,{thinking:'high'}),mount=app.files.repo.mounts(c.environmentId)[0]!;
    steps.push(call('read_file',{mountId:mount.id,path:'a.txt',byteLength:64000}));
    for(let i=0;i<7;i++) steps.push(call('stat_file',{mountId:mount.id,path:`note${i}.txt`},'核对元数据',`stat-${i}`));
    steps.push(text('阶段结束'));
    const r=app.send(c.conversationId,uid(),'读后持续核验');assert.equal((await app.wait(r.runId)).status,'completed');
    for(let i=1;i<model.requests.length;i++){
      const previous=wire(model.requests[i-1]!),current=wire(model.requests[i]!);
      assert.deepEqual(current.slice(0,previous.length),previous);
      assert.deepEqual(model.requests[i]!.body.tools,model.requests[0]!.body.tools);
      const read=current.find(m=>m.role==='tool'&&m.tool_call_id==='provider-call-1');
      if(read)assert.equal(JSON.parse(read.content).data.text,source);
      assert.equal(current.find(m=>m.tool_calls?.[0]?.id==='provider-call-1')?.reasoning_content,'我先核实必要的信息。');
    }
    const carry=wire(model.requests.at(-1)!);assert((app.store.snapshot(c.conversationId).context.metrics?.cache?.carriedMessages??0)>0);
    await app.close();const reopened=new WireModel([text('重启后回应新要求')]);app=new UmiApplication(join(root,'data'),reopened);
    const next=app.send(c.conversationId,uid(),'继续解释');assert.equal((await app.wait(next.runId)).status,'completed');
    assert.deepEqual(wire(reopened.requests[0]!).slice(0,carry.length),carry);
    assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),source);
    console.log(JSON.stringify({sample:'cache-prefix',requests:model.requests.length+reopened.requests.length,readBytes:Buffer.byteLength(source),realAPI:false}));
  }finally{await app.close();removeTestRoot(root);}
});

test('缓存诊断：语言、模型和工具变化建立新视图，压力维护可释放旧派生快照',()=>{
  const manager=new ContextManager(20000,1000,{off:1000,normal:1000,high:1000});
  const settings={model:'deepseek-flash',thinking:'off',executionPolicy:'ask',uiLocale:'zh-CN',answerLocale:'zh-CN',reasoningLocale:'zh-CN'} as const;
  const facts={settings,messages:[{id:'u',applied:true,projectionSequence:'1',payload:{role:'user' as const,content:'当前要求'}}],state:{revision:1}};
  const first=manager.prepare(facts,[]);
  const next=manager.prepare({...facts,carry:first,state:{revision:2}},[]);
  assert.deepEqual(next.messages.slice(0,first.messages.length),first.messages);
  assert.deepEqual(next.metrics.cache.prefixChangeReasons,[]);
  const language=manager.prepare({...facts,carry:first,settings:{...settings,answerLocale:'en'}},[]);
  assert(language.metrics.cache.prefixChangeReasons.includes('system'));
  const thinking=manager.prepare({...facts,carry:first,settings:{...settings,thinking:'high'}},[]);
  assert(thinking.metrics.cache.prefixChangeReasons.includes('model-settings'));
  const tools=manager.prepare({...facts,carry:first},[{name:'new_tool',description:'新规格',parameters:{type:'object'}}]);
  assert(tools.metrics.cache.prefixChangeReasons.includes('tools'));
  const bloated={...first,messages:[...first.messages,...Array.from({length:80},()=>({role:'system' as const,content:'旧派生快照'.repeat(200)}))]};
  assert.throws(()=>manager.prepare({...facts,carry:bloated},[]),/预算/);
  // 窗口边界可以丢弃派生快照；用户原话完整，原始 sources 不变。
  const rebuilt=manager.prepare({...facts,carry:null},[]);
  assert(rebuilt.estimatedInputTokens<rebuilt.inputCeiling);
  assert.deepEqual(rebuilt.sources,first.sources);
});

test('缓存压力：只刷新累积派生快照不折叠原文、不请求摘要模型',async()=>{
  const f=contextFixture(0);try{
    const facts=f.facts(),baseline=f.manager.prepare(facts,[]),original=f.app.store.messages(f.c.conversationId);
    const carry={...baseline,messages:[...baseline.messages,...Array.from({length:80},()=>({role:'system' as const,content:'旧派生快照'.repeat(200)}))]};
    const model=new ScriptModel([]),result=await f.manager.prepareTurn(f.app.store,model,f.runId,f.generation,[],()=>({...f.facts(),carry}),new AbortController().signal);
    assert.equal(result.contextVersion,2);assert.equal(model.requests.length,0);
    assert.equal(f.app.store.contextMemory(f.c.conversationId).archivedIds.length,0);
    assert.deepEqual(f.app.store.messages(f.c.conversationId),original);
    assert(result.estimatedInputTokens<result.inputCeiling);
    assert(result.metrics.cache.prefixChangeReasons.includes('window'));
  }finally{await f.close();}
});

test('归档容量：UTF-8 边界溢出后只保留连续前缀，不能补入后段伪装完整',()=>{
  assert.equal(new ProcessArchiveBudget().limitBytes,PROCESS_ARCHIVE_BYTES);
  const archive=new ProcessArchiveBudget(9),first=archive.take('头🙂'),second=archive.take('尾😀');
  assert.equal(first,'头🙂');assert.equal(second,'');assert(archive.truncated);
  assert.equal(archive.take('xx'),'', '不能在缺失中文后补入 ASCII');
  assert(![first,second].join('').includes('\uFFFD'));
});

test('停止入口：32 个普通名额占满仍保留停止；释放幂等且控制容量有限',()=>{
  const gate=new RequestAdmission(),ordinary=Array.from({length:32},()=>gate.reserve());
  assert.throws(()=>gate.reserve(),/待处理/);const stop=gate.reserve(true),shutdown=gate.reserve(true);
  assert.throws(()=>gate.reserve(true),/待处理/);ordinary[0]!();ordinary[0]!();const next=gate.reserve();
  assert.throws(()=>gate.reserve(),/待处理/);next();ordinary.forEach(release=>release());stop();shutdown();gate.reserve(true)();gate.reserve()();
});

test('长日志：超过 264 KiB 完整脱敏归档，8 KiB 预览和分页范围独立，末尾关键行可追回',{timeout:40000},async()=>{
  const f=fixture();try{
    const source='开头🙂\n'+'日志正文🙂\n'.repeat(16500)+'LATE_KEY_264K_尾🙂\n';let id='',start=0,joined='',sourceHash='';
    f.steps.push(call('run_command',{program:process.execPath,argv:['-e',"process.stdout.write('开头🙂\\n'+'日志正文🙂\\n'.repeat(16500)+'LATE_KEY_264K_尾🙂\\n')"],cwd:{kind:'mount',mountId:f.mount.id},maxOutputBytes:1024,timeoutMs:10000}),request=>{
      const result=JSON.parse(wire(request).filter(m=>m.role==='tool').at(-1)!.content),view=JSON.parse(result.content);id=result.data.executionId;
      assert(view.previewTruncated);assert.equal(view.archiveComplete,true);assert(Buffer.byteLength(view.stdout)<=1024);
      return call('read_process_output',{executionId:id,channel:'stdout',startByte:start,byteLength:64000});
    });
    const page:Step=request=>{
      const data=JSON.parse(wire(request).filter(m=>m.role==='tool').at(-1)!.content).data;
      assert.equal(data.startByte,start);assert.equal(data.archiveComplete,true);assert(!data.text.includes('\uFFFD'));
      if(sourceHash)assert.equal(data.sourceHash,sourceHash);sourceHash=data.sourceHash;joined+=data.text;
      if(data.nextStartByte!==null){start=data.nextStartByte;f.steps.unshift(page);return call('read_process_output',{executionId:id,channel:'stdout',startByte:start,byteLength:64000});}
      assert.equal(joined,source);assert(joined.includes('LATE_KEY_264K'));return text('已追回完整日志');
    };f.steps.push(page);
    const r=f.app.send(f.c.conversationId,uid(),'执行隔离日志样本');
    const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0],15000);
    f.app.approve(f.c.conversationId,approval,'allow');assert.equal((await f.app.wait(r.runId)).status,'completed');
    assert.equal(f.app.commands.repo.receipt(id)!.truncated,false);assert.equal(f.app.commands.repo.receipt(id)!.stdoutBytes,Buffer.byteLength(source));
    console.log(JSON.stringify({sample:'archive-pagination',bytes:Buffer.byteLength(source),pages:Math.ceil(Buffer.byteLength(source)/64000),lateKey:true}));
  }finally{await f.close();}
});
