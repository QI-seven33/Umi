import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,renameSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {LegacyFileApplication} from './legacy-file-fixture.js';
import {ScriptModel,call,text,eventually,removeTestRoot} from './fixtures.js';
import type {Step} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {bytesHash} from '../packages/adapters/src/host-files/paths.js';

function fixture(initial='原文\r\n保留学习注释\r\n') {
 const root=mkdtempSync(join(tmpdir(),'umi-direct-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'a.txt'),initial);
 const steps:Step[]=[],model=new ScriptModel(steps);let app=new UmiApplication(data,model);const c=app.createConversation(workspace),m=app.files.repo.direct.mounts(c.environmentId)[0]!;
 return {root,workspace,data,steps,model,c,m,get app(){return app;},async run(){const r=app.send(c.conversationId,uid(),'按要求修改文件');await app.wait(r.runId);return r;},
 async restart(){await app.close();app=new UmiApplication(data,model);},async close(){await app.close();removeTestRoot(root);}};
}
test('直改完整任务：真实读取、批量精确修改、创建、diff与恢复，无物化或交付',async()=>{
 const f=fixture('\ufeff原文\r\n保留学习注释\r\n');try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'原文',newText:'新文'}),call('write_file',{mountId:f.m.id,path:'new.txt',content:'新文件'}),()=>{assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'\ufeff新文\r\n保留学习注释\r\n');return text('修改已完成');});
  const r=await f.run();assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(f.app.store.tools(r.runId).length,3);
  assert.equal(f.app.store.all('SELECT * FROM materializations').length,0);assert.equal(f.app.store.all('SELECT * FROM approval_requests').length,0);
  const names=(f.model.requests[0]!.body.tools as {name:string}[]).map(t=>t.name);assert(names.includes('request_directory_access'));assert(!names.includes('build_changeset'));assert(!names.includes('request_resource'));
  const changes=f.app.files.repo.direct.changes(f.c.conversationId);assert.equal(changes.length,2);
  const change=changes.find(c=>c.path==='a.txt')!;const preview=f.app.files.direct.preview(f.c.conversationId,String(change.id));assert(preview.diff.includes('-\ufeff原文'));assert(preview.diff.includes('+\ufeff新文'));
  f.app.restoreFileChange(f.c.conversationId,String(change.id));assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'\ufeff原文\r\n保留学习注释\r\n');
  f.app.restoreFileChange(f.c.conversationId,String(changes.find(c=>c.path==='new.txt')!.id));assert(!existsSync(join(f.workspace,'new.txt')));
 }finally{await f.close();}
});
test('工作区授权：跨run和重启复用，新会话复用同根，撤销后全部停用且不自动复活',async()=>{
 const f=fixture();try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),text('已读'));await f.run();await f.restart();
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),text('继续'));await f.run();
  const service=new DesktopService(f.app),next=await service.handle({type:'new_conversation',conversationId:f.c.conversationId}) as {environmentId:string;conversationId:string};
  const other=f.app.files.repo.direct.mounts(next.environmentId)[0]!;assert.equal(other.root,f.workspace);assert.equal(other.direct!.grantId,f.m.direct!.grantId);
  f.app.revokeDirectoryAccess(f.c.conversationId,f.m.direct!.grantId);assert.throws(()=>f.app.previewFile(f.c.conversationId,f.m.id,'a.txt'),/撤销/);
  assert.throws(()=>f.app.previewFile(next.conversationId,other.id,'a.txt'),/撤销/);await f.restart();assert.throws(()=>f.app.previewFile(f.c.conversationId,f.m.id,'a.txt'),/撤销/);
  await assert.rejects(new DesktopService(f.app).handle({type:'new_conversation',conversationId:f.c.conversationId}),/重新选择/);
 }finally{await f.close();}
});
test('直接访问按需进行：超过旧单文件物化上限的旁邻文件不阻止普通任务',async()=>{
 const f=fixture();try{writeFileSync(join(f.workspace,'large.bin'),Buffer.alloc(5*1024*1024));const c=f.app.createConversation(f.workspace);assert(f.app.files.repo.direct.mounts(c.environmentId).length);assert.equal(f.app.store.all('SELECT * FROM materializations').length,0);}finally{await f.close();}
});
test('读后并发修改与恢复冲突均不覆盖用户劳动',async()=>{
 const f=fixture();try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),()=>{writeFileSync(join(f.workspace,'a.txt'),'用户后改');return call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'原文',newText:'新文'});},text('版本变化'));const r=await f.run();assert.equal(f.app.store.tools(r.runId)[1]!.state,'failed');assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'用户后改');
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'用户后改',newText:'模型改'}),text('完成'));await f.run();
  const change=f.app.files.repo.direct.changes(f.c.conversationId)[0]!;writeFileSync(join(f.workspace,'a.txt'),'用户最终劳动');assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(change.id)),/后续修改/);assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'用户最终劳动');
 }finally{await f.close();}
});
test('写前备份/意图持久化失败时源文件不变',async()=>{
 const f=fixture();try{
  f.app.store.db.exec("CREATE TRIGGER fail_backup BEFORE INSERT ON file_changes BEGIN SELECT RAISE(ABORT,'test-backup-failed');END;");
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'原文',newText:'新文'}),text('受阻'));await f.run();assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'原文\r\n保留学习注释\r\n');assert.equal(f.app.store.all('SELECT * FROM file_changes').length,0);
 }finally{await f.close();}
});
test('目录根身份替换、穿越、控制数据、只读授权拒绝实际访问',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),f.m.id,'../outside'),/路径/);
  const broad=f.app.createConversation(f.root),m=f.app.files.repo.direct.mounts(broad.environmentId).find(m=>m.root===f.root)!;
  assert.throws(()=>f.app.previewFile(broad.conversationId,m.id,'data/umi.sqlite'),/控制数据/);
  const candidate=f.app.files.repo.candidate(f.c.environmentId,f.workspace,f.m.rootIdentity);const readonly=f.app.files.direct.grant(candidate,'read','test-user-selection');
  assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),readonly.id,'a.txt',undefined,true),/不允许修改/);
  assert.equal((f.app.store.runtimeFacts(f.c.environmentId) as {mounts:any[]}).mounts.find(m=>m.mountId===readonly.id).canEdit,false);
  renameSync(f.workspace,f.workspace+'-old');mkdirSync(f.workspace);writeFileSync(join(f.workspace,'a.txt'),'同名新目录');assert.throws(()=>f.app.previewFile(f.c.conversationId,f.m.id,'a.txt'),/身份/);
 }finally{await f.close();}
});
test('旧副本升级保持原位置和旧批准语义，不自动写回或变成直改权',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-direct-legacy-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'a.txt'),'源文');
 const old=new LegacyFileApplication(data,new ScriptModel([])),c=old.createConversation(workspace),m=old.files.repo.mounts(c.environmentId)[0]!;writeFileSync(join(m.root,'a.txt'),'未交付成果');const events=old.store.events(c.conversationId),fingerprints=old.store.all('SELECT * FROM schema_migrations WHERE version<=7');old.store.db.exec('DROP TABLE file_changes;DROP TABLE direct_file_mounts;DROP TABLE direct_file_environments;DROP TABLE workspace_file_grants;DELETE FROM schema_migrations WHERE version=8');await old.close();
 const app=new UmiApplication(data,new ScriptModel([]));try{app.files.initialize(c.environmentId);assert.equal(app.files.repo.mount(m.id,c.environmentId).root,m.root);assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),'源文');assert.equal(readFileSync(join(m.root,'a.txt'),'utf8'),'未交付成果');assert.deepEqual(app.store.events(c.conversationId),events);assert.deepEqual(app.store.all('SELECT * FROM schema_migrations WHERE version<=7'),fingerprints);assert.equal(app.store.databaseVersion,12);assert(!app.files.repo.direct.enabled(c.environmentId));}finally{await app.close();removeTestRoot(root);}
});
test('外部目录需独立明确授权，后续run复用；普通编辑不批准宿主命令',async()=>{
 const f=fixture(),external=join(f.root,'external');mkdirSync(external);try{
  f.steps.push(call('discover_resource',{path:external}),r=>{const msgs=r.body.messages as {role:string;content:string}[];const d=JSON.parse(msgs.filter(m=>m.role==='tool').at(-1)!.content).data;return call('request_directory_access',{candidateId:d.candidates[0].id,access:'edit',purpose:'新建文件'});},r=>{const msgs=r.body.messages as {role:string;content:string}[];const d=JSON.parse(msgs.filter(m=>m.role==='tool').at(-1)!.content).data;return call('write_file',{mountId:d.mountId,path:'x.txt',content:'外部获准文件'});},text('已完成'));
  const run=f.app.send(f.c.conversationId,uid(),'在另外目录新建文件');const approval=await eventually(()=>f.app.store.all('SELECT * FROM approval_requests WHERE decision IS NULL')[0]);assert(!existsSync(join(external,'x.txt')));f.app.approve(f.c.conversationId,String(approval.id),'allow');await f.app.wait(run.runId);
  assert.equal(readFileSync(join(external,'x.txt'),'utf8'),'外部获准文件');const m=f.app.files.repo.direct.mounts(f.c.environmentId).find(m=>m.root===external)!;
  f.steps.push(call('read_file',{mountId:m.id,path:'x.txt'}),text('续作'));await f.run();assert.equal(f.app.store.all('SELECT * FROM approval_requests').length,1);
  assert.equal(f.app.registry.get('run_command').effect,'host-code');assert.equal(f.app.registry.get('run_shell').effect,'host-code');
 }finally{await f.close();}
});

