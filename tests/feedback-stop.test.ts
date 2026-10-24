import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { WorkerCommandQueue } from '../apps/desktop/command-queue.js';
import { WindowsProcessRunner } from '../packages/adapters/src/host-process/runner.js';
import { toolResultViews } from '../packages/agent/src/context/bounded.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import type { HistoryRow } from '../packages/agent/src/context/projection.js';
import type { WireMessage } from '../packages/protocol/src/model.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid } from '../packages/agent/src/identity.js';
import { call, text, ScriptModel, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';

function row(id: string, payload: WireMessage, seq: number): HistoryRow {
  return { id, payload, applied: true, projectionSequence: String(seq) };
}
function results(request: PreparedRequest) {
  return (request.body.messages as WireMessage[]).filter(m => m.role === 'tool')
    .map(m => { try { return JSON.parse(m.content); } catch { return null; } });
}
function fixture(files: Record<string,string>, context?: ContextManager) {
  const root = mkdtempSync(join(tmpdir(), 'umi-feedback-')), workspace = join(root,'workspace');
  mkdirSync(workspace);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(workspace,path),content);
  const steps: Step[] = [], model = new ScriptModel(steps), app = new UmiApplication(join(root,'data'),model,context ? {context} : {});
  const c = app.createConversation(workspace), mount = app.files.repo.mounts(c.environmentId)[0]!;
  return { root, workspace, steps, model, app, c, mount,
    async close() { await app.close(); removeTestRoot(root); } };
}

test('反馈契约：11/30 条历史不缩小最新 6 KiB 读取；旧原文与配对保留', () => {
  for (const count of [11,30]) {
    const rows: HistoryRow[] = [row('u',{role:'user',content:'读取文件'},0)];
    for (let n=0;n<count;n++) {
      rows.push(row('a'+n,call('read_file',{},'',String(n)),rows.length));
      rows.push(row('t'+n,{role:'tool',tool_call_id:String(n),content:JSON.stringify({outcome:'succeeded',content:'',data:{text:'旧资料'.repeat(800)}})},rows.length));
    }
    const body = '头🙂'+'中间关键正文\r\n'.repeat(700)+'尾🙂';
    const data = {readExecutionId:'latest',startByte:0,endByte:Buffer.byteLength(body),text:body};
    rows.push(row('a',call('read_file',{},'','latest-call'),rows.length));
    rows.push(row('t',{role:'tool',tool_call_id:'latest-call',content:JSON.stringify({outcome:'succeeded',content:JSON.stringify(data),data})},rows.length));
    const original=structuredClone(rows), view=toolResultViews(rows,200000);
    assert.equal(JSON.parse(view.messages.at(-1)!.content).data.text,body);
    assert.equal(view.messages.at(-1)!.content.split('中间关键正文').length-1,700);
    assert(!view.views.some(v=>v.messageId==='t'));
    assert.equal(view.views.length,0);
    assert.equal(JSON.parse(view.messages[2]!.content).data.text, '旧资料'.repeat(800));
    assert.deepEqual(rows,original);
  }
});

test('反馈契约：最新并列读取整组保留；硬预算阻塞而非截取或折叠新结果', async () => {
  const rows=[row('u',{role:'user',content:'任务'},0),row('a',call('read_file',{},'','latest'),1),
    row('t',{role:'tool',tool_call_id:'latest',content:'最新正文'.repeat(3000)},2)];
  const manager=new ContextManager(10000,1000,{off:1000,normal:1000,high:1000});
  assert.throws(()=>manager.prepare({messages:rows,settings:{model:'deepseek-flash',thinking:'off',executionPolicy:'ask',uiLocale:'zh-CN',answerLocale:'zh-CN',reasoningLocale:'zh-CN'},state:{}},[]),/预算/);
  assert.equal(toolResultViews(rows,8000).messages.at(-1)!.content,rows.at(-1)!.payload.content);
});

