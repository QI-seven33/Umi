import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel,text,eventually,removeTestRoot } from './fixtures.js';
import type { DeliveryReceipt } from '../packages/protocol/src/resources.js';

for(const mode of ['pending','before-intent','after-intent','after-effect','after-receipt','all-receipts','changed-after-effect','temp-complete','temp-partial']) {
  test(`A26/A36：交付实际进程强制退出 ${mode}`,{timeout:20000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'umi-delivery-crash-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);
    writeFileSync(join(workspace,'a.txt'),'旧甲');writeFileSync(join(workspace,'b.txt'),'旧乙');
    const actualMode=mode==='changed-after-effect'?'after-effect':mode.startsWith('temp-')?'after-intent':mode;
    const child=fork(new URL('./resource-crash-worker.js',import.meta.url),[data,workspace,actualMode],{stdio:['ignore','ignore','pipe','ipc']});
    let app:UmiApplication|undefined,errors='';child.stderr!.on('data',x=>{errors+=String(x);});
    try {
      const cp=await new Promise<{conversationId:string;environmentId:string;runId:string;mountId:string;executionId:string;changeSetId?:string;approvalId?:string}>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`测试边界未就绪：${errors}`)),12000);child.once('message',m=>{clearTimeout(timer);resolve(m as never);});child.once('exit',c=>{clearTimeout(timer);reject(new Error(`子进程提前退出 ${c} ${errors}`));});});
      const exit=once(child,'exit');child.kill('SIGKILL');await exit;
      if(mode==='changed-after-effect')writeFileSync(join(workspace,'a.txt'),'外部竞争修改');
      const model=new ScriptModel([text('依据交付核验结果说明完成或未完成项目'),text('最终总结')]);app=new UmiApplication(data,model);
      let temporary:string|undefined;
      if(mode.startsWith('temp-')) {const item=app.files.repo.items(cp.changeSetId!)[0]!;temporary=join(workspace,item.temporary_path as string);writeFileSync(temporary,mode==='temp-complete'?'新甲':'不完整内容');}
      if(mode==='pending') {
        assert.equal(app.store.getRun(cp.runId).status,'waiting_permission');app.resume(cp.conversationId,cp.runId);
        await eventually(()=>app!.store.getRun(cp.runId).status==='waiting_permission'?true:undefined);assert.equal(model.requests.length,0);
        assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),'旧甲');app.approve(cp.conversationId,cp.approvalId!,'allow');
      }else {assert.equal(app.store.tool(cp.executionId).state,'unknown');app.resume(cp.conversationId,cp.runId);}
      const run=await app.wait(cp.runId);
      if(mode==='changed-after-effect'||mode==='temp-partial') {assert.equal(run.status,'recovery_required');assert.equal(model.requests.length,0);assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),mode==='temp-partial'?'旧甲':'外部竞争修改');if(temporary)assert(existsSync(temporary));}
      else {
        assert.equal(run.status,'completed');assert.equal(model.requests.length,1);
        const expected=mode==='pending'||mode==='all-receipts'?'succeeded':'failed';assert.equal(app.store.tool(cp.executionId).state,expected);
        assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),['after-effect','after-receipt','all-receipts','pending'].includes(mode)?'新甲':'旧甲');
        assert.equal(readFileSync(join(workspace,'b.txt'),'utf8'),['all-receipts','pending'].includes(mode)?'新乙':'旧乙');
        assert.equal(app.store.events(cp.conversationId).filter(e=>e.type==='tool.dispatch_intent'&&e.executionId===cp.executionId).length,1);
        if(mode==='after-effect') {
          const csId=cp.changeSetId!,item=app.files.repo.items(csId)[0]!;assert.equal(app.store.readArtifact<DeliveryReceipt>(item.receipt_ref as string).outcome,'satisfied');
          assert.equal(app.files.repo.baseline(app.files.repo.mount(cp.mountId,cp.environmentId))['a.txt']!.hash,app.store.readArtifact<DeliveryReceipt>(item.receipt_ref as string).observed!.hash);
        }
      }
      assert(!Object.values(app.store.snapshot(cp.conversationId).tools).some(t=>t.status==='running'));
      if(mode==='temp-complete')assert(!existsSync(temporary!));
      if(mode==='temp-partial') {unlinkSync(temporary!);app.resume(cp.conversationId,cp.runId);assert.equal((await app.wait(cp.runId)).status,'completed');
        assert.equal(app.store.tool(cp.executionId).state,'failed');assert.equal(readFileSync(join(workspace,'a.txt'),'utf8'),'旧甲');}
    }finally{if(child.exitCode===null&&!child.killed){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await app?.close();removeTestRoot(root);}
  });
}
