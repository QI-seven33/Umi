import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,eventually,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {UmiError} from '../packages/protocol/src/model.js';
import type {DocumentTarget} from '../packages/protocol/src/native-open.js';
import {verifiedDocumentPath} from '../packages/adapters/src/host-files/delivered-open.js';

function fixture(openError?:boolean){
 const root=mkdtempSync(join(tmpdir(),'umi-direct-open-')),workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'index.html'),'<title>实际文档</title>');writeFileSync(join(workspace,'fake.exe'),'不可执行的测试文本');
 const steps:ConstructorParameters<typeof ScriptModel>[0]=[],opened:DocumentTarget[]=[];
 const app=new UmiApplication(join(root,'data'),new ScriptModel(steps),{openDocument:async target=>{verifiedDocumentPath(target);opened.push(target);if(openError)throw new Error('模拟接收后回执丢失');}});
 const c=app.createConversation(workspace,{executionPolicy:'auto'}),mount=app.files.repo.mounts(c.environmentId)[0]!;
 const pending=()=>eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
 const send=()=>{steps.push(call('open_file',{mountId:mount.id,path:'index.html'}),text('系统已接收打开请求，未验证页面交互。'));return app.send(c.conversationId,uid(),'请打开这个页面');};
 return {root,workspace,steps,opened,app,c,mount,pending,send,async close(){await app.close();removeTestRoot(root);}};
}
test('直改打开走具体批准及唯一Agent事实链，不产生命令进程；下一次打开仍独立批准',async()=>{
 const f=fixture();try{
  const run=f.send(),approval=await f.pending();assert.equal(f.opened.length,0);assert.equal(f.app.store.all('SELECT * FROM process_executions').length,0);
  f.app.approve(f.c.conversationId,approval,'allow');await f.app.wait(run.runId);
  assert.equal(f.opened.length,1);assert.equal(readFileSync(verifiedDocumentPath(f.opened[0]!),'utf8'),'<title>实际文档</title>');
  assert.equal(f.app.store.tools(run.runId)[0]!.state,'succeeded');assert.equal(f.app.store.all('SELECT * FROM process_executions').length,0);
  const execution=f.app.store.tools(run.runId)[0]!;assert(execution.approval_id);assert(execution.context_ref);assert(execution.result_ref);
  const next=f.send(),nextApproval=await f.pending();assert.notEqual(nextApproval,approval);assert.equal(f.opened.length,1);
  f.app.approve(f.c.conversationId,nextApproval,'deny');await f.app.wait(next.runId);assert.equal(f.opened.length,1);
 }finally{await f.close();}
});
for(const change of ['file','grant'] as const)test(`打开前${change==='file'?'文件变化':'授权撤销'}拒绝调用系统`,async()=>{
 const f=fixture();try{
  const run=f.send(),approval=await f.pending();
  if(change==='file')writeFileSync(join(f.workspace,'index.html'),'外部新版本');else f.app.revokeDirectoryAccess(f.c.conversationId,f.mount.direct!.grantId);
  if(change==='file'){
   f.app.approve(f.c.conversationId,approval,'allow');
   const boundary=await eventually(()=>{
    const fresh=Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([id,a])=>id!==approval&&a.status==='pending')?.[0];
    if(fresh)return fresh;
    return ['completed','failed','stopped','interrupted','recovery_required'].includes(f.app.store.getRun(run.runId).status)?'settled':undefined;
   });
   assert.equal(f.opened.length,0);if(boundary!=='settled')f.app.approve(f.c.conversationId,boundary,'deny');
  }
  await f.app.wait(run.runId);assert.equal(f.opened.length,0);assert.notEqual(f.app.store.tools(run.runId)[0]!.state,'succeeded');
 }finally{await f.close();}
});
test('文档打开不能变成程序/URL/argv入口；不确定回执保持unknown且冷启动不重放',async()=>{
 const f=fixture(true);try{
  const tool=f.app.registry.get('open_file');assert.throws(()=>tool.schema.parse({mountId:f.mount.id,path:'index.html',argv:['--new-window']}));
  assert.throws(()=>tool.prepare({mountId:f.mount.id,path:'fake.exe'},f.app.store.environment(f.c.environmentId)));
  assert.throws(()=>tool.schema.parse({mountId:f.mount.id,path:'https://example.com'}));
  const run=f.send();f.app.approve(f.c.conversationId,await f.pending(),'allow');await f.app.wait(run.runId);
  assert.equal(f.opened.length,1);assert.equal(f.app.store.tools(run.runId)[0]!.state,'unknown');
  await f.app.close();
  const again=new UmiApplication(join(f.root,'data'),new ScriptModel([]),{openDocument:async()=>{throw new Error('不应重放');}});
  try{assert.equal(again.store.tools(run.runId)[0]!.state,'unknown');assert.equal(f.opened.length,1);}finally{await again.close();}
 }finally{await f.close();}
});