test('验收：小项目 11 文件读取→模型完整可见→修改→真实 node 测试', {timeout:40000}, async () => {
  const source='// 中文学习注释\r\n'+('// 保留中间正文与注释🙂\r\n'.repeat(220))+'exports.add=(a,b)=>a-b;\r\n';
  const files:Record<string,string>={'calc.cjs':source,'calc.test.cjs':"const t=require('node:test'),a=require('node:assert/strict');t('add',()=>a.equal(require('./calc.cjs').add(3,4),7));"};
  for(let i=0;i<9;i++)files['note'+i+'.txt']='辅助文件 '+i;
  const f=fixture(files);
  try {
    f.steps.push({role:'assistant',content:'读取项目',tool_calls:Object.keys(files).map(path=>call('read_file',{mountId:f.mount.id,path,byteLength:64000},'',uid()).tool_calls![0]!)},
      request=>{
        const data=results(request).find(r=>r?.data?.path==='calc.cjs').data;
        assert.equal(data.text,source);assert(Buffer.byteLength(data.text)>6000);
        assert(f.app.store.modelReceivedToolResult(data.readExecutionId)===false,'当前尚未收到响应，不提前算可见');
        return call('write_file',{mountId:f.mount.id,path:'calc.cjs',mode:'replace',readExecutionId:data.readExecutionId,expectedReadHash:data.hash,content:data.text.replace('a-b','a+b')});
      }, call('run_command',{program:process.execPath,argv:['--test','calc.test.cjs'],cwd:{kind:'mount',mountId:f.mount.id},timeoutMs:10000,maxOutputBytes:16000}),text('已完成'),text('测试通过'));
    const run=f.app.send(f.c.conversationId,uid(),'修复小项目并测试');
    const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0],15000);
    f.app.approve(f.c.conversationId,approval,'allow');
    assert.equal((await f.app.wait(run.runId)).status,'completed');
    const tools=f.app.store.tools(run.runId);
    assert(tools.every(t=>t.state==='succeeded'));
    const command=tools.find(t=>t.name==='run_command')!;
    const output=f.app.previewProcess(f.c.conversationId,command.id,'stdout');
    assert.equal(output.receipt!.exitCode,0);assert.match(output.text,/pass 1/);
    assert.equal(readFileSync(join(f.mount.root,'calc.cjs'),'utf8'),source.replace('a-b','a+b'));
    assert.equal(readFileSync(join(f.workspace,'calc.cjs'),'utf8'),source.replace('a-b','a+b'));
    console.log(JSON.stringify({sample:'coding',readFiles:11,readBytes:Buffer.byteLength(source),exitCode:0}));
  } finally { await f.close(); }
});

test('验收：日常中文 CRLF 文件真实分页→局部修改→历史/资料追回完整可见', async () => {
  const source='日常记录🙂\r\n'.repeat(950)+'待办：买牛奶\r\n';
  const f=fixture({'notes.txt':source});
  let originalMessage='', artifact='', collected='';
  try {
    const consume: Step=request=>{
      const r=results(request).at(-1)!.data;
      assert.equal(r.text,Buffer.from(source).subarray(r.startByte,r.endByte).toString('utf8'));
      collected+=r.text;
      if (!originalMessage) {
        const tool=f.app.store.tools(f.app.store.messages(f.c.conversationId).at(-1)!.runId).at(-1)!;
        artifact=tool.result_ref!;originalMessage=f.app.store.messages(f.c.conversationId).at(-1)!.id;
      }
      if (r.nextStartByte!=null) {
        f.steps.unshift(consume);
        return call('read_file',{mountId:f.mount.id,path:'notes.txt',startByte:r.nextStartByte,byteLength:4000});
      }
      assert.equal(collected,source);
      return call('edit_file',{mountId:f.mount.id,path:'notes.txt',readExecutionId:r.readExecutionId,expectedReadHash:r.hash,oldText:'买牛奶',newText:'买牛奶和面包'});
    };
    f.steps.push(call('read_file',{mountId:f.mount.id,path:'notes.txt',byteLength:4000}),consume,
    ()=>call('read_history',{messageId:originalMessage,startByte:0,byteLength:64000}),request=>{
      const data=results(request).at(-1)!.data;
      assert.equal(data.text,f.app.store.messageById(f.c.conversationId,originalMessage)!.payload.content);
      return call('read_artifact',{artifactId:artifact,startByte:0,byteLength:64000});
    },request=>{
      const data=results(request).at(-1)!.data;assert.equal(JSON.parse(data.text).data.text,collected.slice(0,JSON.parse(data.text).data.text.length));
      return text('日常任务完成');
    },text('完成'));
    const run=f.app.send(f.c.conversationId,uid(),'整理中文记录');
    assert.equal((await f.app.wait(run.runId)).status,'completed');
    assert.equal(readFileSync(join(f.mount.root,'notes.txt'),'utf8'),source.replace('买牛奶','买牛奶和面包'));
    assert.equal(readFileSync(join(f.workspace,'notes.txt'),'utf8'),source.replace('买牛奶','买牛奶和面包'));
    assert(f.app.store.tools(run.runId).every(t=>t.state==='succeeded'));
    const t=f.app.store.tools(run.runId)[0]!, service=new DesktopService(f.app);
    let rendered='',startByte=0,nextStartByte:number|null=0;
    while (nextStartByte!=null) {
      const detail=await service.handle({type:'tool_detail',conversationId:f.c.conversationId,callId:t.call_id,startByte,byteLength:128}) as any;
      rendered+=detail.result.content;nextStartByte=detail.result.nextStartByte;startByte=nextStartByte??0;
    }
    assert.equal(JSON.parse(rendered).text,f.app.store.readArtifact<any>(t.result_ref!).data.text);
    console.log(JSON.stringify({sample:'daily-files',readBytes:Buffer.byteLength(source),retrieval:'history+artifact'}));
  } finally {await f.close();}
});

