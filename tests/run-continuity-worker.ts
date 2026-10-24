import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { ScriptModel } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import type { ModelFrame,PreparedRequest } from '../packages/agent/src/ports.js';

const root=process.argv[2]!,source=join(root,'source');mkdirSync(source);
class CrashModel extends ScriptModel {
  override async *stream(_request:PreparedRequest):AsyncGenerator<ModelFrame> {
    yield {kind:'delta',channel:'reasoning',key:'r',text:'崩溃前的原始思考。'};
    // 强制刷新真实流片段，再在没有应用关闭/收尾的情况下退出。
    await new Promise(resolve=>setTimeout(resolve,80));
    process.stdout.write(JSON.stringify({conversationId:c.conversationId,runId:receipt.runId}),()=>process.exit(0));
    await new Promise(()=>{});
  }
}
const app=new UmiApplication(join(root,'data'),new CrashModel([])),c=app.createConversation(source);
const receipt=app.send(c.conversationId,uid(),'处理一个任务');
await app.wait(receipt.runId);
