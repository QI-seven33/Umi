import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { EventBlocks, streamMemberKey } from '../packages/adapters/src/sqlite/event-blocks.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import type { EventBody } from '../packages/protocol/src/events.js';
import { uid } from '../packages/agent/src/identity.js';
import { contextFixture } from './context-fixture.js';
import { ScriptModel, removeTestRoot } from './fixtures.js';

function fixture() {
  const f = contextFixture(0), scope = {conversationId:f.c.conversationId,runId:f.runId,modelTurnId:uid(),modelAttemptId:uid()}, requestId=uid(),blockId=uid();
  f.app.store.persistRequest(scope,requestId,uid(),new ScriptModel([]).prepare([],[],f.app.store.settings(f.c.conversationId),1024),{estimatedInputTokens:1,inputCeiling:100000,estimator:'fixture'},f.generation);
  f.app.store.commit(scope,{type:'model.attempt_started',payload:{requestId}});
  f.app.store.commit(scope,{type:'model.block_started',payload:{blockId,kind:'reasoning',displayRole:'commentary'}});
  const delta=(deltaIndex:number,text='中文🌱'):Extract<EventBody,{type:'model.delta'}>=>({type:'model.delta',payload:{blockId,kind:'reasoning',deltaIndex,text}});
  return {...f,scope,blockId,delta};
}
const eventRow = 'SELECT payload,event_id,idempotency_key,conversation_id,log_epoch,CAST(sequence AS TEXT) seq FROM events';

test('事件分块：旧标量与新块混读，每个片段/任意分页/时间身份保持，外部修改不污染历史',async()=>{
  const f=fixture();try{
    const s=f.app.store,before=s.events(f.c.conversationId),seed=s.snapshot(f.c.conversationId);
    s.commit(f.scope,f.delta(0,'旧标量'));
    const pieces=['','中','\ud83c','\udf31','\\"\n','🙂'];
    for(let start=1;start<131;start+=13)s.commitModelDeltas(f.scope,f.generation,Array.from({length:13},(_,i)=>f.delta(start+i,pieces[(start+i)%pieces.length])));
    const events=s.events(f.c.conversationId),tail=events.slice(before.length),snapshot=s.snapshot(f.c.conversationId);
    assert.equal(tail.length,131);assert.deepEqual(events.slice(0,before.length),before);assert.equal(s.all('SELECT id FROM event_blocks').length,10);
    assert.deepEqual(tail.map(e=>e.type==='model.delta'&&e.payload.text),['旧标量',...Array.from({length:130},(_,i)=>pieces[(i+1)%pieces.length])]);
    assert.deepEqual(events.reduce(reduceConversation,initialState(f.c.conversationId,seed.cursor.logEpoch)),snapshot);
    for(let offset=0;offset<tail.length;offset++)assert.deepEqual(s.events(f.c.conversationId,{...seed.cursor,sequence:(BigInt(seed.cursor.sequence)+BigInt(offset)).toString()},7),tail.slice(offset,offset+7));
    assert.equal(s.listConversations()[0]!.updatedAt,tail.at(-1)!.occurredAt);
    assert.equal(s.get(eventRow+' WHERE event_id=?',tail[20]!.eventId),undefined);assert.deepEqual(new EventBlocks(s.db).at(f.c.conversationId,seed.cursor.logEpoch,tail[20]!.sequence),tail[20]);
    assert.equal(s.all('SELECT * FROM events').length,before.length+11);assert.equal(s.all('SELECT * FROM event_ranges').length,10);
    const member=tail[20]!;assert.deepEqual(s.transaction(()=>s.append(f.scope,{type:member.type,payload:member.payload} as EventBody,member.idempotencyKey)),member);
    assert.throws(()=>s.transaction(()=>s.append(f.scope,f.delta(1000),member.idempotencyKey)),/幂等/);
    (tail[20] as any).payload.text='外部对象修改';assert.notEqual((s.events(f.c.conversationId)[before.length+20] as any).payload.text,'外部对象修改');
  }finally{await f.close();}
});

