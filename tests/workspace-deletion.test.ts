import {ProviderChunkArchive} from '../packages/adapters/src/deepseek/chunk-archive.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {ConversationDeletion} from '../packages/adapters/src/sqlite/conversation-deletion.js';
import {observe} from '../packages/adapters/src/host-files/paths.js';
import {ScriptModel,text,call,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'umi-workspace-delete-')),workspace=join(root,'workspace'),other=join(root,'other'),data=join(root,'data');
 mkdirSync(workspace);mkdirSync(other);writeFileSync(join(workspace,'source.txt'),'原始源文件');writeFileSync(join(other,'keep.txt'),'其他工作区');
 const steps:ConstructorParameters<typeof ScriptModel>[0]=[],model=new ScriptModel(steps),app=new UmiApplication(data,model),c=app.createConversation(workspace),second=app.createConversation(workspace),kept=app.createConversation(other);
 return {root,workspace,other,data,steps,app,c,second,kept,service:new DesktopService(app),async close(){await app.close();removeTestRoot(root);}};
}

test('删除工作区：一次确认删除全部会话、草稿与授权，保留修改后的真实源文件和其他工作区',async()=>{
 const f=fixture();try{
  const m=f.app.files.repo.direct.mounts(f.c.environmentId)[0]!;
  f.steps.push(call('read_file',{mountId:m.id,path:'source.txt'}),call('edit_file',{mountId:m.id,path:'source.txt',oldText:'原始',newText:'已改'}),text('完成'));
  const r=f.app.send(f.c.conversationId,uid(),'修改');await f.app.wait(r.runId);f.app.store.editConversation(f.c.conversationId,null,true);
  const kept=f.service.snapshot(f.kept.conversationId),count=f.app.store.all('SELECT id FROM artifacts').length;
  const result=await f.service.handle(desktopCommandSchema.parse({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true})) as {conversationIds:string[];cleanupPending:boolean};
  assert.deepEqual(result.conversationIds,[f.c.conversationId,f.second.conversationId]);assert.equal(result.cleanupPending,false);
  assert.equal(readFileSync(join(f.workspace,'source.txt'),'utf8'),'已改源文件');assert.equal(readFileSync(join(f.other,'keep.txt'),'utf8'),'其他工作区');
  assert(!existsSync(join(f.data,'environments',f.c.environmentId)));assert(!existsSync(join(f.data,'environments',f.second.environmentId)));
  assert(!f.app.store.get('SELECT id FROM workspaces WHERE id=?',f.c.workspaceId));assert.equal(f.app.store.all('SELECT id FROM workspace_file_grants WHERE workspace_id=?',f.c.workspaceId).length,0);
  assert.equal(f.app.store.all('SELECT id FROM file_changes').length,0);assert(f.app.store.all('SELECT id FROM artifacts').length<count);assert.deepEqual(f.service.snapshot(f.kept.conversationId),kept);assert.deepEqual(f.app.store.all('PRAGMA foreign_key_check'),[]);
  assert(!desktopCommandSchema.safeParse({type:'delete_workspace',workspaceId:f.kept.workspaceId}).success);
  assert(!desktopCommandSchema.safeParse({type:'delete_workspace',workspaceId:f.kept.workspaceId,confirm:false}).success);
  assert(!desktopCommandSchema.safeParse({type:'delete_workspace',workspaceId:f.kept.workspaceId,confirm:true,path:f.other}).success);
 }finally{await f.close();}
});

