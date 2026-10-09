import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel,call,text,eventually,removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { ToolRegistry } from '../packages/agent/src/tools/registry.js';
import { registerRecycle } from '../packages/adapters/src/host-files/recycle.js';

test('A28：原生能力不可用时明确拒绝，不能建立 .trash 替代',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-recycle-unavailable-')),workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'file.txt'),'保留');
  const app=new UmiApplication(join(root,'data'),new ScriptModel([]));
  try{const c=app.createConversation(workspace),m=app.files.repo.mounts(c.environmentId)[0]!,registry=new ToolRegistry();registerRecycle(registry,app.files,false);
    assert.throws(()=>registry.get('recycle_file').prepare({resourceId:m.resourceId,path:'file.txt'},app.store.environment(c.environmentId)),/没有实现/);
    assert(existsSync(join(workspace,'file.txt')));assert(!existsSync(join(workspace,'.trash')));
  }finally{await app.close();removeTestRoot(root);}
});

test('A28：真实原生系统回收站及 hash 回执；不创建 .trash',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-native-recycle-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const filename=`umi-recycle-${uid()}.txt`;writeFileSync(join(workspace,filename),'仅供 Umi 原生回收站验收的临时文件');let resourceId='';
  const app=new UmiApplication(join(root,'data'),new ScriptModel([()=>call('recycle_file',{resourceId,path:filename}),text('依据回执说明'),text('结束')]));
  try {
    const c=app.createConversation(workspace);resourceId=app.files.repo.mounts(c.environmentId)[0]!.resourceId;
    const r=app.send(c.conversationId,uid(),'将专用验收文件移入系统回收站'),a=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
    assert(existsSync(join(workspace,filename)));app.approve(c.conversationId,a,'allow');await app.wait(r.runId);
    const t=app.store.tools(r.runId)[0]!,result=app.store.readArtifact<{content:string;data:unknown}>(t.result_ref!);
    assert.equal(t.state,'succeeded',JSON.stringify(result));assert(!existsSync(join(workspace,filename)));assert(!existsSync(join(workspace,'.trash')));
    assert((result.data as {receipt:{contentHash:string}}).receipt.contentHash);
  }finally{await app.close();removeTestRoot(root);}
});
