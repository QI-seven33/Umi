import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { UmiError } from '../packages/protocol/src/model.js';
import { reduceConversation } from '../packages/protocol/src/reducer.js';
import { uid } from '../packages/agent/src/identity.js';
import { runDiagnostics } from '../packages/agent/src/loop/run-diagnostics.js';
import { ScriptModel, text, call, removeTestRoot } from './fixtures.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';

function worker(root: string, mode = 'store') {
  const child = spawn(process.execPath, [new URL('./writer-lock-worker.js', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), root, mode], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const queue: any[] = [], waiting: ((x: any) => void)[] = [];
  lines.on('line', line => { const value=JSON.parse(line); const waiter=waiting.shift(); if(waiter)waiter(value);else queue.push(value); });
  return { child, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise<any>(resolve => waiting.push(resolve)),
    async stop() { if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}lines.close(); } };
}
const temp=()=>mkdtempSync(join(tmpdir(),'umi-reliability-'));
async function deadPid() { const p=spawn(process.execPath,['-e',''],{windowsHide:true});await once(p,'exit');return p.pid!; }
function appFixture(model = new ScriptModel([call('search_history',{query:'x'})]), maxTurns=1) {
  const root=temp(), app=new UmiApplication(join(root,'data'),model,{limits:{maxTurns,maxRetries:1,modelTimeoutMs:2000,retryDelayMs:1}}),c=app.createConversation(root);
  return {root,app,c,model,async close(){await app.close();removeTestRoot(root);}};
}

test('启动恢复：空guard和已退出owner均恢复，关闭只清理自己标记',async()=>{
  const pid=await deadPid();
  for(const kind of ['empty','dead','dead-and-lock','lock-only']) {
    const root=temp();try{
      if(kind!=='lock-only'){mkdirSync(join(root,'writer.starting'));if(kind!=='empty')writeFileSync(join(root,'writer.starting/owner.json'),JSON.stringify({pid,instanceId:'old'}));}
      if(kind==='dead-and-lock'||kind==='lock-only')writeFileSync(join(root,'writer.lock'),JSON.stringify({pid,instanceId:'old'}));
      const s=new SqliteStore(root);assert(existsSync(join(root,'writer.starting/owner.json')));s.close();s.close();
      assert(!existsSync(join(root,'writer.starting')));assert(!existsSync(join(root,'writer.lock')));
      const again=new SqliteStore(root);again.close();
    }finally{removeTestRoot(root);}
  }
});

test('启动恢复：活跃、损坏和非法PID的owner不被删除，失败后锁可再次核验',()=>{
  for(const [path,body]of [['writer.starting/owner.json',JSON.stringify({pid:process.pid,instanceId:'live'})],['writer.lock',JSON.stringify({pid:process.pid,instanceId:'legacy'})],['writer.starting/owner.json','{broken'],['writer.lock',JSON.stringify({pid:-1,instanceId:'invalid'})]]){
    const root=temp();try{if(path!.includes('/'))mkdirSync(join(root,'writer.starting'));writeFileSync(join(root,path!),body!);
      for(let i=0;i<2;i++)assert.throws(()=>new SqliteStore(root),(e:unknown)=>e instanceof UmiError&&e.code==='WRITER_LOCKED');
      assert.equal(readFileSync(join(root,path!),'utf8'),body);
    }finally{removeTestRoot(root);}
  }
});

test('启动恢复：真实并发恢复者只有一个写者，进程硬退出后系统锁可恢复',async()=>{
  const root=temp(), pid=await deadPid();mkdirSync(join(root,'writer.starting'));writeFileSync(join(root,'writer.starting/owner.json'),JSON.stringify({pid,instanceId:'old'}));
  const a=worker(root),b=worker(root);
  try{const values=await Promise.all([a.next(),b.next()]);assert.equal(values.filter(v=>v.status==='ready').length,1);assert.equal(values.filter(v=>v.status==='blocked').length,1);
    assert.throws(()=>new SqliteStore(root),/写入/);await a.stop();await b.stop();const s=new SqliteStore(root);s.close();
  }finally{await a.stop();await b.stop();removeTestRoot(root);}
});

test('启动恢复：旧协议刚建空目录时wx决定owner，失败者不能继续启动',async()=>{
  const root=temp(),old=worker(root,'legacy-empty');let store:SqliteStore|undefined;
  try{assert.equal((await old.next()).status,'empty');store=new SqliteStore(root);old.child.stdin.write('continue');assert.equal((await old.next()).status,'blocked');assert.equal(JSON.parse(readFileSync(join(root,'writer.lock'),'utf8')).instanceId,store.instanceId);}
  finally{store?.close();await old.stop();removeTestRoot(root);}
});