test('删除工作区：任一会话活动或未决文件效果都拒绝，前面的会话和恢复证据完整保留',async()=>{
 const f=fixture();try{
  f.steps.push(text('完成'));const r=f.app.send(f.second.conversationId,uid(),'活动任务');
  await assert.rejects(f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true}),/活动|停止/);await f.app.wait(r.runId);
  const m=f.app.files.repo.direct.mounts(f.second.environmentId)[0]!,before=observe(m.root,'source.txt',m.rootIdentity),bytes=readFileSync(join(f.workspace,'source.txt'));
  const change=f.app.files.repo.direct.intent(m,'source.txt',before,bytes,Buffer.from('未知结果'));
  await assert.rejects(f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true}),/未知副作用/);
  assert(f.app.store.conversation(f.c.conversationId));assert(f.app.store.conversation(f.second.conversationId));assert.equal(f.app.store.get('SELECT state FROM file_changes WHERE id=?',change)!.state,'intent');
  assert(existsSync(join(f.data,'environments',f.c.environmentId)));assert.equal(f.app.store.all('SELECT * FROM conversation_deletions').length,0);
  f.app.store.editConversation(f.second.conversationId,null,true);
  assert.throws(()=>f.app.deleteArchivedConversation(f.second.conversationId),/未知副作用/);
  assert.equal(f.app.files.direct.inspect(f.second.conversationId,change).state,'not_applied');
  await f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true});
 }finally{await f.close();}
});

test('删除工作区：中途数据库错误回滚整组会话，提交之前不清理任何目录',async()=>{
 const f=fixture();try{
  const before=f.service.snapshot(f.c.conversationId);
  f.app.store.db.exec("CREATE TRIGGER fail_workspace_delete BEFORE DELETE ON conversations WHEN OLD.id='"+f.second.conversationId+"' BEGIN SELECT RAISE(ABORT,'test-workspace-delete-failed'); END;");
  await assert.rejects(f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true}),/test-workspace-delete-failed/);
  assert.deepEqual(f.service.snapshot(f.c.conversationId),before);assert(f.app.store.conversation(f.second.conversationId));assert.equal(f.app.store.all('SELECT * FROM conversation_deletions').length,0);
  assert(existsSync(join(f.data,'environments',f.c.environmentId)));assert(existsSync(join(f.data,'environments',f.second.environmentId)));assert(f.app.store.all('SELECT id FROM workspace_file_grants WHERE workspace_id=?',f.c.workspaceId).length);
  assert.deepEqual(f.app.store.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});

test('删除工作区：托管目录清理失败如实保留重试项，重启只重试原托管位置',async()=>{
 const f=fixture();let reopened:UmiApplication|undefined,closed=false;try{
  const result=new ConversationDeletion(f.app.store,()=>{throw Object.assign(Error('occupied'),{code:'EACCES'});}).deleteWorkspace(f.c.workspaceId);
  assert(result.cleanupPending);assert.equal(f.app.store.all('SELECT * FROM conversation_deletions').length,2);assert.equal(readFileSync(join(f.workspace,'source.txt'),'utf8'),'原始源文件');
  await f.app.close();closed=true;reopened=new UmiApplication(f.data,new ScriptModel([]));assert.equal(reopened.store.all('SELECT * FROM conversation_deletions').length,0);
  assert(!existsSync(join(f.data,'environments',f.c.environmentId)));assert.equal(readFileSync(join(f.workspace,'source.txt'),'utf8'),'原始源文件');assert(reopened.store.conversation(f.kept.conversationId));
 }finally{if(reopened)await reopened.close();if(!closed)await f.app.close();removeTestRoot(f.root);}
});

test('删除完成凭据：丢失响应后可只读查询，重复删除和重启返回同一事实；不扩大IPC字段',async()=>{
 const f=fixture();let reopened:UmiApplication|undefined,closed=false;try{
  const result=await f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true}) as any;
  assert.deepEqual(await f.service.handle({type:'workspace_deletion_status',workspaceId:f.c.workspaceId}),result);
  assert.deepEqual(await f.service.handle({type:'delete_workspace',workspaceId:f.c.workspaceId,confirm:true}),result);
  const raw=f.app.store.get('SELECT * FROM workspace_deletion_receipts WHERE workspace_id=?',f.c.workspaceId)!;
  assert(!JSON.stringify(raw).includes(f.workspace));assert(!JSON.stringify(raw).includes('原始源文件'));
  assert(!desktopCommandSchema.safeParse({type:'workspace_deletion_status',workspaceId:f.c.workspaceId,path:f.workspace}).success);
  assert.deepEqual(await f.service.handle({type:'workspace_deletion_status',workspaceId:f.kept.workspaceId}),{deleted:false,exists:true});
  await f.app.close();closed=true;reopened=new UmiApplication(f.data,new ScriptModel([]));assert.deepEqual(reopened.store.workspaceDeletionStatus(f.c.workspaceId),result);
  assert.equal(readFileSync(join(f.workspace,'source.txt'),'utf8'),'原始源文件');
 }finally{if(reopened)await reopened.close();if(!closed)await f.app.close();removeTestRoot(f.root);}
});

