import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {hash} from '../../../agent/src/identity.js';
import {UmiError} from '../../../protocol/src/model.js';
import type {ExecutionContext} from '../../../protocol/src/model.js';
import {directCommandSchema,shellCommandSchema,processSnapshotSchema} from '../../../protocol/src/process.js';
import type {ProcessSnapshot} from '../../../protocol/src/process.js';
import {ResourceFiles} from '../host-files/resources.js';
import {safeRoot,fileIdentity,bytesHash} from '../host-files/paths.js';
import {hostContext} from '../host-files/scratch.js';
import {ProcessRepository} from '../sqlite/processes.js';
import {WINDOWS_BRIDGE} from './windows-bridge.js';

export function bridgeProgram(){if(process.platform!=='win32'||!process.env.SystemRoot)throw new UmiError('CAPABILITY_UNAVAILABLE','当前宿主命令执行器仅实现 Windows');return join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');}
export function bridgeEnvironment():Record<string,string>{
  const env:Record<string,string>={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key]!;
  env.PATH=join(process.env.SystemRoot!,'System32');env.PSModulePath=join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','Modules');return env;
}
// 按 Windows C 运行库 argv 规则编码。CMD 的脚本另用其 /s /c 语义，不复用此规则。
export function quoteArgument(value:string){if(value&&!/[\s"]/.test(value))return value;return '"'+value.replace(/(\\*)"/g,(_m,slashes:string)=>slashes+slashes+'\\"').replace(/\\+$/g,s=>s+s)+'"';}
export function fingerprint(root:string):string {
  safeRoot(root);let count=0,bytes=0;const start=Date.now(),entries:unknown[]=[];
  function walk(dir:string,base:string,depth:number){if(depth>24||Date.now()-start>5000)throw new UmiError('PROCESS_SCOPE_LIMIT','命令工作目录超过指纹深度或时间预算');
    for(const name of readdirSync(dir).sort()){if(++count>20000)throw new UmiError('PROCESS_SCOPE_LIMIT','命令工作目录超过 20000 个对象');const file=join(dir,name),path=base?`${base}/${name}`:name,s=lstatSync(file,{bigint:true});
      if(s.isSymbolicLink()||!s.isDirectory()&&(!s.isFile()||s.nlink>1))throw new UmiError('PERMISSION_DENIED','命令工作目录含链接、硬链接或特殊对象');
      if(s.isDirectory()){entries.push({path,directory:true,identity:`${s.dev}:${s.ino}`});walk(file,path,depth+1);}else{
        bytes+=Number(s.size);if(bytes>128*1024*1024||s.size>32n*1024n*1024n)throw new UmiError('PROCESS_SCOPE_LIMIT','命令工作目录超过 128 MiB 总内容或 32 MiB 单文件限制');
        const identity=fileIdentity(file),data=readFileSync(file);if(fileIdentity(file)!==identity||BigInt(data.length)!==s.size)throw new UmiError('RESOURCE_CHANGED','命令准备期间文件改变');entries.push({path,identity,hash:bytesHash(data)});
      }
    }
  }walk(root,'',0);return hash(entries);
}
const executableCache=new Map<string,{stamp:string;digest:string}>();
function executable(path:string,fresh=false){const file=realpathSync(path);safeRoot(dirname(file));const s=lstatSync(file,{bigint:true});if(!s.isFile()||s.size>160n*1024n*1024n)throw new UmiError('PERMISSION_DENIED','程序不是可核验的普通可执行文件');
  const identity=fileIdentity(file),stamp=`${identity}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,old=executableCache.get(file);let digest=old?.stamp===stamp&&!fresh?old.digest:bytesHash(readFileSync(file));
  if(fileIdentity(file)!==identity)throw new UmiError('RESOURCE_CHANGED','程序身份变化');executableCache.set(file,{stamp,digest});return {path:file,identity,digest};
}
function resolveProgram(program:string){
  if(program==='node'&&!process.versions.electron)return process.execPath;
  if(isAbsolute(program)){if(!/\.exe$/i.test(program))throw new UmiError('PROGRAM_UNSUPPORTED','直接执行仅接受 .exe；批处理请使用明确的 CMD 脚本');return program;}
  if(/[\\/]/.test(program)||!/^[-\w.]+$/.test(program))throw new UmiError('PROGRAM_UNSUPPORTED','程序使用明确名称或绝对 .exe 路径');
  for(const path of (process.env.PATH??'').split(';').filter(Boolean)){const candidate=join(path,/\.exe$/i.test(program)?program:`${program}.exe`);if(existsSync(candidate))return candidate;}
  throw new UmiError('PROGRAM_NOT_FOUND','没有找到指定程序；npm 等 .cmd 入口应使用 CMD 模式');
}
export class CommandPreparation {
  constructor(readonly files:ResourceFiles,readonly repo:ProcessRepository){}
  prepare(input:unknown,mode:'direct'|'shell',executionId:string,fresh=false,track=true):ExecutionContext {
    bridgeProgram();const a=mode==='direct'?directCommandSchema.parse(input):shellCommandSchema.parse(input),t=this.repo.store.tool(executionId),env=this.repo.store.environment(t.environment_id);let root:string;
    if(a.cwd.kind==='mount'){const m=this.files.repo.mount(a.cwd.mountId,env.id);this.files.mountContext({},env,m.id,undefined,undefined,true);root=m.root;}
    else root=join(env.root,'task',a.cwd.area);
    safeRoot(root);if(a.cwd.path)root=join(root,...a.cwd.path.split('/'));root=safeRoot(root);const cwdIdentity=`${statSync(root,{bigint:true}).dev}:${statSync(root,{bigint:true}).ino}`,cwdFingerprint=fingerprint(root);
    if(track)this.repo.trackFingerprint(executionId,root,cwdFingerprint);
    const context=hostContext(input,this.repo.store.environment(env.id));let program:string,argv:string[],script:string|undefined,shell:'powershell'|'cmd'|'direct'='direct';
    if(mode==='direct'){const d=directCommandSchema.parse(input);program=resolveProgram(d.program);argv=d.argv;}else{const s=shellCommandSchema.parse(input);script=s.script;shell=s.shell;
      program=s.shell==='powershell'?bridgeProgram():join(process.env.SystemRoot!,'System32','cmd.exe');argv=s.shell==='powershell'?['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("[Console]::InputEncoding=New-Object System.Text.UTF8Encoding;[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;$OutputEncoding=[Console]::OutputEncoding;"+script,'utf16le').toString('base64')]:['/d','/s','/c',script];}
    const exe=executable(program,fresh);let scope:ProcessSnapshot['scope']='host-code-execution';const environment:Record<string,string>={...bridgeEnvironment(),PATH:process.env.PATH??''};for(const [key,value] of Object.entries(a.env))if(value!==undefined)environment[key]=value;
    if(mode==='direct'&&/(?:^|[\\/])(?:powershell|pwsh|cmd)\.exe$/i.test(exe.path))throw new UmiError('PROGRAM_UNSUPPORTED','Windows Shell 请使用 run_shell，以固定 NoProfile 或禁用 AutoRun 的入口执行');
    // 不继承 API 密钥、NODE_OPTIONS、代理凭据、SSH agent、PowerShell profile 或用户 Git 全局配置。
    if(/(?:^|[\\/])git\.exe$/i.test(exe.path)){
      const verb=argv[0];if(!verb||verb.startsWith('-')||argv.some(x=>x==='-c'||x.startsWith('--config-env')||x.startsWith('--exec-path')||x.startsWith('--upload-pack')||x.startsWith('--receive-pack')))throw new UmiError('GIT_ARGUMENTS_UNSUPPORTED','Git 必须指定明确子命令；不接受配置/执行程序覆盖参数');
      scope=['status','diff','log','show','rev-parse','ls-files'].includes(verb)?'git-inspect':['clone','fetch','pull','push'].includes(verb)?'git-network':['reset','clean','restore'].includes(verb)?'git-destructive':'git-write';
      environment.GIT_CONFIG_NOSYSTEM='1';environment.GIT_CONFIG_GLOBAL='NUL';environment.GIT_TERMINAL_PROMPT='0';environment.GCM_INTERACTIVE='Never';
      argv=['-c','credential.helper=','-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','protocol.ext.allow=never',...argv];
      if(verb==='diff'||verb==='show')argv.push('--no-ext-diff','--no-textconv');
    }
    const commandLine=shell==='cmd'?`${quoteArgument(exe.path)} /d /s /c "${script}"`:[exe.path,...argv].map(quoteArgument).join(' ');
    const snapshot=processSnapshotSchema.parse({schemaVersion:1,executionId,leaseGeneration:this.repo.store.getRun(t.run_id).generation,mode:shell,program:exe.path,programIdentity:exe.identity,programHash:exe.digest,
      argv,commandLine,cwd:root,cwdIdentity,cwdFingerprint,cwdRef:a.cwd,env:environment,stdin:a.stdin,...(script!==undefined?{script,scriptHash:hash(script)}:{}),bridgeHash:hash(WINDOWS_BRIDGE),timeoutMs:a.timeoutMs,maxOutputBytes:a.maxOutputBytes,scope});
    return {...context,runtimeId:'host-windows-job-process',process:snapshot};
  }
}
