import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { removeTestRoot, ScriptModel,text } from './fixtures.js';
import { validatePairs,executionContextSchema } from '../packages/protocol/src/model.js';
import { uid } from '../packages/agent/src/identity.js';

type Checkpoint={conversationId:string;environmentId:string;runId:string;executionId:string|null};
for(const mode of ['approved','intent','effect','settled','partial']) {
  test(`A08/A13/A18/A45：真实进程硬退出边界 ${mode}`,{timeout:15000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'umi-crash-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);
    const child=fork(new URL('./crash-worker.js',import.meta.url),[data,workspace,mode],{stdio:['ignore','ignore','pipe','ipc']});
    let errors='';child.stderr?.on('data',d=>{errors+=String(d);});let app:UmiApplication|undefined;
    try {
      const checkpoint=await new Promise<Checkpoint>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`故障注入未就绪：${errors}`)),7000);
        child.once('message',m=>{clearTimeout(timer);resolve(m as Checkpoint);});
        child.once('exit',code=>{clearTimeout(timer);reject(new Error(`故障注入提前退出 ${code}：${errors}`));});
      });
      const exit=once(child,'exit');child.kill('SIGKILL');await exit;
      const model=new ScriptModel([text('恢复核验后的阶段结果'),text('恢复结束')]);app=new UmiApplication(data,model);
      assert.equal(app.store.getRun(checkpoint.runId).status,'interrupted');
      const file=join(app.store.environment(checkpoint.environmentId).root,'task','scratch','recovery.txt');
      if(mode==='partial') {
        const prefix=app.store.snapshot(checkpoint.conversationId).blocks[0]!;
        assert.equal(prefix.text,'已显示的正文前缀');assert.equal(prefix.status,'interrupted');
        assert.equal(app.store.messages(checkpoint.conversationId).some(m=>m.payload.content===prefix.text),false);
      } else {
        const t=app.store.tool(checkpoint.executionId!);
        assert.equal(t.state,mode==='approved'?'prepared':mode==='settled'?'succeeded':'unknown');
        const ctx=executionContextSchema.parse(app.store.readArtifact(t.context_ref!));
        assert.equal(ctx.environmentId,checkpoint.environmentId);assert.equal(ctx.locations[0]?.relativePath,'recovery.txt');
        assert.equal(ctx.locations[0]?.rootRef.kind,'task');
      }
      app.resume(checkpoint.conversationId,checkpoint.runId);const recovered=await app.wait(checkpoint.runId);
      if(mode==='intent') {
        assert.equal(recovered.status,'recovery_required');assert.equal(model.requests.length,0);assert(!existsSync(file));
        // 新输入可持久接收，但同一环境的未知写入不能被新任务绕过。
        await app.stop(checkpoint.conversationId,checkpoint.runId);
        const newer=app.send(checkpoint.conversationId,uid(),'尝试新任务');assert.equal((await app.wait(newer.runId)).status,'recovery_required');
        assert.equal(model.requests.length,0);assert.equal(app.store.unresolvedEnvironment(checkpoint.environmentId).length,1);
      } else {
        assert.equal(recovered.status,'completed');assert.equal(model.requests.length,1);
        if(mode!=='partial') {
          assert.equal(readFileSync(file,'utf8'),'可核验内容');assert.equal(app.store.environment(checkpoint.environmentId).revision,1);
          const dispatches=app.store.events(checkpoint.conversationId).filter(e=>e.type==='tool.dispatch_intent');assert.equal(dispatches.length,1);
          if(mode==='effect')assert.equal(app.store.readArtifact<{verification:string}>(app.store.tool(checkpoint.executionId!).result_ref!).verification,'desired-state-verified');
        }
      }
      const messages=app.store.messages(checkpoint.conversationId).filter(m=>m.applied).sort((a,b)=>Number(BigInt(a.projectionSequence)-BigInt(b.projectionSequence))).map(m=>m.payload);
      validatePairs(messages);
      const snap=app.store.snapshot(checkpoint.conversationId);assert(!Object.values(snap.tools).some(t=>t.status==='running'));
    } finally {
      if(child.exitCode===null&&!child.killed){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
      await app?.close();removeTestRoot(root);
    }
  });
}
