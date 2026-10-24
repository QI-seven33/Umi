export type PreviewMount={mountId:string;resourceId?:string;sourceRoot?:string;resourceScope?:{kind:string;path?:string}};
const windows=(path:string)=>/^[a-z]:\//i.test(path)||path.startsWith('//');
const fold=(path:string)=>windows(path)?path.toLowerCase():path;
const relative=(path:string)=>path.length>0&&!path.startsWith('/')&&!path.includes(':')&&!path.split('/').some(p=>!p||p==='.'||p==='..')&&!/[\x00-\x1f]/.test(path);
const inScope=(mount:PreviewMount,path:string)=>mount.resourceScope?.kind!=='file'||mount.resourceScope.path===path;

// 这里只把已给页面的mount定位为预览目标；真正访问仍经过核心的权限/身份检查。
// 不猜测多个来源中的同名文件，也不把任意file URL交给系统打开。
export function resolveFileReference(value:string,mounts:readonly PreviewMount[]) {
 let path=value.trim();
 if(path.startsWith('file://')){
  try{if(decodeURIComponent(path).replaceAll('\\','/').split('/').some(p=>p==='.'||p==='..'))return null;}catch{return null;}
  try{const url=new URL(path);if(url.search)return null;path=(url.hostname?'//'+url.hostname:'')+decodeURIComponent(url.pathname);if(/^\/[a-z]:\//i.test(path))path=path.slice(1);}catch{return null;}
 }else{try{path=decodeURIComponent(path);}catch{return null;}}
 path=path.replaceAll('\\','/').replace(/:(\d+)(?::\d+)?$/,'');
 const logical=/^@working\/([^/]+)\/(.+)$/.exec(path);
 if(logical){const found=mounts.filter(m=>m.mountId===logical[1]||m.resourceId===logical[1]);const p=logical[2]!;return found.length===1&&relative(p)&&inScope(found[0]!,p)?{mountId:found[0]!.mountId,path:p}:null;}
 if(windows(path)||path.startsWith('/')){
  if(path.split('/').some(p=>p==='..'||p==='.'))return null;
  const found=mounts.flatMap(m=>{
   const root=m.sourceRoot?.replaceAll('\\','/').replace(/\/$/,'');if(!root||!fold(path).startsWith(fold(root)+'/'))return [];
   const p=path.slice(root.length+1);return relative(p)&&inScope(m,p)?[{mountId:m.mountId,path:p,length:root.length}]:[];
  }).sort((a,b)=>b.length-a.length);
  const best=found[0];return best&&found.filter(f=>f.length===best.length).length===1?{mountId:best.mountId,path:best.path}:null;
 }
 if(path.startsWith('./'))path=path.slice(2);
 if(!relative(path)||(!/\.[\p{L}\p{N}_-]+$/u.test(path)&&!/(?:^|\/)(?:README|LICENSE|Dockerfile|Makefile)$/i.test(path)))return null;
 const found=mounts.filter(m=>inScope(m,path));return found.length===1?{mountId:found[0]!.mountId,path}:null;
}
