import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {StringDecoder} from 'node:string_decoder';
import {z} from 'zod';
import {UmiError} from '../../../protocol/src/model.js';
import {processIdentitySchema} from '../../../protocol/src/process.js';
import type {ProcessIdentity,ProcessSnapshot} from '../../../protocol/src/process.js';
import {WINDOWS_BRIDGE} from './windows-bridge.js';
import {bridgeEnvironment,bridgeProgram} from './prepare.js';

const frameSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('owner'),bridge:processIdentitySchema}).strict(),
  z.object({kind:z.literal('ready'),bridge:processIdentitySchema,child:processIdentitySchema}).strict(),
  z.object({kind:z.literal('started')}).strict(),
  z.object({kind:z.literal('data'),channel:z.enum(['stdout','stderr']),base64:z.string().max(6000).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict(),
  z.object({kind:z.literal('exit'),reason:z.enum(['exited','timeout','stopped','parent_closed','not_started','launch_failed']),exitCode:z.number().int().nullable(),jobInactive:z.boolean(),gateReleased:z.boolean(),stdoutBytes:z.number().int().nonnegative(),stderrBytes:z.number().int().nonnegative(),truncated:z.boolean()}).strict(),
  z.object({kind:z.literal('error'),reason:z.string(),gateReleased:z.boolean()}).strict(),
  z.object({kind:z.literal('probe'),state:z.enum(['absent','different','same','terminated','inaccessible'])}).strict(),
]);
export type NativeExit=Extract<z.infer<typeof frameSchema>,{kind:'exit'}>;
function startBridge(){
  // 脚本通过标准输入传输，避免 Windows 命令行长度上限；引导脚本没有模型输入插值。
  const bootstrap="[Console]::InputEncoding=New-Object System.Text.UTF8Encoding;[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::ReadLine())))";
  const child=spawn(bridgeProgram(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:bridgeEnvironment()});
  child.stdin.on('error',()=>{});child.stdin.write(Buffer.from(WINDOWS_BRIDGE,'utf16le').toString('base64')+'\n');return child;
}
// 保留尾部，避免已知 API 密钥在两个输出分片之间被拆开而绕过脱敏。
class OutputRedactor {
  private decoder=new StringDecoder('utf8');private tail='';
  private readonly secrets=Object.entries(process.env).filter(([k,v])=>/(?:API_KEY|TOKEN|PASSWORD|SECRET)$/i.test(k)&&v&&v.length>=8).map(([,v])=>v!);
  write(bytes:Buffer,final=false){this.tail+=this.decoder.write(bytes)+(final?this.decoder.end():'');for(const secret of this.secrets)this.tail=this.tail.split(secret).join('[已隐藏凭据]');
    let keep=0;if(!final)for(const secret of this.secrets){for(let n=Math.min(this.tail.length,secret.length-1);n>keep;n--)if(this.tail.endsWith(secret.slice(0,n))){keep=n;break;}}
    let end=Math.max(0,this.tail.length-keep);if(end&&/[\uD800-\uDBFF]/.test(this.tail[end-1]!)&&/[\uDC00-\uDFFF]/.test(this.tail[end]??''))end--;const text=this.tail.slice(0,end);this.tail=this.tail.slice(end);return text;
  }
}
export class WindowsProcessRunner {
  async run(snapshot:ProcessSnapshot,callbacks:{owner:(bridge:ProcessIdentity)=>void;ready:(bridge:ProcessIdentity,child:ProcessIdentity)=>Promise<void>;started:()=>void;output:(channel:'stdout'|'stderr',text:string)=>void},signal:AbortSignal):Promise<NativeExit>{
    signal.throwIfAborted();const child=startBridge(),closed=once(child,'close');void closed.catch(()=>{});let finished=false,owned=false,ready=false,released=false,exit:NativeExit|undefined,fatal=false;
    const redactors={stdout:new OutputRedactor(),stderr:new OutputRedactor()};const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
    let archivedBytes=0,archiveTruncated=false;const publish=(channel:'stdout'|'stderr',text:string)=>{const bytes=Buffer.from(text);let length=Math.min(bytes.length,Math.max(0,snapshot.maxOutputBytes-archivedBytes));while(length<bytes.length&&length>0&&(bytes[length]!&0xc0)===0x80)length--;if(length<bytes.length)archiveTruncated=true;archivedBytes+=length;if(length)callbacks.output(channel,bytes.subarray(0,length).toString('utf8'));};
    child.stderr.on('data',()=>{});child.on('error',()=>{fatal=true;});
    const abort=()=>{if(!finished)child.stdin.write('stop\n');};signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{fatal=true;child.stdin.destroy();},snapshot.timeoutMs+25000);
    try{
      child.stdin.write(JSON.stringify({action:'run',program:snapshot.program,commandLine:snapshot.commandLine,cwd:snapshot.cwd,env:snapshot.env,stdin:snapshot.stdin,timeoutMs:snapshot.timeoutMs,maxOutputBytes:snapshot.maxOutputBytes})+'\n');
      for await(const line of lines){if(line.length>12000)throw new UmiError('PROCESS_PROTOCOL_INVALID','原生桥接输出超过协议上限');
        const frame=frameSchema.parse(JSON.parse(line.replace(/^\uFEFF/,'')));
        if(frame.kind==='owner'){if(owned||frame.bridge.pid!==child.pid)throw new UmiError('PROCESS_PROTOCOL_INVALID','桥接所有者身份错误');owned=true;callbacks.owner(frame.bridge);signal.throwIfAborted();child.stdin.write('prepare\n');}
        else if(frame.kind==='ready'){if(!owned||ready||frame.bridge.pid!==child.pid)throw new UmiError('PROCESS_PROTOCOL_INVALID','原生桥接身份或就绪状态错误');ready=true;await callbacks.ready(frame.bridge,frame.child);signal.throwIfAborted();child.stdin.write('go\n');}
        else if(frame.kind==='started'){if(!ready||released)throw new UmiError('PROCESS_PROTOCOL_INVALID','进程启动顺序错误');released=true;callbacks.started();}
        else if(frame.kind==='data'){if(!released||exit)throw new UmiError('PROCESS_PROTOCOL_INVALID','进程输出顺序错误');const text=redactors[frame.channel].write(Buffer.from(frame.base64,'base64'));publish(frame.channel,text);}
        else if(frame.kind==='exit'){if(exit||frame.gateReleased!==released)throw new UmiError('PROCESS_PROTOCOL_INVALID','进程退出回执顺序错误');for(const channel of ['stdout','stderr'] as const)publish(channel,redactors[channel].write(Buffer.alloc(0),true));exit={...frame,truncated:frame.truncated||archiveTruncated};}
        else if(frame.kind==='error')fatal=true;
        else throw new UmiError('PROCESS_PROTOCOL_INVALID','执行桥接返回了错误种类');
      }
      const [code]=await closed;finished=true;if(code!==0||fatal||!exit)throw new UmiError('PROCESS_OUTCOME_UNKNOWN','原生进程退出回执不完整；未重启原命令');return exit;
    }finally{
      finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);child.stdin.destroy();lines.close();
      if(child.exitCode===null&&child.signalCode===null){await Promise.race([closed.catch(()=>{}),delay(7000)]);if(child.exitCode===null&&child.signalCode===null)child.kill();}
      await closed.catch(()=>{});
    }
  }
  async probe(identity:ProcessIdentity,terminate=false):Promise<'absent'|'different'|'same'|'terminated'|'inaccessible'>{
    processIdentitySchema.parse(identity);
    const child=startBridge(),closed=once(child,'close');let output='',overflow=false;const timer=setTimeout(()=>child.kill(),20000);
    child.on('error',()=>{});child.stderr.on('data',()=>{});child.stdout.on('data',b=>{output+=String(b);if(output.length>12000){overflow=true;child.kill();}});
    child.stdin.end(JSON.stringify({action:'probe',...identity,terminate})+'\n');
    try{const [code]=await closed;if(code!==0||overflow)return 'inaccessible';const frame=frameSchema.parse(JSON.parse(output.replace(/^\uFEFF/,'')));return frame.kind==='probe'?frame.state:'inaccessible';}
    catch{return 'inaccessible';}finally{clearTimeout(timer);}
  }
}
