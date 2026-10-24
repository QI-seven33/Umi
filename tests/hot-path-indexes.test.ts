import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStore} from '../packages/adapters/src/sqlite/store.js';
import {DirectFileRepository} from '../packages/adapters/src/sqlite/direct-files.js';
import {removeTestRoot} from './fixtures.js';

test('许可输入定位保留待应用新输入，按事件顺序区分run与会话',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-latest-input-')),workspace=join(root,'source');mkdirSync(workspace);
 const s=new SqliteStore(join(root,'data'),()=> '2026-10-24T00:00:00.000Z');
 try{
  const c=s.createConversation(workspace),other=s.createConversation(workspace);
  assert.equal(s.latestUserInputId(c.conversationId,'not-a-run'),'');
  const first=s.acceptInput(c.conversationId,'input-1','原要求');
  const second=s.acceptInput(c.conversationId,'input-2','尚未应用的新要求');
  const unrelated=s.acceptInput(other.conversationId,'other-1','其他会话');
  assert.equal(first.runId,second.runId);
  assert.equal(s.get('SELECT applied FROM messages WHERE id=?',second.messageId)!.applied,0);
  assert.equal(s.latestUserInputId(c.conversationId,first.runId),second.messageId);
  assert.equal(s.latestUserInputId(other.conversationId,unrelated.runId),unrelated.messageId);
  assert.equal(s.latestUserInputId(c.conversationId,unrelated.runId),'');
 }finally{s.close();removeTestRoot(root);}
});

test('迁移11只加索引，旧事件/资料/迁移指纹不变，内容相同的资料身份仍独立',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-hot-migration-')),workspace=join(root,'source'),data=join(root,'data');mkdirSync(workspace);
 let s=new SqliteStore(data);
 try{
  const c=s.createConversation(workspace);s.acceptInput(c.conversationId,'input','保留原始要求');
  const a=s.artifact({text:'相同正文'}),b=s.artifact({text:'相同正文'});assert.notEqual(a,b);
  const files=new DirectFileRepository(s),ref=files.content(Buffer.from('备份正文'));
  assert.equal(files.content(Buffer.from('备份正文')),ref);
  const events=s.all('SELECT * FROM events'),artifacts=s.all('SELECT * FROM artifacts'),old=s.all('SELECT * FROM schema_migrations WHERE version<=10');
  const indexes=s.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'hot_%'");
  for(const row of indexes)s.db.exec('DROP INDEX "'+String(row.name)+'"');
  s.db.exec('DELETE FROM schema_migrations WHERE version=11');s.close();s=new SqliteStore(data);
  assert.equal(s.databaseVersion,12);
  assert.deepEqual(s.all('SELECT * FROM events'),events);assert.deepEqual(s.all('SELECT * FROM artifacts'),artifacts);
  assert.deepEqual(s.all('SELECT * FROM schema_migrations WHERE version<=10'),old);
  assert.equal(s.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'hot_%'").length,indexes.length);
  assert.deepEqual(s.all('PRAGMA foreign_key_check'),[]);
 }finally{s.close();removeTestRoot(root);}
});
