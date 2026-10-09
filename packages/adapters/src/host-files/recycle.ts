import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { ResourceFiles } from './resources.js';
import { observe, safeFile, safeRoot, fileIdentity } from './paths.js';
import { hostContext } from './scratch.js';
import { filePath } from '../../../protocol/src/resources.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { UmiError } from '../../../protocol/src/model.js';

// 固定 Windows 桥接程序，模型不能提交脚本、程序名或额外参数。
// 微软 FileIO 原生回收站接口 + Shell 回收站条目核验；不使用自建 .trash。
const SCRIPT=`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$a = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Hash-File([string]$path) {
  $stream=[IO.File]::OpenRead($path)
  $algorithm=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Find-Receipt {
  $shell = New-Object -ComObject Shell.Application
  $bin = $shell.Namespace(10)
  foreach ($item in $bin.Items()) {
    $from = [string]$item.ExtendedProperty('System.Recycle.DeletedFrom')
    $name = [string]$item.ExtendedProperty('System.FileName')
    if (-not $from -or -not $name) { continue }
    $original = [IO.Path]::Combine($from, $name)
    if ($original -ine $a.path) { continue }
    try { $hash = Hash-File $item.Path } catch { continue }
    $birthNs=([IO.File]::GetCreationTimeUtc($item.Path).Ticks - 621355968000000000L) * 100L
    if ($hash -eq $a.hash -and [string]$birthNs -eq [string]$a.birthNs) { return @{ originalPath=$original; contentHash=$hash; recyclePath=$item.Path; deletedAt=[string]$item.ExtendedProperty('System.Recycle.DateDeleted') } }
  }
  return $null
}
if ($a.mode -eq 'apply') {
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($a.path))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'RECYCLE_UNSUPPORTED_VOLUME' }
  $current = Get-Item -LiteralPath $a.path -Force
  while ($current) { if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RESOURCE_LINK' }; if ($current -is [IO.FileInfo]) { $current=$current.Directory } else { $current = $current.Parent } }
  if ((Hash-File $a.path) -ne $a.hash) { throw 'RESOURCE_CHANGED' }
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($a.path,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
}
$receipt = Find-Receipt
@{ sourceAbsent=(-not (Test-Path -LiteralPath $a.path)); receipt=$receipt } | ConvertTo-Json -Compress -Depth 5
`;
type NativeReceipt={sourceAbsent:boolean;receipt:null|{originalPath:string;contentHash:string;recyclePath:string;deletedAt:string}};
async function native(path:string,hash:string,expectedIdentity:string,mode:'apply'|'inspect',signal:AbortSignal):Promise<NativeReceipt> {
  if(process.platform!=='win32'||!process.env.SystemRoot)throw new UmiError('CAPABILITY_UNAVAILABLE','当前平台不提供 Windows 系统回收站');
  const program=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={};for(const k of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','USERDOMAIN','USERNAME'])if(process.env[k])env[k]=process.env[k];
    env.PSModulePath=join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','Modules');env.PATH=join(process.env.SystemRoot!,'System32');
    const child=spawn(program,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(SCRIPT,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal,env});
    let output='',error='';child.stdout.on('data',b=>{output+=String(b);if(output.length>64000)child.kill();});child.stderr.on('data',b=>{error+=String(b);if(error.length>64000)child.kill();});
    child.once('error',reject);child.once('close',code=>{if(code!==0){reject(new UmiError('RECYCLE_FAILED','原生回收站调用未完成，需要核验原文件'));return;}
      try{const r=JSON.parse(output.replace(/^\uFEFF/,'')) as NativeReceipt;if(typeof r.sourceAbsent!=='boolean')throw new Error('invalid');
        if(r.receipt&&fileIdentity(r.receipt.recyclePath)!==expectedIdentity)r.receipt=null;resolve(r);}catch{reject(new UmiError('RECYCLE_UNKNOWN','回收站回执无效'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path,hash,mode,birthNs:expectedIdentity.split(':').at(-1)}));
  });
}
export function registerRecycle(registry:ToolRegistry,files:ResourceFiles,enabled=process.platform==='win32') {
  const schema=z.object({resourceId:z.string().min(1),path:filePath}).strict(),repo=files.repo;
  registry.register({name:'recycle_file',description:'申请将真实来源中的一个普通文件移入 Windows 系统回收站。独立批准绑定原路径、对象身份和内容；核验原生回收站条目。不创建 .trash，不执行任意 Shell。',schema,effect:'source-write',
    prepare(input,env){if(!enabled)throw new UmiError('CAPABILITY_UNAVAILABLE','当前运行环境没有实现原生回收站');const a=schema.parse(input),c=repo.getCandidate(a.resourceId,env.id);
      if(!repo.authorized(c.id,env.id))throw new UmiError('PERMISSION_DENIED','本任务尚未获准访问这个来源');safeRoot(c.path,c.identity);const before=observe(c.path,a.path,c.identity);
      if(!before)throw new UmiError('NOT_FOUND','原文件不存在');return {...hostContext(input,env),locations:[{schemaVersion:1,environmentId:env.id,rootRef:{kind:'source',resourceId:c.id,bindingVersion:1},relativePath:a.path,
        physicalRoot:c.path,physicalRootIdentity:c.identity,beforeIdentity:before.identity,beforeHash:before.hash,desiredHash:null}]};},
    approvalDescription(input,ctx){const a=schema.parse(input),c=repo.getCandidate(a.resourceId,ctx.environmentId);return `将 ${join(c.path,a.path)} 移入 Windows 系统回收站，是否允许？不会用临时目录替代回收站。`;},
    async execute(input,ctx,_conversation,signal){const a=schema.parse(input),c=repo.getCandidate(a.resourceId,ctx.environmentId),loc=ctx.locations[0]!,before=observe(c.path,a.path,c.identity);
      if(!before||before.hash!==loc.beforeHash||before.identity!==loc.beforeIdentity)return {outcome:'failed',content:'原文件在批准后变化，未移入回收站。',data:null};
      const result=await native(safeFile(c.path,a.path,c.identity),before.hash,before.identity,'apply',signal);
      return result.sourceAbsent&&result.receipt?{outcome:'succeeded',content:'原文件已进入 Windows 系统回收站，原路径消失且回收站内容 hash 已核验。',data:result}:
        {outcome:'unknown',content:'未取得完整的系统回收站回执，不能确认已回收；未再次执行。',data:result};},
    async reconcile(input,ctx,_c,signal){const a=schema.parse(input),c=repo.getCandidate(a.resourceId,ctx.environmentId),loc=ctx.locations[0]!;
      const result=await native(safeFile(c.path,a.path,c.identity),loc.beforeHash!,loc.beforeIdentity!,'inspect',signal);
      return result.sourceAbsent&&result.receipt?{outcome:'succeeded',content:'原生回收站条目和内容已核验，没有重复回收。',data:result,verification:'native-recycle-item-verified'}:
        {outcome:'unknown',content:'原回收结果无法确认，禁止重复执行。',data:result,verification:'unknown'};}});
}