test('直改写后回执失败：重启核验同一对象，不重写且收敛原修改记录',async()=>{
 const f=fixture();try{
  f.app.store.db.exec("CREATE TRIGGER fail_change_receipt BEFORE UPDATE OF state ON file_changes WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'test-receipt-failure');END;");
  f.steps.push(call('write_file',{mountId:f.m.id,path:'created.txt',content:'只创建一次'}));const r=await f.run();assert.equal(f.app.store.getRun(r.runId).status,'recovery_required');
  const before=f.app.files.read(f.m,'created.txt').identity;f.app.store.db.exec('DROP TRIGGER fail_change_receipt');await f.restart();f.steps.push(text('原执行已核验'));f.app.resume(f.c.conversationId,r.runId);await f.app.wait(r.runId);
  assert.equal(f.app.files.read(f.m,'created.txt').identity,before);assert.equal(f.app.store.tools(r.runId)[0]!.state,'succeeded');assert.equal(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.state,'settled');assert.equal(f.app.store.events(f.c.conversationId).filter(e=>e.type==='tool.dispatch_intent').length,1);
 }finally{await f.close();}
});
test('撤销后明确重新选择可核验/恢复原对象，旧批准和旧绑定仍不获得写权',async()=>{
 const f=fixture();try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'原文',newText:'新文'}),text('完成'));await f.run();const change=f.app.files.repo.direct.changes(f.c.conversationId)[0]!;
  f.app.revokeDirectoryAccess(f.c.conversationId,f.m.direct!.grantId);assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(change.id)),/撤销/);
  f.app.files.direct.select(f.c.conversationId);assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),f.m.id,'a.txt',null,true),/撤销/);
  f.app.restoreFileChange(f.c.conversationId,String(change.id));assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'原文\r\n保留学习注释\r\n');
 }finally{await f.close();}
});
test('真实删除需要具体批准，拒绝不删除；允许后保留恢复字节',async()=>{
 const f=fixture();try{
  f.steps.push(call('delete_file',{mountId:f.m.id,path:'a.txt'}),text('尊重拒绝'));const first=f.app.send(f.c.conversationId,uid(),'删除此文件');
  const denied=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);assert(existsSync(join(f.workspace,'a.txt')));f.app.approve(f.c.conversationId,denied,'deny');await f.app.wait(first.runId);assert(existsSync(join(f.workspace,'a.txt')));
  f.steps.push(call('delete_file',{mountId:f.m.id,path:'a.txt'}),text('已删除'));const second=f.app.send(f.c.conversationId,uid(),'现在确认删除此文件');const allowed=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);f.app.approve(f.c.conversationId,allowed,'allow');await f.app.wait(second.runId);assert(!existsSync(join(f.workspace,'a.txt')));
  f.app.restoreFileChange(f.c.conversationId,String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id));assert(existsSync(join(f.workspace,'a.txt')));
 }finally{await f.close();}
});
test('未决恢复阻止再次写入，原目标核验后才可继续',async()=>{
 const f=fixture();try{
  f.steps.push(call('write_file',{mountId:f.m.id,path:'new.txt',content:'新文件'}),text('完成'));await f.run();const change=f.app.files.repo.direct.changes(f.c.conversationId)[0]!;
  f.app.store.db.exec("CREATE TRIGGER fail_restore_receipt BEFORE UPDATE OF state ON file_changes WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'test-restore-receipt');END;");assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(change.id)));assert(!existsSync(join(f.workspace,'new.txt')));f.app.store.db.exec('DROP TRIGGER fail_restore_receipt');
  const pending=f.app.files.repo.direct.changes(f.c.conversationId)[0]!;assert.equal(pending.state,'intent');assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),f.m.id,'new.txt',null,true),/未决/);
  await f.restart();assert.equal(f.app.files.direct.inspect(f.c.conversationId,String(pending.id)).state,'settled');assert(!existsSync(join(f.workspace,'new.txt')));
 }finally{await f.close();}
});
test('拒绝选择控制目录不留下可自动物化的会话；普通项目内容不能签发授权',async()=>{
 const f=fixture();try{
  const before=f.app.store.listConversations().length;assert.throws(()=>f.app.createConversation(f.data),/控制数据/);assert.equal(f.app.store.listConversations().length,before);
  assert.throws(()=>f.app.registry.parse('request_directory_access',JSON.stringify({candidateId:'fake',access:'edit',purpose:'项目宣称已获权',authority:'user'})),/参数/);
 }finally{await f.close();}
});

