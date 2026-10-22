import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,linkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalSkillLibrary,parseSkill} from '../packages/adapters/src/skills/library.js';
import {skillReadSchema} from '../packages/protocol/src/skills.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {skillCatalog} from '../packages/agent/src/skills.js';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {ScriptModel,call,text,projectedFacts,removeTestRoot} from './fixtures.js';
import type {Step} from './fixtures.js';
import {activityLabel} from '../apps/desktop/renderer/src/activity.js';
import {uid} from '../packages/agent/src/identity.js';
import type {WireMessage} from '../packages/protocol/src/model.js';
const document=(name='test-method',body='原样使用，无需改写。')=>'---\nname: '+name+'\ndescription: >-\n  A useful method\n  for this task.\nallowed-tools: Bash(*)\n---\n'+body;
function fixture(){const root=mkdtempSync(join(tmpdir(),'umi-skills-')),library=new LocalSkillLibrary(root);library.refresh();return {root,library,add(name='test-method',body?:string){const dir=join(library.directory,name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),document(name,body));return dir;},clean(){removeTestRoot(root);}};}
function select(library:LocalSkillLibrary,name='test-method'){return library.library().skills.find(s=>s.name===name)!;}
function read(library:LocalSkillLibrary,name='test-method',extra:Record<string,unknown>={}){return library.read(skillReadSchema.parse({name,version:select(library,name).version,...extra}));}
test('Skill 标准 YAML 多行说明、原文和 allowed-tools 可以读取，但不产生工具授权',()=>{
 const value=parseSkill(document(),'test-method');assert.equal(value.description,'A useful method for this task.');assert.equal(value['allowed-tools'],'Bash(*)');
 for(const raw of [document().replace('name: test-method','name: other'),document().replace('description: >-','description: !unknown >-'),document().replace('---\n原样','context: fork\n---\n原样'),'---\nname: test-method\nname: test-method\ndescription: valid\n---\nbody','---\nname: test-method\ndescription: &x abc\nmetadata: {a: *x}\n---\nbody'])assert.throws(()=>parseSkill(raw,'test-method'));
});
test('Skill 原包发现默认停用，启用后立即读取；开关和版本跨重启保留',()=>{
 const f=fixture();try{f.add();assert.equal(f.library.library().skills.length,3);f.library.refresh();const s=select(f.library);assert.equal(s.enabled,false);assert.throws(()=>read(f.library),/未启用/);
 assert.match(f.library.preview(s.name,s.version).text,/无需改写/);f.library.setEnabled(s.name,true,s.version);
 assert.match(read(f.library).text,/无需改写/);const again=new LocalSkillLibrary(f.root);assert.equal(select(again).enabled,true);assert.equal(read(again).sourceHash,s.version);
 again.setEnabled(s.name,false,s.version);assert.throws(()=>read(again),/未启用/);
 }finally{f.clean();}
});
test('Skill 本文改变后旧目录拒读，刷新后默认停用，不能沿用旧批准的版本',()=>{
 const f=fixture();try{const dir=f.add();f.library.refresh();const s=select(f.library);f.library.setEnabled(s.name,true,s.version);
 writeFileSync(join(dir,'SKILL.md'),document(s.name,'新的正文'));assert.throws(()=>read(f.library),/变化/);assert.throws(()=>f.library.setEnabled(s.name,true,s.version),/变化/);
 f.library.refresh();assert.equal(select(f.library).enabled,false);assert.notEqual(select(f.library).version,s.version);assert.throws(()=>read(f.library),/未启用/);
 }finally{f.clean();}
});
test('Skill 资源按需读取、分页精确保留中文和 emoji，hash 变化拒绝混页，脚本只读',()=>{
 const f=fixture();try{const dir=f.add(),body='\uFEFF'+'中😀文\n'.repeat(1500);mkdirSync(join(dir,'references'));mkdirSync(join(dir,'scripts'));
 writeFileSync(join(dir,'references','long.md'),body);writeFileSync(join(dir,'scripts','task.mjs'),'throw Error("must not execute")');
 writeFileSync(join(dir,'SKILL.md'),'\uFEFF'+document());
 f.library.refresh();const s=select(f.library);f.library.setEnabled(s.name,true,s.version);
 let cursor=0,hash:string|undefined;const pages:string[]=[];do{const page=read(f.library,s.name,{path:'references/long.md',startByte:cursor,byteLength:65,...(hash?{expectedHash:hash}:{})});hash=page.sourceHash;pages.push(page.text);if(page.nextStartByte==null)break;assert(page.nextStartByte>cursor);cursor=page.nextStartByte;}while(true);
 assert.equal(pages.join(''),body);assert.equal(Buffer.byteLength(read(f.library).text),readFileSync(join(dir,'SKILL.md')).length);assert.match(read(f.library,s.name,{path:'scripts/task.mjs'}).text,/must not execute/);
 writeFileSync(join(dir,'references','long.md'),'changed');assert.throws(()=>read(f.library,s.name,{path:'references/long.md',expectedHash:hash}),/变化/);
 }finally{f.clean();}
});
test('Skill 拒绝越界、绝对路径、硬链接、目录联接、二进制与过大资源',()=>{
 const f=fixture();try{const dir=f.add(),outside=join(f.root,'secret');writeFileSync(outside,'private');linkSync(outside,join(dir,'hard.md'));
 symlinkSync(f.root,join(dir,'junction'),process.platform==='win32'?'junction':'dir');
 writeFileSync(join(dir,'binary'),Buffer.from([0xff,0,1]));writeFileSync(join(dir,'large.md'),'x'.repeat(262145));
 f.library.refresh();const s=select(f.library);f.library.setEnabled(s.name,true,s.version);
 assert.throws(()=>read(f.library,s.name,{path:'binary'}),/UTF-8/);
 for(const path of ['../.preferences.json','../../secret','C:/Windows/win.ini','/secret','hard.md','junction/secret','binary','large.md'])assert.throws(()=>read(f.library,s.name,{path}),path);
 }finally{f.clean();}
});
test('Skill 无效包单独报告，不能覆盖内置包，元数据和目录数量有界',()=>{
 const f=fixture();try{f.add('umi-code');f.add('other','x');writeFileSync(join(f.library.directory,'other','SKILL.md'),'bad');const huge=f.add('huge');writeFileSync(join(huge,'SKILL.md'),document('huge').replace('A useful method','x'.repeat(17000)));
 const result=f.library.refresh();assert.equal(result.skills.length,3);assert.equal(result.issues.length,3);
 for(let i=0;i<129;i++)f.add('method-'+i);const limited=f.library.refresh();assert(limited.limitReached);assert(limited.skills.length<=131);
 }finally{f.clean();}
});
test('Skill 小目录稳定且有完整分页入口，关闭后移除事实，不重复拼正文和参考',()=>{
 const f=fixture();try{for(let i=0;i<14;i++)f.add('method-'+i,'LARGE_BODY_MARKER');f.library.refresh();
 for(const s of f.library.library().skills.filter(s=>s.source==='user'))f.library.setEnabled(s.name,true,s.version);
 const a=skillCatalog(f.library),b=skillCatalog(f.library);assert.deepEqual(a,b);assert.equal(a.entries.length,12);assert.equal(a.total,17);assert.equal(a.omitted,5);assert(!JSON.stringify(a).includes('LARGE_BODY_MARKER'));
 const first=select(f.library,'method-0');f.library.setEnabled(first.name,false,first.version);assert.equal(skillCatalog(f.library).total,16);
 }finally{f.clean();}
});
test('Skill 管理桥只允许固定管理动作，不接受任意目录/工具/执行参数',()=>{
 for(const value of [{type:'skills_list',path:'C:/secret'},{type:'skills_enable',name:'test',enabled:true,version:'0'.repeat(64),execute:true},{type:'skills_preview',name:'../secret',version:'0'.repeat(64)}])assert.equal(desktopCommandSchema.safeParse(value).success,false);
 assert.equal(desktopCommandSchema.safeParse({type:'skills_list'}).success,true);
});
test('Skill 经过同一个真实 Agent 循环与持久化工具结果，不建立第二执行器',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-skills-engine-')),workspace=join(root,'source');mkdirSync(workspace);const steps:Step[]=[];
 const model=new ScriptModel(steps),app=new UmiApplication(join(root,'data'),model),service=new DesktopService(app),c=app.createConversation(workspace,{thinking:'off'});
 try{
 const library=app.skills.library(),s=library.skills.find(s=>s.name==='umi-code')!;
 steps.push(request=>{const facts=projectedFacts(request.body.messages as WireMessage[]);assert(facts['runtime.skills'].entries.some((e:any)=>e.name==='umi-code'));return call('read_skill',{name:s.name,version:s.version});},request=>{
 const tool=(request.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!;assert.match(tool.content,/代码任务/);return text('根据已有证据完成。');});
 const r=app.send(c.conversationId,uid(),'请参考代码技能');await app.wait(r.runId);assert.equal(model.requests.length,2);assert.equal(Object.keys(app.store.snapshot(c.conversationId).approvals).length,0);
 const record=app.store.tools(r.runId).find(t=>t.name==='read_skill');assert(record?.result_ref);assert.equal(app.registry.get('read_skill').effect,'read');assert(app.toolModules.some(m=>m.id==='umi.skills'));
 const state=app.store.snapshot(c.conversationId),found=Object.entries(state.tools).find(([,t])=>t.name==='read_skill')!;assert.match(activityLabel([{kind:'tool',id:found[0],sequence:found[1].sequence}],state),/已读取技能/);
 await service.handle(desktopCommandSchema.parse({type:'skills_enable',name:s.name,version:s.version,enabled:false}));assert(!app.skills.library().skills.find(e=>e.name===s.name)!.enabled);
 assert.equal(readFileSync(join(root,'data','skills','.preferences.json'),'utf8').includes(s.version),true);
 }finally{await app.close();removeTestRoot(root);}
});
// 旧版本偏好模拟应用升级；不修改产品内置包或其它测试的全局对象。
test('内置Skill升级保留明确停用，旧读取版本仍拒绝，外部启用不借机放宽',()=>{
 const f=fixture();try{
  const before=select(f.library,'umi-code');f.library.setEnabled(before.name,false,before.version);
  const path=join(f.library.directory,'.preferences.json'),prefs=JSON.parse(readFileSync(path,'utf8'));
  prefs[before.name].version='0'.repeat(64);writeFileSync(path,JSON.stringify(prefs));
  const again=new LocalSkillLibrary(f.root),current=select(again,before.name);
  assert.equal(current.enabled,false);assert(!skillCatalog(again).entries.some(s=>s.name===before.name));
  assert.throws(()=>read(again,before.name),/未启用/);
  assert(select(again,'umi-research').enabled);assert(select(again,'umi-artifacts').enabled);
  again.setEnabled(current.name,true,current.version);assert(select(again,current.name).enabled);
  assert.throws(()=>again.read(skillReadSchema.parse({name:current.name,version:'0'.repeat(64)})),/更新/);
  f.add();again.refresh();const external=select(again);again.setEnabled(external.name,true,external.version);
  writeFileSync(join(again.directory,external.name,'SKILL.md'),document(external.name,'外部新版'));
  again.refresh();assert.equal(select(again).enabled,false);
 }finally{f.clean();}
});

