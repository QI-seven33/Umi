import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,eventually,removeTestRoot,type Step} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {taskCommandCandidate} from '../packages/agent/src/tools/command-permission.js';
import type {ExecutionContext} from '../packages/protocol/src/model.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';

function fixture(boundary?:NonNullable<ConstructorParameters<typeof UmiApplication>[2]>['processBoundary']){
 const root=mkdtempSync(join(tmpdir(),'umi-command-permission-')),source=join(root,'source'),data=join(root,'data');mkdirSync(source);
 const script="require('node:fs').appendFileSync('effects.txt','A')";
 writeFileSync(join(source,'probe.cjs'),script);writeFileSync(join(source,'other.cjs'),script);
 const steps:Step[]=[],model=new ScriptModel(steps);let app=new UmiApplication(data,model,boundary?{processBoundary:boundary}:{});
 const c=app.createConversation(source,{executionPolicy:'auto'}),m=app.files.repo.direct.mounts(c.environmentId)[0]!;
 const args={program:process.execPath,argv:['--test','probe.cjs'],cwd:{kind:'mount' as const,mountId:m.id},timeoutMs:15000};
 return {root,source,data,c,m,args,steps,get app(){return app;},start(){return app.send(c.conversationId,uid(),'运行本任务测试');},
  pending(){return eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending'),12000);},
  async restart(){await app.close();app=new UmiApplication(data,model);},
  async close(){await app.close();removeTestRoot(root);}};
}

test('自动模式：首命令具体批准，本任务复用有来源与新执行身份；项目代码变化后执行当前代码',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),()=>{writeFileSync(join(f.source,'probe.cjs'),"require('node:fs').appendFileSync('effects.txt','B')");return call('run_command',f.args);},text('测试完成'));
  const r=f.start(),approval=await f.pending();assert(approval[1].canReuseCommand);f.app.approve(f.c.conversationId,approval[0],'allow','task');await f.app.wait(r.runId);
  assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'AB');
  const tools=f.app.store.tools(r.runId);assert.equal(tools.length,2);assert.notEqual(tools[0]!.id,tools[1]!.id);
  const decisions=Object.values(f.app.store.snapshot(f.c.conversationId).approvals);assert.equal(decisions.filter(a=>a.decisionSource==='user').length,1);
  assert.equal(decisions.filter(a=>a.decisionSource==='task-grant'&&a.sourceApprovalId===approval[0]).length,1);
  const events=f.app.store.events(f.c.conversationId).filter(e=>e.type==='approval.decided');
  assert.equal(events.find(e=>e.type==='approval.decided'&&e.payload.decisionSource==='user')?.producer,'user');
  assert.equal(events.find(e=>e.type==='approval.decided'&&e.payload.decisionSource==='task-grant')?.producer,'system');
  assert.equal(f.app.store.all("SELECT id FROM artifacts WHERE kind='command-task-grant'").length,1);
  assert.equal(f.app.store.all("SELECT id FROM artifacts WHERE kind='command-task-reuse'").length,1);
 }finally{await f.close();}
});

test('自动模式：允许本次不会升级；参数变化、新run均再次询问',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),call('run_command',f.args),text('遵从拒绝'));
  let r=f.start(),a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow');
  assert.throws(()=>f.app.approve(f.c.conversationId,a[0],'allow','task'),/范围已提交/);
  a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
  f.steps.push(call('run_command',f.args),call('run_command',{...f.args,argv:['--test','other.cjs']}),text('结束'));
  r=f.start();a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'AA');
  f.steps.push(call('run_command',f.args),text('新任务拒绝'));r=f.start();a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'AA');
 }finally{await f.close();}
});

test('自动模式：切回询问再开启不会复活旧任务许可',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),()=>{const old=f.app.store.settings(f.c.conversationId);f.app.store.updateSettings(f.c.conversationId,{...old,executionPolicy:'ask'});f.app.store.updateSettings(f.c.conversationId,old);return call('run_command',f.args);},text('已停止重复'));
  const r=f.start();let a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
 }finally{await f.close();}
});

test('自动模式：复用命令已经派发但尚未释放时，模式撤销仍阻止原生程序运行',{timeout:30000},async()=>{
 let f:ReturnType<typeof fixture>,ready=0;
 f=fixture((point)=>{if(point==='ready'&&++ready===2){f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),executionPolicy:'ask'});}});
 try{
  f.steps.push(call('run_command',f.args),call('run_command',f.args),text('按实际退出说明'));
  const r=f.start(),a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');await f.app.wait(r.runId);
  assert.equal(ready,2);assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
  assert.notEqual(f.app.store.tools(r.runId)[1]!.state,'succeeded');
  assert.equal(f.app.store.tools(r.runId)[1]!.state,'unknown');
  f.app.resume(f.c.conversationId,r.runId);await f.app.wait(r.runId);
  const receipt=f.app.commands.repo.receipt(f.app.store.tools(r.runId)[1]!.id);assert.equal(receipt?.gateReleased,false);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
 }finally{await f.close();}
});

