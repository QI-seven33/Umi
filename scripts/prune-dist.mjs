import {existsSync,readFileSync,readdirSync,lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Only orphaned TypeScript outputs in this project's generated dist tree are removed.
export function pruneDist(project) {
  const root=realpathSync(project);
  if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).name!=='umi')throw Error('拒绝清理非Umi构建目录');
  const dist=join(root,'dist'),removed=[];
  if(!existsSync(dist))return removed;
  if(lstatSync(dist).isSymbolicLink())throw Error('拒绝清理目录链接');
  const walk=directory=>{
    if(!existsSync(directory))return;
    if(lstatSync(directory).isSymbolicLink())throw Error('生成目录包含链接，未继续清理');
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const path=join(directory,entry.name),stat=lstatSync(path);
      if(stat.isSymbolicLink())throw Error('生成目录包含链接，未继续清理');
      if(stat.isDirectory()){walk(path);continue;}
      if(!stat.isFile()||!/(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/.test(entry.name))continue;
      const rel=relative(dist,path),stem=rel.replace(/(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/,'');
      if(stem.split(sep).join('/')==='apps/desktop/renderer/app')continue; // esbuild browser bundle
      if(['.ts','.tsx','.js','.mjs'].some(ext=>existsSync(join(root,stem+ext))))continue;
      if(!resolve(path).toLowerCase().startsWith(resolve(dist).toLowerCase()+sep))throw Error('生成路径越界');
      removed.push(path);
    }
  };
  // Validate the complete plan before deleting any file; no directory is recursively removed.
  for(const area of ['apps','packages','scripts','tests'])walk(join(dist,area));
  for(const path of removed)unlinkSync(path);
  return removed;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const removed=pruneDist(process.cwd());
  if(removed.length)console.log(JSON.stringify({prunedOrphanedOutputs:removed.length}));
}