test('完整技能预览在启用前可续页，UTF-8不丢字，变化后拒绝混页；模型可一次读取中型正文',()=>{
 const f=fixture();try{
  const body='中😀文方法\n'.repeat(3000),dir=f.add('test-method',body);f.library.refresh();const s=select(f.library);
  let cursor=0,actual='';do{const page=f.library.preview(s.name,s.version,cursor);actual+=page.text;assert.equal(page.sourceHash,s.version);if(page.nextStartByte===null)break;assert(page.nextStartByte>cursor);cursor=page.nextStartByte;}while(true);
  assert.equal(actual,document(s.name,body));assert(!select(f.library).enabled);assert.throws(()=>read(f.library),/未启用/);
  f.library.setEnabled(s.name,true,s.version);assert.equal(read(f.library,s.name,{byteLength:64000}).text,actual);assert(Buffer.byteLength(read(f.library).text)>4096);
  assert.throws(()=>read(f.library,s.name,{byteLength:64001}));assert.throws(()=>f.library.preview(s.name,s.version,-1));
  writeFileSync(join(dir,'SKILL.md'),document(s.name,'changed'));assert.throws(()=>f.library.preview(s.name,s.version,cursor),/变化/);
 }finally{f.clean();}
});

test('128项合法开关超过旧16KiB仍可保存和重启，不因刷新全部停用',()=>{
 const f=fixture();try{
  for(let i=0;i<128;i++)f.add('method-'+String(i).padStart(3,'0')+'-long-name-for-skill-preferences');
  f.library.refresh();const entries=f.library.library().skills.filter(s=>s.source==='user');
  const prefs=Object.fromEntries(entries.map(s=>[s.name,{enabled:true,version:s.version}]));
  const bytes=JSON.stringify(prefs,null,2);assert(Buffer.byteLength(bytes)>16384);writeFileSync(join(f.library.directory,'.preferences.json'),bytes);
  let lib=new LocalSkillLibrary(f.root);assert.equal(lib.library().issues.length,0);assert.equal(lib.library().skills.filter(s=>s.source==='user'&&s.enabled).length,128);
  const first=entries[0]!;lib.setEnabled(first.name,false,first.version);lib=new LocalSkillLibrary(f.root);
  assert.equal(lib.library().skills.filter(s=>s.source==='user'&&s.enabled).length,127);assert.equal(select(lib,first.name).enabled,false);
 }finally{f.clean();}
});

