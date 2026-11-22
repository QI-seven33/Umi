import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { createDirectoryAccessObserver } from '../packages/adapters/src/host-files/directory-access.js';
import { rootIdentity, fileIdentity } from '../packages/adapters/src/host-files/paths.js';
import { ScriptModel, text, removeTestRoot } from './fixtures.js';
import type { DirectoryAccessView } from '../packages/protocol/src/resources.js';
import { uid } from '../packages/agent/src/identity.js';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'umi-access-status-')),workspace=join(root,'workspace'),external=join(root,'external');
 mkdirSync(workspace);mkdirSync(external);writeFileSync(join(external,'key.txt'),'test-only');
 const model=new ScriptModel([text('收到')]),app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace);
 return {root,workspace,external,model,app,c,grant(file=false){
  const path=file?join(external,'key.txt'):external;
  const stat=statSync(path,{bigint:true});
  const scope=file?{kind:'file' as const,path:'key.txt',identity:fileIdentity(path),rootIdentity:rootIdentity(external),size:Number(stat.size),modifiedNs:String(stat.mtimeNs),changedNs:String(stat.ctimeNs)}:{kind:'directory' as const};
  const candidate=app.files.repo.candidate(c.environmentId,path,rootIdentity(external),false,scope);
  return app.files.direct.grant(candidate,'read','isolated-test-selection');
 },async close(){await app.close();removeTestRoot(root);}};
}

test('项目授权跨会话复用，但模型只获得当前存在且根身份一致的目录',async()=>{
 const f=fixture();try{
  const mount=f.grant(),other=f.app.createConversation(f.workspace);
  const before=f.app.store.events(f.c.conversationId).length;
  assert(f.app.store.directoryAccess(other.environmentId,true).some(g=>g.id===mount.direct!.grantId&&g.status==='available'));
  renameSync(f.external,f.external+'-moved');
  const rows=f.app.store.directoryAccess(f.c.environmentId,true);
  assert.equal(rows.find(g=>g.id===mount.direct!.grantId)!.status,'missing');
  assert.equal(rows.find(g=>g.id===mount.direct!.grantId)!.revoked,false);
  const facts=f.app.store.runtimeFacts(other.environmentId) as any;
  assert(!facts.mounts.some((m:any)=>m.grantId===mount.direct!.grantId));
  assert(!facts.directAccess.grants.some((g:any)=>g.id===mount.direct!.grantId));
  assert.equal(f.app.store.events(f.c.conversationId).length,before);
  const run=f.app.send(other.conversationId,uid(),'你好');await f.app.wait(run.runId);
  const messages=f.model.requests[0]!.body.messages as any[];
  const domain=messages.find(m=>m.role==='system'&&m.content.includes('runtime.resources'));
  assert(domain);assert(domain.content.includes('missing'));
  assert.equal(readFileSync(join(f.external+'-moved','key.txt'),'utf8'),'test-only');
 }finally{await f.close();}
});

test('单文件授权显示实际文件路径，文件移除后退出当前可用挂载，历史事实保留',async()=>{
 const f=fixture();try{
  const mount=f.grant(true),service=new DesktopService(f.app);
  const query=()=>service.handle({type:'list_directory_access',conversationId:f.c.conversationId}) as Promise<DirectoryAccessView[]>;
  let rows=await query();assert.equal(rows.find(g=>g.id===mount.direct!.grantId)!.path,join(f.external,'key.txt'));
  unlinkSync(join(f.external,'key.txt'));rows=await query();
  assert.equal(rows.find(g=>g.id===mount.direct!.grantId)!.status,'missing');
  assert.throws(()=>f.app.previewFile(f.c.conversationId,mount.id,'key.txt'));
  assert(f.app.files.repo.direct.grant(mount.direct!.grantId,f.c.environmentId));
 }finally{await f.close();}
});

test('同名新目录不继承旧对象授权；原目录移回时只恢复原身份的可用状态',async()=>{
 const f=fixture();try{
  const mount=f.grant(),saved=f.external+'-saved';renameSync(f.external,saved);mkdirSync(f.external);writeFileSync(join(f.external,'key.txt'),'replacement');
  assert.equal(f.app.store.directoryAccess(f.c.environmentId,true).find(g=>g.id===mount.direct!.grantId)!.status,'changed');
  assert.throws(()=>f.app.previewFile(f.c.conversationId,mount.id,'key.txt'));
  unlinkSync(join(f.external,'key.txt'));rmdirSync(f.external);renameSync(saved,f.external);
  assert.equal(f.app.store.directoryAccess(f.c.environmentId,true).find(g=>g.id===mount.direct!.grantId)!.status,'available');
  assert.equal(f.app.previewFile(f.c.conversationId,mount.id,'key.txt').text,'test-only');
 }finally{await f.close();}
});

test('撤销即时改变所有会话可用事实，刷新不能恢复旧授权，完整记录仍能核对',async()=>{
 const f=fixture();try{
  const mount=f.grant(),other=f.app.createConversation(f.workspace);
  f.app.revokeDirectoryAccess(f.c.conversationId,mount.direct!.grantId);
  assert.equal(f.app.store.directoryAccess(other.environmentId,true).find(g=>g.id===mount.direct!.grantId)!.status,'revoked');
  const facts=f.app.store.runtimeFacts(other.environmentId) as any;
  assert(!facts.directAccess.grants.some((g:any)=>g.id===mount.direct!.grantId));
  assert(facts.directAccess.unavailableGrants.some((g:any)=>g.id===mount.direct!.grantId&&g.status==='revoked'));
  assert.equal(f.app.files.repo.direct.grant(mount.direct!.grantId,other.environmentId).revoked,1);
 }finally{await f.close();}
});

test('元数据短缓存不会授予文件读取，强制刷新和到期后均反映路径消失',async()=>{
 const f=fixture();try{
  const mount=f.grant(true);let now=0;const observe=createDirectoryAccessObserver(()=>now);
  const probe={root:mount.root,rootIdentity:mount.rootIdentity,scope:mount.scope};
  assert.equal(observe(probe),'available');unlinkSync(join(f.external,'key.txt'));
  assert.equal(observe(probe),'available');
  assert.throws(()=>f.app.previewFile(f.c.conversationId,mount.id,'key.txt'));
  now=1001;assert.equal(observe(probe),'missing');
  writeFileSync(join(f.external,'key.txt'),'new bytes');assert.equal(observe(probe),'missing');
  assert.equal(observe(probe,true),'available');
 }finally{await f.close();}
});
