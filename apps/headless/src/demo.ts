import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from './application.js';
import { ScriptModel, call, text, eventually } from '../../../tests/fixtures.js';
import { uid } from '../../../packages/agent/src/identity.js';
const directory=mkdtempSync(join(tmpdir(),'umi-demo-'));
const model=new ScriptModel([call('write_scratch',{relativePath:'hello.txt',content:'你好，Umi。'},'我先在托管临时区验证写入。'),text('文件已回读核验。'),text('托管测试文件已生成，用户项目未修改。')]);
const app=new UmiApplication(directory,model);
try{
  const c=app.createConversation(directory),receipt=app.send(c.conversationId,uid(),'验证一次批准与文件写入');
  const approvalId=await eventually(()=>Object.entries(app.store.snapshot(c.conversationId).approvals).find(([,a])=>a.status==='pending')?.[0]);
  console.log(`Umi 正在等待批准：${approvalId}`);console.log('演示驱动批准这一次托管测试写入。');app.approve(c.conversationId,approvalId,'allow');
  const run=await app.wait(receipt.runId),env=app.store.environment(c.environmentId);
  console.log(JSON.stringify({name:'Umi',status:run.status,environmentId:env.id,content:readFileSync(join(env.root,'task','scratch','hello.txt'),'utf8'),
    database:join(directory,'umi.sqlite'),cursor:app.store.snapshot(c.conversationId).cursor},null,2));
}finally{await app.close();}