test('可见证据：旧投影隐藏正文时，成功磁盘观察不能授权覆盖', async () => {
  class LegacyProjection extends ContextManager {
    override prepare(...args: Parameters<ContextManager['prepare']>) {
      const value=super.prepare(...args);
      return {...value,messages:value.messages.map(m=>m.role==='tool'?{...m,content:JSON.stringify({truncated:true,excerpts:['首段','尾段']})}:m)};
    }
  }
  const f=fixture({'notes.txt':'原正文中间保留'},new LegacyProjection());
  try {
    f.steps.push(call('read_file',{mountId:f.mount.id,path:'notes.txt'}),text('已读'),text('结束'));
    const run=f.app.send(f.c.conversationId,uid(),'读取');await f.app.wait(run.runId);
    const tool=f.app.store.tools(run.runId)[0]!, data=f.app.store.readArtifact<any>(tool.result_ref!).data;
    assert(!f.app.store.modelReceivedToolResult(tool.id));
    // 原始读回执仍完整；真实冻结请求只发送旧摘录，不篡改历史或伪造 SQL。
    const original=f.app.store.readArtifact<any>(tool.result_ref!);
    assert.throws(()=>f.app.registry.get('write_file').prepare({mountId:f.mount.id,path:'notes.txt',mode:'replace',readExecutionId:data.readExecutionId,expectedReadHash:data.hash,content:'不能覆盖'},f.app.store.environment(f.c.environmentId),uid()),/尚未完整反馈/);
    assert.deepEqual(f.app.store.readArtifact(tool.result_ref!),original);
    assert.equal(readFileSync(join(f.mount.root,'notes.txt'),'utf8'),'原正文中间保留');
  } finally {await f.close();}
});

test('停止契约：优先入口绕过等待；接收停止与清理结束是两个事实', async () => {
  const f=fixture({});
  let release!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve), queue=new WorkerCommandQueue();
  try {
    f.steps.push(async()=>{await held;return text('迟到模型响应');});
    const run=f.app.send(f.c.conversationId,uid(),'等待');
    await eventually(()=>f.model.requests.length||undefined);
    let unblock!:()=>void;
    const blocked=queue.dispatch(()=>new Promise<void>(resolve=>unblock=resolve));
    await delay(1);
    const service=new DesktopService(f.app), start=performance.now();
    await queue.dispatch(async()=>{await service.handle({type:'stop',conversationId:f.c.conversationId,runId:run.runId});},true);
    const elapsed=performance.now()-start;
    assert(elapsed<500);assert.equal(f.app.store.getRun(run.runId).stop_requested,1);
    assert.equal(f.app.store.getRun(run.runId).status,'stopping');
    unblock();await blocked;release();await f.app.wait(run.runId);
    assert.equal(f.app.store.getRun(run.runId).status,'stopped');
    assert.equal(f.model.requests.length,1);
    console.log(JSON.stringify({sample:'stop-receipt',receiptMs:elapsed,final:'stopped'}));
  } finally {release?.();await f.close();}
});