test('最后工作区删除跳过历史候选扫描，仍保留其它持久事实引用的资料与嵌套共享内容',async()=>{
 const f=fixture();try{
  f.app.store.deleteWorkspace(f.kept.workspaceId);
  const shared=f.app.store.artifact({text:'全局保留'}),nested=f.app.store.artifact({id:shared});
  f.app.store.db.exec('CREATE TABLE retained_global_evidence(id TEXT PRIMARY KEY,artifact_id TEXT)');f.app.store.run('INSERT INTO retained_global_evidence VALUES(?,?)',uid(),nested);
  f.app.store.artifact({text:'应当删除的孤立资料'});
  const result=f.app.store.deleteWorkspace(f.c.workspaceId);assert(result.deleted);
  assert.deepEqual(f.app.store.readArtifact(shared),{text:'全局保留'});assert.deepEqual(f.app.store.readArtifact(nested),{id:shared});assert.equal(f.app.store.all('SELECT * FROM artifacts').length,2);
 }finally{await f.close();}
});

test('迁移9只新增删除凭据，旧8库的历史、批准、备份与迁移指纹保持',async()=>{
 const f=fixture();let reopened:UmiApplication|undefined,closed=false;try{
  const before=f.app.store.events(f.c.conversationId),fingerprints=f.app.store.all('SELECT * FROM schema_migrations WHERE version<=8'),grants=f.app.store.all('SELECT * FROM workspace_file_grants');
  f.app.store.db.exec('DROP TABLE workspace_deletion_receipts;DELETE FROM schema_migrations WHERE version=9');await f.app.close();closed=true;
  reopened=new UmiApplication(f.data,new ScriptModel([]));assert.equal(reopened.store.databaseVersion,12);assert.deepEqual(reopened.store.events(f.c.conversationId),before);
  assert.deepEqual(reopened.store.all('SELECT * FROM schema_migrations WHERE version<=8'),fingerprints);assert.deepEqual(reopened.store.all('SELECT * FROM workspace_file_grants'),grants);
 }finally{if(reopened)await reopened.close();if(!closed)await f.app.close();removeTestRoot(f.root);}
});

test('删除的页缓存预算仅作用于本次连接操作，失败回滚及成功后均恢复原值',async()=>{
 const f=fixture();try{
  f.app.store.db.exec('PRAGMA cache_size=-1234');
  f.app.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON workspace_deletion_receipts BEGIN SELECT RAISE(ABORT,'test-receipt-failed');END;");
  assert.throws(()=>f.app.store.deleteWorkspace(f.c.workspaceId),/test-receipt-failed/);
  assert.equal(f.app.store.get('PRAGMA cache_size')!.cache_size,-1234);assert(f.app.store.conversation(f.c.conversationId));assert.equal(f.app.store.workspaceDeletionStatus(f.c.workspaceId).deleted,false);
  assert.equal(f.app.store.get('PRAGMA foreign_keys')!.foreign_keys,1);f.app.store.db.exec('DROP TRIGGER fail_receipt');
  f.app.store.deleteWorkspace(f.c.workspaceId);assert.equal(f.app.store.get('PRAGMA cache_size')!.cache_size,-1234);assert.equal(f.app.store.get('PRAGMA foreign_keys')!.foreign_keys,1);
 }finally{await f.close();}
});

