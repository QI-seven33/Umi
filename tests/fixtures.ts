import type { ModelPort, PreparedRequest, ModelFrame } from '../packages/agent/src/ports.js';
import type { WireMessage, ToolSpec, Settings } from '../packages/protocol/src/model.js';
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync,rmSync } from 'node:fs';
import { basename,dirname } from 'node:path';
import { tmpdir } from 'node:os';
export function removeTestRoot(root:string) {
  const target=realpathSync(root),parent=realpathSync(tmpdir());
  if(dirname(target).toLowerCase()!==parent.toLowerCase()||!basename(target).startsWith('umi-'))
    throw new Error('拒绝清理专用临时测试目录以外的位置');
  rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
export type Step=WireMessage|((request:PreparedRequest)=>WireMessage|Promise<WireMessage>);
// 仅替换模型端口；所有模拟响应仍经过产品中的同一个循环和仓储。
export class ScriptModel implements ModelPort {
  readonly requests:PreparedRequest[]=[];beforeResponse:((request:PreparedRequest)=>Promise<void>)|undefined;
  constructor(private readonly steps:Step[]) {}
  prepare(messages:WireMessage[],tools:ToolSpec[],settings:Settings,maxOutputTokens:number):PreparedRequest {
    return {adapterId:'fixture',adapterVersion:'1',protocol:'fixture',endpointProfileId:'local-fixture',model:settings.model,settings,maxOutputTokens,body:{messages,tools}};
  }
  async* stream(request:PreparedRequest,signal:AbortSignal):AsyncGenerator<ModelFrame> {
    this.requests.push(structuredClone(request));signal.throwIfAborted();
    const step=this.steps.shift();if(!step)throw new Error('模拟脚本已用尽');const message=typeof step==='function'?await step(request):step;
    if(message.reasoning_content)yield {kind:'delta',channel:'reasoning',key:'reasoning',text:message.reasoning_content};
    if(message.content){yield {kind:'delta',channel:'text',key:'text',text:message.content.slice(0,2)};await delay(1,undefined,{signal});
      yield {kind:'delta',channel:'text',key:'text',text:message.content.slice(2)};}
    for(const c of message.tool_calls??[])yield {kind:'delta',channel:'tool',key:c.id,text:c.function.arguments};
    await this.beforeResponse?.(request);signal.throwIfAborted();
    yield {kind:'response',message,finishReason:message.tool_calls?.length?'tool_calls':'stop',usage:{prompt_tokens:17,completion_tokens:11},raw:{message}};
  }
}
export const text=(content:string):WireMessage=>({role:'assistant',content});
export const call=(name:string,args:unknown,content='先执行这项操作。',id='provider-call-1'):WireMessage=>({role:'assistant',content,
  reasoning_content:'我先核实必要的信息。',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
export async function eventually<T>(fn:()=>T|undefined,timeout=4000):Promise<T> {
  const start=Date.now();while(Date.now()-start<timeout){const value=fn();if(value!==undefined)return value;await delay(5);}throw new Error('条件未按时满足');
}

// 测试模型按域合并最新事实，而非假定每轮最后一条必为全量快照。
export function projectedFacts(messages: WireMessage[]): Record<string, any> {
  const domains: Record<string, any> = {};
  for (const message of messages) {
    if (message.role !== 'system' || !message.content.startsWith('当前宿主事实按域更新；')) continue;
    Object.assign(domains, JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)));
  }
  return domains;
}