test('停止契约：实际进程身份核验可取消，不等待 20 秒 probe 超时', {timeout:10000}, async () => {
  const signal=new AbortController(), runner=new WindowsProcessRunner(), start=performance.now();
  const promise=runner.probe({pid:process.pid,birth:'1'},false,signal.signal);
  signal.abort(new Error('用户停止核验'));
  await assert.rejects(promise,/用户停止核验/);
  assert(performance.now()-start<1000);
});

test('停止契约：连续同步读取在工具边界让出 IPC，停止后不继续派发', async () => {
  const files: Record<string,string>={};
  for(let n=0;n<30;n++)files['file'+n+'.txt']='同步读取 '+n;
  const f=fixture(files);
  try {
    f.steps.push({role:'assistant',content:'读取批次',tool_calls:Object.keys(files).map(path=>call('read_file',{mountId:f.mount.id,path},'',uid()).tool_calls![0]!)});
    const settle=f.app.store.settle.bind(f.app.store);
    let queued=false;
    f.app.store.settle=(...args)=>{
      settle(...args);
      if(!queued && args[1].outcome==='succeeded') {
        queued=true;
        // 模拟 stop IPC 在下一次事件循环到达，而不是在当前工具内同步取消。
        setTimeout(()=>f.app.requestStop(f.c.conversationId,f.app.store.tool(args[0]).run_id),0);
      }
    };
    const run=f.app.send(f.c.conversationId,uid(),'批量读取');
    assert.equal((await f.app.wait(run.runId)).status,'stopped');
    const tools=f.app.store.tools(run.runId);
    assert(tools.filter(t=>t.state==='succeeded').length<30);
    assert(tools.some(t=>t.state==='cancelled'));
    assert.equal(f.model.requests.length,1);
  } finally {await f.close();}
});

test('验收：PowerShell 中文错误可读，长输出通过真实范围工具完整追回', {timeout:40000}, async () => {
  const f=fixture({}), expected='开头中文🙂'+'x'.repeat(10000)+'中间正文中文🙂'+'y'.repeat(10000)+'末尾';
  let executionId='';
  try {
    f.steps.push(call('run_shell',{shell:'powershell',cwd:{kind:'task',area:'scratch'},timeoutMs:10000,maxOutputBytes:64000,script:"[Console]::Write('开头中文🙂' + ('x' * 10000) + '中间正文中文🙂' + ('y' * 10000) + '末尾'); Write-Error '可读中文错误' -ErrorAction Continue; exit 7"}),request=>{
      const r=results(request).at(-1);executionId=r.data.executionId;
      assert.equal(r.data.exitCode,7);assert(JSON.parse(r.content).truncated);
      return call('read_process_output',{executionId,channel:'stdout',byteLength:64000});
    },request=>{
      const r=results(request).at(-1)!.data;
      assert.equal(r.text,expected);assert.equal(r.startByte,0);assert.equal(r.endByte,Buffer.byteLength(expected));assert.equal(r.nextStartByte,null);assert.match(r.sourceHash,/^[a-f0-9]{64}$/);
      return call('read_process_output',{executionId,channel:'stderr',byteLength:64000});
    },request=>{
      const r=results(request).at(-1)!.data;
      console.log(JSON.stringify({sample:'powershell-error',stderr:r.text.slice(0,250)}));
      assert(r.text.includes('可读中文错误'));assert(!r.text.includes('CLIXML'));assert(!r.text.includes('\uFFFD'));
      return text('完整结果和错误已读回');
    });
    const run=f.app.send(f.c.conversationId,uid(),'核对中文脚本输出');
    const approval=await eventually(()=>Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0],15000);
    f.app.approve(f.c.conversationId,approval,'allow');
    assert.equal((await f.app.wait(run.runId)).status,'completed');
    assert.equal(f.app.store.tools(run.runId)[0]!.state,'failed');
    assert(f.app.store.tools(run.runId).slice(1).every(t=>t.state==='succeeded'));
  } finally {await f.close();}
});
