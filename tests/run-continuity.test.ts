import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { DesktopService } from '../apps/desktop/service.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { UmiError, validatePairs, type WireMessage } from '../packages/protocol/src/model.js';
import { uid } from '../packages/agent/src/identity.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';
import { ScriptModel, text, call, removeTestRoot } from './fixtures.js';

function fixture(model: ScriptModel, options: ConstructorParameters<typeof UmiApplication>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'umi-continuity-')), source = join(root, 'source');
  mkdirSync(source);
  const app = new UmiApplication(join(root,'data'), model, options), c = app.createConversation(source);
  return {root,source,app,c,async close(){await app.close();removeTestRoot(root);}};
}
const history = (app: UmiApplication, cid: string) => app.store.messages(cid).filter(m=>m.applied).map(m=>m.payload);
function html(app: UmiApplication, cid: string) {
  return renderToStaticMarkup(createElement(Timeline, {snapshot:new DesktopService(app).snapshot(cid),onPreview:()=>{},onError:()=>{}}));
}

test('运行连续性：默认超过24次请求仍完成，普通最终答复不增加总结请求', async()=>{
  const model = new ScriptModel([...Array.from({length:26},(_,i)=>call('search_history',{query:'独立查询'+i},'查看相关资料',uid())),text('已完成这些查询。')]);
  const f=fixture(model);
  try {
    const receipt=f.app.send(f.c.conversationId,uid(),'查询资料');
    assert.equal((await f.app.wait(receipt.runId)).status,'completed');
    assert.equal(model.requests.length,27);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[receipt.runId]!.failureSummary,undefined);
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.outputBudget.limit,null);
    validatePairs(history(f.app,f.c.conversationId));
  } finally {await f.close();}
});

test('运行说明：只有思考不能成功，错误有正文且重开后原样可见',async()=>{
  const model=new ScriptModel([{role:'assistant',content:'',reasoning_content:'正在考虑实现。'},{role:'assistant',content:'',reasoning_content:'仍在考虑实现。'}]),f=fixture(model);
  try {
    const r=f.app.send(f.c.conversationId,uid(),'请完成操作');await f.app.wait(r.runId);
    const state=f.app.store.snapshot(f.c.conversationId),notice=state.runs[r.runId]!.failureSummary!;
    assert.equal(state.runs[r.runId]!.status,'failed');assert.match(notice.text,/模型未给出可用正文/);
    assert.equal(model.requests.length,2);assert.match(html(f.app,f.c.conversationId),/Umi 执行说明/);
    assert.equal(history(f.app,f.c.conversationId).find(m=>m.reasoning_content)?.reasoning_content,'正在考虑实现。');
    await f.app.close();
    const reopened=new UmiApplication(join(f.root,'data'),new ScriptModel([]));
    try {assert.deepEqual(reopened.store.snapshot(f.c.conversationId),state);assert.match(html(reopened,f.c.conversationId),/模型未给出可用正文/);}finally{await reopened.close();}
  } finally {await f.close();}
});

class InterruptingModel extends ScriptModel {
  override async *stream(request:PreparedRequest,_signal:AbortSignal):AsyncGenerator<ModelFrame> {
    this.requests.push(request);
    yield {kind:'delta',channel:'reasoning',key:'r',text:'已生成的思考保留。'};
    throw new UmiError('PROVIDER_INTERRUPTED','离线连接中断',true);
  }
}
test('运行说明：连接中断主动解释，继续完成后仍能看见原中断记录',async()=>{
  const model=new InterruptingModel([]),f=fixture(model);
  try {
    const r=f.app.send(f.c.conversationId,uid(),'处理任务');await f.app.wait(r.runId);
    const notice=f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummary!;
    assert.match(notice.text,/离线连接中断/);assert.equal(model.requests.length,1);
    // 使用同一端口的后续实现，不丢失第一次模型请求的记录。
    const next=new ScriptModel([text('继续后的答复。')]);model.stream=next.stream.bind(next);
    const continued=f.app.send(f.c.conversationId,uid(),'继续');assert.equal(continued.runId,r.runId);
    assert.equal((await f.app.wait(r.runId)).status,'completed');
    assert.match(html(f.app,f.c.conversationId),/离线连接中断/);assert.match(html(f.app,f.c.conversationId),/继续后的答复/);
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummaries!.length,1);
    validatePairs(history(f.app,f.c.conversationId));
  } finally {await f.close();}
});