test('事件分块：块插入/成员插入故障及重复唯一键，正文、身份、序号和投影整批回滚',async()=>{
 const f=fixture();try{
  const s=f.app.store,seed=s.snapshot(f.c.conversationId),events=s.events(f.c.conversationId);
  for(const [name,sql] of [['fail_block',"CREATE TRIGGER fail_block BEFORE INSERT ON event_blocks BEGIN SELECT RAISE(ABORT,'block-write-failed');END;"],['fail_member',"CREATE TRIGGER fail_member BEFORE INSERT ON event_ranges BEGIN SELECT RAISE(ABORT,'member-write-failed');END;"]] as const){
   s.db.exec(sql);assert.throws(()=>s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]),/write-failed/);
   assert.deepEqual(s.snapshot(f.c.conversationId),seed);assert.deepEqual(s.events(f.c.conversationId),events);assert.equal(s.all('SELECT id FROM event_blocks').length,0);s.db.exec('DROP TRIGGER '+name);
  }
  s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]);const deltaEvents=s.events(f.c.conversationId,seed.cursor);
  assert.throws(()=>new EventBlocks(s.db).write(deltaEvents),/事务内/);
  assert.throws(()=>s.transaction(()=>new EventBlocks(s.db).write(deltaEvents)),/UNIQUE|已被流批次占用/);assert.equal(s.all('SELECT id FROM event_blocks').length,1);
  assert.deepEqual(s.events(f.c.conversationId,seed.cursor),deltaEvents);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});

test('事件分块：单片及超出块容量的合法内容继续标量落盘，不引入新的文本拒绝限制',async()=>{
 const f=fixture();try{
  const s=f.app.store,seed=s.snapshot(f.c.conversationId);s.commitModelDeltas(f.scope,f.generation,[f.delta(0)]);
  const large='文'.repeat(370000);s.commitModelDeltas(f.scope,f.generation,[f.delta(1,large),f.delta(2,large)]);
  assert.equal(s.all('SELECT id FROM event_blocks').length,0);assert.deepEqual(s.events(f.c.conversationId,seed.cursor).map(e=>(e as any).payload.text),['中文🌱',large,large]);
 }finally{await f.close();}
});

test('事件分块：缺失块、坏压缩及错位指针明确失败，不能静默跳过或返回另一条事件',async()=>{
 for(const mode of ['missing','corrupt','offset']){
  const f=fixture();try{
   const s=f.app.store;s.transaction(()=>{s.append(f.scope,f.delta(0));s.append(f.scope,f.delta(1));});
   const old=s.events(f.c.conversationId).slice(-2);s.transaction(()=>{s.run('DELETE FROM events WHERE sequence>=?',BigInt(old[0]!.sequence));new EventBlocks(s.db).write(old);});const row=s.get(eventRow+' ORDER BY sequence DESC LIMIT 1')!;
   if(mode==='missing')s.run('DELETE FROM event_blocks');
   if(mode==='corrupt'){s.db.exec('DROP TRIGGER immutable_event_block');s.db.prepare("UPDATE event_blocks SET content=?").run(Buffer.from('bad'));}
   if(mode==='offset')row.payload=JSON.stringify({...JSON.parse(String(row.payload)),offset:0});
   assert.throws(()=>new EventBlocks(s.db).read(row),/缺失、损坏|身份不一致/);
  }finally{await f.close();}
 }
});

test('事件分块：重启从块中重建相同前缀，缓存缺失也沿唯一归约器追平',async()=>{
 const f=fixture();let next:SqliteStore|undefined;try{
  const s=f.app.store;s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]);
  const before=s.events(f.c.conversationId);s.db.exec('DELETE FROM conversation_projections');await f.app.close();
  next=new SqliteStore(join(f.root,'data'));await next.prepareProjection(f.c.conversationId);const events=next.events(f.c.conversationId);
  assert.deepEqual(events.slice(0,before.length),before);assert.equal(next.getRun(f.runId).status,'interrupted');
  assert.deepEqual(next.snapshot(f.c.conversationId),events.reduce(reduceConversation,initialState(f.c.conversationId,events[0]!.logEpoch)));
 }finally{next?.close();await f.close();}
});

