import {createHash} from 'node:crypto';
import {z} from 'zod';
import {UmiError} from '../../../protocol/src/model.js';
import {filePath} from '../../../protocol/src/file-path.js';
import {githubSkillInput,gitSha,importSnapshot} from '../../../protocol/src/skill-import.js';
import type {GithubSkillInput,SkillImportSnapshot} from '../../../protocol/src/skill-import.js';
import {bytesHash} from '../host-files/paths.js';
import {byteExcerpt} from '../../../agent/src/context/bounded.js';
import {parseSkill} from './library.js';

export type DownloadedSkill={snapshot:SkillImportSnapshot;files:Map<string,Uint8Array>};
export function githubCoordinates(input:GithubSkillInput) {
  const a=githubSkillInput.parse(input);
  let url:URL;
  try{url=new URL(a.repository);}catch{throw new UmiError('SKILL_SOURCE_INVALID','请填写 GitHub 仓库根链接，技能子目录和修订单独填写');}
  const parts=url.pathname.replace(/\/$/,'').split('/').slice(1);
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash||parts.length!==2)
    throw new UmiError('SKILL_SOURCE_INVALID','仅接受 https://github.com/所有者/仓库；子目录和修订单独填写');
  const owner=parts[0]!,repo=parts[1]!.replace(/\.git$/,'');
  if(!/^[A-Za-z0-9-]{1,100}$/.test(owner)||!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)||['.','..'].includes(repo))
    throw new UmiError('SKILL_SOURCE_INVALID','GitHub 所有者或仓库名无效');
  if(a.ref&&(!/^[^\s\\?#:]+$/.test(a.ref)||a.ref.split('/').some(s=>!s||s==='.'||s==='..')))
    throw new UmiError('SKILL_SOURCE_INVALID','修订无效；可填分支、标签或40位提交');
  if(a.path.split('/').filter(Boolean).length>8)throw new UmiError('RESOURCE_LIMIT','技能子目录最多8层');
  return {...a,owner,repo,repository:'https://github.com/'+owner+'/'+repo};
}
const treeEntry=z.object({path:z.string(),mode:z.string(),type:z.string(),sha:gitSha,size:z.number().int().nonnegative().optional()});
const treeSchema=z.object({sha:gitSha,truncated:z.boolean(),tree:z.array(treeEntry)});
export class GithubSkillSource {
  constructor(private readonly transport:typeof fetch=fetch){}
  async download(input:GithubSkillInput,external:AbortSignal,progress:(text:string)=>void):Promise<DownloadedSkill>{
    const a=githubCoordinates(input),signal=AbortSignal.any([external,AbortSignal.timeout(60000)]);
    const api='https://api.github.com/repos/'+a.owner+'/'+a.repo;
    let requests=0;
    const get=async(url:string,limit:number,json:boolean)=>{
      signal.throwIfAborted();
      if(++requests>145)throw new UmiError('RESOURCE_LIMIT','获取请求数量超过上限');
      let response:Response;
      try{response=await this.transport(url,{signal,redirect:'error',credentials:'omit',
        headers:{Accept:json?'application/vnd.github+json':'application/vnd.github.raw+json','User-Agent':'Umi-Skill-Import','X-GitHub-Api-Version':'2022-11-28'}});
      }catch{
        if(external.aborted)throw external.reason;
        throw new UmiError('SKILL_FETCH_FAILED',signal.aborted?'GitHub 获取超过60秒，未安装；可稍后重试。':'无法连接 GitHub，请检查网络后重试；未安装。');
      }
      if(!response.ok){await response.body?.cancel();throw new UmiError('SKILL_FETCH_FAILED',
        [403,429].includes(response.status)?'GitHub 访问受限或达到限额，请稍后重试；未自动重试。':'GitHub 获取失败（HTTP '+response.status+'），未安装技能。');}
      if(response.redirected)throw new UmiError('SKILL_FETCH_FAILED','不接受跳转的技能来源');
      const reader=response.body?.getReader();if(!reader)throw new UmiError('SKILL_FETCH_FAILED','GitHub 未返回响应正文');
      const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){signal.throwIfAborted();const r=await reader.read();if(r.done)break;size+=r.value.length;
        if(size>limit)throw new UmiError('RESOURCE_LIMIT','GitHub 响应超过大小上限');chunks.push(r.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const bytes=Buffer.concat(chunks);
      return json?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):bytes;
    };
    progress('定位仓库与提交');
    const repo=z.object({default_branch:z.string()}).parse(await get(api,262144,true));
    const requestedRef=a.ref||repo.default_branch;
    const resolved=z.object({sha:gitSha,commit:z.object({tree:z.object({sha:gitSha})})}).parse(await get(api+'/commits/'+encodeURIComponent(requestedRef),1048576,true));
    const tree=async(sha:string,recursive=false)=>{
      const t=treeSchema.parse(await get(api+'/git/trees/'+sha+(recursive?'?recursive=1':''),1048576,true));
      if(t.sha!==sha||t.truncated)throw new UmiError('RESOURCE_LIMIT','GitHub 目录未完整返回，未导入部分包');
      return t;
    };
    let sha=resolved.commit.tree.sha;
    for(const part of a.path.split('/').filter(Boolean)){
      const node=(await tree(sha)).tree.find(e=>e.path===part);
      if(!node||node.type!=='tree'||node.mode!=='040000')throw new UmiError('SKILL_SOURCE_INVALID','技能子目录不存在，或包含链接/子模块');
      sha=node.sha;
    }
    progress('核对技能包目录');
    const entries=(await tree(sha,true)).tree;
    if(entries.length>256)throw new UmiError('RESOURCE_LIMIT','技能包目录项超过256个');
    const selected=entries.filter(e=>e.type!=='tree'),seen=new Set<string>(),spellings=new Map<string,string>();let total=0;
    for(const e of entries){
      filePath.max(240).parse(e.path);
      const parts=e.path.split('/');for(let i=1;i<=parts.length;i++){
        const prefix=parts.slice(0,i).join('/'),key=prefix.toLowerCase(),old=spellings.get(key);
        if(old&&old!==prefix)throw new UmiError('SKILL_SOURCE_INVALID','技能包含 Windows 大小写目录冲突');spellings.set(key,prefix);
      }
      if(e.path.split('/').length>12||e.path.toLowerCase()==='.umi-origin.json')throw new UmiError('SKILL_SOURCE_INVALID','技能路径过深或使用了 Umi 保留名称');
      const key=e.path.toLowerCase();if(seen.has(key))throw new UmiError('SKILL_SOURCE_INVALID','技能包含 Windows 大小写冲突路径');seen.add(key);
      if(e.type==='tree'){if(e.mode!=='040000')throw new UmiError('SKILL_SOURCE_INVALID','目录模式无效');continue;}
      if(e.type!=='blob'||!['100644','100755'].includes(e.mode))throw new UmiError('SKILL_SOURCE_INVALID','技能包含链接或子模块，未导入');
      if(e.size==null||e.size>1048576)throw new UmiError('RESOURCE_LIMIT','技能单文件超过1MiB或缺少大小');
      total+=e.size;
    }
    if(selected.length<1||selected.length>128||total>8388608)throw new UmiError('RESOURCE_LIMIT','技能最多128个文件、总计8MiB');
    const main=selected.find(e=>e.path==='SKILL.md');
    if(!main||main.size!>262144)throw new UmiError('SKILL_INVALID','所选目录需要有256KiB以内的 SKILL.md');
    const files=new Map<string,Uint8Array>();let next=0,done=0;
    // 有限并发下载固定提交的文件，既不git clone，也不运行安装钩子。
    await Promise.all(Array.from({length:Math.min(3,selected.length)},async()=>{
      for(;;){const e=selected[next++];if(!e)return;signal.throwIfAborted();
        // Git blob按内容寻址；使用同一官方API域，避免另一个Raw域的网络可达性差异。
        const bytes=await get(api+'/git/blobs/'+e.sha,1048576,false) as Buffer;
        const gitHash=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
        if(bytes.length!==e.size||gitHash!==e.sha)throw new UmiError('RESOURCE_CHANGED','下载字节与固定提交的 Git blob 不一致');
        if(bytes.subarray(0,130).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))
          throw new UmiError('SKILL_UNSUPPORTED','技能含Git LFS指针；当前未获取实际大文件');
        files.set(e.path,bytes);progress('下载文件 '+(++done)+' / '+selected.length);
      }
    }));
    signal.throwIfAborted();
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(files.get('SKILL.md')!);
    // 远程包根可与仓库/子目录名不同；本地发布目录按合法name创建，无需改写正文。
    const m=parseSkill(text);
    const manifest=selected.map(e=>({path:e.path,bytes:e.size!,gitSha:e.sha,sha256:bytesHash(files.get(e.path)!)})).sort((x,y)=>x.path.localeCompare(y.path));
    const preview=byteExcerpt(text,0,12000);
    const snapshot=importSnapshot.parse({name:m.name,description:m.description,version:bytesHash(files.get('SKILL.md')!),
      license:m.license??'未声明；请核对包内许可与原仓库',compatibility:m.compatibility??'未声明；依赖可用性需按任务核对',
      source:{repository:a.repository,owner:a.owner,repo:a.repo,path:a.path,requestedRef,commit:resolved.sha},
      files:manifest,totalBytes:total,packageHash:bytesHash(Buffer.from(JSON.stringify(manifest))),
      preview:preview.text,previewTruncated:preview.endByte<Buffer.byteLength(text)});
    return {snapshot,files};
  }
}