test('运行说明：用户停止保留目标和原片段，不请求模型收尾',async()=>{
  const model=new ScriptModel([text('不应提交的正文')]),f=fixture(model);
  try {
    model.beforeResponse=async()=>{const id=f.app.store.environment(f.c.environmentId).active_run_id!;f.app.requestStop(f.c.conversationId,id);};
    const r=f.app.send(f.c.conversationId,uid(),'开始操作');await f.app.wait(r.runId);
    const run=f.app.store.snapshot(f.c.conversationId).runs[r.runId]!;
    assert.equal(run.status,'stopped');assert.match(run.failureSummary!.text,/目标未被取消/);assert.equal(model.requests.length,1);
    assert(!f.app.store.events(f.c.conversationId).some(e=>e.type==='task.state_changed'&&e.payload.state==='cancelled'));
  } finally {await f.close();}
});

test('输出预算：到达上限不再请求，恢复不清零，调高后继续原运行',async()=>{
  const model=new ScriptModel([call('search_history',{query:'第一项'}),call('search_history',{query:'第二项'}),text('最终答复')]),f=fixture(model);
  try {
    f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),runOutputTokenLimit:22});
    const r=f.app.send(f.c.conversationId,uid(),'执行任务');await f.app.wait(r.runId);
    let state=f.app.store.snapshot(f.c.conversationId);
    assert.equal(state.runs[r.runId]!.status,'interrupted');assert.equal(state.runs[r.runId]!.code,'RUN_OUTPUT_BUDGET');
    assert.deepEqual(model.requests.map(r=>r.maxOutputTokens),[22,11]);
    assert.throws(()=>f.app.resume(f.c.conversationId,r.runId),/输出预算/);
    const same=f.app.send(f.c.conversationId,uid(),'继续');assert.equal(same.runId,r.runId);await f.app.wait(r.runId);
    assert.equal(model.requests.length,2);assert.equal(f.app.store.messageById(f.c.conversationId,same.messageId)!.applied,true);
    state=f.app.store.snapshot(f.c.conversationId);assert.equal(state.runs[r.runId]!.failureSummary!.inputId,same.messageId);
    assert.match(html(f.app,f.c.conversationId),/本轮输出预算/);
    f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),runOutputTokenLimit:33});
    const continuation=f.app.send(f.c.conversationId,uid(),'已提高预算，请继续');assert.equal(continuation.runId,r.runId);
    assert.equal((await f.app.wait(r.runId)).status,'completed');assert.equal(model.requests.length,3);assert.equal(model.requests[2]!.maxOutputTokens,11);
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.outputBudget.used,33);
    validatePairs(history(f.app,f.c.conversationId));
  } finally {await f.close();}
});

class MissingUsageModel extends ScriptModel {
  override async *stream(request:PreparedRequest,signal:AbortSignal):AsyncGenerator<ModelFrame> {
    for await(const frame of super.stream(request,signal)) yield frame.kind==='response'?{...frame,usage:null}:frame;
  }
}
test('输出预算：缺失用量保持未知，阻止继续计费，解除预算后可继续',async()=>{
  const model=new MissingUsageModel([call('search_history',{query:'读取'}),text('答复')]),f=fixture(model);
  try {
    f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),runOutputTokenLimit:100});
    const r=f.app.send(f.c.conversationId,uid(),'任务');await f.app.wait(r.runId);
    assert.equal(model.requests.length,1);assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.code,'RUN_OUTPUT_USAGE_UNKNOWN');
    assert.equal(f.app.contextStatistics(f.c.conversationId).latestRun!.outputBudget.missing,1);
    f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),runOutputTokenLimit:null});
    f.app.send(f.c.conversationId,uid(),'已解除预算，继续');assert.equal((await f.app.wait(r.runId)).status,'completed');
  } finally {await f.close();}
});