test('事件分块：超过JS安全整数的序号仍按64位整数读取，块内游标不取整',async()=>{
 const f=fixture();try{
  const s=f.app.store;s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]);const original=s.events(f.c.conversationId).slice(-2),start=9007199254741000n;
  const events=original.map((e,i)=>({...e,eventId:uid(),idempotencyKey:uid(),sequence:(start+BigInt(i)).toString()}));
  s.transaction(()=>new EventBlocks(s.db).write(events));const blocks=new EventBlocks(s.db);
  for(const e of events){const row=s.get(eventRow+' WHERE event_id=?',e.eventId)!;assert.deepEqual(blocks.read(row),e);}
 }finally{await f.close();}
});

test('迁移10：只添加格式表，旧9事件字节、身份与迁移指纹保持；不自动压缩旧历史',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-block-migrate-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);
 let s=new SqliteStore(data);try{
  const c=s.createConversation(workspace);s.commit({conversationId:c.conversationId},{type:'settings.changed',payload:{version:1}});
  const rows=s.all('SELECT * FROM events'),fingerprints=s.all('SELECT * FROM schema_migrations WHERE version<=9');
  s.db.exec('DROP TABLE event_blocks;DELETE FROM schema_migrations WHERE version=10');s.close();s=new SqliteStore(data);
  assert.equal(s.databaseVersion,12);assert.deepEqual(s.all('SELECT * FROM events'),rows);assert.deepEqual(s.all('SELECT * FROM schema_migrations WHERE version<=9'),fingerprints);assert.equal(s.all('SELECT id FROM event_blocks').length,0);
 }finally{s.close();removeTestRoot(root);}
});

test('事件分块：压缩正文中的共享资料被保留，删块失败回滚整组，成功后无孤儿块',async()=>{
 const f=fixture();try{
  const s=f.app.store,other=f.app.createConversation(f.workspace),ref=s.artifact({text:'只被压缩片段引用的共享资料'});
  s.commitModelDeltas(f.scope,f.generation,[f.delta(0,JSON.stringify({ref})),f.delta(1)]);
  // 资料成为待删会话的候选，但仍被另一会话的压缩正文使用。
  s.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',uid(),other.conversationId,'候选资料','text/plain',1,ref);
  s.editConversation(other.conversationId,null,true);s.deleteArchivedConversation(other.conversationId);assert.deepEqual(s.readArtifact(ref),{text:'只被压缩片段引用的共享资料'});
  s.commit({conversationId:f.c.conversationId,runId:f.runId},{type:'run.stopped',payload:{reason:'停止以验证删除'}});const before=s.events(f.c.conversationId);
  s.db.exec("CREATE TRIGGER fail_block_delete BEFORE DELETE ON event_blocks BEGIN SELECT RAISE(ABORT,'block-delete-failed');END;");
  assert.throws(()=>s.deleteWorkspace(f.c.workspaceId),/block-delete-failed/);assert.deepEqual(s.events(f.c.conversationId),before);assert.equal(s.all('SELECT id FROM event_blocks').length,1);
  s.db.exec('DROP TRIGGER fail_block_delete');s.deleteWorkspace(f.c.workspaceId);assert.equal(s.all('SELECT id FROM event_blocks').length,0);assert.equal(s.all('SELECT * FROM events').length,0);assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});

for(const mode of ['committed','inflight'])test('事件分块：真实进程硬退出 '+mode,{timeout:20000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-block-crash-')),data=join(root,'data'),workspace=join(root,'workspace');mkdirSync(workspace);
 const child=fork(new URL('./event-blocks-crash-worker.js',import.meta.url),[data,workspace,mode],{stdio:['ignore','ignore','pipe','ipc']});let errors='',s:SqliteStore|undefined;
 child.stderr?.on('data',d=>errors+=String(d));try{
  const checkpoint=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors||'hard-exit checkpoint timeout')),12000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',code=>{clearTimeout(timer);reject(Error('worker exited '+code+' '+errors));});});
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;s=new SqliteStore(data);const events=s.events(checkpoint.conversationId),deltas=events.filter(e=>e.type==='model.delta');
  assert.equal(deltas.length,mode==='committed'?2:0);assert.equal(s.all('SELECT id FROM event_blocks').length,mode==='committed'?1:0);
  if(mode==='committed')assert.deepEqual(deltas,checkpoint.events);assert.equal(s.getRun(checkpoint.runId).status,'interrupted');assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 }finally{child.kill('SIGKILL');s?.close();removeTestRoot(root);}
});

