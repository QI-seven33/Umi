import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,removeTestRoot,eventually} from './fixtures.js';
import type {Step} from './fixtures.js';
import type {PreparedRequest} from '../packages/agent/src/ports.js';
import type {WireMessage} from '../packages/protocol/src/model.js';
import {uid} from '../packages/agent/src/identity.js';
const result=(r:PreparedRequest)=>JSON.parse((r.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!.content);
function fixture(initial='A\n用户备注\n'){
 const root=mkdtempSync(join(tmpdir(),'umi-natural-history-')),source=join(root,'source'),data=join(root,'data');mkdirSync(source);writeFileSync(join(source,'a.txt'),initial);
 const steps:Step[]=[],model=new ScriptModel(steps);let app=new UmiApplication(data,model);const c=app.createConversation(source),m=app.files.repo.direct.mounts(c.environmentId)[0]!;
 return {root,source,data,steps,model,c,m,get app(){return app;},async run(prompt='这个版本不好，你帮我回退到上个版本吧'){const r=app.send(c.conversationId,uid(),prompt);await app.wait(r.runId);return r;},
 async edit(oldText:string,newText:string){steps.push(call('read_file',{mountId:m.id,path:'a.txt'}),call('edit_file',{mountId:m.id,path:'a.txt',oldText,newText}),text('完成'));return this.run('按要求修改');},
 async restart(){await app.close();app=new UmiApplication(data,model);},async close(){await app.close();removeTestRoot(root);}};
}
test('自然语言链路：按一轮合并版本，恢复完整上一版，备份与回复保留',async()=>{
 const f=fixture();try{
  f.steps.push(call('read_file',{mountId:f.m.id,path:'a.txt'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'A',newText:'B'}),call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'B',newText:'C'}),text('这一版完成'));await f.run('修改这份文件');
  let restoreId='';f.steps.push(call('list_file_versions',{mountId:f.m.id,path:'a.txt'}),r=>{const versions=result(r).data.versions;assert.equal(versions.length,1);assert.equal(versions[0].edits,2);restoreId=versions[0].restoreChangeId;return call('read_file_version',{changeId:restoreId});},
   r=>{assert.equal(result(r).data.content,'A\n用户备注\n');return call('restore_file_version',{changeId:restoreId});},r=>{assert.equal(result(r).outcome,'succeeded');assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A\n用户备注\n');return text('**已回退**，用户备注保留。');});
  const run=await f.run();assert.equal(f.app.store.getRun(run.runId).status,'completed');assert.equal(f.app.store.all('SELECT * FROM approval_requests').length,0);assert.equal(f.app.store.all('SELECT * FROM file_changes').length,3);
  f.steps.push(call('restore_file_version',{changeId:restoreId}),r=>{assert(result(r).data.noOp);return text('已是所选版本');});await f.run();assert.equal(f.app.store.all('SELECT * FROM file_changes').length,3);
 }finally{await f.close();}
});
test('保留历史可跨多轮与重启回退；恢复后新分支仍能选择此前版本',async()=>{
 const f=fixture('A');try{
  await f.edit('A','B');const first=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);await f.edit('B','C');const second=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);await f.restart();
  f.steps.push(call('restore_file_version',{changeId:first}),text('回到A'));await f.run();assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A');
  await f.edit('A','D');f.steps.push(call('restore_file_version',{changeId:second}),text('选择此前B'));await f.run('请回到之前的B版本');assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'B');
  f.steps.push(call('list_file_versions',{mountId:f.m.id,path:'a.txt',limit:1}),r=>{const d=result(r).data;assert(d.nextBeforeVersionId);return call('list_file_versions',{mountId:f.m.id,path:'a.txt',limit:1,beforeVersionId:d.nextBeforeVersionId});},r=>{assert.equal(result(r).data.versions.length,1);return text('更早记录还在');});await f.run('查更早版本');
 }finally{await f.close();}
});
test('人工后改阻止整文件回退，比较后可精确撤销且保留无关修改',async()=>{
 const f=fixture();try{
  await f.edit('A','B');const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);writeFileSync(join(f.source,'a.txt'),'B\n用户后加说明\n');
  f.steps.push(call('restore_file_version',{changeId:id}),r=>{assert.equal(result(r).data.code,'RESTORE_CONFLICT');assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'B\n用户后加说明\n');return call('read_file_version',{changeId:id});},
   r=>{assert.equal(result(r).data.content,'A\n用户备注\n');return call('read_file',{mountId:f.m.id,path:'a.txt'});},call('edit_file',{mountId:f.m.id,path:'a.txt',oldText:'B',newText:'A'}),text('已撤销Umi修改，保留你后加的说明'));
  await f.run();assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A\n用户后加说明\n');
 }finally{await f.close();}
});
test('人工版本断点、同字节对象替换与跨会话版本都不能静默覆盖',async()=>{
 const f=fixture('A');try{
  await f.edit('A','B');const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);writeFileSync(join(f.source,'a.txt'),'人工版本');await f.edit('人工版本','C');
  f.steps.push(call('restore_file_version',{changeId:id}),r=>{assert.equal(result(r).data.code,'RESTORE_CONFLICT');return text('需要比较人工修改');});await f.run();assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'C');
  const latest=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);renameSync(join(f.source,'a.txt'),join(f.source,'saved.txt'));writeFileSync(join(f.source,'a.txt'),'C');
  f.steps.push(call('restore_file_version',{changeId:latest}),r=>{assert.equal(result(r).data.code,'RESTORE_CONFLICT');return text('对象被替换');});await f.run();
  const other=f.app.createConversation(f.source);assert.throws(()=>f.app.registry.get('read_file_version').prepare({changeId:id,side:'before',startByte:0,byteLength:100},f.app.store.environment(other.environmentId)),/不属于/);
 }finally{await f.close();}
});
test('恢复删除仍询问，拒绝不删除；撤销权限后不能读取历史或恢复',async()=>{
 const f=fixture();try{
  f.steps.push(call('write_file',{mountId:f.m.id,path:'new.txt',content:'新增文件'}),text('已新建'));await f.run('新建');const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  f.steps.push(call('restore_file_version',{changeId:id}),text('遵从拒绝'));const run=f.app.send(f.c.conversationId,uid(),'撤销新建文件');
  const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);assert(existsSync(join(f.source,'new.txt')));f.app.approve(f.c.conversationId,approval,'deny');await f.app.wait(run.runId);assert(existsSync(join(f.source,'new.txt')));
  f.app.revokeDirectoryAccess(f.c.conversationId,f.m.direct!.grantId);
  assert.throws(()=>f.app.registry.get('read_file_version').prepare({changeId:id,side:'before',startByte:0,byteLength:100},f.app.store.environment(f.c.environmentId)),/撤销/);
  assert.throws(()=>f.app.registry.get('restore_file_version').prepare({changeId:id},f.app.store.environment(f.c.environmentId),'test-execution'),/撤销/);
 }finally{await f.close();}
});
test('恢复回执失败后重启仅核验原恢复，不重写或新建第二条恢复意图',async()=>{
 const f=fixture('A');try{
  await f.edit('A','B');const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  f.app.store.db.exec("CREATE TRIGGER fail_restore_receipt BEFORE UPDATE OF state ON file_changes WHEN NEW.restores_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'restore-receipt-failed');END;");
  f.steps.push(call('restore_file_version',{changeId:id}),text('按已记录结果说明'));const run=await f.run();
  assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A');const tool=f.app.store.tools(run.runId)[0]!;assert.equal(tool.state,'unknown');f.app.store.db.exec('DROP TRIGGER fail_restore_receipt');
  await f.restart();f.app.resume(f.c.conversationId,run.runId);await f.app.wait(run.runId);assert.equal(f.app.store.tool(tool.id).state,'succeeded');assert.equal(f.app.store.all('SELECT * FROM file_changes').length,2);assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A');
 }finally{await f.close();}
});

