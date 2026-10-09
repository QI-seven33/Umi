import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { ContextManager } from '../packages/agent/src/context/manager.js';
import { uid } from '../packages/agent/src/identity.js';
import { removeTestRoot } from '../tests/fixtures.js';

// 实际 API 仅操作专用临时资源。凭据从环境读，不输出、不写报告和请求快照。
const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';if(!key())throw new Error('未配置 DEEPSEEK_API_KEY，未调用真实模型');
const root=mkdtempSync(join(tmpdir(),'umi-live-files-')),workspace=join(root,'workspace'),external=join(root,'external-project');mkdirSync(workspace);mkdirSync(external);
writeFileSync(join(external,'config.json'),JSON.stringify({port:3000,name:'Umi',keep:true},null,2));
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{
  context:new ContextManager(1_000_000,16384,{off:1024,normal:4096,high:8192}),limits:{maxTurns:16,maxRetries:0,modelTimeoutMs:180000,retryDelayMs:1000}});
try {
  const c=app.createConversation(workspace,{thinking:'high'}),r=app.send(c.conversationId,uid(),
    `外部项目位于 ${external}。请实际发现并申请这个项目的工作副本编辑权限，读取 config.json，将 port 从 3000 改为 4100，保持 name 和 keep 等其他内容；新增 report.md，只写“完成”。然后申请把这两项变化交付到该项目的真实目录。请先说明进展，批准后继续，取得实际交付结果再总结。不要操作其他目录，不要用 write_scratch 代替项目交付。`);
  const deadline=Date.now()+480000;const approved=new Set<string>();let lastSequence='0';
  while(!['completed','failed','interrupted','recovery_required','stopped'].includes(app.store.getRun(r.runId).status)) {
    for(const event of app.store.events(c.conversationId).filter(e=>BigInt(e.sequence)>BigInt(lastSequence))) {
      lastSequence=event.sequence;if(['model.request_prepared','tool.prepared','tool.settled','run.waiting'].includes(event.type))
        console.log(JSON.stringify({progress:event.type,...(event.type==='tool.prepared'?{tool:event.payload.name}:{}),sequence:event.sequence}));
    }
    for(const [approvalId,a] of Object.entries(app.store.snapshot(c.conversationId).approvals)) {
      if(a.status!=='pending'||approved.has(approvalId))continue;
      const tool=app.store.tool(app.store.approval(approvalId).execution_id),args=JSON.parse(tool.args) as {candidateId?:string;changeSetId?:string};
      assert.equal(app.store.getRun(r.runId).status,'waiting_permission');
      assert(!app.store.snapshot(c.conversationId).blocks.some(b=>b.displayRole==='final'),'批准前不能产生最终身份');
      if(tool.name==='request_resource') {const candidate=app.files.repo.getCandidate(args.candidateId!,c.environmentId);assert.equal(resolve(candidate.path),resolve(external));}
      else if(tool.name==='deliver_changeset') {
        const cs=app.files.repo.changeSet(args.changeSetId!,c.environmentId),m=app.files.repo.mount(cs.mountId,c.environmentId);assert.equal(resolve(m.sourceRoot),resolve(external));
        assert.deepEqual(cs.changes.map(c=>c.path).sort(),['config.json','report.md']);
        const config=cs.changes.find(c=>c.path==='config.json')!,report=cs.changes.find(c=>c.path==='report.md')!,env=app.store.environment(c.environmentId);
        assert.deepEqual(JSON.parse(app.files.blob(env,config.after!.hash).toString()),{port:4100,name:'Umi',keep:true});assert.equal(app.files.blob(env,report.after!.hash).toString().trim(),'完成');
        assert.equal(JSON.parse(readFileSync(join(external,'config.json'),'utf8')).port,3000);
      }else throw new Error(`验证拒绝批准超出测试范围的工具：${tool.name}`);
      console.log(JSON.stringify({progress:'approval-verified',tool:tool.name}));approved.add(approvalId);app.approve(c.conversationId,approvalId,'allow');
    }
    if(Date.now()>deadline)throw new Error('真实文件任务超过验收时间限制');await delay(100);
  }
  assert.equal((await app.wait(r.runId)).status,'completed');assert.deepEqual(JSON.parse(readFileSync(join(external,'config.json'),'utf8')),{port:4100,name:'Umi',keep:true});assert.equal(readFileSync(join(external,'report.md'),'utf8').trim(),'完成');
  const requests=app.store.all('SELECT artifact_id FROM model_requests ORDER BY rowid'),events=app.store.events(c.conversationId);
  const responses=app.store.all("SELECT id FROM artifacts WHERE kind='provider-response'").flatMap(r=>app.store.readArtifact<{model?:string}[]>(r.id as string));
  const reasoning=app.store.messages(c.conversationId).filter(m=>m.payload.reasoning_content).map(m=>m.payload.reasoning_content!);
  const report={name:'Umi',verifiedAt:new Date().toISOString(),status:'passed',requestedModel:'deepseek-flash',returnedModels:[...new Set(responses.map(r=>r.model).filter(Boolean))],thinking:'high',
    calls:requests.length,approvals:approved.size,tools:app.store.tools(r.runId).map(t=>({name:t.name,status:t.state})),
    checks:['真实外部发现','资源批准后物化','真实文件读取','副本自动编辑','交付前源文件未变','固定两文件交付批准','回执后最终总结','原始 reasoning 持久回传'],
    reasoningPresent:reasoning.length,reasoningFirstNonWhitespaceIsHan:/^\p{Script=Han}/u.test((reasoning[0]??'').trimStart()),
    usage:events.filter(e=>e.type==='usage.recorded').map(e=>e.type==='usage.recorded'?app.store.readArtifact(e.payload.usageRef):null),
    limitation:'单个 Flash high 短任务样本；不代表 Pro、长任务稳定性、大窗口或成本结论。'};
  const output=resolve(process.env.UMI_VERIFY_REPORT||'docs/evidence/deepseek-stage3a.json');mkdirSync(join(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await app.close();removeTestRoot(root);}