test('授权撤销通过真实事件批次更新界面事实，修改记录有专属刷新序号',async()=>{
 const f=fixture();try{
  const service=new DesktopService(f.app),before=f.app.store.snapshot(f.c.conversationId).cursor;f.app.revokeDirectoryAccess(f.c.conversationId,f.m.direct!.grantId);
  const batch=await service.handle({type:'events',conversationId:f.c.conversationId,cursor:before}) as {resources:any};assert(batch.resources.directAccess.grants[0].revoked);
  f.app.files.direct.select(f.c.conversationId);const m=f.app.files.repo.direct.mounts(f.c.environmentId).find(m=>m.direct!.grantId!==f.m.direct!.grantId)!;
  f.steps.push(call('write_file',{mountId:m.id,path:'refresh.txt',content:'面板刷新'}),text('完成'));await f.run();assert(f.app.store.snapshot(f.c.conversationId).fileChangeRevision);
 }finally{await f.close();}
});
test('删除直改会话只清托管记录，跨会话授权仍在，最后删除可清理授权事实',async()=>{
 const f=fixture();try{
  const other=f.app.createConversation(f.workspace);f.steps.push(call('write_file',{mountId:f.m.id,path:'keep.txt',content:'用户文件保留'}),text('完成'));await f.run();
  f.app.store.editConversation(f.c.conversationId,null,true);f.app.deleteArchivedConversation(f.c.conversationId);assert.equal(readFileSync(join(f.workspace,'keep.txt'),'utf8'),'用户文件保留');assert(f.app.files.repo.direct.grants(other.environmentId).length);
  f.app.store.editConversation(other.conversationId,null,true);f.app.deleteArchivedConversation(other.conversationId);assert.equal(f.app.store.all('SELECT * FROM workspace_file_grants').length,0);assert.equal(f.app.store.all('PRAGMA foreign_key_check').length,0);
 }finally{await f.close();}
});