test('具体批准后可撤销新建文件，删除恢复留备份且可以再恢复文件',async()=>{
 const f=fixture();try{
  f.steps.push(call('write_file',{mountId:f.m.id,path:'new.txt',content:'新增文件'}),text('已新建'));await f.run('新建');
  const id=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  f.steps.push(call('restore_file_version',{changeId:id}),r=>{const d=result(r).data;assert.equal(d.previewRef,null);assert(!existsSync(join(f.source,'new.txt')));return text('已按批准撤销新增');});
  const run=f.app.send(f.c.conversationId,uid(),'撤销新建文件');
  const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
  f.app.approve(f.c.conversationId,approval,'allow');await f.app.wait(run.runId);
  assert.equal(f.app.store.getRun(run.runId).status,'completed');assert(!existsSync(join(f.source,'new.txt')));
  const deletion=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  f.steps.push(call('restore_file_version',{changeId:deletion}),text('撤销删除恢复'));await f.run('把刚才删掉的文件恢复回来');
  assert.equal(readFileSync(join(f.source,'new.txt'),'utf8'),'新增文件');assert.equal(f.app.store.all('SELECT * FROM approval_requests').length,1);
  assert.equal(f.app.store.all('SELECT * FROM file_changes').length,3);
 }finally{await f.close();}
});

test('A整体恢复所选版本后，B的旧读证据不能覆盖；重新读取后可继续编辑',async()=>{
 const f=fixture('A');try{
  await f.edit('A','B');const change=String(f.app.files.repo.direct.changes(f.c.conversationId)[0]!.id);
  const other=f.app.createConversation(f.source),mount=f.app.files.repo.direct.mounts(other.environmentId)[0]!;
  f.steps.push(call('read_file',{mountId:mount.id,path:'a.txt'}),call('edit_file',{mountId:mount.id,path:'a.txt',oldText:'B',newText:'C'}),text('B会话完成'));
  let run=f.app.send(other.conversationId,uid(),'继续修改同一文件');await f.app.wait(run.runId);assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'C');
  f.steps.push(call('restore_file_version',{changeId:change}),text('已整体回到A选定版本，后续修改也被回退'));await f.run('把整个文件恢复到所选旧版本');
  assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A');
  f.steps.push(call('edit_file',{mountId:mount.id,path:'a.txt',oldText:'C',newText:'D'}),r=>{assert.equal(result(r).outcome,'failed');assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'A');return call('read_file',{mountId:mount.id,path:'a.txt'});},
   call('edit_file',{mountId:mount.id,path:'a.txt',oldText:'A',newText:'D'}),text('读取当前版本后继续'));
  run=f.app.send(other.conversationId,uid(),'继续修改');await f.app.wait(run.runId);
  assert.equal(f.app.store.getRun(run.runId).status,'completed');assert.equal(readFileSync(join(f.source,'a.txt'),'utf8'),'D');
 }finally{await f.close();}
});
