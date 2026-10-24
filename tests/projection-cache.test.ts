import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { WorkerCommandQueue } from '../apps/desktop/command-queue.js';
import { removeTestRoot } from './fixtures.js';

function fixture(count = 1200) {
  const root = mkdtempSync(join(tmpdir(), 'umi-projection-cache-')), data = join(root, 'data'), source = join(root, 'source');
  mkdirSync(source);
  let store = new SqliteStore(data);
  const c = store.createConversation(source);
  store.transaction(() => { for (let i = 1; i <= count; i++) store.append({ conversationId: c.conversationId }, { type: 'settings.changed', payload: { version: i } }); });
  const expected = store.snapshot(c.conversationId), events = store.events(c.conversationId);
  assert.deepEqual(expected, events.reduce(reduceConversation, initialState(c.conversationId, expected.cursor.logEpoch)));
  store.close();
  return { root, data, c, expected, events,
    open() { store = new SqliteStore(data); return store; },
    close() { store.close(); removeTestRoot(root); } };
}
function observeReplay(store: SqliteStore) {
  const prepare = store.db.prepare.bind(store.db), queries: string[] = [];
  store.db.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (/SELECT payload[^;]* FROM events/i.test(sql)) {
      const all = statement.all.bind(statement), iterate = statement.iterate.bind(statement);
      statement.all = (...args) => { queries.push(sql); return Reflect.apply(all, statement, args); };
      statement.iterate = (...args) => { queries.push(sql); return Reflect.apply(iterate, statement, args); };
    }
    return statement;
  };
  return queries;
}

test('投影缓存：重启后完整状态相同，无需再次扫描历史正文', async () => {
  const f = fixture();
  try {
    const store = f.open(), reads = observeReplay(store);
    await store.prepareProjection(f.c.conversationId);
    assert.deepEqual(store.snapshot(f.c.conversationId), f.expected);
    assert.equal(reads.length, 0);
    assert.deepEqual(store.events(f.c.conversationId), f.events);
    assert.equal(store.databaseVersion, 12);
  } finally { f.close(); }
});

for (const [label, sql] of [
  ['内容校验失败', "UPDATE conversation_projections SET state_hash='broken'"],
  ['旧归约版本', "UPDATE conversation_projections SET version='old'"],
  ['其他日志身份', "UPDATE conversation_projections SET log_epoch='foreign'"],
  ['尾部事件身份不符', "UPDATE conversation_projections SET event_id='foreign'"],
  ['序号超过原始日志', "UPDATE conversation_projections SET sequence='999999'"],
  ['完整缓存缺失', 'DELETE FROM conversation_projections'],
] as const) {
  test(`投影缓存：${label}回退原始历史，不丢失内容`, async () => {
    const f = fixture();
    try {
      const store = f.open(); store.db.exec(sql);
      const reads = observeReplay(store);
      await store.prepareProjection(f.c.conversationId);
      assert(reads.length > 0);
      assert.deepEqual(store.snapshot(f.c.conversationId), f.expected);
      assert.deepEqual(store.events(f.c.conversationId), f.events);
    } finally { f.close(); }
  });
}

test('投影缓存：未能刷新缓存时仍提交新事件，重启从旧缓存追加尾部', async () => {
  const f = fixture();
  try {
    let store = f.open();
    store.db.exec("CREATE TRIGGER refuse_cache_write BEFORE UPDATE ON conversation_projections BEGIN SELECT RAISE(ABORT,'cache unavailable'); END;");
    store.commit({ conversationId: f.c.conversationId }, { type: 'settings.changed', payload: { version: 1201 } });
    const expected = store.snapshot(f.c.conversationId);
    assert.equal(store.get('SELECT sequence FROM conversation_projections')!.sequence, '1200');
    store.close();
    store = f.open(); const reads = observeReplay(store);
    await store.prepareProjection(f.c.conversationId);
    assert(reads.length > 0);
    assert.deepEqual(store.snapshot(f.c.conversationId), expected);
    assert.equal(store.events(f.c.conversationId).length, 1201);
  } finally { f.close(); }
});

test('投影缓存：事务回滚不保存未提交状态或改变批准/历史事实', async () => {
  const f = fixture();
  try {
    const store = f.open();
    assert.throws(() => store.transaction(() => {
      store.append({ conversationId: f.c.conversationId }, { type: 'settings.changed', payload: { version: 1201 } });
      assert.equal(store.snapshot(f.c.conversationId).cursor.sequence, '1201');
      throw Error('rollback');
    }), /rollback/);
    await store.prepareProjection(f.c.conversationId);
    assert.deepEqual(store.snapshot(f.c.conversationId), f.expected);
    assert.equal(store.get('SELECT sequence FROM conversation_projections')!.sequence, '1200');
    assert.deepEqual(store.events(f.c.conversationId), f.events);
  } finally { f.close(); }
});

