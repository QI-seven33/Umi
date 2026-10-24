import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {rootIdentity} from '../packages/adapters/src/host-files/paths.js';

test('宽目录授权不能经回收站申请操作Umi数据库或应用控制文件',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-boundary-')),data=join(root,'data'),control=join(root,'control');mkdirSync(control);writeFileSync(join(control,'config.json'),'用户控制配置');
 const app=new UmiApplication(data,new ScriptModel([]),{protectedFileRoots:[control]});
 try{
  const c=app.createConversation(root),m=app.files.repo.direct.mounts(c.environmentId)[0]!,env=app.store.environment(c.environmentId);
  for(const path of ['data/umi.sqlite','control/config.json']){
   assert.throws(()=>app.registry.get('read_file').prepare({mountId:m.id,path},env),/控制数据/);
   assert.throws(()=>app.registry.get('recycle_file').prepare({resourceId:m.resourceId,path},env),/控制数据/);
  }
  assert(existsSync(join(data,'umi.sqlite')));assert.equal(readFileSync(join(control,'config.json'),'utf8'),'用户控制配置');
  assert.equal(app.store.all('SELECT * FROM approval_requests').length,0);
 }finally{await app.close();removeTestRoot(root);}
});

test('回收站准备后撤销目录许可，执行入口在原生调用前拒绝且文件保留',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-recycle-revoke-')),source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'keep.txt'),'保留');
 const app=new UmiApplication(join(root,'data'),new ScriptModel([]));
 try{
  const c=app.createConversation(source),m=app.files.repo.direct.mounts(c.environmentId)[0]!,a={resourceId:m.resourceId,path:'keep.txt'},tool=app.registry.get('recycle_file');
  const ctx=tool.prepare(a,app.store.environment(c.environmentId));
  app.revokeDirectoryAccess(c.conversationId,m.direct!.grantId);
  await assert.rejects(tool.execute(a,ctx,c.conversationId,new AbortController().signal),/撤销/);
  assert.equal(readFileSync(join(source,'keep.txt'),'utf8'),'保留');
 }finally{await app.close();removeTestRoot(root);}
});

test('选择后目录被替换导致新建失败，重启也不得把新会话降为旧物化入口',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-create-race-')),source=join(root,'source'),saved=join(root,'original-source'),data=join(root,'data');mkdirSync(source);writeFileSync(join(source,'keep.txt'),'原选择内容');
 let app=new UmiApplication(data,new ScriptModel([]));
 try{
  const selectedIdentity=rootIdentity(source);
  app.store.db.function('audit_rotate_source',()=>{renameSync(source,saved);mkdirSync(source);writeFileSync(join(source,'replacement.txt'),'未授权替换对象');return 1;});
  app.store.db.exec('CREATE TRIGGER rotate_selected_source AFTER INSERT ON conversations BEGIN SELECT audit_rotate_source();END;');
  assert.throws(()=>app.createConversation(source,{},selectedIdentity),/身份/);
  app.store.db.exec('DROP TRIGGER rotate_selected_source');
  const c=app.store.get('SELECT id,environment_id FROM conversations')!;
  assert(app.files.repo.direct.enabled(String(c.environment_id)));
  await app.close();app=new UmiApplication(data,new ScriptModel([]));
  app.files.initialize(String(c.environment_id));
  assert.equal(app.files.repo.mounts(String(c.environment_id)).length,0);
  assert.equal(app.store.all('SELECT * FROM materializations').length,0);
  assert.equal(readFileSync(join(saved,'keep.txt'),'utf8'),'原选择内容');
  assert.equal(readFileSync(join(source,'replacement.txt'),'utf8'),'未授权替换对象');
 }finally{await app.close();removeTestRoot(root);}
});

test('授权落库失败保留无权限直改草稿，恢复初始化不扫描复制来源',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-create-failure-')),source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'keep.txt'),'原文');
 const app=new UmiApplication(join(root,'data'),new ScriptModel([]));
 try{
  app.store.db.exec("CREATE TRIGGER reject_initial_grant BEFORE INSERT ON workspace_file_grants BEGIN SELECT RAISE(ABORT,'grant-storage-failed');END;");
  assert.throws(()=>app.createConversation(source),/grant-storage-failed/);app.store.db.exec('DROP TRIGGER reject_initial_grant');
  const c=app.store.get('SELECT id,environment_id FROM conversations')!;app.files.initialize(String(c.environment_id));
  assert(app.files.repo.direct.enabled(String(c.environment_id)));assert.equal(app.files.repo.mounts(String(c.environment_id)).length,0);
  assert.equal(app.store.all('SELECT * FROM materializations').length,0);assert.equal(readFileSync(join(source,'keep.txt'),'utf8'),'原文');
 }finally{await app.close();removeTestRoot(root);}
});

test('直改发现结果指向当前可用授权工具，独立导出也拒绝应用控制目录',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-contract-')),source=join(root,'source'),control=join(root,'control');mkdirSync(source);mkdirSync(control);writeFileSync(join(source,'a.txt'),'用于发现');
 const app=new UmiApplication(join(root,'data'),new ScriptModel([call('create_output',{name:'result.txt',mime:'text/plain',content:'独立成果'}),text('已生成')]),{protectedFileRoots:[control]});
 try{
  const c=app.createConversation(source),env=app.store.environment(c.environmentId);
  const discovery=app.files.discover(env,'a',undefined,{root:source});assert(discovery.notice?.includes('request_directory_access'));assert(!discovery.notice?.includes('request_resource'));
  const r=app.send(c.conversationId,uid(),'创建独立成果');await app.wait(r.runId);const output=app.store.tools(r.runId).find(t=>t.name==='create_output')!;assert.equal(output.state,'succeeded');
  assert.throws(()=>app.outputs.prepareExport({items:[{outputId:output.id,target:join(control,'new-config.json')}]},app.store.environment(c.environmentId),'test-export'),/控制数据/);
  assert(!existsSync(join(control,'new-config.json')));
 }finally{await app.close();removeTestRoot(root);}
});
