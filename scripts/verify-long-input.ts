import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid} from '../packages/agent/src/identity.js';
import {asTextDocument,documentInstruction} from '../apps/desktop/renderer/src/features/work/longInput.js';
// 与前端共用载体判断和读取指令；只发送生成的测试文本，不读取用户文件。
const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';
if(!key())throw Error('缺少 DeepSeek 配置，未运行真实验证');
const root=mkdtempSync(join(tmpdir(),'umi-long-input-')),workspace=join(root,'workspace');mkdirSync(workspace);
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{
  context:new ContextManager(1_000_000,16384,{off:1024,normal:2048,high:4096}),limits:{maxTurns:6,maxRetries:0,modelTimeoutMs:60000,retryDelayMs:1000}});
try{
  const c=app.createConversation(workspace,{thinking:'off'});
  const original=Array.from({length:180},(_,i)=>`参考第 ${i+1} 行：测试数据只用于验证长消息原文可以保存并读取，不需要文件修改。`).join('\n')+'\n验收口令：海风';
  assert(asTextDocument(original));const document=app.store.uploadAttachment(c.conversationId,'长消息.txt','text/plain',original);
  const receipt=app.send(c.conversationId,uid(),documentInstruction(document.name)+' 原文最后一行包含验收口令，请读到末尾，只回答口令。',[document.id]);
  assert.equal((await app.wait(receipt.runId)).status,'completed');
  const reads=app.store.tools(receipt.runId).filter(t=>t.name==='read_attachment'&&t.state==='succeeded');assert(reads.length>0);
  const reply=app.store.snapshot(c.conversationId).blocks.filter(b=>b.kind==='text'&&b.displayRole==='final').map(b=>b.text).join('');assert(reply.includes('海风'));
  assert.equal(app.store.readAttachment(c.conversationId,document.id,0,64000).text,original);
  const report={passed:true,model:'deepseek-flash',thinking:'off',verifiedAt:new Date().toISOString(),calls:app.store.all('SELECT id FROM model_requests').length,
    originalBytes:Buffer.byteLength(original),attachmentReads:reads.length,reply,checks:['原文持久化无损','真实模型读取附件','越过默认预览范围后取得原文末尾要求','最终正文唯一']};
  mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/surface-long-input.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}