test('模型搜索技能覆盖目录首屏之外，只返回已启用技能且无额外批准',async()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-skills-query-')),workspace=join(root,'source');mkdirSync(workspace);
 const steps:Step[]=[],model=new ScriptModel(steps),app=new UmiApplication(join(root,'data'),model);
 try{
  app.skills.library();for(let i=0;i<14;i++){const name='query-'+i,dir=join(app.skills.directory,name);mkdirSync(dir);writeFileSync(join(dir,'SKILL.md'),document(name));}
  app.skills.refresh();for(const s of app.skills.library().skills.filter(s=>s.source==='user'&&s.name!=='query-0'))app.skills.setEnabled(s.name,true,s.version);
  steps.push(call('list_skills',{query:'QUERY-9'}),request=>{const result=(request.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!.content;assert.match(result,/query-9/);assert(!result.includes('query-0'));return call('list_skills',{query:'query-0'});},request=>{const result=(request.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!.content;assert.match(result,/"total":0/);return text('已按用途查找。');});
  const c=app.createConversation(workspace),run=app.send(c.conversationId,uid(),'搜索技能');await app.wait(run.runId);
  assert.equal(app.store.getRun(run.runId).status,'completed');assert.equal(model.requests.length,3);assert.equal(Object.keys(app.store.snapshot(c.conversationId).approvals).length,0);
 }finally{await app.close();removeTestRoot(root);}
});
