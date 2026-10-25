import {filePath} from './file-path.js';
export type FileReferenceTarget={mountId:string;path:string};
export type PreviewMount={mountId:string;resourceId?:string;sourceRoot?:string;resourceScope?:{kind:string;path?:string}};
const windows=(path:string)=>/^[a-z]:\//i.test(path)||path.startsWith('//');
const fold=(path:string)=>windows(path)?path.toLowerCase():path;
const inScope=(mount:PreviewMount,path:string)=>mount.resourceScope?.kind!=='file'||mount.resourceScope.path===path;
// 语法候选不代表文件存在或获得权限；只有宿主核验的唯一目标才能成为按钮。
export function fileReferencePath(value:string):string|null {
 if(value.length>2048)return null;
 let path=value.trim();
 try {
  if(/^file:\/\//i.test(path)){
   if(decodeURIComponent(path).replaceAll('\\','/').split('/').some(p=>p==='.'||p==='..'))return null;
   const url=new URL(path);if(url.search||url.username||url.password||url.port||(url.hash&&!/^#L\d+(?:-L\d+)?$/.test(url.hash)))return null;
   path=(url.hostname?'//'+url.hostname:'')+decodeURIComponent(url.pathname);if(/^\/[a-z]:\//i.test(path))path=path.slice(1);
  } else path=decodeURIComponent(path);
 }catch{return null;}
 path=path.replaceAll('\\','/').replace(/:(\d+)(?::\d+)?$/,'').replace(/#L\d+(?:-L\d+)?$/,'');
 if(/[\x00-\x1f]/.test(path)||path.split('/').some(p=>p==='.'||p==='..')){
  if(!path.startsWith('./')||path.slice(2).split('/').some(p=>p==='.'||p==='..'))return null;
 }
 if(path.startsWith('./'))path=path.slice(2);
 if(/(?:^|\s)--?[\p{L}]/u.test(path)||/[|<>"*?]/.test(path)||/\.(?:exe|dll|com|msi|lnk|url|sys|bin|zip|7z|rar|mp3|mp4|png|jpe?g|gif|webp|pdf|docx|xlsx|pptx)$/i.test(path))return null;
 if(!/\.[\p{L}\p{N}_-]+$/u.test(path)&&!/(?:^|\/)(?:README|LICENSE|Dockerfile|Makefile)$/i.test(path))return null;
 return path;
}
export function fileReferenceCandidates(value:string,mounts:readonly PreviewMount[],known:readonly FileReferenceTarget[]=[]):FileReferenceTarget[] {
 const path=fileReferencePath(value);if(!path)return [];
 const valid=(mount:PreviewMount,p:string)=>filePath.safeParse(p).success&&inScope(mount,p);
 const logical=/^@working\/([^/]+)\/(.+)$/.exec(path);
 if(logical)return mounts.filter(m=>m.mountId===logical[1]||m.resourceId===logical[1]).flatMap(m=>valid(m,logical[2]!)?[{mountId:m.mountId,path:logical[2]!}]:[]);
 if(windows(path)||path.startsWith('/')){
  const found=mounts.flatMap(m=>{
   const root=m.sourceRoot?.replaceAll('\\','/').replace(/\/$/,'');if(!root||!fold(path).startsWith(fold(root)+'/'))return [];
   const p=path.slice(root.length+1);return valid(m,p)?[{mountId:m.mountId,path:p,length:root.length}]:[];
  }).sort((a,b)=>b.length-a.length);
  return found.filter(f=>f.length===found[0]?.length).map(({mountId,path})=>({mountId,path}));
 }
 if(!filePath.safeParse(path).success)return [];
 const found=mounts.flatMap(m=>valid(m,path)?[{mountId:m.mountId,path}]:[]);
 for(const target of known){const m=mounts.find(m=>m.mountId===target.mountId);if(m&&valid(m,target.path)&&(target.path===path||target.path.endsWith('/'+path)))found.push(target);}
 return [...new Map(found.map(f=>[JSON.stringify([f.mountId,f.path]),f])).values()];
}
