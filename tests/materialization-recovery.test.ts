import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { ScriptModel,text,call,eventually,removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';

for(const mode of ['partial','complete']) {
  test(`A23/A36/A45：物化实际进程退出 ${mode}，按原计划核验而非重新复制`,{timeout:15000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'umi-materialization-crash-')),workspace=join(root,'workspace'),external=join(root,'external'),data=join(root,'data');mkdirSync(workspace);mkdirSync(external);
    writeFileSync(join(external,'a.txt'),'甲');writeFileSync(join(external,'b.txt'),'乙');
    const child=fork(new URL('./materialization-crash-worker.js',import.meta.url),[data,workspace,mode],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',b=>{errors+=String(b);});let app:UmiApplication|undefined;
    try{const [code]=await once(child,'exit');assert.equal(code,137,errors);const cp=JSON.parse(readFileSync(join(data,'checkpoint.json'),'utf8')) as {conversationId:string;environmentId:string;runId:string;executionId:string};
      const model=new ScriptModel([text('按恢复核验结果说明'),text('结束')]);app=new UmiApplication(data,model);assert.equal(app.store.tool(cp.executionId).state,'unknown');
      const ctx=executionContextSchema.parse(app.store.readArtifact(app.store.tool(cp.executionId).context_ref!)),location=ctx.locations.find(l=>l.rootRef.kind==='mount')!;assert.equal(location.rootRef.kind,'mount');
      app.resume(cp.conversationId,cp.runId);assert.equal((await app.wait(cp.runId)).status,'completed');assert.equal(app.store.tool(cp.executionId).state,mode==='complete'?'succeeded':'failed');
      assert.equal(app.files.repo.mounts(cp.environmentId).length,mode==='complete'?2:1);assert.equal(readFileSync(join(external,'a.txt'),'utf8'),'甲');assert.equal(readFileSync(join(location.physicalRoot!,'a.txt'),'utf8'),'甲');
      assert.equal(app.store.events(cp.conversationId).filter(e=>e.type==='tool.dispatch_intent'&&e.executionId===cp.executionId).length,1);
      const m=Object.values(app.store.snapshot(cp.conversationId).materializations).find(m=>m.resourceId!==app!.files.repo.mounts(cp.environmentId)[0]!.resourceId)!;assert.equal(m.status,mode==='complete'?'ready':'failed');
    }finally{if(child.exitCode===null&&!child.killed){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await app?.close();removeTestRoot(root);}
  });
}

test('A36：物化开始后停止，保留定位并显式恢复核验，不重做复制',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-materialization-stop-')),workspace=join(root,'workspace'),external=join(root,'external');mkdirSync(workspace);mkdirSync(external);writeFileSync(join(external,'a.txt'),'原资料');
  const model=new ScriptModel([call('discover_resource',{path:external}),r=>{
    const messages=r.body.messages as {role:string;content:string}[],data=JSON.parse(messages.filter(m=>m.role==='tool').at(-1)!.content).data;
    return call('request_resource',{candidateId:data.candidates[0].id,access:'edit',purpose:'停止边界验收'});
  },text('说明中断核验'),text('结束')]),app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace);let runId='',stopping:Promise<void>|undefined;
  try{
    const bind=app.files.repo.bindMaterializationRoot.bind(app.files.repo);app.files.repo.bindMaterializationRoot=(id,env,identity)=>{bind(id,env,identity);stopping=app.stop(c.conversationId,runId);};
    runId=app.send(c.conversationId,uid(),'读取外部').runId;const a=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);app.approve(c.conversationId,a,'allow');
    assert.equal((await app.wait(runId)).status,'stopped');await stopping;assert.equal(model.requests.length,2);
    const t=app.store.tools(runId).find(t=>t.name==='request_resource')!;assert.equal(t.state,'unknown');const ctx=executionContextSchema.parse(app.store.readArtifact(t.context_ref!)),location=ctx.locations.find(l=>l.rootRef.kind==='mount')!;
    assert(!existsSync(join(location.physicalRoot!,'a.txt')));app.resume(c.conversationId,runId);assert.equal((await app.wait(runId)).status,'completed');assert.equal(app.store.tool(t.id).state,'failed');assert(!existsSync(join(location.physicalRoot!,'a.txt')));assert.equal(readFileSync(join(external,'a.txt'),'utf8'),'原资料');
    assert.equal(app.store.events(c.conversationId).filter(e=>e.type==='tool.dispatch_intent'&&e.executionId===t.id).length,1);
  }finally{await app.close();removeTestRoot(root);}
});