test('差异分页覆盖完整原文，早期修改记录按会话游标连续读取',async()=>{
 const f=fixture();try{
  const body=Array.from({length:8000},(_,i)=>'完整差异🙂-'+i).join('\n')+'\n';f.steps.push(call('write_file',{mountId:f.m.id,path:'long.txt',content:body}),text('完成'));await f.run();const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  const service=new DesktopService(f.app);let offset=0,collected='';do{const page=await service.handle({type:'preview_file_change',conversationId:f.c.conversationId,changeId:id,startByte:offset,byteLength:64000}) as {diff:string;nextStartByte:number|null};collected+=page.diff;if(page.nextStartByte===null)break;offset=page.nextStartByte;}while(true);assert(collected.includes('完整差异🙂'));assert.equal(collected.split('\n').filter(line=>line.startsWith('+完整差异🙂-')).map(line=>line.slice(1)).join('\n')+'\n',body);
  assert.equal(f.app.files.repo.direct.changes(f.c.conversationId,id).length,0);
 }finally{await f.close();}
});

test('已核验未生效的修改不会因后来出现相同字节被改判为成功',async()=>{
 const f=fixture();try{
  const id=f.app.files.repo.direct.intent(f.m,'cancelled.txt',null,null,Buffer.from('预期字节'));assert.equal(f.app.files.direct.inspect(f.c.conversationId,id).state,'not_applied');
  writeFileSync(join(f.workspace,'cancelled.txt'),'预期字节');assert.equal(f.app.files.direct.inspect(f.c.conversationId,id).state,'not_applied');assert.equal(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.state,'not_applied');
 }finally{await f.close();}
});
test('直改路径拒绝联接、硬链接和失效选择身份，外部目标不变',async()=>{
 const f=fixture(),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'外部用户劳动');try{
  symlinkSync(outside,join(f.workspace,'junction'),'junction');linkSync(join(outside,'keep.txt'),join(f.workspace,'hard.txt'));
  for(const path of ['junction/keep.txt','hard.txt','a.txt:stream'])assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),f.m.id,path,null,true));
  assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'外部用户劳动');const before=f.app.store.listConversations().length;assert.throws(()=>f.app.createConversation(f.workspace,{},'different-root-identity'),/身份/);assert.equal(f.app.store.listConversations().length,before);
 }finally{await f.close();}
});