test('TASK_LIMIT：保存唯一真实正文和失败状态，不请求额外模型，重启一致',async()=>{
  const f=appFixture();try{const r=f.app.send(f.c.conversationId,uid(),'检索后继续工作');assert.equal((await f.app.wait(r.runId)).status,'failed');
    const state=f.app.store.snapshot(f.c.conversationId),notice=state.runs[r.runId]!.failureSummary;
    assert.equal(notice?.code,'TASK_LIMIT');assert.match(notice!.text,/成功 1 项/);assert.match(notice!.text,/尚未确认完成/);assert.equal(f.model.requests.length,1);
    assert.equal(state.runs[r.runId]!.acceptance?.status,'blocked');assert.equal(f.app.store.events(f.c.conversationId).filter(e=>e.type==='run.failure_summary').length,1);
    const diag=f.app.contextStatistics(f.c.conversationId).latestRun!;assert.equal(diag.requests,1);assert.equal(diag.tokens.input.known,17);assert.equal(diag.tokens.hit.missing,1);assert.equal(diag.cacheRate,null);
    await f.app.close();const app=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{assert.deepEqual(app.store.snapshot(f.c.conversationId),state);assert.deepEqual(app.contextStatistics(f.c.conversationId).latestRun,diag);}finally{await app.close();}
  }finally{await f.close();}
});

test('TASK_LIMIT：最后允许的一轮直接答复正常完成，不误报上限',async()=>{
  const f=appFixture(new ScriptModel([text('完整答案')]));try{const r=f.app.send(f.c.conversationId,uid(),'问答');assert.equal((await f.app.wait(r.runId)).status,'completed');assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary,undefined);}finally{await f.close();}
});

test('TASK_LIMIT：正文提交后硬退出，恢复采用同一正文，不重新收费或重放工具',async()=>{
  const root=temp(),w=worker(root,'limit-crash');try{const exit=once(w.child,'exit'),ids=await w.next();await exit;
    const model=new ScriptModel([]),app=new UmiApplication(join(root,'data'),model);
    try{const original=app.store.snapshot(ids.conversationId).runs[ids.runId]?.failureSummary;assert.equal(original?.code,'TASK_LIMIT');app.resume(ids.conversationId,ids.runId);assert.equal((await app.wait(ids.runId)).status,'failed');assert.equal(model.requests.length,0);assert.deepEqual(app.store.snapshot(ids.conversationId).runs[ids.runId]?.failureSummary,original);assert.equal(app.store.tools(ids.runId).length,1);}finally{await app.close();}
  }finally{await w.stop();removeTestRoot(root);}
});

test('TASK_LIMIT：停止优先，不写旧失败收尾',async()=>{
  const f=appFixture();f.model.beforeResponse=async()=>{const run=Object.keys(f.app.store.snapshot(f.c.conversationId).runs).at(-1)!;f.app.requestStop(f.c.conversationId,run);};
  try{const r=f.app.send(f.c.conversationId,uid(),'工作');assert.equal((await f.app.wait(r.runId)).status,'stopped');assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary?.code,'STOPPED');assert(!f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary?.text.includes('轮次上限'));}finally{await f.close();}
});

test('用量诊断：重试缺usage与字段缺失明确未知，维护与本地维护分别计数',async()=>{
  class Retry extends ScriptModel {
    failed=false;
    override async*stream(r:PreparedRequest,s:AbortSignal):AsyncGenerator<ModelFrame>{if(!this.failed){this.failed=true;throw new UmiError('PROVIDER_HTTP','fixture',true);}yield*super.stream(r,s);}
  }
  const f=appFixture(new Retry([text('完成')]));try{const r=f.app.send(f.c.conversationId,uid(),'问答');await f.app.wait(r.runId);
    const state=f.app.store.snapshot(f.c.conversationId),plans:Record<string,unknown>={plan:{request:{}},local:{request:null},usage:{prompt_tokens:3,completion_tokens:0,completion_tokens_details:{reasoning_tokens:0},prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:3}};
    state.memory.maintenance.m={runId:r.runId,planRef:'plan',status:'completed',usageRef:'usage'};state.memory.maintenance.l={runId:r.runId,planRef:'local',status:'completed'};
    const value=runDiagnostics(state,ref=>plans[ref]??f.app.store.readArtifact(ref))!;
    assert.equal(value.retries,1);assert.equal(value.missingUsage,1);assert.deepEqual(value.tokens.input,{known:20,missing:1});assert.deepEqual(value.tokens.reasoning,{known:0,missing:2});assert.equal(value.maintenancePlans,1);assert.equal(value.localMaintenance,1);assert.equal(value.cacheRate,null);
    assert.deepEqual(new DesktopService(f.app).snapshot(f.c.conversationId).context.latestRun,f.app.contextStatistics(f.c.conversationId).latestRun);
  }finally{await f.close();}
});

