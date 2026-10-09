import {utilityProcess} from 'electron';
import type {UtilityProcess} from 'electron';
import {randomUUID} from 'node:crypto';
import {readySchema,ipcResponseSchema,bootErrorSchema} from '../../packages/protocol/src/desktop.js';
import type {DesktopCommand,DesktopConfig} from '../../packages/protocol/src/desktop.js';
import {UmiError} from '../../packages/protocol/src/model.js';

export class AgentBroker {
  private child:UtilityProcess|null=null;
  private current:ReturnType<typeof readySchema.parse>|null=null;
  private starting:Promise<ReturnType<typeof readySchema.parse>>|null=null;
  private pending=new Map<string,{resolve:(x:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private closing=false;
  private nextStartAt=0;
  private failures=0;
  constructor(private readonly entry:string,private readonly dataRoot:string,private config:DesktopConfig,private verification=false){}
  async ready(){if(this.closing)throw new UmiError('APP_SHUTDOWN','应用正在退出');if(this.current)return this.current;if(this.starting)return this.starting;
    if(Date.now()<this.nextStartAt)throw new UmiError('READY_BACKOFF','Agent 尚未就绪，请稍后重试；不会自动恢复任务');
    this.starting=new Promise<ReturnType<typeof readySchema.parse>>((resolve,reject)=>{
      const env:Record<string,string>={};for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH'])if(process.env[k])env[k]=process.env[k]!;
      const child=utilityProcess.fork(this.entry,[],{env,stdio:'pipe',serviceName:'Umi Agent'});this.child=child;
      const timer=setTimeout(()=>{child.kill();reject(new UmiError('READY_TIMEOUT','Agent 未完成数据库与协议就绪检查'));},20000);
      child.on('message',message=>{if(child!==this.child)return;
        if(message?.kind==='boot_error'){const e=bootErrorSchema.safeParse(message);clearTimeout(timer);child.kill();reject(new UmiError(e.success?e.data.code:'READY_FAILED',e.success?e.data.message:'Agent 初始化失败'));return;}
        if(message?.kind==='ready'){try{this.current=readySchema.parse(message.payload);this.failures=0;this.nextStartAt=0;clearTimeout(timer);resolve(this.current);}catch{child.kill();reject(new UmiError('PROTOCOL_INVALID','Agent 就绪协议不兼容'));}return;}
        const parsed=ipcResponseSchema.safeParse(message);if(!parsed.success)return;const response=parsed.data;
        if(!this.current||response.instanceId!==this.current.instanceId)return;
        const p=this.pending.get(response.correlationId);if(!p)return;clearTimeout(p.timer);this.pending.delete(response.correlationId);
        if(response.kind==='error')p.reject(new UmiError(response.code,response.message));else p.resolve(response.payload);
      });
      child.on('exit',()=>{clearTimeout(timer);if(child!==this.child)return;this.child=null;this.current=null;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new UmiError('AGENT_DISCONNECTED','Agent 进程退出；命令可能已接收，请按原 commandId 查询'));}this.pending.clear();reject(new UmiError('AGENT_DISCONNECTED','Agent 启动或执行进程退出'));});
      child.on('spawn',()=>child.postMessage({kind:'init',dataRoot:this.dataRoot,config:this.config,...(this.verification?{verification:true}:{})}));
      // stderr 不转发给渲染器；避免诊断回显成为秘密泄露通道。
      child.stderr?.on('data',()=>{});child.stdout?.on('data',()=>{});
    }).catch(error=>{this.failures++;this.nextStartAt=Date.now()+Math.min(30000,1000*2**this.failures);throw error;}).finally(()=>{this.starting=null;});return this.starting;
  }
  async request(payload:DesktopCommand|{internal:'create_internal'|'configure'|'shutdown';payload:unknown}){
    if(this.pending.size>=32)throw new UmiError('BACKPRESSURE','待处理请求过多，请稍后从持久游标继续');
    const ready=await this.ready(),correlationId=randomUUID();return new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(correlationId);reject(new UmiError('COMMAND_TIMEOUT','命令回执超时；请查询原 commandId，不要重复提交新命令'));},20000);
      this.pending.set(correlationId,{resolve,reject,timer});
      try{this.child!.postMessage('internal' in payload?{kind:payload.internal,correlationId,instanceId:ready.instanceId,payload:payload.payload}:{protocolVersion:1,correlationId,instanceId:ready.instanceId,payload});}
      catch{clearTimeout(timer);this.pending.delete(correlationId);reject(new UmiError('AGENT_DISCONNECTED','消息未能发送到执行进程'));}
    });
  }
  async configure(config:DesktopConfig){if(config.baseUrl!==this.config.baseUrl)throw new UmiError('CONFIG_RESTART_REQUIRED','修改端点后请重启 Umi；正在运行的任务不会切换模型路由');await this.request({internal:'configure',payload:config});this.config=config;if(this.current)this.current.modelConfigured=Boolean(config.apiKey);}
  async close(){if(this.closing)return;if(this.child&&this.current){try{await this.request({internal:'shutdown',payload:{}});}catch{this.child?.kill();}}this.closing=true;this.child?.kill();}
  killForVerification(){this.child?.kill();}
}

