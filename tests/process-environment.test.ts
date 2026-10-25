import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {UmiApplication} from '../apps/headless/src/application.js';
import {ScriptModel,call,text,eventually,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';

async function run(code:string){
 const root=mkdtempSync(join(tmpdir(),'umi-launch-check-')),workspace=join(root,'workspace');mkdirSync(workspace);
 const steps:ConstructorParameters<typeof ScriptModel>[0]=[],app=new UmiApplication(join(root,'data'),new ScriptModel(steps)),c=app.createConversation(workspace),mount=app.files.repo.mounts(c.environmentId)[0]!;
 try{
  steps.push(call('run_command',{program:process.execPath,argv:['-e',code],cwd:{kind:'mount',mountId:mount.id},timeoutMs:10000}),text('按实际回执结束'));
  const run=app.send(c.conversationId,uid(),'隔离进程探针'),approval=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
  app.approve(c.conversationId,approval,'allow');await app.wait(run.runId);
  const tool=app.store.tools(run.runId)[0]!;assert.equal(tool.state,'succeeded');
  return {root,workspace,app,c,tool,output:app.previewProcess(c.conversationId,tool.id,'stdout'),async close(){await app.close();removeTestRoot(root);}};
 }catch(e){await app.close();removeTestRoot(root);throw e;}
}
test('实际子进程保留Windows安装目录变量，继续排除合成API密钥', {timeout:20000},async()=>{
 const prior=process.env.UMI_LAUNCH_TEST_API_KEY;process.env.UMI_LAUNCH_TEST_API_KEY='synthetic-private-value';
 let f:Awaited<ReturnType<typeof run>>|undefined;
 try{
  f=await run("process.stdout.write(JSON.stringify({programFiles:process.env.ProgramFiles,programFilesX86:process.env['ProgramFiles(x86)'],programW6432:process.env.ProgramW6432,secret:process.env.UMI_LAUNCH_TEST_API_KEY??null}))");
  const values=JSON.parse(f.output.text);assert.equal(values.programFiles,process.env.ProgramFiles);assert.equal(values.programFilesX86,process.env['ProgramFiles(x86)']);assert.equal(values.programW6432,process.env.ProgramW6432);assert.equal(values.secret,null);
 }finally{if(f)await f.close();if(prior===undefined)delete process.env.UMI_LAUNCH_TEST_API_KEY;else process.env.UMI_LAUNCH_TEST_API_KEY=prior;}
});
test('实际复现：命令内已启动的普通子进程在父命令正常退出后被Job清理', {timeout:20000},async()=>{
 const child="const fs=require('fs');fs.writeFileSync('heartbeat.txt','started\\n');setInterval(()=>fs.appendFileSync('heartbeat.txt','tick\\n'),20);setTimeout(()=>process.exit(0),2000)";
 const parent=`const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',windowsHide:true});child.unref();const timer=setInterval(()=>{if(fs.existsSync('heartbeat.txt')){clearInterval(timer);process.stdout.write(String(child.pid));process.exit(0);}},10);`;
 const f=await run(parent);try{
  assert.equal(f.output.receipt!.reason,'exited');assert.equal(f.output.receipt!.jobInactive,true);
  const before=readFileSync(join(f.workspace,'heartbeat.txt'),'utf8');assert(before.includes('started'));await delay(180);
  assert.equal(readFileSync(join(f.workspace,'heartbeat.txt'),'utf8'),before);
 }finally{await f.close();}
});
