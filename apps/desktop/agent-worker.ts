import {z} from 'zod';
import {registerExecutionPlugins} from './plugins.js';
import type {DesktopConfig} from '../../packages/protocol/src/desktop.js';
import {DesktopVerificationModel} from './verification-model.js';
import {UmiApplication} from '../headless/src/application.js';
import {DeepSeekAdapter} from '../../packages/adapters/src/deepseek/adapter.js';
import {desktopCommandSchema,desktopConfigSchema,ipcRequestSchema} from '../../packages/protocol/src/desktop.js';
import {UmiError} from '../../packages/protocol/src/model.js';
import {DesktopService} from './service.js';

const port=process.parentPort;if(!port)throw new Error('Agent 只能由 Electron utility process 启动');
const init=z.object({kind:z.literal('init'),dataRoot:z.string().min(1),config:desktopConfigSchema,verification:z.literal(true).optional()}).strict();
let runtimeConfig:DesktopConfig;
let app:UmiApplication|undefined,service:DesktopService|undefined,key='',instanceId='',queue=Promise.resolve();
port.on('message',({data}:Electron.MessageEvent)=>{queue=queue.then(async()=>{
  let correlationId:string|undefined;
  try{
    if(!app){const c=init.parse(data);runtimeConfig=c.config;key=c.config.apiKey??'';app=new UmiApplication(c.dataRoot,c.verification?new DesktopVerificationModel():new DeepSeekAdapter(()=>key,c.config.baseUrl),{search:{key:()=>key,baseUrl:c.config.baseUrl}});registerExecutionPlugins(app.registry,()=>runtimeConfig);service=new DesktopService(app);instanceId=app.store.instanceId;
      port.postMessage({kind:'ready',payload:{protocolVersion:1,instanceId,databaseVersion:5,name:'Umi',node:process.versions.node,sqlite:true,modelConfigured:Boolean(key),osSandbox:false}});return;}
    const internal=z.object({kind:z.enum(['shutdown','configure','create_internal']),correlationId:z.string(),instanceId:z.string(),payload:z.unknown()}).strict().safeParse(data);
    if(internal.success){const c=internal.data;correlationId=c.correlationId;if(c.instanceId!==instanceId)throw new UmiError('INSTANCE_STALE','命令属于旧执行进程');
      if(c.kind==='shutdown'){await app.close();port.postMessage({kind:'result',instanceId,correlationId,payload:{closed:true}});process.exit(0);}
      if(c.kind==='configure'){runtimeConfig=desktopConfigSchema.parse(c.payload);key=runtimeConfig.apiKey??'';port.postMessage({kind:'result',instanceId,correlationId,payload:{configured:true}});return;}
      const c2=z.object({workspace:z.string().min(1)}).strict().parse(c.payload);const result=await service!.handle({type:'create_internal',workspace:c2.workspace});port.postMessage({kind:'result',instanceId,correlationId,payload:result});return;
    }
    const request=ipcRequestSchema.parse(data);correlationId=request.correlationId;if(request.instanceId!==instanceId)throw new UmiError('INSTANCE_STALE','命令属于旧执行进程');
    const result=await service!.handle(request.payload);port.postMessage({kind:request.payload.type==='send'?'ack':'result',instanceId,correlationId,payload:result});
  }catch(e){const error={code:e instanceof UmiError?e.code:'COMMAND_FAILED',message:e instanceof UmiError?e.message:'命令字段无效或服务无法处理'};port.postMessage(correlationId?{kind:'error',instanceId,correlationId,...error}:{kind:'boot_error',...error});}
});});

