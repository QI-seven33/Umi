import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid} from '../packages/agent/src/identity.js';

const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';
if(!key())throw Error('未配置模型密钥；未执行真实回复验收。');
const root=mkdtempSync(join(tmpdir(),'umi-ui-model-')),workspace=join(root,'workspace');mkdirSync(workspace);
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{context:new ContextManager(1_000_000,16384,{off:512,normal:2048,high:2048}),limits:{maxTurns:3,maxRetries:0,modelTimeoutMs:60000,retryDelayMs:1000}});
const checks:unknown[]=[];
try{
  const c=app.createConversation(workspace,{thinking:'normal'});
  for(const prompt of ['你好','请用两句话解释工作副本是什么。不需要查看文件或使用工具。']){
    const r=app.send(c.conversationId,uid(),prompt);assert.equal((await app.wait(r.runId)).status,'completed');
    assert.equal(app.store.getRun(r.runId).model_turns,1);assert.equal(app.store.tools(r.runId).length,0);
    const state=app.store.snapshot(c.conversationId),reply=state.blocks.filter(b=>b.runId===r.runId&&b.kind==='text'&&b.displayRole==='final').map(b=>b.text).join('');
    assert(reply.trim());assert(!/mountId|environmentId|mount-[a-f0-9]{16}|尚无具体任务目标|本轮没有实际执行/.test(reply));
    if(prompt==='你好'){assert(reply.length<=80);assert(!/工作副本|工作区|修改|文件|项目|代码/.test(reply));}
    checks.push({prompt,reply,modelTurns:1,tools:0,usage:app.contextStatistics(c.conversationId).lastActualUsage});
  }
  mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/ui-response-deepseek.json',JSON.stringify({passed:true,model:'deepseek-flash',thinking:'normal',checks},null,2));
  process.stdout.write(JSON.stringify({passed:true,checks:checks.length,modelTurns:checks.length})+'\n');
}finally{await app.close();}
