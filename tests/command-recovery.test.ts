import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,text,removeTestRoot} from './fixtures.js';

for(const mode of ['planned','ready','released','started','output','receipt']){
  test(`A31/A36：宿主命令实际父进程硬退出 ${mode}，核验原进程而非重跑`,{timeout:60000},async()=>{
    const root=mkdtempSync(join(tmpdir(),'umi-command-crash-')),workspace=join(root,'workspace'),data=join(root,'data');mkdirSync(workspace);writeFileSync(join(workspace,'a.txt'),'原来源');
    const worker=fork(new URL('./command-crash-worker.js',import.meta.url),[data,workspace,mode],{stdio:['ignore','ignore','pipe','ipc']});let errors='';worker.stderr!.on('data',b=>{errors+=String(b);});let app:UmiApplication|undefined;
    try{const message=await Promise.race([once(worker,'message').then(([m])=>m),once(worker,'exit').then(()=>{throw new Error('测试进程提前退出：'+errors);})]) as {conversationId:string;runId:string;environmentId:string;mountId:string;executionId:string};
      const exit=once(worker,'exit');worker.kill('SIGKILL');await exit;app=new UmiApplication(data,new ScriptModel([text('依据中断核验说明'),text('结束')]));
      assert.equal(app.store.tool(message.executionId).state,'unknown');const mount=app.files.repo.mount(message.mountId,message.environmentId),file=join(mount.root,'count.txt');
      app.resume(message.conversationId,message.runId);const result=await app.wait(message.runId);assert.equal(result.status,'completed');assert.equal(app.store.tool(message.executionId).state,mode==='receipt'?'succeeded':'failed');
      if(['planned','ready','released'].includes(mode))assert(!existsSync(file));else if(existsSync(file))assert.equal(readFileSync(file,'utf8'),'1');
      if(mode==='output'||mode==='receipt')assert.equal(readFileSync(file,'utf8'),'1');assert(!existsSync(join(workspace,'count.txt')));
      const receipt=app.commands.repo.receipt(message.executionId)!;assert(receipt.jobInactive);assert.equal(receipt.reason,mode==='receipt'?'exited':['planned','ready'].includes(mode)?'not_started':'interrupted');
      assert.equal(app.store.events(message.conversationId).filter(e=>e.type==='tool.dispatch_intent'&&e.executionId===message.executionId).length,1);
      assert.equal(app.store.events(message.conversationId).filter(e=>e.type==='process.planned'&&e.executionId===message.executionId).length,1);
    }finally{if(worker.exitCode===null&&worker.signalCode===null){const exit=once(worker,'exit');worker.kill('SIGKILL');await exit;}await app?.close();removeTestRoot(root);}
  });
}