for(const opaque of [false,true])test('资料扫描保留嵌套JSON键及Unicode转义引用：'+(opaque?'兼容非UUID资料':'标准UUID资料'),async()=>{
 const f=fixture();try{
  let ref=f.app.store.artifact({text:'保留完整共享资料'});
  if(opaque){const custom='legacy-artifact-reference';f.app.store.run('INSERT INTO artifacts SELECT ?,hash,kind,content FROM artifacts WHERE id=?',custom,ref);ref=custom;}
  const encoded=JSON.stringify({ref}).replaceAll('-',String.fromCharCode(92)+'u002d');
  const nested=JSON.stringify({nested:encoded}),keyed=JSON.stringify({refs:{[ref]:'原始来源'}});
  f.app.store.db.exec('CREATE TABLE external_evidence(id TEXT PRIMARY KEY,body TEXT)');
  f.app.store.run('INSERT INTO external_evidence VALUES(?,?)',uid(),nested);f.app.store.run('INSERT INTO external_evidence VALUES(?,?)',uid(),keyed);
  // 另一工作区仍在，强制走候选/保留引用扫描，而不是最后工作区快捷路径。
  f.app.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',uid(),f.c.conversationId,'共享引用','text/plain',1,ref);
  f.app.store.deleteWorkspace(f.c.workspaceId);assert.deepEqual(f.app.store.readArtifact(ref),{text:'保留完整共享资料'});assert(f.app.store.conversation(f.kept.conversationId));
 }finally{await f.close();}
});

test('批量删除：事件删除故障时DDL、记录和完成凭据一起回滚，成功后辅助索引原样重建',async()=>{
 const f=fixture();try{
  f.steps.push(text('有事件的真实会话'));const r=f.app.send(f.c.conversationId,uid(),'生成历史');await f.app.wait(r.runId);
  const indexes=()=>f.app.store.all("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN('events_applied_input','events_attempt_lifecycle') ORDER BY name");
  const before=indexes();assert.equal(before.length,2);
  f.app.store.db.exec("CREATE TRIGGER fail_event_removal BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'event-delete-failed');END;");
  assert.throws(()=>f.app.deleteWorkspace(f.c.workspaceId),/event-delete-failed/);assert.deepEqual(indexes(),before);
  assert(f.app.store.conversation(f.c.conversationId));assert.equal(f.app.store.workspaceDeletionStatus(f.c.workspaceId).deleted,false);
  f.app.store.db.exec('DROP TRIGGER fail_event_removal');f.app.deleteWorkspace(f.c.workspaceId);
  assert.deepEqual(indexes(),before);assert.deepEqual(f.app.store.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});

test('删除资料快路径：普通JSON、压缩协议中的间接引用及自定义SQL列名都保留',async()=>{
 const f=fixture();try{
  const child=f.app.store.artifact({text:'压缩内引用仍保留'}),column=f.app.store.artifact({text:'自定义列名引用'});
  const archive=new ProviderChunkArchive();archive.append({refs:{[child]:'来源'}});
  const parent=f.app.store.artifact({kind:'umi-provider-stream',archive:archive.finish()},'provider-response');
  f.app.store.db.exec('CREATE TABLE retained_columns(id TEXT, "'+column+'" TEXT,body TEXT)');
  f.app.store.run('INSERT INTO retained_columns VALUES(?,?,?)',uid(),null,JSON.stringify({parent}));
  for(const ref of [parent,child,column])f.app.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',uid(),f.c.conversationId,'候选资料','text/plain',1,ref);
  f.app.deleteWorkspace(f.c.workspaceId);
  assert.deepEqual(f.app.store.readArtifact(child),{text:'压缩内引用仍保留'});assert.deepEqual(f.app.store.readArtifact(column),{text:'自定义列名引用'});
  assert.equal(f.app.store.readArtifact<any[]>(parent)[0].refs[child],'来源');assert.deepEqual(f.app.store.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});