test('首次重建：让出线程后列表可响应，相同会话并发等待保持同一结果', async () => {
  const f = fixture(2200);
  try {
    const store = f.open(); store.db.exec('DELETE FROM conversation_projections');
    const queue = new WorkerCommandQueue(), order: string[] = [];
    const heavy = queue.dispatch(async () => {
      const first = store.prepareProjection(f.c.conversationId), second = store.prepareProjection(f.c.conversationId);
      await Promise.all([first, second]); order.push('history');
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    await queue.dispatch(async () => { assert.equal(store.listConversations().length, 1); order.push('list'); }, true);
    assert.deepEqual(order, ['list']);
    await heavy; assert.deepEqual(order, ['list', 'history']);
    assert.deepEqual(store.snapshot(f.c.conversationId), f.expected);
  } finally { f.close(); }
});

test('首次重建：让出线程期间新的权威提交不能被旧读取覆盖', async () => {
  const f = fixture(2200);
  try {
    const store = f.open(); store.db.exec('DELETE FROM conversation_projections');
    const reading = store.prepareProjection(f.c.conversationId);
    store.commit({ conversationId: f.c.conversationId }, { type: 'settings.changed', payload: { version: 2201 } });
    await reading;
    const state = store.snapshot(f.c.conversationId);
    assert.equal(state.cursor.sequence, '2201');
    assert.deepEqual(state, store.events(f.c.conversationId).reduce(reduceConversation, initialState(f.c.conversationId, state.cursor.logEpoch)));
  } finally { f.close(); }
});

test('投影缓存：永久删除会话同时删除派生缓存，不遗留个人历史副本', () => {
  const f = fixture();
  try {
    const store = f.open();
    assert.equal(store.all('SELECT * FROM conversation_projections').length, 1);
    store.editConversation(f.c.conversationId, null, true);
    store.deleteArchivedConversation(f.c.conversationId);
    assert.equal(store.all('SELECT * FROM conversation_projections').length, 0);
    assert.equal(store.all('PRAGMA foreign_key_check').length, 0);
  } finally { f.close(); }
});

test('冷授权通知只追加事实，不重建旧历史；重启按原归约器追平',async()=>{
 const f=fixture();try{
  let store=f.open();store.db.exec('DELETE FROM conversation_projections');const reads=observeReplay(store);
  const body={type:'workspace.access_changed' as const,payload:{grantId:'grant-test',revision:1,revoked:false}};
  store.commit({conversationId:f.c.conversationId},body);assert.equal(reads.length,0);store.close();store=f.open();
  await store.prepareProjection(f.c.conversationId);const state=store.snapshot(f.c.conversationId);assert.equal(state.cursor.sequence,'1201');
  assert.deepEqual(state,store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)));
 }finally{f.close();}
});

test('异步冷重建期间追加授权通知仍消费新尾部，事务失败不产生虚假通知',async()=>{
 const f=fixture(2200);try{
  const store=f.open();store.db.exec('DELETE FROM conversation_projections');const reading=store.prepareProjection(f.c.conversationId);
  const body={type:'workspace.access_changed' as const,payload:{grantId:'grant-test',revision:1,revoked:false}};
  assert.throws(()=>store.transaction(()=>{store.append({conversationId:f.c.conversationId},body);throw Error('rollback-notice');}),/rollback-notice/);
  store.commit({conversationId:f.c.conversationId},body);await reading;const state=store.snapshot(f.c.conversationId);assert.equal(state.cursor.sequence,'2201');
  assert.deepEqual(state,store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)));
 }finally{f.close();}
});

function residentIds(store: SqliteStore) {
  return [...(store as unknown as {states: Map<string,unknown>}).states.keys()];
}
function retainedMetadata(store: SqliteStore) {
  return (store as unknown as {projections: {saved: Map<string,unknown>}}).projections.saved.size;
}

