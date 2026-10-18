import {clearConversationStorage} from '../apps/desktop/renderer/src/features/settings/conversationStorage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,renameSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {desktopCommandSchema,readySchema} from '../packages/protocol/src/desktop.js';
import {ConversationDeletion} from '../packages/adapters/src/sqlite/conversation-deletion.js';
import {RESOURCE_SCOPE_SCHEMA_SQL} from '../packages/adapters/src/sqlite/resource-scope-schema.js';
import {uid} from '../packages/agent/src/identity.js';
import {ScriptModel,call,text,removeTestRoot} from './fixtures.js';
import type {Step} from './fixtures.js';

function fixture(steps:Step[]=[]) {
  const root=mkdtempSync(join(tmpdir(),'umi-permanent-delete-')),workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'source.txt'),'源文件');
  const app=new UmiApplication(join(root,'data'),new ScriptModel(steps),{search:{key:()=> 'test-only',baseUrl:'https://api.deepseek.com',transport:async url=>String(url).endsWith('/search')?Response.json({results:[{title:'网页',url:'https://example.org/doc',summary:'搜索摘要',snippet:'短摘要',content:'',date:null,site_name:null,site_icon:null,rerank_score:2,authority:2}]}):Response.json({title:'网页',content:'# 文档\n正文🙂\n'})}}),c=app.createConversation(workspace);
  return {root,workspace,app,c,service:new DesktopService(app),async close(){await app.close();removeTestRoot(root);}};
}
async function finish(f:ReturnType<typeof fixture>,runId:string) {
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    const state=f.app.store.snapshot(f.c.conversationId);
    for(const [id,a] of Object.entries(state.approvals))if(a.status==='pending')f.app.approve(f.c.conversationId,id,'allow');
    if(!['queued','running','waiting_permission','stopping','recovering'].includes(f.app.store.getRun(runId).status))return f.app.wait(runId);
    await delay(5);
  }
  throw Error('删除验收中的工具任务未完成');
}
test('永久删除协议：必须明确确认、只接受会话ID；未归档不可删且模型工具表无删除能力',async()=>{
  const f=fixture();
  try{
    assert.throws(()=>desktopCommandSchema.parse({type:'delete_conversation',conversationId:f.c.conversationId}));
    assert.throws(()=>desktopCommandSchema.parse({type:'delete_conversation',conversationId:f.c.conversationId,confirm:false}));
    assert.throws(()=>desktopCommandSchema.parse({type:'delete_conversation',conversationId:f.c.conversationId,confirm:true,path:f.workspace}));
    await assert.rejects(()=>f.service.handle(desktopCommandSchema.parse({type:'delete_conversation',conversationId:f.c.conversationId,confirm:true})),/先归档/);
    const names=f.app.registry.specs().map(s=>s.name);assert(names.includes('search_web'));assert(!names.some(n=>/delete.*conversation|deepseek_server_web_search/.test(n)));
    assert.equal(f.app.store.databaseVersion,7);assert.equal(readySchema.shape.databaseVersion.value,7);
  }finally{await f.close();}
});
test('永久删除：真实循环的搜索/抓取/附件/交付/成果导出全部清理，源文件和已导出文件保留',async()=>{
  const steps:Step[]=[],f=fixture(steps);let outputId='',changeSetId='';
  try{
    const other=f.app.createConversation(f.workspace),otherState=f.app.store.snapshot(other.conversationId),otherEnv=f.app.store.environment(other.environmentId).root;
    const mount=f.app.files.repo.mounts(f.c.environmentId)[0]!,environment=f.app.store.environment(f.c.environmentId).root;
    const data=(r:any)=>JSON.parse(r.body.messages.filter((m:any)=>m.role==='tool').at(-1).content).data;
    steps.push(call('search_web',{query:'测试网页'}),call('fetch_webpage',{url:'https://example.org/doc'}),
      call('write_file',{mountId:mount.id,path:'delivered.txt',content:'已交付正文'}),
      call('build_changeset',{mountId:mount.id}),r=>{changeSetId=data(r).changeSetId;return call('deliver_changeset',{changeSetId});},
      call('create_output',{name:'成果.txt',content:'已导出正文'}),r=>{outputId=data(r).outputId;return call('export_outputs',{items:[{outputId,target:join(f.workspace,'exported.txt')}]});},text('完成。'));
    const attachment=f.app.store.uploadAttachment(f.c.conversationId,'资料.txt','text/plain','仅属于将删除会话的原文'),r=f.app.send(f.c.conversationId,uid(),'搜索并交付',[attachment.id]);
    assert.equal((await finish(f,r.runId)).status,'completed');assert(outputId&&changeSetId,JSON.stringify(f.app.store.tools(r.runId).map(t=>({name:t.name,state:t.state,result:t.result_ref?f.app.store.readArtifact(t.result_ref):null}))));assert(f.app.store.all("SELECT id FROM artifacts WHERE kind='output-export'").length>=2);
    writeFileSync(join(environment,'task','scratch','private.txt'),'托管临时文件');
    f.app.store.editConversation(f.c.conversationId,null,true);
    const result=await f.service.handle(desktopCommandSchema.parse({type:'delete_conversation',conversationId:f.c.conversationId,confirm:true})) as any;
    assert.equal(result.deleted,true);assert.equal(result.cleanupPending,false);assert(result.deletedArtifacts>0);
    assert.throws(()=>f.app.store.conversation(f.c.conversationId),/不存在/);assert.throws(()=>f.app.store.snapshot(f.c.conversationId),/不存在/);
    assert(!existsSync(environment));assert(existsSync(otherEnv));assert.deepEqual(f.app.store.snapshot(other.conversationId),otherState);
    assert.equal(readFileSync(join(f.workspace,'source.txt'),'utf8'),'源文件');assert.equal(readFileSync(join(f.workspace,'delivered.txt'),'utf8'),'已交付正文');assert.equal(readFileSync(join(f.workspace,'exported.txt'),'utf8'),'已导出正文');
    for(const table of ['runs','messages','tool_executions','approval_requests','events','commands','attachments','context_snapshots','model_requests','memory_entries','context_maintenance','changesets','delivery_items'])
      assert.equal(f.app.store.all('SELECT * FROM '+table).filter(row=>table!=='events'||row.conversation_id===f.c.conversationId).length,0,table);
    assert.equal(f.app.store.all('PRAGMA foreign_key_check').length,0);assert.equal(f.app.store.all("SELECT id FROM artifacts WHERE kind IN('web-search','web-page','output-export')").length,0);
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    try{assert.throws(()=>reopened.store.conversation(f.c.conversationId),/不存在/);assert.equal(reopened.store.listConversations().length,1);assert.equal(reopened.store.listConversations(true).length,0);}finally{await reopened.close();}
  }finally{await f.close();}
});
test('永久删除：跨会话共享资料和另一会话的间接导出回执保留；最后一条删除回收孤立资料',async()=>{
  const f=fixture([call('search_history',{query:'保留'}),text('保留。')]);
  try{
    const shared=f.app.store.artifact({text:'共有资料'}),nested=f.app.store.artifact({snapshotId:shared}),liveNested=f.app.store.artifact({references:{[shared]:'source-hash'}}),orphan=f.app.store.artifact({text:'无归属旧资料'});
    const other=f.app.createConversation(f.workspace),r=f.app.send(other.conversationId,uid(),'保留会话');await f.app.wait(r.runId);
    const tool=f.app.store.tools(r.runId)[0]!,implicit='output-receipt-'+tool.id+'-0';
    f.app.outputs.repo.save(implicit,{outcome:'applied',target:join(f.workspace,'retained.txt')});
    f.app.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',uid(),f.c.conversationId,'将删除','text/plain',1,nested);
    f.app.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',uid(),other.conversationId,'保留','text/plain',1,liveNested);
    f.app.store.editConversation(f.c.conversationId,null,true);f.app.deleteArchivedConversation(f.c.conversationId);
    assert.throws(()=>f.app.store.readArtifact(nested));assert.deepEqual(f.app.store.readArtifact(shared),{text:'共有资料'});assert(f.app.store.readArtifact(liveNested));assert(f.app.store.readArtifact(implicit));assert(f.app.store.readArtifact(orphan));
    f.app.store.editConversation(other.conversationId,null,true);f.app.deleteArchivedConversation(other.conversationId);
    assert.equal(f.app.store.all('SELECT * FROM artifacts').length,0);assert.equal(f.app.store.all('SELECT * FROM workspaces').length,0);
  }finally{await f.close();}
});
test('永久删除：事务失败回滚所有记录和清理项，不先删工作副本',async()=>{
  const f=fixture([text('原回复')]);
  try{
    const r=f.app.send(f.c.conversationId,uid(),'原要求');await f.app.wait(r.runId);f.app.store.editConversation(f.c.conversationId,null,true);
    const before=f.app.store.snapshot(f.c.conversationId),environment=f.app.store.environment(f.c.environmentId).root,artifacts=f.app.store.all('SELECT id FROM artifacts');
    f.app.store.db.exec("CREATE TRIGGER refuse_test_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(()=>f.app.deleteArchivedConversation(f.c.conversationId),/test rollback/);
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId),before);assert.deepEqual(f.app.store.all('SELECT id FROM artifacts'),artifacts);
    assert.equal(f.app.store.all('SELECT * FROM conversation_deletions').length,0);assert(existsSync(environment));
  }finally{await f.close();}
});
test('永久删除：清理失败明确 pending；数据库已删，重启后完成托管目录清理',async()=>{
  const f=fixture();
  try{
    const environment=f.app.store.environment(f.c.environmentId).root;f.app.store.editConversation(f.c.conversationId,null,true);
    const repository=new ConversationDeletion(f.app.store,()=>{throw Object.assign(Error('occupied'),{code:'EACCES'});});
    const result=repository.deleteArchived(f.c.conversationId);assert(result.cleanupPending);assert(existsSync(environment));assert.throws(()=>f.app.store.conversation(f.c.conversationId));
    assert.equal(f.app.store.all('SELECT * FROM conversation_deletions')[0]?.last_error,'EACCES');
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    try{assert(!existsSync(environment));assert.equal(reopened.store.all('SELECT * FROM conversation_deletions').length,0);}finally{await reopened.close();}
  }finally{await f.close();}
});
test('永久删除：目录根替换为联接时拒绝；内部联接仅移除链接，外部源文件不变',async()=>{
  const f=fixture(),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'保留');
  try{
    const root=f.app.store.environment(f.c.environmentId).root,backup=root+'-saved';f.app.store.editConversation(f.c.conversationId,null,true);
    renameSync(root,backup);symlinkSync(outside,root,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>f.app.deleteArchivedConversation(f.c.conversationId));assert(f.app.store.conversation(f.c.conversationId));assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'保留');
    unlinkSync(root);renameSync(backup,root);symlinkSync(outside,join(root,'outside-link'),process.platform==='win32'?'junction':'dir');
    assert.equal(f.app.deleteArchivedConversation(f.c.conversationId).cleanupPending,false);assert(!existsSync(root));assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'保留');
  }finally{await f.close();}
});
test('永久删除：工作区仍引用托管目录时拒绝，不删除其他会话来源',async()=>{
  const f=fixture();
  try{
    const root=f.app.store.environment(f.c.environmentId).root,other=f.app.createConversation(root);f.app.store.editConversation(f.c.conversationId,null,true);
    assert.throws(()=>f.app.deleteArchivedConversation(f.c.conversationId),/工作区引用/);assert(existsSync(root));assert(f.app.store.conversation(f.c.conversationId));
    f.app.store.editConversation(other.conversationId,null,true);f.app.deleteArchivedConversation(other.conversationId);
    assert.equal(f.app.deleteArchivedConversation(f.c.conversationId).deleted,true);
  }finally{await f.close();}
});
test('永久删除：归档标记异常时也不能删除活动任务或未知副作用',async()=>{
  const f=fixture([call('search_history',{query:'证据'}),text('完成')]);
  try{
    const r=f.app.send(f.c.conversationId,uid(),'保留证据');await f.app.wait(r.runId);f.app.store.editConversation(f.c.conversationId,null,true);
    const tool=f.app.store.tools(r.runId)[0]!;
    f.app.store.run("UPDATE tool_executions SET state='unknown' WHERE id=?",tool.id);
    assert.throws(()=>f.app.deleteArchivedConversation(f.c.conversationId),/未知副作用/);
    f.app.store.run("UPDATE tool_executions SET state='succeeded' WHERE id=?",tool.id);
    f.app.store.run("UPDATE runs SET status='queued' WHERE id=?",r.runId);
    assert.throws(()=>f.app.deleteArchivedConversation(f.c.conversationId),/活动任务/);
    assert(f.app.store.conversation(f.c.conversationId));assert(existsSync(f.app.store.environment(f.c.environmentId).root));
  }finally{await f.close();}
});
test('迁移7：旧6库数据/指纹保持，普通资源范围删除仍被禁止',async()=>{
  const f=fixture([text('迁移前')]);
  try{
    const r=f.app.send(f.c.conversationId,uid(),'保留原话');await f.app.wait(r.runId);
    const before=f.app.store.events(f.c.conversationId),fingerprints=f.app.store.all('SELECT * FROM schema_migrations WHERE version<=6');
    f.app.store.db.exec('DROP TABLE conversation_deletions; DROP TRIGGER immutable_resource_scope_delete; DELETE FROM schema_migrations WHERE version=7;');f.app.store.db.exec(RESOURCE_SCOPE_SCHEMA_SQL);
    await f.app.close();const next=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    try{
      assert.equal(next.store.databaseVersion,7);assert.deepEqual(next.store.events(f.c.conversationId),before);assert.deepEqual(next.store.all('SELECT * FROM schema_migrations WHERE version<=6'),fingerprints);
      const mount=next.files.repo.mounts(f.c.environmentId)[0]!;const candidate=next.store.get('SELECT id FROM resource_candidates WHERE environment_id=?',f.c.environmentId)!;
      if(!next.store.get('SELECT resource_id FROM resource_scopes WHERE resource_id=?',candidate.id!))next.store.run('INSERT INTO resource_scopes VALUES(?,?)',candidate.id!,'{"kind":"directory"}');
      assert.throws(()=>next.store.run('DELETE FROM resource_scopes WHERE resource_id=?',candidate.id!),/明确删除/);assert(mount);
    }finally{await next.close();}
  }finally{await f.close();}
});

test('永久删除清理浏览器草稿/反馈，仅影响指定会话，个人资料和其他会话保留',()=>{
  const data=new Map([['umi.pending.delete-id','待发正文'],['umi.feedback.delete-id.message','like'],['umi.pending.keep-id','保留草稿'],['umi.feedback.keep-id.message','like'],['umi.work.activeThread','delete-id'],['umi.profile.username','保留用户'],['umi.theme','dark']]);
  const storage={get length(){return data.size;},key:(index:number)=>[...data.keys()][index]??null,getItem:(key:string)=>data.get(key)??null,removeItem:(key:string)=>{data.delete(key);}};
  clearConversationStorage(storage,'delete-id');assert(!data.has('umi.pending.delete-id'));assert(!data.has('umi.feedback.delete-id.message'));assert(!data.has('umi.work.activeThread'));assert.equal(data.get('umi.pending.keep-id'),'保留草稿');assert.equal(data.get('umi.profile.username'),'保留用户');assert.equal(data.get('umi.theme'),'dark');
});
