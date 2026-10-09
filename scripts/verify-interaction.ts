import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DeepSeekAdapter} from '../packages/adapters/src/deepseek/adapter.js';
import {ContextManager} from '../packages/agent/src/context/manager.js';
import {uid} from '../packages/agent/src/identity.js';

// 仅发送生成的测试图片和测试原话；不读取用户文件，不执行宿主命令。
function png(){
  const crc=(bytes:Buffer)=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
  const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(128,0);header.writeUInt32BE(128,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(128*(1+128*3)))),chunk('IEND',Buffer.alloc(0))]);
}
const key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';
if(!key())throw new Error('未配置 DeepSeek key，未执行真实验证。');
const root=mkdtempSync(join(tmpdir(),'umi-interaction-live-')),workspace=join(root,'workspace');mkdirSync(workspace);
const app=new UmiApplication(join(root,'data'),new DeepSeekAdapter(key,process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com'),{
  context:new ContextManager(1_000_000,16384,{off:1024,normal:2048,high:4096}),
  limits:{maxTurns:5,maxRetries:0,modelTimeoutMs:60000,retryDelayMs:1000}});
try{
  const c=app.createConversation(workspace,{thinking:'off'});
  const first=app.send(c.conversationId,uid(),'本次测试原始要求：配色为灰色。请仅用一句话确认，不使用工具。');assert.equal((await app.wait(first.runId)).status,'completed');
  const second=app.send(c.conversationId,uid(),'请调用 search_history 找回本会话包含“配色为灰色”的用户原话，然后仅用一句话说出找到的颜色。不要调用其他工具。');assert.equal((await app.wait(second.runId)).status,'completed');
  const tools=app.store.tools(second.runId);assert(tools.some(t=>t.name==='search_history'&&t.state==='succeeded'));
  const requests=app.store.all('SELECT run_id, artifact_id FROM model_requests ORDER BY rowid');
  const toolRequestCount=requests.filter(r=>r.run_id===second.runId).length;
  const toolTurns=new Set(tools.map(t=>t.turn_id)).size;
  assert.equal(toolRequestCount,toolTurns+1,'结算后不应产生额外总结请求');
  const image=app.store.uploadImage(c.conversationId,'black-square.png',png().toString('base64'));
  const third=app.send(c.conversationId,uid(),'请仅用一句话描述此图的主要颜色。不要使用工具。',[image.id]);assert.equal((await app.wait(third.runId)).status,'completed');
  const state=app.store.snapshot(c.conversationId);
  assert.equal(state.blocks.filter(b=>b.kind==='text'&&b.displayRole==='final'&&b.runId===third.runId).length,1);
  const usages=app.store.events(c.conversationId).filter(e=>e.type==='usage.recorded').map(e=>e.type==='usage.recorded'?app.store.readArtifact(e.payload.usageRef):null);
  const report={passed:true,verifiedAt:new Date().toISOString(),model:'deepseek-flash',thinking:'off',calls:app.store.all('SELECT id FROM model_requests').length,
    checks:['真实原话确认','真实历史检索','工具结算后无重复总结','PNG 用户图片块成功调用','最终正文唯一'],toolRequestCount,toolTurns,
    replies:state.blocks.filter(b=>b.kind==='text'&&b.displayRole==='final').map(b=>b.text),usages};
  mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/interaction-deepseek.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,calls:report.calls,checks:report.checks,replies:report.replies}));
}finally{await app.close();}