test('TASK_LIMIT：收尾前收到更正，旧正文不提交，新输入先执行',async()=>{
  const f=appFixture(new ScriptModel([call('search_history',{query:'x'}),text('回答新问题')]));
  const original=f.app.store.persistFailureSummary.bind(f.app.store);let sent=false;
  f.app.store.persistFailureSummary=(...args)=>{if(!sent){sent=true;f.app.send(f.c.conversationId,uid(),'改为回答新问题');}return original(...args);};
  try{const r=f.app.send(f.c.conversationId,uid(),'原任务');await f.app.wait(r.runId);assert.equal(f.app.store.getRun(r.runId).status,'completed');assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary,undefined);assert.equal(f.model.requests.length,2);}
  finally{await f.close();}
});

test('TASK_LIMIT：正文写入失败回滚原因和消息，显示可恢复中断而非假装保存成功',async()=>{
  const f=appFixture();
  try{f.app.store.db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='run.failure_summary' BEGIN SELECT RAISE(ABORT,'fixture summary failed'); END;");
    const r=f.app.send(f.c.conversationId,uid(),'工作');assert.equal((await f.app.wait(r.runId)).status,'interrupted');assert.equal(f.app.store.snapshot(f.c.conversationId).runs[r.runId]?.failureSummary,undefined);assert.equal(f.model.requests.length,1);
    assert.equal(f.app.store.events(f.c.conversationId).filter(e=>e.type==='run.failure_summary').length,0);assert.equal(f.app.store.messages(f.c.conversationId).filter(m=>m.role==='assistant').length,1);
    f.app.store.db.exec('DROP TRIGGER fail_notice');
  }finally{await f.close();}
});

test('用量诊断：新运行独立计数，缺失字段不补零，批准时钟倒退明确未知',async()=>{
  const f=appFixture(new ScriptModel([text('第一轮'),text('第二轮')]));
  try{const a=f.app.send(f.c.conversationId,uid(),'一');await f.app.wait(a.runId);const b=f.app.send(f.c.conversationId,uid(),'二');await f.app.wait(b.runId);
    const s=f.app.store.snapshot(f.c.conversationId);const tools=Object.values(s.tools);assert.equal(tools.length,0);
    s.tools.c={name:'fake',runId:b.runId,turnId:'t',attemptId:'a',executionId:'e',sequence:'1',status:'succeeded'};
    s.approvals.p={callId:'c',description:'fixture',status:'allow',requestedAt:'2026-10-19T12:00:02Z',decidedAt:'2026-10-19T12:00:01Z'};
    const d=runDiagnostics(s,ref=>f.app.store.readArtifact(ref))!;assert.equal(d.runId,b.runId);assert.equal(d.attempts,1);assert.equal(d.tokens.input.known,17);assert.equal(d.tokens.output.known,11);assert.equal(d.tokens.reasoning.missing,1);assert.equal(d.approvalUnknown,1);assert.equal(d.approvalWaitMs,0);
  }finally{await f.close();}
});


test('用量诊断：显式恢复较早run时选择真实最近启动身份，重放后保持',async()=>{
  const f=appFixture(new ScriptModel([text('一'),text('二')]));
  try{const first=f.app.send(f.c.conversationId,uid(),'一');await f.app.wait(first.runId);const second=f.app.send(f.c.conversationId,uid(),'二');await f.app.wait(second.runId);
    const s=f.app.store.snapshot(f.c.conversationId),base=f.app.store.events(f.c.conversationId).at(-1)!;
    // 仅构造归约器合法的恢复事实，验证选轮逻辑；不恢复已完成业务run或派发工具。
    const e={...base,eventId:uid(),idempotencyKey:uid(),sequence:String(BigInt(base.sequence)+1n),runId:first.runId,type:'run.recovery_started' as const,payload:{generation:2}};
    const resumed=reduceConversation(s,e);assert.equal(resumed.latestRunId,first.runId);
    assert.equal(runDiagnostics(resumed,ref=>f.app.store.readArtifact(ref))!.runId,first.runId);
  }finally{await f.close();}
});