test('投影保留：反复打开多会话只保留预算内非活动状态，淘汰后重建相同且元数据不累积',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-projection-retention-')),source=join(root,'source');mkdirSync(source);
  const store=new SqliteStore(join(root,'data'),undefined,{maxInactive:2,maxSerializedBytes:1024*1024});
  try {
    const conversations=Array.from({length:12},()=>store.createConversation(source));
    for(const c of conversations)store.transaction(()=>{for(let version=1;version<=30;version++)store.append({conversationId:c.conversationId},{type:'settings.changed',payload:{version}});});
    for(let round=0;round<3;round++)for(const c of conversations){
      await store.prepareProjection(c.conversationId);
      const state=store.snapshot(c.conversationId),events=store.events(c.conversationId);
      assert.deepEqual(state,events.reduce(reduceConversation,initialState(c.conversationId,state.cursor.logEpoch)));
      assert(residentIds(store).length<=2);assert(retainedMetadata(store)<=2);assert.equal(events.length,30);
    }
    assert.equal(store.all('SELECT count(*) n FROM conversation_projections')[0]!.n,12);
  } finally {store.close();removeTestRoot(root);}
});

test('投影保留：字节预算保留当前单个超大状态，旧状态可逐出且原始历史不变',()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-projection-byte-budget-')),source=join(root,'source');mkdirSync(source);
  const store=new SqliteStore(join(root,'data'),undefined,{maxInactive:8,maxSerializedBytes:1});
  try {
    const a=store.createConversation(source),b=store.createConversation(source);
    for(const c of [a,b])store.commit({conversationId:c.conversationId},{type:'settings.changed',payload:{version:1}});
    assert.deepEqual(residentIds(store),[b.conversationId]);
    assert.equal(store.snapshot(a.conversationId).cursor.sequence,'1');assert.deepEqual(residentIds(store),[a.conversationId]);
    assert.equal(store.events(b.conversationId).length,1);assert(retainedMetadata(store)<=1);
  } finally {store.close();removeTestRoot(root);}
});

test('投影保留：活动任务不逐出，结束后纳入预算；派生写入失败仍可从原始历史恢复',()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-projection-active-pin-')),source=join(root,'source');mkdirSync(source);
  const store=new SqliteStore(join(root,'data'),undefined,{maxInactive:1,maxSerializedBytes:1024*1024});
  try {
    const a=store.createConversation(source),b=store.createConversation(source),c=store.createConversation(source);
    const run=store.acceptInput(a.conversationId,'input','保留活动目标');store.claim(run.runId);
    store.db.exec("CREATE TRIGGER refuse_new_projection BEFORE INSERT ON conversation_projections BEGIN SELECT RAISE(ABORT,'cache unavailable'); END;");
    for(const item of [b,c])store.commit({conversationId:item.conversationId},{type:'settings.changed',payload:{version:1}});
    assert(residentIds(store).includes(a.conversationId));assert(residentIds(store).length<=2);
    store.commit({conversationId:a.conversationId,runId:run.runId},{type:'run.stopped',payload:{reason:'用户停止'}});
    const expected=store.snapshot(a.conversationId);
    store.commit({conversationId:b.conversationId},{type:'settings.changed',payload:{version:2}});
    assert(residentIds(store).length<=1);assert(!residentIds(store).includes(a.conversationId));
    assert.deepEqual(store.snapshot(a.conversationId),expected);assert.equal(store.getRun(run.runId).status,'stopped');
    assert.deepEqual(store.all('PRAGMA foreign_key_check'),[]);
  } finally {store.close();removeTestRoot(root);}
});

test('投影保留：冷重建期间的较新提交被固定，其他会话读取不能逐出或覆盖它',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-projection-rebuild-pin-')),source=join(root,'source');mkdirSync(source);
  const store=new SqliteStore(join(root,'data'),undefined,{maxInactive:1,maxSerializedBytes:1024*1024});
  try {
    const a=store.createConversation(source),b=store.createConversation(source);
    store.transaction(()=>{for(let version=1;version<=1500;version++)store.append({conversationId:a.conversationId},{type:'settings.changed',payload:{version}});});
    store.commit({conversationId:b.conversationId},{type:'settings.changed',payload:{version:1}});
    store.run('DELETE FROM conversation_projections WHERE conversation_id=?',a.conversationId);
    const reading=store.prepareProjection(a.conversationId);
    store.commit({conversationId:a.conversationId},{type:'settings.changed',payload:{version:1501}});
    store.commit({conversationId:b.conversationId},{type:'settings.changed',payload:{version:2}});
    assert(residentIds(store).includes(a.conversationId));await reading;
    const state=store.snapshot(a.conversationId);assert.equal(state.cursor.sequence,'1501');
    assert.deepEqual(state,store.events(a.conversationId).reduce(reduceConversation,initialState(a.conversationId,state.cursor.logEpoch)));
    assert(residentIds(store).length<=1);
  } finally {store.close();removeTestRoot(root);}
});
