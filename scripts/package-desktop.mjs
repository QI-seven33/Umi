import {packager} from '@electron/packager';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),output=resolve('release/Umi-win32-x64');
if(resolve(process.cwd()).toLowerCase()!==resolve(root).toLowerCase()||!output.toLowerCase().startsWith(resolve(root,'release').toLowerCase()+'/'.replace('/', '\\')))throw Error('打包目录不属于当前 Umi 项目');
if(existsSync(output)&&(!existsSync(join(output,'resources/app/package.json'))||JSON.parse(readFileSync(join(output,'resources/app/package.json'),'utf8')).name!=='umi'))throw Error('拒绝覆盖不属于 Umi 的既有目录');
const paths=await packager({dir:'.',out:'release',name:'Umi',executableName:'Umi',icon:resolve('apps/desktop/renderer/public/umi.ico'),platform:'win32',arch:'x64',electronVersion:'44.5.1',asar:false,prune:true,overwrite:true,ignore:[/^\/release($|\/)/,/^\/apps($|\/)/,/^\/packages($|\/)/,/^\/tests($|\/)/,/^\/scripts($|\/)/,/^\/docs($|\/)/,/^\/baseline\.json$/,/^\/[^/]+\.log$/,/^\/dist\/(tests|scripts)($|\/)/,/^\/\.env/,/^\/\.umi/,/^\/node_modules\/(?:\.cache|\.bin)/]});
process.stdout.write(JSON.stringify({name:'Umi',paths})+'\n');
