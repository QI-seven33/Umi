import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {CommandGate} from '../apps/desktop/renderer/src/features/work/CommandGate.js';
import {decodeAttachment,insertPlainText} from '../apps/desktop/renderer/src/features/work/attachments.js';
import {asTextDocument,documentInstruction} from '../apps/desktop/renderer/src/features/work/longInput.js';
import {Timeline,fileTargetKey} from '../apps/desktop/renderer/src/Timeline.js';
import {reduceConversation,initialState} from '../packages/protocol/src/reducer.js';
import {uid} from '../packages/agent/src/identity.js';
import type {PreparedRequest} from '../packages/agent/src/ports.js';
import {ScriptModel,call,text,eventually,removeTestRoot} from './fixtures.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {estimateInput} from '../packages/agent/src/context/estimate.js';

function fixture(model:ScriptModel){const root=mkdtempSync(join(tmpdir(),'umi-interaction-')),workspace=join(root,'workspace');mkdirSync(workspace);const app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace);return {root,workspace,app,c,service:new DesktopService(app),async close(){await app.close();removeTestRoot(root);}};}
test('I01：文本上传保留 JSX 与中文，允许无后缀文本和 UTF-16，拒绝二进制和超限文件',async()=>{
  const code='<span>{mode === "chat" ? "Chat" : mode === "lite" ? "Work" : "Studio"}</span>\n中文';
  assert.equal(await decodeAttachment(new File([code],'source.rs')),code);
  assert.equal(await decodeAttachment(new File([code],'README')),code);
  const utf16=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('你好','utf16le')]);
  assert.equal(await decodeAttachment(new File([utf16],'note.txt')),'你好');
  await assert.rejects(()=>decodeAttachment(new File([new Uint8Array([0x89,0x50,0x4e,0x47])],'screenshot.png')),/不是 UTF/);
  await assert.rejects(()=>decodeAttachment(new File(['x'.repeat(1_000_001)],'large.txt')),/1 MB/);
});
test('I02：粘贴纯文本仅替换选择范围，模板表达式不被 React 对象化',()=>{
  const code='<span>{mode === "chat" ? "Chat" : "Work"}</span>';
  const result=insertPlainText('前缀被替换后缀',2,5,code);
  assert.equal(result.value,`前缀${code}后缀`);assert.equal(result.caret,2+code.length);
});
test('I03：20 次并发提交只取得一份请求，重复回执核对不产生新消息',async()=>{
  const f=fixture(new ScriptModel([text('收到。')])),gate=new CommandGate(),commandId=uid();let releases:()=>void=()=>{};
  const pending=new Promise<void>(resolve=>{releases=resolve;});let sends=0;
  const submit=async()=>{const unlock=gate.acquire(f.c.conversationId);if(!unlock)return;try{await pending;sends++;await f.service.handle(desktopCommandSchema.parse({type:'send',conversationId:f.c.conversationId,commandId,text:'同一份请求'}));}finally{unlock();}};
  try{const attempts=Array.from({length:20},submit);releases();await Promise.all(attempts);assert.equal(sends,1);const original=f.app.store.messages(f.c.conversationId).find(m=>m.role==='user')!;await f.app.wait(original.runId);
    await f.service.handle(desktopCommandSchema.parse({type:'send',conversationId:f.c.conversationId,commandId,text:'同一份请求'}));assert.equal(f.app.store.messages(f.c.conversationId).filter(m=>m.role==='user').length,1);
  }finally{await f.close();}
});
test('I04：工具结算后的完整回复不重新请求总结，正文仅出现一次且重放一致',async()=>{
  const model=new ScriptModel([call('search_history',{query:'天气'},'我先查资料。'),text('这是完整答复。')]),f=fixture(model);
  try{const receipt=f.app.send(f.c.conversationId,uid(),'查天气');await f.app.wait(receipt.runId);assert.equal(model.requests.length,2);const state=f.app.store.snapshot(f.c.conversationId);
    assert.equal(state.blocks.filter(b=>b.kind==='text'&&b.displayRole==='final').length,1);assert.equal(state.blocks.filter(b=>b.text==='这是完整答复。').length,1);
    assert.deepEqual(f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch)),state);
    const html=renderToStaticMarkup(createElement(Timeline,{snapshot:f.service.snapshot(f.c.conversationId),onPreview:()=>{},onError:()=>{}}));assert.equal(html.split('这是完整答复。').length-1,1);
  }finally{await f.close();}
});
test('I05：归档恢复只修改会话视图，重启后原事件、工作环境和消息不变',async()=>{
  const f=fixture(new ScriptModel([text('原回复。')]));
  try{const receipt=f.app.send(f.c.conversationId,uid(),'原问题');await f.app.wait(receipt.runId);const events=f.app.store.events(f.c.conversationId),state=f.app.store.snapshot(f.c.conversationId);
    await f.service.handle(desktopCommandSchema.parse({type:'archive',conversationId:f.c.conversationId}));assert.equal((await f.service.handle(desktopCommandSchema.parse({type:'list'})) as unknown[]).length,0);
    assert.equal((await f.service.handle(desktopCommandSchema.parse({type:'list',archived:true})) as unknown[]).length,1);
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{const service=new DesktopService(reopened);await service.handle(desktopCommandSchema.parse({type:'restore',conversationId:f.c.conversationId}));assert.equal(reopened.store.listConversations().length,1);assert.deepEqual(reopened.store.events(f.c.conversationId),events);assert.deepEqual(reopened.store.snapshot(f.c.conversationId),state);assert.equal(reopened.store.conversation(f.c.conversationId).environment_id,f.c.environmentId);}finally{await reopened.close();}
  }finally{await f.close();}
});
test('I06：交付卡片读取批准所绑定的冻结范围，旧 JSON 不进入展示，写回仍核验源文件',async()=>{
  let mountId='';const lastData=(request:PreparedRequest)=>JSON.parse((request.body.messages as {role:string;content:string}[]).filter(m=>m.role==='tool').at(-1)!.content).data;
  const f=fixture(new ScriptModel([()=>call('write_file',{mountId,path:'result.txt',content:'冻结正文'}),()=>call('build_changeset',{mountId}),request=>call('deliver_changeset',{changeSetId:lastData(request).changeSetId}),text('写回冲突，未覆盖。')]));
  try{const mount=f.app.files.repo.mounts(f.c.environmentId)[0]!;mountId=mount.id;const receipt=f.app.send(f.c.conversationId,uid(),'写文件并交付');const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending'));
    const detail=await f.service.handle(desktopCommandSchema.parse({type:'approval_detail',conversationId:f.c.conversationId,approvalId:approval[0]})) as any;
    assert.equal(detail.preview.changes[0].afterText,'冻结正文');assert.equal(detail.preview.changes[0].path,'result.txt');assert.equal(detail.preview.targetDirectory,f.workspace);
    const snapshot=f.service.snapshot(f.c.conversationId);snapshot.state=structuredClone(snapshot.state);snapshot.state.approvals[approval[0]]!.description='旧描述：'+JSON.stringify(detail.preview);
    const html=renderToStaticMarkup(createElement(Timeline,{snapshot,onPreview:()=>{},onError:()=>{}}));assert(!html.includes('冻结正文'));assert(!html.includes('beforeContentHash'));assert(!html.includes('旧描述'));
    writeFileSync(join(f.workspace,'result.txt'),'外部新文件');f.app.approve(f.c.conversationId,approval[0],'allow');await f.app.wait(receipt.runId);assert.equal(readFileSync(join(f.workspace,'result.txt'),'utf8'),'外部新文件');assert.notEqual(f.app.store.tools(receipt.runId).find(t=>t.name==='deliver_changeset')!.state,'succeeded');
    await assert.rejects(()=>f.service.handle(desktopCommandSchema.parse({type:'approval_detail',conversationId:f.c.conversationId,approvalId:'foreign'})),/不属于/);
  }finally{await f.close();}
});
test('I07：长输入转换为文本载体，短代码不转换，提示指向完整原文而非摘要',()=>{
  assert.notEqual(fileTargetKey({mountId:'attachment',path:'已粘贴的文本.txt',attachmentId:'a'}),fileTargetKey({mountId:'attachment',path:'已粘贴的文本.txt',attachmentId:'b'}));
  assert.notEqual(fileTargetKey({mountId:'m',path:'config.json',changeSetId:'old'}),fileTargetKey({mountId:'m',path:'config.json',changeSetId:'new'}));
    assert.equal(asTextDocument('<span>{mode === "chat" ? "Chat" : "Work"}</span>'),false);
    assert.equal(asTextDocument('中文'.repeat(3000)),true);
    assert.equal(asTextDocument(Array.from({length:120},()=>'<div/>').join('\n')),true);
    assert(documentInstruction('长消息.txt').includes('完整用户消息'));
});
test('I08：图片按身份持久化，Flash 每轮输入带图片，历史重开一致，Pro 拒绝新图片',async()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9kAAAAASUVORK5CYII=';
  const model=new ScriptModel([text('看到了图片。'),text('继续依据这张图片。')]),f=fixture(model);
  try{const image=f.app.store.uploadImage(f.c.conversationId,'test.png',png),first=f.app.send(f.c.conversationId,uid(),'查看图片',[image.id]);await f.app.wait(first.runId);
    const messages=model.requests[0]!.body.messages as any[];assert.equal(messages.find(m=>m.role==='user').images[0].dataUrl,`data:image/png;base64,${png}`);
    const adapter=new DeepSeekAdapter(()=>''),request=adapter.prepare(messages,[],f.app.store.settings(f.c.conversationId),1024);
    const user=(request.body.messages as any[]).find(m=>m.role==='user');assert.equal(user.content[1].type,'image_url');assert.equal(user.images,undefined);assert.equal(user.content[0].text,'查看图片');
    const actual=f.service.snapshot(f.c.conversationId);assert.equal(actual.messages[0]!.attachments[0]!.mime,'image/png');assert(!JSON.stringify(actual).includes(png));assert.equal(actual.state.context.metrics!.estimateBasis,'utf8-vision-v2');
    const second=f.app.send(f.c.conversationId,uid(),'继续');await f.app.wait(second.runId);assert((model.requests[1]!.body.messages as any[]).some(m=>m.images?.length));
    const before=f.app.store.previewAttachment(f.c.conversationId,image.id);await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{assert.deepEqual(reopened.store.previewAttachment(f.c.conversationId,image.id),before);reopened.store.updateSettings(f.c.conversationId,{...reopened.store.settings(f.c.conversationId),model:'deepseek-v4-pro'});const next=reopened.store.uploadImage(f.c.conversationId,'next.png',png);assert.throws(()=>reopened.send(f.c.conversationId,uid(),'Pro 看图片',[next.id]),/不支持图片/);}finally{await reopened.close();}
  }finally{await f.close();}
});
test('I09：图片预算使用图像上界而非 base64 长度，文本 data URL 不被误扣除',()=>{
  const dataUrl='data:image/png;base64,'+'A'.repeat(100_000);
  const request={messages:[{role:'user',content:[{type:'text',text:'图片'},{type:'image_url',image_url:{url:dataUrl}}]}]};
  assert(estimateInput(request)<2000);assert(estimateInput({messages:[{role:'user',content:dataUrl}]})>100_000);
});