test('输出预算：真实上下文维护入口也受同一预算约束并累计usage',async()=>{
  let round=0;
  const model=new ScriptModel(Array.from({length:80},()=>request=>{
    const messages=request.body.messages as WireMessage[];
    if(messages[0]?.content.includes('上下文维护步骤')) return text(JSON.stringify({items:[]}));
    round++;
    return round<=26?call('search_history',{query:'查询'+round},'这段资料仅供查询定位。'.repeat(400),uid()):text('资料查询已完成。');
  }));
  const f=fixture(model,{context:new ContextManager(100000,1024,{off:1024,normal:1024,high:1024})});
  try {
    f.app.store.updateSettings(f.c.conversationId,{...f.app.store.settings(f.c.conversationId),runOutputTokenLimit:1000});
    const r=f.app.send(f.c.conversationId,uid(),'查询资料');assert.equal((await f.app.wait(r.runId)).status,'completed');
    const diag=f.app.contextStatistics(f.c.conversationId).latestRun!;
    assert(diag.maintenancePlans>0);assert.equal(diag.outputBudget.used,model.requests.length*11);assert.equal(diag.outputBudget.missing,0);
    for(let i=0;i<model.requests.length;i++)assert(model.requests[i]!.maxOutputTokens<=1000-i*11);
    validatePairs(history(f.app,f.c.conversationId));
  } finally {await f.close();}
});

test('运行说明：硬退出后恢复显示原因，不新增模型请求，片段保留',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-continuity-crash-'));
  try {
    const child=spawn(process.execPath,[new URL('./run-continuity-worker.js',import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''),root],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
    const [exit]=await once(child,'exit');assert.equal(exit,0,err);
    const ids=JSON.parse(out),model=new ScriptModel([]),app=new UmiApplication(join(root,'data'),model);
    try {
      const state=app.store.snapshot(ids.conversationId),run=state.runs[ids.runId]!;
      assert.equal(run.status,'interrupted');assert.match(run.failureSummary!.text,/进程退出/);
      assert.equal(model.requests.length,0);assert(state.blocks.some(b=>b.text==='崩溃前的原始思考。'));
      validatePairs(history(app,ids.conversationId));
    } finally {await app.close();}
  } finally {removeTestRoot(root);}
});

test('运行说明：发送后立即停止也有说明，原输入不伪装成已交给模型',async()=>{
  const model=new ScriptModel([]),f=fixture(model);
  try {
    const r=f.app.send(f.c.conversationId,uid(),'尚未开始的任务');f.app.requestStop(f.c.conversationId,r.runId);await f.app.wait(r.runId);
    assert.equal(model.requests.length,0);assert.equal(f.app.store.messageById(f.c.conversationId,r.messageId)!.applied,false);
    assert.match(f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.failureSummary!.text,/目标未被取消/);
  } finally {await f.close();}
});

test('运行说明：说明插入故障回滚整条正文，保存可恢复错误而非留下running',async()=>{
  const model=new ScriptModel([{role:'assistant',content:'',reasoning_content:'原始思考'}]),f=fixture(model);
  try {
    f.app.store.db.exec("CREATE TRIGGER fail_terminal_note BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='run.failure_summary' BEGIN SELECT RAISE(ABORT,'fixture terminal note'); END;");
    const r=f.app.send(f.c.conversationId,uid(),'操作');await f.app.wait(r.runId);
    const state=f.app.store.snapshot(f.c.conversationId);assert.equal(state.runs[r.runId]!.status,'interrupted');assert.equal(state.runs[r.runId]!.code,'PERSISTENCE_FAILED');
    assert.equal(state.runs[r.runId]!.failureSummary,undefined);assert.equal(f.app.store.messages(f.c.conversationId).filter(m=>m.role==='assistant'&&!m.modelAttemptId).length,0);
    f.app.store.db.exec('DROP TRIGGER fail_terminal_note');
  } finally {await f.close();}
});