test('自动模式：新用户要求使原任务许可失效，新输入先应用再询问',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),()=>{f.app.send(f.c.conversationId,uid(),'现在换一个要求，先别复用旧许可');return call('run_command',f.args);},call('run_command',f.args),text('遵从新要求'));
  const r=f.start();let a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
 }finally{await f.close();}
});

test('自动模式：停止和重启保留历史但不恢复旧任务许可',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),call('ask_user_question',{questions:[{id:'next',prompt:'等待下一步',options:[{label:'继续'},{label:'停止'}]}]}),call('run_command',f.args),text('重启后尊重决定'));
  const r=f.start(),a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');
  await eventually(()=>Object.values(f.app.store.snapshot(f.c.conversationId).questions??{}).some(q=>q.status==='pending')||undefined,12000);
  await f.app.stop(f.c.conversationId,r.runId);await f.restart();f.app.resume(f.c.conversationId,r.runId);
  const fresh=await f.pending();f.app.approve(f.c.conversationId,fresh[0],'deny');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
  assert.equal(f.app.store.all("SELECT id FROM artifacts WHERE kind='command-task-grant'").length,1);
 }finally{await f.close();}
});

test('自动模式：高危、复合、任意代码与安装声明不能伪造成可复用开发命令',()=>{
 const p={mode:'cmd',script:'npm test',cwdRef:{kind:'mount'},stdin:''} as ExecutionContext['process'];
 const ctx={process:p} as ExecutionContext;
 assert(taskCommandCandidate('run_shell',ctx));
 for(const script of ['npm install','npm publish','npm run deploy','npm test && del a.txt','npm test | more','npm test > output.txt','npm test\\nwhoami','npx test','npm test -- --upload','npm run test:deploy'])assert(!taskCommandCandidate('run_shell',{...ctx,process:{...p!,script}}),script);
 assert(!taskCommandCandidate('run_shell',{...ctx,process:{...p!,preparation:{network:'may-access'} as any}}));
 assert(!taskCommandCandidate('run_command',{...ctx,process:{...p!,mode:'direct',program:'node.exe',argv:['-e',"require('fs').rmSync('a')"]}}));
 assert(!desktopCommandSchema.safeParse({type:'approve',conversationId:'c',approvalId:'a',decision:'allow',scope:'everything'}).success);
});

test('自动模式：不能用用户管理API把不支持的高危操作升级为任务许可',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_shell',{shell:'cmd',script:'echo risk',cwd:f.args.cwd}),text('遵从拒绝'));
  const r=f.start(),a=await f.pending();assert(!a[1].canReuseCommand);assert.throws(()=>f.app.approve(f.c.conversationId,a[0],'allow','task'),/不能授予/);
  assert.equal(f.app.store.approval(a[0]).decision,null);assert(!existsSync(join(f.source,'effects.txt')));
  f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
 }finally{await f.close();}
});

test('自动模式：拒绝后添加默认参数外壳也不能重新请求同一命令',{timeout:30000},async()=>{
 const f=fixture();try{
  f.steps.push(call('run_command',f.args),call('run_command',{...f.args,env:{}}),text('遵从拒绝'));
  const r=f.start(),a=await f.pending();f.app.approve(f.c.conversationId,a[0],'deny');await f.app.wait(r.runId);
  assert.equal(f.app.store.all('SELECT * FROM approval_requests').length,1);
  assert(!existsSync(join(f.source,'effects.txt')));
  const tools=f.app.store.tools(r.runId);assert.equal(tools[1]!.state,'failed');
  assert.match(f.app.store.readArtifact<{content:string}>(tools[1]!.result_ref!).content,/已被拒绝/);
 }finally{await f.close();}
});

test('自动模式：保存复用来源失败时，不决定allow也不派发第二次命令',{timeout:30000},async()=>{
 const f=fixture();try{
  f.app.store.db.exec("CREATE TRIGGER fail_task_permission BEFORE INSERT ON artifacts WHEN NEW.kind='command-task-reuse' BEGIN SELECT RAISE(ABORT,'permission-record-failed');END;");
  f.steps.push(call('run_command',f.args),call('run_command',f.args),text('未执行第二次'));
  const r=f.start(),a=await f.pending();f.app.approve(f.c.conversationId,a[0],'allow','task');await f.app.wait(r.runId);
  assert.equal(readFileSync(join(f.source,'effects.txt'),'utf8'),'A');
  const tools=f.app.store.tools(r.runId);assert.equal(tools[1]!.state,'prepared');assert(tools[1]!.approval_id);
  assert.equal(f.app.store.approval(tools[1]!.approval_id!).decision,null);
  assert.equal(f.app.store.all("SELECT * FROM artifacts WHERE kind='command-task-reuse'").length,0);
  assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.code,'PERSISTENCE_FAILED');
 }finally{await f.close();}
});
