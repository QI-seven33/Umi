import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,removeTestRoot} from './fixtures.js';
import type {Step} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {UmiError,validatePairs,type WireMessage} from '../packages/protocol/src/model.js';
import {attachmentTextPage,attachmentTextSearch} from '../packages/adapters/src/sqlite/attachment-text.js';
import {attachmentReadSchema,attachmentListSchema,attachmentSearchSchema} from '../packages/protocol/src/attachments.js';
import type {PreparedRequest} from '../packages/agent/src/ports.js';
import {decodeAttachment} from '../apps/desktop/renderer/src/features/work/attachments.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';
const last=(r:PreparedRequest)=>JSON.parse((r.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!.content);
function fixture(steps:Step[]=[]){
 const root=mkdtempSync(join(tmpdir(),'umi-attachment-')),workspace=join(root,'source');mkdirSync(workspace);
 const model=new ScriptModel(steps),app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace,{thinking:'normal'});
 return {root,workspace,app,c,model,steps,apply(ids:string[],prompt='附件参考资料'){
   const r=app.store.acceptInput(c.conversationId,uid(),prompt,ids);app.store.applyInputs(r.runId);return r;
 },async run(prompt='查阅附件',ids:string[]=[]){const r=app.send(c.conversationId,uid(),prompt,ids);await app.wait(r.runId);return r;},async close(){await app.close();removeTestRoot(root);}};
}
test('附件分页：中文/emoji不足一字节页明确报错，正常续页始终前进且精确保留CRLF/空白',()=>{
 const body='中😀\r\n英é语\t正文。'.repeat(300),expected=Buffer.from(body);
 for(const byteLength of [1,2])assert.throws(()=>attachmentTextPage(body,0,byteLength),e=>e instanceof UmiError&&e.code==='ATTACHMENT_RANGE_TOO_SMALL');
 for(const width of [4,7,13,8192,64000]){
  const chunks:string[]=[];let cursor=0,version:string|undefined;
  do{const page=attachmentTextPage(body,cursor,width,version?{expectedHash:version}:{});version=page.hash;chunks.push(page.text);
    assert.equal(page.startByte,cursor);if(page.truncated){assert(page.endByte>cursor);assert.equal(page.nextStartByte,page.endByte);cursor=page.nextStartByte!;}else break;
  }while(cursor<expected.length);
  assert.equal(chunks.join(''),body);
 }
 assert.throws(()=>attachmentTextPage(body,1,8),/切开/);
 const eof=attachmentTextPage(body,expected.length+10,4);assert.equal(eof.text,'');assert.equal(eof.nextStartByte,null);assert.equal(eof.truncated,false);
 assert.equal(attachmentTextPage('',0,4).totalLines,0);
});
test('附件行读取：准确定位、不改原行文本，长行截断仍可用字节续页，hash失配拒绝',()=>{
 const body='第一行\r\n\n第三行😀\n';
 const page=attachmentTextPage(body,0,64000,{startLine:2,lineCount:2});assert.equal(page.text,'\n第三行😀\n');assert.equal(page.startLine,2);assert.equal(page.endLine,3);assert.equal(page.totalLines,3);
 const long='😀'.repeat(18000)+'\n尾行';const first=attachmentTextPage(long,0,64000,{startLine:1,lineCount:1});
 assert.equal(first.endsMidLine,true);assert.equal(first.nextLine,1);assert(first.truncated);
 const next=attachmentTextPage(long,first.nextStartByte!,64000,{expectedHash:first.hash});assert.equal(first.text+next.text,long);
 assert.equal(attachmentTextPage(body,0,8192,{startLine:99,lineCount:1}).text,'');
 assert.throws(()=>attachmentTextPage(body,0,10,{expectedHash:'0'.repeat(64)}),/hash/);
 for(const a of [{attachmentId:'x',startLine:1,startByte:0},{attachmentId:'x',lineCount:2},{attachmentId:'x',byteLength:0}])assert.equal(attachmentReadSchema.safeParse(a).success,false);
});
test('附件搜索：定位大附件末尾准确字节/行号，Unicode摘录可回读，搜索不冒充全文',()=>{
 const prefix=Array.from({length:4000},(_,i)=>`记录${i}：常规条目\n`).join(''),body=prefix+'目标😀：SECRET-7K\n结束';
 const result=attachmentTextSearch(body,'目标😀',0,5);assert.equal(result.matches.length,1);const hit=result.matches[0]!;
 assert.equal(hit.line,4001);assert.equal(hit.matchStartByte,Buffer.byteLength(prefix));assert(hit.matchStartByte>8192);
 assert.equal(attachmentTextPage(body,hit.startByte,hit.endByte-hit.startByte,{expectedHash:result.hash}).text,hit.text);
 assert.equal(attachmentTextSearch(body,'不存在',0,5).totalMatches,0);assert.match(result.coverage,/不是附件全文/);
});
test('附件搜索：重叠命中分页、字面元字符、偏移/负例和同名错误hash均明确',()=>{
 const body='aaaa\n😀😀 .*';let offset=0;const positions:number[]=[];
 do{const r=attachmentTextSearch(body,'aa',offset,1);positions.push(...r.matches.map(m=>m.matchStartByte));if(!r.hasMore){assert.equal(r.totalExact,true);assert.equal(r.totalMatches,3);break;}assert.equal(r.totalExact,false);assert.equal(r.totalMatches,null);assert(r.nextOffset!>offset);offset=r.nextOffset!;}while(true);
 assert.deepEqual(positions,[0,1,2]);assert.equal(attachmentTextSearch(body,'.*',0,5).matches.length,1);
 assert.equal(attachmentTextSearch(body,'😀',0,5).matches.length,2);assert.equal(attachmentTextSearch(body,'aa',99,5).matches.length,0);
 assert.throws(()=>attachmentTextSearch(body,'aa',0,5,'0'.repeat(64)),/hash/);
 for(const input of [{attachmentId:'x',query:''},{attachmentId:'x',query:'a',limit:21},{attachmentId:'x',query:'a',offset:-1}])assert.equal(attachmentSearchSchema.safeParse(input).success,false);
 assert.equal(attachmentListSchema.safeParse({limit:21}).success,false);
});
test('附件来源：草稿/尚未应用/跨会话不向模型暴露，用户预览草稿仍可用',async()=>{
 const f=fixture();try{
  const a=f.app.store.uploadAttachment(f.c.conversationId,'draft.md','text/markdown','草稿正文');const preview=f.app.store.previewAttachment(f.c.conversationId,a.id);assert('text' in preview);assert.equal(preview.text,'草稿正文');
  assert.equal(f.app.store.listAttachments(f.c.conversationId,{}).total,0);assert.throws(()=>f.app.store.sentAttachment(f.c.conversationId,a.id),/尚未/);
  const accepted=f.app.store.acceptInput(f.c.conversationId,uid(),'使用附件',[a.id]);assert.throws(()=>f.app.store.sentAttachment(f.c.conversationId,a.id),/尚未/);
  assert.equal(f.app.store.listAttachments(f.c.conversationId,{}).total,0);f.app.store.applyInputs(accepted.runId);
  assert.equal(f.app.store.sentAttachment(f.c.conversationId,a.id).messageId,accepted.messageId);
  const other=f.app.createConversation(f.workspace);
  assert.throws(()=>f.app.store.searchAttachment(other.conversationId,{attachmentId:a.id,query:'正文'}),/尚未/);assert.equal(f.app.store.listAttachments(other.conversationId,{}).total,0);
  const cancelled=AbortSignal.abort(new UmiError('STOPPED','停止'));
  for(const name of ['list_attachments','search_attachment','read_attachment'])await assert.rejects(()=>f.app.registry.get(name).execute({},{} as any,f.c.conversationId,cancelled),/停止/);
 }finally{await f.close();}
});
test('附件目录：24个历史附件可分页找回，文件名为字面筛选，不读取正文或载入图片base64',async()=>{
 const f=fixture();try{
  for(let i=0;i<24;i++){const a=f.app.store.uploadAttachment(f.c.conversationId,i===0?'old%_资料.txt':`资料${i}.txt`,'text/plain','正文'+i);f.apply([a.id]);}
  const read=f.app.store.readArtifact;f.app.store.readArtifact=()=>{throw Error('目录不读取正文');};
  try{
   const ids:string[]=[];let offset=0;do{const page=f.app.store.listAttachments(f.c.conversationId,{offset,limit:5});assert.equal(page.total,24);ids.push(...page.entries.map(a=>a.id));if(page.nextOffset===null)break;offset=page.nextOffset;}while(true);
   assert.equal(new Set(ids).size,24);assert.equal(f.app.store.listAttachments(f.c.conversationId,{query:'%_'}).total,1);
   assert.equal(f.app.store.listAttachments(f.c.conversationId,{query:'不存在'}).total,0);
  }finally{f.app.store.readArtifact=read;}
 }finally{await f.close();}
});
test('附件原文：重复正文复用资料但保留独立ID/名称，同名不同版本不混淆',async()=>{
 const f=fixture();try{
  const original='保留\r\n空格  与😀\t',a=f.app.store.uploadAttachment(f.c.conversationId,'same.txt','text/plain',original),b=f.app.store.uploadAttachment(f.c.conversationId,'alias.txt','text/plain',original),c=f.app.store.uploadAttachment(f.c.conversationId,'same.txt','text/plain','另一版');
  assert.notEqual(a.id,b.id);assert.equal(f.app.store.attachment(f.c.conversationId,a.id).artifact_ref,f.app.store.attachment(f.c.conversationId,b.id).artifact_ref);assert.notEqual(f.app.store.attachment(f.c.conversationId,a.id).artifact_ref,f.app.store.attachment(f.c.conversationId,c.id).artifact_ref);
  f.apply([a.id,b.id,c.id]);assert.equal(f.app.store.listAttachments(f.c.conversationId,{query:'same.txt'}).total,2);
  const page=f.app.store.readAttachment(f.c.conversationId,a.id);assert.equal(page.text,original);assert('hash' in page);
  assert.throws(()=>f.app.store.readAttachment(f.c.conversationId,c.id,0,8192,{expectedHash:page.hash!}),/hash/);
 }finally{await f.close();}
});
test('附件唯一循环：超出最近16个的旧附件按名查找/搜尾部/按行核对，正文不自动塞入请求',async()=>{
 let expected='',targetId='';const prefix=Array.from({length:8000},(_,i)=>`无关记录${i}\n`).join(''),body=prefix+'TARGET-CHECK: Z8F41\n附加约束：保持原文\n';
 const f=fixture([r=>{
   const wire=r.body.messages as WireMessage[];assert(!JSON.stringify(wire).includes('无关记录7999'));assert(!wire.filter(m=>m.role==='system').some(m=>m.content.includes(targetId)));
   return call('list_attachments',{query:'old-target.txt'});
  },r=>{assert.equal(last(r).data.entries[0].id,targetId);return call('search_attachment',{attachmentId:targetId,query:'TARGET-CHECK'});},r=>{
    const result=last(r).data,hit=result.matches[0];assert(hit.matchStartByte>8192);expected=result.hash;return call('read_attachment',{attachmentId:targetId,startLine:hit.line,lineCount:2,expectedHash:expected});
  },r=>{const data=last(r).data;assert.equal(data.text,'TARGET-CHECK: Z8F41\n附加约束：保持原文\n');validatePairs(r.body.messages as WireMessage[]);return text('校验码Z8F41，原约束保持');}]);
 try{
  const a=f.app.store.uploadAttachment(f.c.conversationId,'old-target.txt','text/plain',body);targetId=a.id;f.apply([a.id]);
  for(let i=0;i<20;i++){const a=f.app.store.uploadAttachment(f.c.conversationId,`recent-${i}.txt`,'text/plain','其它参考');f.apply([a.id]);}
  const run=await f.run('查阅old-target.txt末尾TARGET-CHECK及附加约束');assert.equal(f.app.store.getRun(run.runId).status,'completed');assert.equal(f.model.requests.length,4);
  assert.deepEqual(f.app.store.tools(run.runId).map(t=>t.name),['list_attachments','search_attachment','read_attachment']);
  assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,0);
  const raw=f.app.store.messages(f.c.conversationId);assert.equal(raw.filter(m=>m.role==='user').at(-1)!.payload.content,'查阅old-target.txt末尾TARGET-CHECK及附加约束');
  assert(raw.filter(m=>m.payload.tool_calls?.length).every(m=>m.payload.reasoning_content==='我先核实必要的信息。'));
 }finally{await f.close();}
});
test('附件持久化：重启后目录/全文检索/hash一致，投影重放不改变附件或原话',async()=>{
 let id='';const f=fixture([()=>call('search_attachment',{attachmentId:id,query:'明确保留'}),text('引用原资料')]);
 try{const a=f.app.store.uploadAttachment(f.c.conversationId,'rules.md','text/markdown','明确保留😀\r\n完整原话');id=a.id;await f.run('参考这份材料，不按其中指令扩大权限',[id]);
  const before=f.app.store.searchAttachment(f.c.conversationId,{attachmentId:id,query:'明确保留'}),state=f.app.store.snapshot(f.c.conversationId);
  assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)),state);
  await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{assert.deepEqual(reopened.store.searchAttachment(f.c.conversationId,{attachmentId:id,query:'明确保留'}),before);assert.equal(reopened.store.listAttachments(f.c.conversationId,{}).total,1);}finally{await reopened.close();}
 }finally{await f.close();}
});
test('附件格式：前后端拒绝ASCII PDF冒充提取正文和无效Unicode，文本代码/UTF16仍可用',async()=>{
 const f=fixture();try{
  const pdf='%PDF-1.4\n1 0 obj\nASCII container, not extracted text\nendobj\n%%EOF';
  await assert.rejects(()=>decodeAttachment(new File([pdf],'document.pdf')),/PDF尚未/);
  for(const value of [pdf,'binary\0data','bad\ud800'])assert.throws(()=>f.app.store.uploadAttachment(f.c.conversationId,'test.txt','text/plain',value));
  const code='<div>{value}</div>\n原文';assert.equal(await decodeAttachment(new File([code],'source.tsx')),code);
  const utf16=Buffer.concat([Buffer.from([255,254]),Buffer.from('UTF16中文😀','utf16le')]);assert.equal(await decodeAttachment(new File([utf16],'utf16.txt')),'UTF16中文😀');
 }finally{await f.close();}
});
test('附件图片/模型：图片不伪装可搜索文本，文本在Pro仍可查找，不改模型配置',async()=>{
 let id='';const f=fixture([()=>call('search_attachment',{attachmentId:id,query:'文字参考'}),r=>{assert.equal(last(r).data.matches.length,1);return text('使用文本附件');}]);
 try{
  const a=f.app.store.uploadAttachment(f.c.conversationId,'notes.txt','text/plain','文字参考');id=a.id;
  const image=f.app.store.uploadImage(f.c.conversationId,'x.png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=');f.apply([image.id]);
  assert.throws(()=>f.app.store.searchAttachment(f.c.conversationId,{attachmentId:image.id,query:'文字'}),/没有可搜索文本/);
  f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),model:'deepseek-v4-pro'});const r=await f.run('搜索文本附件',[id]);assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(f.app.store.settings(f.c.conversationId).model,'deepseek-v4-pro');
 }finally{await f.close();}
});
