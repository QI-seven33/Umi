import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {FileLinkClient} from '../apps/desktop/renderer/src/file-link-client.js';
import {ScriptModel,call,text,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';

async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'umi-links-')),workspace=join(root,'workspace');mkdirSync(join(workspace,'girlfriend.github.io','css'),{recursive:true});
 writeFileSync(join(workspace,'girlfriend.github.io','index.html'),'<title>用户实际页面</title>');
 writeFileSync(join(workspace,'girlfriend.github.io','css','girlfriend.css'),'body{color:blue}');
 writeFileSync(join(workspace,'有 空格.md'),'中文文件');
 const steps:ConstructorParameters<typeof ScriptModel>[0]=[],app=new UmiApplication(join(root,'data'),new ScriptModel(steps)),c=app.createConversation(workspace),mount=app.files.repo.mounts(c.environmentId)[0]!;
 steps.push(call('read_file',{mountId:mount.id,path:'girlfriend.github.io/index.html'}),call('read_file',{mountId:mount.id,path:'girlfriend.github.io/css/girlfriend.css'}),text('已读取实际项目'));
 const run=app.send(c.conversationId,uid(),'检查实际项目');await app.wait(run.runId);
 const service=new DesktopService(app);
 const resolve=async(references:string[])=>await service.handle({type:'resolve_file_links',conversationId:c.conversationId,references}) as {reference:string;target:{mountId:string;path:string}|null}[];
 return {root,workspace,app,c,mount,resolve,async close(){await app.close();removeTestRoot(root);}};
}
test('真实目录链接：省略项目目录的文件名沿已成功读取记录定位，绝对/URI/逻辑链接指向同一实际内容',async()=>{
 const f=await fixture();try{
  const refs=['index.html','girlfriend.github.io/index.html',join(f.workspace,'girlfriend.github.io','index.html'),pathToFileURL(join(f.workspace,'girlfriend.github.io','index.html')).href,`@working/${f.mount.id}/girlfriend.github.io/index.html`];
  for(const result of await f.resolve(refs)){
   assert.deepEqual(result.target,{mountId:f.mount.id,path:'girlfriend.github.io/index.html'});
   const preview=f.app.previewFile(f.c.conversationId,result.target!.mountId,result.target!.path);assert(preview.text?.includes('用户实际页面'));
  }
  assert.equal((await f.resolve(['css/girlfriend.css']))[0]!.target?.path,'girlfriend.github.io/css/girlfriend.css');
  assert.equal((await f.resolve(['有 空格.md']))[0]!.target?.path,'有 空格.md');
 }finally{await f.close();}
});
test('命令/可执行名/旧路径/错拼/目录不再被误当预览文件；同名目标冲突不猜测',async()=>{
 const f=await fixture();try{
  const refs=['msedge.exe','python -m http.server','iindex.html','css/valentine.css','girlfriend.github.io','C:/Program Files/Google/Chrome/Application/chrome.exe','@working/missing/index.html'];
  assert((await f.resolve(refs)).every(r=>r.target===null));
  writeFileSync(join(f.workspace,'index.html'),'另一个文件');assert.equal((await f.resolve(['index.html']))[0]!.target,null);
  assert.equal((await f.resolve(['girlfriend.github.io/index.html']))[0]!.target?.path,'girlfriend.github.io/index.html');
 }finally{await f.close();}
});
test('预览定位不扫描未知子目录、不授予外部/控制目录/硬链接访问；点击前删除和撤销后重新核验',async()=>{
 const f=await fixture();try{
  mkdirSync(join(f.workspace,'unknown'));writeFileSync(join(f.workspace,'unknown','never-read.txt'),'未被发现');
  writeFileSync(join(f.root,'outside.txt'),'外部');linkSync(join(f.root,'outside.txt'),join(f.workspace,'hard.txt'));
  const refs=['never-read.txt','../outside.txt',join(f.root,'outside.txt'),'hard.txt',join(f.app.store.dataRoot,'umi.sqlite')];
  assert((await f.resolve(refs)).every(r=>r.target===null));
  unlinkSync(join(f.workspace,'girlfriend.github.io','index.html'));
  assert.equal((await f.resolve(['index.html']))[0]!.target,null);assert.throws(()=>f.app.previewFile(f.c.conversationId,f.mount.id,'girlfriend.github.io/index.html'));
  f.app.revokeDirectoryAccess(f.c.conversationId,f.mount.direct!.grantId);
  assert.equal((await f.resolve(['有 空格.md']))[0]!.target,null);assert.throws(()=>f.app.previewFile(f.c.conversationId,f.mount.id,'有 空格.md'));
 }finally{await f.close();}
});
test('链接IPC严格限制批次；客户端合并重复请求，负例不发IPC，缓存有界且新代次重新核验',async()=>{
 const conversationId=uid();assert(!desktopCommandSchema.safeParse({type:'resolve_file_links',conversationId,references:Array(33).fill('a.txt')}).success);
 const batches:string[][]=[];const client=new FileLinkClient(async refs=>{batches.push(refs);return refs.map(reference=>({reference,target:null}));});
 const first=client.resolve('a.txt');assert.equal(client.resolve('a.txt'),first);
 await Promise.all([first,client.resolve('msedge.exe'),client.resolve('python -m http.server')]);assert.deepEqual(batches,[['a.txt']]);
 const many=new FileLinkClient(async refs=>{batches.push(refs);return refs.map(reference=>({reference,target:null}));});
 await Promise.all(Array.from({length:300},(_,i)=>many.resolve(`file-${i}.txt`)));
 assert(batches.every(b=>b.length<=32));assert.equal(batches.slice(1).flat().length,256);
 const refreshed=new FileLinkClient(async refs=>refs.map(reference=>({reference,target:{mountId:'m',path:'a.txt'}})));
 assert.deepEqual(await refreshed.resolve('a.txt'),{mountId:'m',path:'a.txt'});
});