test('连续恢复：跨run/重启撤销C到B到A，重复回执不再写入，可撤销恢复本身',async()=>{
 const f=fixture('A');try{
  for(const [oldText,newText] of [['A','B'],['B','C']]){
   f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText,newText}),text('完成'));await f.run();
  }
  const [second,first]=f.app.files.repo.direct.changes(f.c.conversationId);await f.restart();
  const restore=f.app.restoreFileChange(f.c.conversationId,String(second!.id));assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'B');
  const count=f.app.files.repo.direct.changes(f.c.conversationId).length;
  const duplicate=f.app.restoreFileChange(f.c.conversationId,String(second!.id));assert.equal(duplicate.changeId,restore.changeId);assert(duplicate.alreadyRestored);assert.equal(f.app.files.repo.direct.changes(f.c.conversationId).length,count);
  await f.restart();const prior=f.app.restoreFileChange(f.c.conversationId,String(first!.id));assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'A');
  assert.equal(f.app.files.direct.inspect(f.c.conversationId,String(first!.id)).matchesBefore,true);
  assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(second!.id)),/后续修改/);
  f.app.restoreFileChange(f.c.conversationId,prior.changeId);assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'B');
 }finally{await f.close();}
});

test('连续恢复仍拒绝相同字节的外部替换和人工后改，跨会话只沿工作区真实恢复关系',async()=>{
 const f=fixture('A');try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'A',newText:'B'}),text('完成'));await f.run();const first=f.app.files.repo.direct.changes(f.c.conversationId)[0]!;
  const other=f.app.createConversation(f.workspace),m=f.app.files.repo.direct.mounts(other.environmentId)[0]!;
  f.steps.push(call('read_file',{mountId:m.id,path:'a.txt'}),call('edit_file',{mountId:m.id,path:'a.txt',oldText:'B',newText:'C'}),text('完成'));
  const r=f.app.send(other.conversationId,uid(),'后续修改');await f.app.wait(r.runId);const second=f.app.files.repo.direct.changes(other.conversationId)[0]!;
  f.app.restoreFileChange(other.conversationId,String(second.id));const path=join(f.workspace,'a.txt'),saved=join(f.workspace,'saved.txt');renameSync(path,saved);writeFileSync(path,'B');
  assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(first.id)),/被替换/);renameSync(saved,path);
  f.app.restoreFileChange(f.c.conversationId,String(first.id));assert.equal(readFileSync(path,'utf8'),'A');writeFileSync(path,'人工后改');
  assert.throws(()=>f.app.restoreFileChange(f.c.conversationId,String(first.id)),/后续修改/);assert.equal(readFileSync(path,'utf8'),'人工后改');
 }finally{await f.close();}
});
