import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {GithubSkillSource,githubCoordinates} from '../packages/adapters/src/skills/github.js';
import {SkillImports} from '../packages/adapters/src/skills/imports.js';
import {LocalSkillLibrary} from '../packages/adapters/src/skills/library.js';
import {skillReadSchema} from '../packages/protocol/src/skills.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {skillSourceFixture,verificationSkillInput as input,verificationCommit} from '../apps/desktop/verification-skill-source.js';
import {removeTestRoot,eventually,ScriptModel,text} from './fixtures.js';
import {UmiApplication} from '../apps/headless/src/application.js';
import {uid} from '../packages/agent/src/identity.js';
function fixture(transport?:typeof fetch){
  const root=mkdtempSync(join(tmpdir(),'umi-skill-import-')),library=new LocalSkillLibrary(root),mock=skillSourceFixture();
  const imports=new SkillImports(root,library,new GithubSkillSource(transport??mock.transport));
  const ready=async()=>{const r=imports.start(input);return eventually(()=>{const p=imports.detail(r.id);return p.state==='fetching'?undefined:p;});};
  return {root,library,mock,imports,ready,async close(){await imports.close();removeTestRoot(root);}};
}
test('GitHub来源仅允许公开固定域仓库根URL，路径/修订分开且拒绝注入',()=>{
  assert.equal(githubCoordinates({...input,repository:input.repository+'.git'}).repo,'skill-fixture');
  for(const repository of ['http://github.com/a/b','https://evil.test/a/b','https://github.com@127.0.0.1/a/b','https://github.com/a/b/tree/main/skills','https://github.com/a/b?token=secret','https://github.com:444/a/b','https://github.com/../b','file:///a/b'])assert.throws(()=>githubCoordinates({...input,repository}));
  for(const ref of ['../bad','a/../b','x?secret','x#fragment','x y'])assert.throws(()=>githubCoordinates({...input,ref}));
  assert.throws(()=>githubCoordinates({...input,path:'../secret'}));
});
test('GitHub原包固定提交，核对blob字节/hash，保留参考/脚本/二进制，不执行或改写',async()=>{
  const m=skillSourceFixture(),got=await new GithubSkillSource(m.transport).download(input,new AbortController().signal,()=>{});
  assert.equal(got.snapshot.source.commit,verificationCommit);assert.equal(got.files.size,4);assert.equal(got.snapshot.files.length,4);
  for(const[p,b]of m.files)assert.deepEqual(got.files.get(p),b);
  const blobs=m.requests.filter(u=>u.includes('/git/blobs/'));assert.equal(blobs.length,4);
  assert(blobs.every(u=>m.entries.some(e=>u.endsWith(e.sha))));assert(m.requests.every(u=>new URL(u).host==='api.github.com'));
  assert.equal(got.snapshot.preview,Buffer.from(m.files.get('SKILL.md')!).toString('utf8'));assert.equal(m.requests.length,9);
});
test('GitHub截断清单、链接/子模块、大小写路径、越界、大小/数量上限均整包拒绝',async()=>{
  for(const change of [
    (r:any)=>{r.truncated=true;},(r:any)=>r.tree.push({path:'link',type:'blob',mode:'120000',sha:'f'.repeat(40),size:3}),
    (r:any)=>r.tree.push({path:'sub',type:'commit',mode:'160000',sha:'f'.repeat(40)}),
    (r:any)=>r.tree.push({...r.tree.find((e:any)=>e.path==='SKILL.md'),path:'skill.md'}),
    (r:any)=>r.tree.push({path:'References/other.md',type:'blob',mode:'100644',sha:'f'.repeat(40),size:2}),
    (r:any)=>r.tree.push({path:'../outside',type:'blob',mode:'100644',sha:'f'.repeat(40),size:3}),
    (r:any)=>{r.tree.find((e:any)=>e.path==='SKILL.md').size=1048577;},
    (r:any)=>{r.tree=Array.from({length:257},(_,i)=>({path:'a'+i,type:'tree',mode:'040000',sha:'f'.repeat(40)}));},
    (r:any)=>r.tree.push({path:'.umi-origin.json',type:'blob',mode:'100644',sha:'f'.repeat(40),size:3}),
  ]){
    const m=skillSourceFixture(),fetcher:typeof fetch=async(i,o)=>{const r=await m.transport(i,o);if(String(i).includes('?recursive=1')){const j=await r.json();change(j);return new Response(JSON.stringify(j));}return r;};
    await assert.rejects(()=>new GithubSkillSource(fetcher).download(input,new AbortController().signal,()=>{}));
  }
});
test('GitHub下载字节不符、HTTP拒绝和过大响应不重试、不发布部分技能',async()=>{
  for(const mode of ['hash','http','oversize','network']){
    const m=skillSourceFixture();let calls=0;
    const transport:typeof fetch=async(i,o)=>{calls++;if(mode==='network')throw new TypeError('fetch failed');if(mode==='http')return new Response('private server text',{status:429});if(mode==='oversize')return new Response('x'.repeat(262145));if(String(i).includes('/git/blobs/'))return new Response('changed');return m.transport(i,o);};
    await assert.rejects(()=>new GithubSkillSource(transport).download(input,new AbortController().signal,()=>{}));if(mode==='http'||mode==='oversize')assert.equal(calls,1);
  }
});
test('后台获取先回编号，慢网络不阻塞原Agent或桌面命令；取消可结算且不安装',async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-skill-import-async-')),workspace=join(root,'project');mkdirSync(workspace);
  const transport:typeof fetch=async(_i,init)=>{await delay(10000,undefined,{signal:init!.signal!});return new Response('{}');};
  const app=new UmiApplication(join(root,'data'),new ScriptModel([text('仍可继续工作')]),{skillFetch:transport});
  try{
    const c=app.createConversation(workspace),r=app.skillImports.start(input);
    assert.equal(app.skillImports.detail(r.id).state,'fetching');
    const run=app.send(c.conversationId,uid(),'请简短确认，不用工具');await app.wait(run.runId);
    assert.equal(app.store.getRun(run.runId).status,'completed');
    app.skillImports.cancel(r.id);
    await eventually(()=>app.skillImports.detail(r.id).state==='cancelled'?true:undefined);
    assert.equal(app.skills.library().skills.length,3);app.skillImports.remove(r.id);
    assert.equal(app.skillImports.list().records.length,0);
  }finally{await app.close();removeTestRoot(root);}
});
test('导入确认绑定冻结planHash；默认停用、来源和原包字节保留，重启后可原样使用',async()=>{
  const f=fixture();try{
    const r=await f.ready();assert.equal(r.state,'staged');assert(!existsSync(join(f.library.directory,'import-example')));
    assert.throws(()=>f.imports.install(r.id,'0'.repeat(64)),/确认/);
    const lib=f.imports.install(r.id,r.planHash!),s=lib.skills.find(s=>s.name==='import-example')!;
    assert.equal(s.enabled,false);assert.equal(s.origin?.commit,verificationCommit);
    for(const[p,b]of f.mock.files)assert.deepEqual(readFileSync(join(lib.directory,s.name,p)),b);
    f.library.setEnabled(s.name,true,s.version);
    const again=new LocalSkillLibrary(f.root),item=again.library().skills.find(s=>s.name==='import-example')!;assert(item.enabled);
    const page=again.read(skillReadSchema.parse({name:s.name,version:s.version,path:'references/check.md'}));
    assert.match(page.text,/VERIFICATION-ONLY/);assert.equal(page.origin?.modifiedFromImport,false);
    f.imports.remove(r.id);assert(existsSync(join(lib.directory,s.name,'SKILL.md')),'移除记录不可删除已安装技能');
  }finally{await f.close();}
});
test('导入不会沿用同正文旧实例的启用，正文/参考修改分别保留真实来源差异',async()=>{
  const f=fixture();try{
    const r=await f.ready();f.imports.install(r.id,r.planHash!);let s=f.library.library().skills.find(s=>s.name==='import-example')!;
    f.library.setEnabled(s.name,true,s.version);
    const prefs=join(f.library.directory,'.preferences.json'),p=JSON.parse(readFileSync(prefs,'utf8'));p[s.name].importId='11111111-1111-4111-8111-111111111111';writeFileSync(prefs,JSON.stringify(p));
    f.library.refresh();assert.equal(f.library.library().skills.find(x=>x.name===s.name)!.enabled,false);
    f.library.setEnabled(s.name,true,s.version);
    writeFileSync(join(f.library.directory,s.name,'references/check.md'),'local change');
    const page=f.library.read(skillReadSchema.parse({name:s.name,version:s.version,path:'references/check.md'}));assert.equal(page.origin?.modifiedFromImport,true);
    writeFileSync(join(f.library.directory,s.name,'SKILL.md'),Buffer.concat([f.mock.files.get('SKILL.md')!,Buffer.from('\nLocal method update')]));
    f.library.refresh();s=f.library.library().skills.find(x=>x.name===s.name)!;assert.equal(s.enabled,false);assert.equal(s.origin?.mainModified,true);
  }finally{await f.close();}
});
test('同名本地技能和被修改的草稿都不被覆盖或发布',async()=>{
  const f=fixture();try{
    const r=await f.ready(),target=join(f.library.directory,'import-example');mkdirSync(target,{recursive:true});writeFileSync(join(target,'keep.txt'),'keep');
    assert.throws(()=>f.imports.install(r.id,r.planHash!),/同名/);assert.equal(readFileSync(join(target,'keep.txt'),'utf8'),'keep');
    const other=fixture();try{const p=await other.ready();writeFileSync(join(other.root,'skill-imports',p.id,'payload','references','check.md'),'changed');assert.throws(()=>other.imports.install(p.id,p.planHash!),/变化/);assert(!existsSync(join(other.library.directory,'import-example')));}finally{await other.close();}
  }finally{await f.close();}
});
test('恢复核对已发布原包，无重复下载；停在获取阶段的旧记录不会自动重试',async()=>{
  const f=fixture();try{
    const r=await f.ready();f.imports.install(r.id,r.planHash!);
    const file=join(f.root,'skill-imports',r.id,'record.json'),record=JSON.parse(readFileSync(file,'utf8'));record.state='installing';writeFileSync(file,JSON.stringify(record));
    let calls=0;const restored=new SkillImports(f.root,new LocalSkillLibrary(f.root),new GithubSkillSource(async()=>{calls++;throw Error('no replay');}));
    assert.equal(restored.detail(r.id).state,'installed');assert.equal(calls,0);
    record.state='fetching';delete record.snapshot;delete record.planHash;writeFileSync(file,JSON.stringify(record));
    assert.equal(restored.detail(r.id).state,'failed');assert.equal(calls,0);
    await restored.close();
  }finally{await f.close();}
});
test('有界草稿与删除边界：不跟随目录联接，不删应用数据或用户源文件',async()=>{
  const f=fixture();try{
    const r=await f.ready(),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'safe');
    symlinkSync(outside,join(f.root,'skill-imports',r.id,'linked'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>f.imports.remove(r.id),/链接/);assert.equal(readFileSync(join(outside,'keep'),'utf8'),'safe');
    assert.throws(()=>f.imports.remove('../outside'));assert.throws(()=>f.imports.start({...input,repository:'https://localhost/a/b'}));
  }finally{await f.close();}
});
test('导入IPC只接受固定动作、UUID与明确确认，不接受目录、脚本或伪造工具参数',()=>{
  for(const value of [
    {type:'skills_import_install',id:crypto.randomUUID(),planHash:'0'.repeat(64),confirm:false},
    {type:'skills_import_install',id:'../../x',planHash:'0'.repeat(64),confirm:true},
    {type:'skills_import_start',input,runScript:true},
    {type:'skills_import_remove',id:crypto.randomUUID(),confirm:true,path:'C:/secret'},
  ])assert.equal(desktopCommandSchema.safeParse(value).success,false);
});
test('预发布来源写入后中断可核对重试；恢复时缺失来源记录不冒充已安装',async()=>{
  const f=fixture();try{
    const r=await f.ready(),origin={schemaVersion:1,importId:r.id,planHash:r.planHash,snapshot:r.snapshot};
    writeFileSync(join(f.root,'skill-imports',r.id,'payload','.umi-origin.json'),JSON.stringify(origin));
    f.imports.install(r.id,r.planHash!);assert.equal(f.imports.detail(r.id).state,'installed');
    const file=join(f.root,'skill-imports',r.id,'record.json'),record=JSON.parse(readFileSync(file,'utf8'));record.state='installing';writeFileSync(file,JSON.stringify(record));
    const originFile=join(f.library.directory,'import-example','.umi-origin.json');writeFileSync(originFile,'changed');
    const restored=new SkillImports(f.root,new LocalSkillLibrary(f.root));
    assert.equal(restored.detail(r.id).state,'failed');await restored.close();
  }finally{await f.close();}
});

test('仓库根/远程目录可与合法Skill名称不同，导入按声明名称建目录，不改写正文',async()=>{
  const m=skillSourceFixture(),transport:typeof fetch=async(i,o)=>{
    if(String(i).includes('/git/trees/'+'a'.repeat(40)+'?recursive=1'))return new Response(JSON.stringify({sha:'a'.repeat(40),truncated:false,tree:[...m.dirs,...m.entries]}));
    return m.transport(i,o);
  };
  const got=await new GithubSkillSource(transport).download({...input,path:''},new AbortController().signal,()=>{});
  assert.equal(got.snapshot.name,'import-example');assert.equal(got.snapshot.source.path,'');
  assert.deepEqual(got.files.get('SKILL.md'),m.files.get('SKILL.md'));
});
