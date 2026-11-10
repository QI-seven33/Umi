import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {taskCheckSchema} from '../packages/protocol/src/task.js';
import {uid} from '../packages/agent/src/identity.js';
import {ScriptModel,call,text,removeTestRoot,eventually} from './fixtures.js';
import type {Step} from './fixtures.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'umi-retired-flow-')),workspace=join(root,'workspace');mkdirSync(workspace);
  writeFileSync(join(workspace,'a.txt'),'original');
  const steps:Step[]=[],app=new UmiApplication(join(root,'data'),new ScriptModel(steps)),c=app.createConversation(workspace),mount=app.files.repo.mounts(c.environmentId)[0]!;
  return {root,workspace,steps,app,c,mount,async run(){const r=app.send(c.conversationId,uid(),'执行这次隔离文件任务');await app.wait(r.runId);return r;},async close(){await app.close();removeTestRoot(root);}};
}
test('退役：注册表没有物化、冻结交付和旧打开工具，桌面与任务协议拒绝旧请求',async()=>{
  const f=fixture();try{
    for(const name of ['request_resource','build_changeset','deliver_changeset','open_delivered_file']){
      assert(!f.app.registry.entries().some(t=>t.name===name));assert.throws(()=>f.app.registry.get(name),/未注册/);
    }
    for(const type of ['preview_changeset','preview_change_file','open_delivered'])assert.equal(desktopCommandSchema.safeParse({type,conversationId:f.c.conversationId,changeSetId:'retired',path:'a.txt',side:'diff'}).success,false);
    assert.equal(taskCheckSchema.safeParse({kind:'delivery',changeSetId:'retired'}).success,false);
    assert(!existsSync(join(f.app.store.environment(f.c.environmentId).root,'working')));
    assert.equal(f.mount.root,f.workspace);
    const facts=JSON.stringify(f.app.store.runtimeFacts(f.c.environmentId));assert(!/incompleteMaterializations|unavailableMounts|request_resource/.test(facts));
  }finally{await f.close();}
});
test('退役：旧会话不能发送或恢复，不自动升级批准、不初始化副本，原数据与文件保持',async()=>{
  const f=fixture();try{
    const old=f.app.store.createConversation(f.workspace,{},false),events=f.app.store.events(old.conversationId);
    assert.throws(()=>f.app.files.initialize(old.environmentId),/旧副本/);
    assert.throws(()=>f.app.send(old.conversationId,uid(),'继续原任务'),/旧副本/);
    assert.throws(()=>f.app.resume(old.conversationId,'old-run'),/旧副本/);
    assert.throws(()=>f.app.approve(old.conversationId,'old-approval','allow'),/旧副本/);
    assert.equal(f.app.files.repo.direct.enabled(old.environmentId),false);
    assert.equal(f.app.files.repo.mounts(old.environmentId).length,0);
    assert.deepEqual(f.app.store.events(old.conversationId),events);
    assert.equal(f.app.store.all('SELECT id FROM runs WHERE conversation_id=?',old.conversationId).length,0);
    assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'original');
  }finally{await f.close();}
});
test('直改：读取编辑即时生效，写前记录可恢复，事实冷重放与目录撤销保持',async()=>{
  const f=fixture();try{
    f.steps.push(call('read_file',{mountId:f.mount.id,path:'a.txt'}),call('edit_file',{mountId:f.mount.id,path:'a.txt',oldText:'original',newText:'updated'}),text('已修改'));
    const r=await f.run();assert.equal(f.app.store.getRun(r.runId).status,'completed');
    assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'updated');
    const changes=f.app.files.repo.direct.changes(f.c.conversationId);assert.equal(changes.length,1);
    assert.equal(f.app.files.direct.preview(f.c.conversationId,String(changes[0]!.id)).diff.includes('-original'),true);
    const before=f.app.store.snapshot(f.c.conversationId);assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,before.cursor.logEpoch)),before);
    f.app.restoreFileChange(f.c.conversationId,String(changes[0]!.id));assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'original');
    f.app.revokeDirectoryAccess(f.c.conversationId,f.mount.direct!.grantId);
    assert.throws(()=>f.app.previewFile(f.c.conversationId,f.mount.id,'a.txt'),/撤销/);
  }finally{await f.close();}
});
test('直改：写前备份失败或读取后外部变化时，不损坏源文件',async()=>{
  const f=fixture();try{
    f.app.store.db.exec("CREATE TRIGGER reject_backup BEFORE INSERT ON file_changes BEGIN SELECT RAISE(ABORT,'backup-test');END");
    f.steps.push(call('read_file',{mountId:f.mount.id,path:'a.txt'}),call('edit_file',{mountId:f.mount.id,path:'a.txt',oldText:'original',newText:'unsafe'}),text('未修改'));
    await f.run();assert.equal(readFileSync(join(f.workspace,'a.txt'),'utf8'),'original');
    assert.equal(f.app.files.repo.direct.changes(f.c.conversationId).length,0);
  }finally{await f.close();}
  const conflict=fixture();try{
    conflict.steps.push(call('read_file',{mountId:conflict.mount.id,path:'a.txt'}),()=>{writeFileSync(join(conflict.workspace,'a.txt'),'external');return call('edit_file',{mountId:conflict.mount.id,path:'a.txt',oldText:'original',newText:'unsafe'});},text('版本冲突'));
    await conflict.run();assert.equal(readFileSync(join(conflict.workspace,'a.txt'),'utf8'),'external');
    assert.equal(conflict.app.files.repo.direct.changes(conflict.c.conversationId).length,0);
  }finally{await conflict.close();}
});
test('直改：跨run外部读取授权按工作区复用，编辑与命令权限不被读授权隐含授予',async()=>{
  const f=fixture(),external=join(f.root,'external');mkdirSync(external);writeFileSync(join(external,'r.txt'),'read only');try{
    const candidate=f.app.files.repo.candidate(f.c.environmentId,external,(await import('../packages/adapters/src/host-files/paths.js')).rootIdentity(external));
    f.steps.push(call('request_directory_access',{candidateId:candidate.id,access:'read',purpose:'读取资料'}),text('已获准'));
    const r=f.app.send(f.c.conversationId,uid(),'允许读取外部资料');const approval=await eventually(()=>f.app.store.all('SELECT id FROM approval_requests WHERE decision IS NULL')[0]);
    f.app.approve(f.c.conversationId,String(approval.id),'allow');await f.app.wait(r.runId);
    const mount=f.app.files.repo.mounts(f.c.environmentId).find(m=>m.root===external)!;
    assert.equal(f.app.previewFile(f.c.conversationId,mount.id,'r.txt').text,'read only');
    f.steps.push(call('read_file',{mountId:mount.id,path:'r.txt'}),text('再次读取'));await f.run();
    assert.equal(f.app.store.all('SELECT id FROM approval_requests').length,1);
    assert.throws(()=>f.app.files.mountContext({},f.app.store.environment(f.c.environmentId),mount.id,'r.txt',undefined,true),{code:'PERMISSION_DENIED'});
    assert.equal(f.app.registry.get('run_command').effect,'host-code');
  }finally{await f.close();}
});