test('投影保留：活动长流按批提交时不逐片写入完整会话投影',async()=>{
 const f=fixture();try{
  const s=f.app.store,prepare=s.db.prepare.bind(s.db);let projectionWrites=0;
  s.db.prepare=(sql:string)=>{if(/^INSERT INTO conversation_projections/.test(sql))projectionWrites++;return prepare(sql);};
  for(let start=0;start<640;start+=64)s.commitModelDeltas(f.scope,f.generation,Array.from({length:64},(_,i)=>f.delta(start+i)));
  assert.equal(projectionWrites,0);assert.equal(s.getRun(f.runId).status,'running');
  assert.equal(s.events(f.c.conversationId).filter(e=>e.type==='model.delta').length,640);
 }finally{await f.close();}
});

test('流范围：首片到尾片的幂等重取、冲突拒绝、旧标量与DB10块混读',async()=>{
 const f=fixture();try{
  const s=f.app.store,oldKeys=['old-key-0','old-key-1'];
  const old=s.transaction(()=>oldKeys.map((key,i)=>s.append(f.scope,f.delta(i,'旧格式'+i),key)));
  s.transaction(()=>{s.run('DELETE FROM events WHERE sequence>=?',BigInt(old[0]!.sequence));new EventBlocks(s.db).write(old);});
  s.commitModelDeltas(f.scope,f.generation,Array.from({length:64},(_,i)=>f.delta(i+2,'新格式'+i)));
  const stream=s.events(f.c.conversationId).filter(e=>e.type==='model.delta');
  assert.equal(stream.length,66);assert.equal(s.all('SELECT * FROM event_ranges').length,1);
  for(const e of stream)assert.deepEqual(s.transaction(()=>s.append(f.scope,{type:e.type,payload:e.payload} as EventBody,e.idempotencyKey)),e);
  assert.throws(()=>s.transaction(()=>s.append(f.scope,f.delta(1000),'umi-stream-v1/not-an-allocated-member')),/宿主批次/);
  assert.throws(()=>s.transaction(()=>s.append({...f.scope,modelTurnId:uid()},f.delta(3,'新格式1'),stream[3]!.idempotencyKey)),/幂等/);
  for(const e of stream.slice(2))assert.throws(()=>s.run('INSERT INTO events VALUES(?,?,?,?,?,?)',e.conversationId,e.logEpoch,BigInt(e.sequence),uid(),uid(),JSON.stringify(e)),/流批次占用|UNIQUE/);
  assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 }finally{await f.close();}
});

for(const mode of ['missing-range','wrong-range','bad-body'])test('流范围损坏拒绝：'+mode,async()=>{
 const f=fixture();try{
  const s=f.app.store,seed=s.snapshot(f.c.conversationId);s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]);
  if(mode==='missing-range')s.run('DELETE FROM event_ranges');
  if(mode==='wrong-range'){s.db.exec('DROP TRIGGER immutable_event_range');s.run('UPDATE event_ranges SET last_sequence=last_sequence+1');}
  if(mode==='bad-body'){s.db.exec('DROP TRIGGER immutable_event_block');s.db.prepare('UPDATE event_blocks SET content=?').run(Buffer.from('bad'));}
  assert.throws(()=>s.events(f.c.conversationId,seed.cursor),/缺失、损坏|身份不一致/);
 }finally{await f.close();}
});

