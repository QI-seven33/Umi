import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid} from '../packages/agent/src/identity.js';
import {executionContextSchema} from '../packages/protocol/src/model.js';
import {removeTestRoot} from '../tests/fixtures.js';

const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';if(!key())throw new Error('未配置 DeepSeek 密钥，未调用 API');
const root=mkdtempSync(join(tmpdir(),'umi-live-process-')),workspace=join(root,'workspace');mkdirSync(workspace);
const script="const fs=require('node:fs');fs.writeFileSync('result.txt','Umi执行成功');console.log('Umi命令验证通过');\n";writeFileSync(join(workspace,'verify.cjs'),script);
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{
  context:new ContextManager(1000000,16384,{off:1024,normal:4096,high:8192}),limits:{maxTurns:12,maxRetries:0,modelTimeoutMs:180000,retryDelayMs:1000}});let passed=false;
try{
  const c=app.createConversation(workspace,{thinking:'high'}),mount=app.files.repo.mounts(c.environmentId)[0]!;
  const r=app.send(c.conversationId,uid(),'请实际运行工作副本里的 verify.cjs，使用 run_command，program 为 node，argv 为 ["verify.cjs"]。检查退出回执、stdout 和生成的 result.txt，再给出总结。不要修改脚本，不需要交付，不要用 run_shell、内联代码或其他程序。等待此次具体命令批准后继续。');
  const approved=new Set<string>(),deadline=Date.now()+300000;while(!['completed','failed','interrupted','stopped','recovery_required'].includes(app.store.getRun(r.runId).status)){
    for(const [id,a] of Object.entries(app.store.snapshot(c.conversationId).approvals))if(a.status==='pending'&&!approved.has(id)){
      const t=app.store.tool(app.store.approval(id).execution_id);assert.equal(t.name,'run_command');const args=JSON.parse(t.args);assert.equal(args.program,'node');assert.deepEqual(args.argv,['verify.cjs']);assert.equal(args.cwd.mountId,mount.id);assert.equal(args.cwd.kind,'mount');assert.equal(args.cwd.path??'','');
      const ctx=executionContextSchema.parse(app.store.readArtifact(t.context_ref!));assert.equal(ctx.process!.program,process.execPath);assert.equal(ctx.process!.cwd,mount.root);assert.equal(readFileSync(join(mount.root,'verify.cjs'),'utf8'),script);assert(!existsSync(join(mount.root,'result.txt')));
      assert(!Object.keys(ctx.process!.env).some(k=>/API_KEY|SECRET|PASSWORD|TOKEN|NODE_OPTIONS/.test(k)));approved.add(id);app.approve(c.conversationId,id,'allow');console.log(JSON.stringify({progress:'verified-command-approved'}));
    }
    if(Date.now()>deadline)throw new Error('真实命令验收超时');await delay(100);
  }
  assert.equal((await app.wait(r.runId)).status,'completed');assert.equal(approved.size,1);const tool=app.store.tools(r.runId).find(t=>t.name==='run_command')!;assert(tool);assert.equal(tool.state,'succeeded');const output=app.previewProcess(c.conversationId,tool.id,'stdout');assert(output.receipt!.jobInactive);assert.equal(output.receipt!.exitCode,0);assert(output.text.includes('Umi命令验证通过'));
  assert.equal(readFileSync(join(mount.root,'result.txt'),'utf8'),'Umi执行成功');assert(!existsSync(join(workspace,'result.txt')));assert.equal(readFileSync(join(workspace,'verify.cjs'),'utf8'),script);
  const events=app.store.events(c.conversationId),report={name:'Umi',stage:'3B',verifiedAt:new Date().toISOString(),status:'passed',requestedModel:'deepseek-flash',thinking:'high',calls:app.store.all('SELECT id FROM model_requests').length,approvals:approved.size,
    tools:app.store.tools(r.runId).map(t=>({name:t.name,status:t.state})),reasoningResponses:app.store.messages(c.conversationId).filter(m=>m.payload.reasoning_content).length,
    process:{exitCode:output.receipt!.exitCode,jobInactive:output.receipt!.jobInactive,reason:output.receipt!.reason,outputArchived:output.text.includes('Umi命令验证通过'),sourceUnchanged:true},
    usage:events.filter(e=>e.type==='usage.recorded').map(e=>e.type==='usage.recorded'?app.store.readArtifact(e.payload.usageRef):null),limitation:'单个真实 Flash high 短任务，仅允许固定 Node 测试脚本；不代表任意脚本安全性、长任务或 Pro 验收。'};
  const path=resolve(process.env.UMI_VERIFY_REPORT||'docs/evidence/deepseek-stage3b.json');mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');passed=true;console.log(JSON.stringify(report,null,2));
}finally{await app.close();if(passed)removeTestRoot(root);else console.log(JSON.stringify({failedEvidenceDirectory:root}));}
