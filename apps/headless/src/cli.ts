import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { z } from 'zod';
import { UmiApplication } from './application.js';
import { DeepSeekAdapter } from '../../../packages/adapters/src/deepseek/adapter.js';
import { cursorSchema, settingsSchema, UmiError } from '../../../packages/protocol/src/model.js';
import { uid } from '../../../packages/agent/src/identity.js';
import { filePath } from '../../../packages/protocol/src/resources.js';

const ref=z.string().min(1).max(160);
const commands=z.discriminatedUnion('type',[
  z.object({type:z.literal('create'),workspace:z.string().min(1),settings:settingsSchema.optional()}).strict(),
  z.object({type:z.literal('send'),conversationId:ref,commandId:ref,text:z.string().min(1).max(2_000_000)}).strict(),
  z.object({type:z.literal('approve'),conversationId:ref,approvalId:ref,decision:z.enum(['allow','deny'])}).strict(),
  z.object({type:z.literal('stop'),conversationId:ref,runId:ref}).strict(),
  z.object({type:z.literal('resume'),conversationId:ref,runId:ref}).strict(),
  z.object({type:z.literal('recovery'),conversationId:ref,runId:ref}).strict(),
  z.object({type:z.literal('history'),conversationId:ref}).strict(),
  z.object({type:z.literal('context'),conversationId:ref}).strict(),
  z.object({type:z.literal('memory'),conversationId:ref}).strict(),
  z.object({type:z.literal('preview_file'),conversationId:ref,mountId:ref,path:filePath,startByte:z.number().int().nonnegative().default(0),byteLength:z.number().int().min(1).max(64000).default(8192)}).strict(),
  z.object({type:z.literal('preview_changeset'),conversationId:ref,changeSetId:ref}).strict(),
  z.object({type:z.literal('preview_process'),conversationId:ref,executionId:ref,channel:z.enum(['stdout','stderr']),startByte:z.number().int().nonnegative().default(0),byteLength:z.number().int().min(1).max(64000).default(8192)}).strict(),
  z.object({type:z.literal('settings'),conversationId:ref,settings:settingsSchema}).strict(),
  z.object({type:z.literal('subscribe'),conversationId:ref,cursor:cursorSchema}).strict(),
  z.object({type:z.literal('unsubscribe'),subscriptionId:ref}).strict(),
  z.object({type:z.literal('shutdown')}).strict(),
]);
const index=process.argv.indexOf('--data'),dataRoot=resolve(index>=0?process.argv[index+1]??'.umi':'.umi');
const baseUrl=process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com',key=()=>process.env.DEEPSEEK_API_KEY?.trim()??'';
const app=new UmiApplication(dataRoot,new DeepSeekAdapter(key,baseUrl),{search:{key,baseUrl}});
const write=(value:unknown)=>process.stdout.write(`${JSON.stringify(value)}\n`);
const subscriptions=new Map<string,AbortController>();let closing=false;
async function shutdown(){if(closing)return;closing=true;for(const s of subscriptions.values())s.abort();await app.close();input.close();}
const input=createInterface({input:process.stdin,terminal:false});
write({kind:'ready',name:'Umi',protocolVersion:1,instanceId:app.store.instanceId,databaseVersion:5,
  capabilities:{modelConfigured:Boolean(key()),history:true,contextMaintenance:true,workMemory:true,scratchApproval:true,resources:true,workingCopy:true,delivery:true,nativeRecycle:process.platform==='win32',shell:process.platform==='win32',osSandbox:false},dataRoot});
async function handle(line:string) {
  try {
    if(Buffer.byteLength(line)>3_000_000)throw new UmiError('PROTOCOL_INVALID','命令过长');
    let json:unknown;try{json=JSON.parse(line);}catch{throw new UmiError('PROTOCOL_INVALID','命令不是 JSON');}
    const parsed=commands.safeParse(json);if(!parsed.success)throw new UmiError('PROTOCOL_INVALID','命令字段不符合协议');
    const c=parsed.data;
    switch(c.type){
      case 'create':write({kind:'result',type:c.type,...app.createConversation(c.workspace,c.settings)});break;
      case 'send':write({kind:'ack',type:c.type,commandId:c.commandId,...app.send(c.conversationId,c.commandId,c.text)});break;
      case 'approve':app.approve(c.conversationId,c.approvalId,c.decision);write({kind:'ack',type:c.type,approvalId:c.approvalId});break;
      case 'settings':app.store.updateSettings(c.conversationId,c.settings);write({kind:'result',type:c.type,settings:app.store.settings(c.conversationId)});break;
      case 'stop':await app.stop(c.conversationId,c.runId);write({kind:'result',type:c.type,run:app.store.getRun(c.runId)});break;
      case 'resume':app.resume(c.conversationId,c.runId);write({kind:'ack',type:c.type,runId:c.runId});break;
      case 'recovery':write({kind:'result',type:c.type,...app.inspectRecovery(c.conversationId,c.runId)});break;
      case 'history':write({kind:'snapshot',state:app.store.snapshot(c.conversationId),messages:app.store.messages(c.conversationId)});break;
      case 'context':write({kind:'result',type:c.type,...app.contextStatistics(c.conversationId)});break;
      case 'memory':write({kind:'result',type:c.type,...app.store.contextMemory(c.conversationId)});break;
      case 'preview_file':write({kind:'result',type:c.type,preview:app.previewFile(c.conversationId,c.mountId,c.path,c.startByte,c.byteLength)});break;
      case 'preview_changeset':write({kind:'result',type:c.type,...app.previewChangeSet(c.conversationId,c.changeSetId)});break;
      case 'preview_process':write({kind:'result',type:c.type,preview:app.previewProcess(c.conversationId,c.executionId,c.channel,c.startByte,c.byteLength)});break;
      case 'subscribe': {
        app.store.events(c.conversationId,c.cursor);const id=uid(),controller=new AbortController();subscriptions.set(id,controller);write({kind:'ack',type:c.type,subscriptionId:id});
        void (async()=>{try{for await(const event of app.subscribe(c.conversationId,c.cursor,controller.signal))write({kind:'event',subscriptionId:id,event});}
          catch(e){write({kind:'error',subscriptionId:id,code:e instanceof UmiError?e.code:'SUBSCRIPTION_FAILED',message:'订阅无法继续，请重新读取快照'});}finally{subscriptions.delete(id);}})();break;
      }
      case 'unsubscribe':subscriptions.get(c.subscriptionId)?.abort();write({kind:'result',type:c.type});break;
      case 'shutdown':await shutdown();break;
    }
  }catch(e){write({kind:'error',code:e instanceof UmiError?e.code:'COMMAND_FAILED',message:e instanceof UmiError?e.message:'命令处理失败'});}
}
// 只串行处理短命令，长任务由 Agent 独立推进；批准输入不会堵在任务 Promise 后。
let queue=Promise.resolve();input.on('line',line=>{queue=queue.then(()=>handle(line));});
input.on('close',()=>{if(!closing)void queue.then(shutdown);});process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
