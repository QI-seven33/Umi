import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {build} from 'esbuild';

test('架构护栏：protocol保持纯模块，agent不直接引入SQL/宿主适配器，renderer只依赖协议/窄桥',async()=>{
 const root=process.cwd();const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):/\.tsx?$/.test(e.name)?[join(dir,e.name)]:[]);
 // 使用现有构建解析器记录真实导入；不用正则把注释/字符串里的路径误判为依赖。
 const files=['packages/protocol/src','packages/agent/src','apps/desktop/renderer/src'].flatMap(dir=>walk(join(root,dir)));
 const graph=await build({entryPoints:files,bundle:true,external:['*'],format:'esm',platform:'neutral',write:false,outdir:'architecture-check',metafile:true,logLevel:'silent'});
 const imports=(file:string)=>{const key=file.slice(root.length+1).replaceAll('\\','/');return graph.metafile!.inputs[key]!.imports.map(i=>i.original??i.path);};
 const within=(file:string,domain:string)=>file.startsWith(join(root,domain)+sep);
 const relativeAllowed=(file:string,module:string,domains:string[])=>module.startsWith('.')&&domains.some(domain=>within(resolve(dirname(file),module),domain));
 for(const file of walk(join(root,'packages/protocol/src')))for(const module of imports(file))
  assert(module==='zod'||relativeAllowed(file,module,['packages/protocol/src']),'protocol越层：'+module);
 for(const file of walk(join(root,'packages/agent/src')))for(const module of imports(file))
  assert(['node:crypto','node:timers/promises','zod'].includes(module)||relativeAllowed(file,module,['packages/agent/src','packages/protocol/src']),'agent越层：'+module);
 for(const file of walk(join(root,'apps/desktop/renderer/src')))for(const module of imports(file))
  assert(module.startsWith('.')?relativeAllowed(file,module,['apps/desktop/renderer/src','packages/protocol/src']):!module.startsWith('node:'),'renderer越层：'+module);
});