import {ApprovalCard} from '../apps/desktop/renderer/src/ApprovalCard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {Timeline} from '../apps/desktop/renderer/src/Timeline.js';
import {processItems,activityLabel} from '../apps/desktop/renderer/src/activity.js';
import {initialState,reduceConversation} from '../packages/protocol/src/reducer.js';
import {uid} from '../packages/agent/src/identity.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ScriptModel,text,call,eventually,removeTestRoot} from './fixtures.js';

function setup(model:ScriptModel){const root=mkdtempSync(join(tmpdir(),'umi-ui-flow-')),workspace=join(root,'workspace');mkdirSync(workspace);const app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace);return {root,app,c,service:new DesktopService(app),async close(){await app.close();removeTestRoot(root);}};}
function markup(f:ReturnType<typeof setup>){return renderToStaticMarkup(createElement(Timeline,{snapshot:f.service.snapshot(f.c.conversationId),onPreview:()=>{},onError:()=>{}}));}

test('UI-01：无需工具的答复只请求一次，完成事件选择同一正文，实时和历史一致',async()=>{
  const model=new ScriptModel([text('你好！有什么需要我帮忙的？')]),f=setup(model);
  try{const r=f.app.send(f.c.conversationId,uid(),'你好');await f.app.wait(r.runId);assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(model.requests.length,1);assert.equal(f.app.store.tools(r.runId).length,0);
    const state=f.app.store.snapshot(f.c.conversationId),blocks=state.blocks.filter(b=>b.runId===r.runId&&b.kind==='text');assert.equal(blocks.length,1);assert.equal(blocks[0]!.displayRole,'final');assert.equal(blocks[0]!.text,'你好！有什么需要我帮忙的？');
    const replay=f.app.store.events(f.c.conversationId).reduce(reduceConversation,initialState(f.c.conversationId,state.cursor.logEpoch));assert.deepEqual(replay,state);
    const html=markup(f);assert(html.includes('你好！'));assert(!html.includes('执行过程'));assert(!html.includes('正在思考'));assert(!html.includes('项操作'));assert(html.includes('message-stack'));assert.equal(html.split('dateTime=').length-1,2);
    const request=JSON.stringify(model.requests[0]!.body);assert(request.includes('无需工具的寒暄'));assert(request.includes('不是需要复述的回复模板'));
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{assert.deepEqual(reopened.store.snapshot(f.c.conversationId),state);}finally{await reopened.close();}
  }finally{await f.close();}
});

test('UI-02：已有工作副本和前轮工具不会迫使新的寒暄再请求总结',async()=>{
  const model=new ScriptModel([call('search_history',{query:'查找'}),text('已找到原始要求。'),text('你好！')]),f=setup(model);
  try{const first=f.app.send(f.c.conversationId,uid(),'查找历史');await f.app.wait(first.runId);assert.equal(model.requests.length,2);
    const second=f.app.send(f.c.conversationId,uid(),'你好');await f.app.wait(second.runId);assert.equal(model.requests.length,3);assert.equal(f.app.store.tools(second.runId).length,0);assert.equal(f.app.store.getRun(second.runId).status,'completed');
  }finally{await f.close();}
});

test('UI-03：批准阻塞保持阶段正文，工具与思考分段按事实排序，完成后才收起',async()=>{
  const f=setup(new ScriptModel([call('write_scratch',{relativePath:'a.txt',content:'test'},'我先准备这份文件。'),text('文件已完成。')]));
  try{const r=f.app.send(f.c.conversationId,uid(),'创建资料'),approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending'));
    const waiting=f.app.store.snapshot(f.c.conversationId),items=processItems(waiting,r.runId);assert.deepEqual(items.map(i=>i.kind),['activity','text','activity']);const last=items.at(-1)!;assert(last.kind==='activity');assert.equal(activityLabel(last.items,waiting),'等待你的批准');
    const html=markup(f);assert(html.includes('我先准备这份文件'));assert(html.includes('等待你的批准'));assert(!html.includes('umi-approval'));const card=renderToStaticMarkup(createElement(ApprovalCard,{id:approval[0],state:waiting,conversationId:f.c.conversationId,onPreview:()=>{},onError:()=>{}}));assert(card.includes('确认本次操作'));assert(card.includes('a.txt'));assert(!html.includes('文件已完成'));assert(!html.includes('第 1 轮'));assert(!html.includes('项操作'));
    f.app.approve(f.c.conversationId,approval[0],'allow');await f.app.wait(r.runId);const complete=markup(f);assert(complete.includes('本轮结束，用时'));assert(complete.includes('文件已完成'));assert(!complete.includes('我先准备这份文件'));assert(complete.includes('aria-expanded="false"'));
  }finally{await f.close();}
});