test('流范围：尾部在批次内部时投影缓存可保存、加载，冷重建与逻辑事件完全一致',async()=>{
 const f=fixture();try{
  const s=f.app.store;s.commitModelDeltas(f.scope,f.generation,Array.from({length:17},(_,i)=>f.delta(i)));
  const state=s.snapshot(f.c.conversationId),events=s.events(f.c.conversationId);
  const {ConversationProjectionCache}=await import('../packages/adapters/src/sqlite/projection-cache.js');
  const cache=new ConversationProjectionCache(s.db);cache.save(state);
  assert.deepEqual(cache.load(f.c.conversationId,state.cursor.logEpoch,(BigInt(state.cursor.sequence)+1n).toString()),state);
  s.db.exec('DELETE FROM conversation_projections');(s as any).states.clear();await s.prepareProjection(f.c.conversationId);
  assert.deepEqual(s.snapshot(f.c.conversationId),state);assert.deepEqual(s.events(f.c.conversationId),events);
 }finally{await f.close();}
});

test('迁移12：旧DB11标量、DB10正文块与所有迁移指纹不改写，打开后原始事件逐字段相同',async()=>{
 const f=fixture();let next:SqliteStore|undefined;try{
  const s=f.app.store;const old=s.transaction(()=>[s.append(f.scope,f.delta(0)),s.append(f.scope,f.delta(1))]);
  s.transaction(()=>{s.run('DELETE FROM events WHERE sequence>=?',BigInt(old[0]!.sequence));new EventBlocks(s.db).write(old);});
  s.commit(f.scope,{type:'model.attempt_failed',payload:{code:'FIXTURE_FINISHED',reason:'迁移前结束模型尝试'}});
  s.commit({conversationId:f.c.conversationId,runId:f.runId},{type:'run.stopped',payload:{reason:'迁移前停止'}});
  const raw=s.all('SELECT * FROM events'),blocks=s.all('SELECT * FROM event_blocks'),events=s.events(f.c.conversationId),oldLedger=s.all('SELECT * FROM schema_migrations WHERE version<=11');
  s.db.exec('DROP TRIGGER event_scalar_range_insert;DROP TRIGGER event_range_insert;DROP TABLE event_ranges;DELETE FROM schema_migrations WHERE version=12');await f.app.close();
  next=new SqliteStore(join(f.root,'data'));assert.equal(next.databaseVersion,12);
  assert.deepEqual(next.all('SELECT * FROM events'),raw);assert.deepEqual(next.all('SELECT * FROM event_blocks'),blocks);
  assert.deepEqual(next.all('SELECT * FROM schema_migrations WHERE version<=11'),oldLedger);assert.deepEqual(next.events(f.c.conversationId),events);
  assert.equal(next.all('SELECT * FROM event_ranges').length,0);
 }finally{next?.close();await f.close();}
});

test('流范围：64位序号、批次内部点读和续读不经过JS浮点数',async()=>{
 const f=fixture();try{
  const s=f.app.store;s.commitModelDeltas(f.scope,f.generation,[f.delta(0),f.delta(1)]);
  const start=9007199254741000n,batch=uid(),events=s.events(f.c.conversationId).slice(-2).map((e,i)=>({...e,
    eventId:streamMemberKey(batch,i),idempotencyKey:streamMemberKey(batch,i),sequence:(start+BigInt(i)).toString()}));
  s.transaction(()=>new EventBlocks(s.db).write(events,batch));const blocks=new EventBlocks(s.db);
  for(const e of events)assert.deepEqual(blocks.at(e.conversationId,e.logEpoch,e.sequence),e);
  assert.deepEqual([...blocks.iterate(f.c.conversationId,events[0]!.logEpoch,start.toString(),(start+1n).toString())],[events[1]]);
 }finally{await f.close();}
});