test('UI-04：分段不把失败当成功，不隐藏 reasoning 的 attempt 身份',async()=>{
  const f=setup(new ScriptModel([call('write_scratch',{relativePath:'a.txt',content:'test'}),text('已经收到拒绝。'),text('没有写入文件。')]));
  try{const r=f.app.send(f.c.conversationId,uid(),'创建资料'),approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending'));f.app.approve(f.c.conversationId,approval[0],'deny');await f.app.wait(r.runId);
    const state=f.app.store.snapshot(f.c.conversationId),items=processItems(state,r.runId),groups=items.filter(i=>i.kind==='activity');assert(groups.some(g=>activityLabel(g.items,state)==='操作已拒绝'));assert(!groups.some(g=>activityLabel(g.items,state).includes('已写入')));
    assert(groups.flatMap(g=>g.items).filter(i=>i.kind==='reasoning').every(i=>i.block.turnId&&i.block.attemptId));
  }finally{await f.close();}
});

test('UI-05：无工具完整响应前的流式正文不被提前标为最终回复',async()=>{
  const model=new ScriptModel([text('正在解释这个问题。')]),f=setup(model);let release:()=>void=()=>{};model.beforeResponse=()=>new Promise<void>(r=>{release=r;});
  try{const r=f.app.send(f.c.conversationId,uid(),'解释一下');await eventually(()=>f.app.store.snapshot(f.c.conversationId).blocks.find(b=>b.text==='正在解释这个问题。'));
    assert(!f.app.store.snapshot(f.c.conversationId).blocks.some(b=>b.displayRole==='final'));assert(markup(f).includes('正在解释这个问题'));release();await f.app.wait(r.runId);assert.equal(f.app.store.snapshot(f.c.conversationId).blocks.find(b=>b.kind==='text')!.displayRole,'final');
  }finally{release();await f.close();}
});

// 型号日期是显示信息；实际请求及持久化继续使用官方路由，不能将显示名称发给 API。
test('UI-06：模型切换保存 API ID，下一轮请求与重新打开的会话保持一致',async()=>{
  const model=new ScriptModel([text('Pro 回复'),text('Flash 回复')]),adapter=new DeepSeekAdapter(()=> 'local-test-only');
  model.prepare=adapter.prepare.bind(adapter);
  const f=setup(model);
  try{
    for(const id of ['deepseek-v4-pro','deepseek-flash'] as const){
      await f.service.handle({type:'settings',conversationId:f.c.conversationId,settings:{...f.app.store.settings(f.c.conversationId),model:id,thinking:'high'}});
      assert.equal(f.service.snapshot(f.c.conversationId).settings.model,id);
      const run=f.app.send(f.c.conversationId,uid(),'请回复一句话');await f.app.wait(run.runId);
      assert.equal(f.app.store.getRun(run.runId).status,'completed');
      const request=model.requests.at(-1)!;assert.equal(request.model,id);assert.equal(request.body.model,id);assert.equal(request.body.reasoning_effort,'high');
    }
    await f.app.close();const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    try{assert.equal(reopened.store.settings(f.c.conversationId).model,'deepseek-flash');assert.equal(reopened.store.settings(f.c.conversationId).thinking,'high');}finally{await reopened.close();}
  }finally{await f.close();}
});
