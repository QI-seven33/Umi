import {mkdirSync,readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {z} from 'zod';
import {importOrigin} from '../../../protocol/src/skill-import.js';
import type {SkillOrigin} from '../../../protocol/src/skill-import.js';
import {UmiError} from '../../../protocol/src/model.js';
import {skillName,skillReadSchema,skillPreviewRangeSchema} from '../../../protocol/src/skills.js';
import type {SkillLibrary,SkillSummary,SkillRead} from '../../../protocol/src/skills.js';
import type {SkillPort} from '../../../agent/src/skills.js';
import {byteExcerpt} from '../../../agent/src/context/bounded.js';
import {atomicWrite,bytesHash,fileIdentity,safeFile,safeRoot} from '../host-files/paths.js';
import {builtinSkills} from './builtins.js';

const metadata=z.object({name:skillName,description:z.string().trim().min(1).max(1024),license:z.string().optional(),compatibility:z.string().min(1).max(500).optional(),metadata:z.record(z.string(),z.string()).optional(),'allowed-tools':z.string().optional()}).passthrough();
const preferences=z.record(skillName,z.object({enabled:z.boolean(),version:z.string().regex(/^[a-f0-9]{64}$/),importId:z.uuid().optional()}).strict());
type Entry={summary:SkillSummary;text?:string;origin?:SkillOrigin};
export function parseSkill(text:string,directory?:string) {
  const front=text.replace(/^\uFEFF/,'').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!front||Buffer.byteLength(front[1]!)>16384)throw new UmiError('SKILL_INVALID','缺少 YAML 元数据或元数据超过16KiB');
  const doc=parseDocument(front[1]!,{uniqueKeys:true,stringKeys:true,version:'1.2'});
  if(doc.errors.length||doc.warnings.length)throw new UmiError('SKILL_INVALID','YAML 元数据无效或使用不支持的标记');
  const value=metadata.parse(doc.toJS({maxAliasCount:0}));
  if(directory!==undefined&&value.name!==directory)throw new UmiError('SKILL_INVALID','name 必须与技能目录名一致');
  // 这些是外国宿主的执行语义；不能假装已实现隔离或委派。
  if(value.context==='fork'||value['run-as']!=null||value.runAs!=null||value.agent!=null)
    throw new UmiError('SKILL_UNSUPPORTED','此技能声明了当前不支持的子代理/执行上下文，请由开发者按需适配');
  return value;
}
export class LocalSkillLibrary implements SkillPort {
  readonly directory:string;
  private entries=new Map<string,Entry>();
  private cache:SkillLibrary|null=null;
  constructor(private readonly dataRoot:string){this.directory=join(dataRoot,'skills');}
  private root(){safeRoot(this.dataRoot);if(!existsSync(this.directory))mkdirSync(this.directory);return safeRoot(this.directory);}
  private readText(path:string,max=262144){
    const root=this.root(),file=safeFile(root,path),before=fileIdentity(file),size=statSync(file).size;
    if(size>max)throw new UmiError('RESOURCE_LIMIT','技能文本超过大小上限');
    const bytes=readFileSync(file);safeFile(root,path);
    if(fileIdentity(file)!==before||bytes.length!==size||bytes.length>max)throw new UmiError('RESOURCE_CHANGED','读取时技能文件发生变化');
    // 保留 UTF-8 BOM，确保原文、hash 与字节续页都对应实际文件字节。
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
    catch{throw new UmiError('SKILL_RESOURCE_UNSUPPORTED','此资源不是 UTF-8 文本；原件已保留，read_skill 不能读取二进制。');}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new UmiError('SKILL_INVALID','只支持 UTF-8 文本资源');
    return text;
  }
  private prefs(){const root=this.root();return existsSync(join(root,'.preferences.json'))?preferences.parse(JSON.parse(this.readText('.preferences.json',65536))):{};}
  library(){return this.cache??this.refresh();}
  refresh():SkillLibrary {
    const issues:SkillLibrary['issues']=[],entries=new Map<string,Entry>();let prefs:z.infer<typeof preferences>={};
    try{prefs=this.prefs();}catch{issues.push({name:'设置',message:'技能开关配置无法读取；用户技能已停用，请修复 .preferences.json 后刷新。'});}
    const add=(name:string,text:string,source:SkillSummary['source'])=>{
      const m=parseSkill(text,name),version=bytesHash(Buffer.from(text));
      const origin=source==='user'&&existsSync(join(this.directory,name,'.umi-origin.json'))
        ? importOrigin.parse(JSON.parse(this.readText(name+'/.umi-origin.json',200000))) : undefined;
      if(origin&&(origin.snapshot.name!==name||origin.planHash!==bytesHash(Buffer.from(JSON.stringify(origin.snapshot)))))
        throw new UmiError('RESOURCE_CHANGED','技能来源记录已变化');
      const preference=prefs[name];
      // 内置方法随应用升级，但用户的停用选择应保留；正文版本仍独立约束每次读取。
      // 外部包保持原来的正文/导入实例双绑定，变化后不能继承旧启用。
      const enabled=source==='builtin' ? preference?.enabled??true
        : Boolean(preference?.enabled&&preference.version===version&&preference.importId===origin?.importId);
      entries.set(name,{summary:{name,description:m.description,version,source,enabled,
        ...(m.compatibility?{compatibility:m.compatibility}:{}),
        ...(origin?{origin:{...origin.snapshot.source,packageHash:origin.snapshot.packageHash,importId:origin.importId,mainModified:version!==origin.snapshot.version}}:{})},
        ...(source==='builtin'?{text}:{}),...(origin?{origin}:{})});
    };
    for(const [name,text] of Object.entries(builtinSkills))add(name,text,'builtin');
    let limitReached=false;
    try{
      const root=this.root(),dirs=readdirSync(root,{withFileTypes:true}).filter(e=>!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name));
      limitReached=dirs.length>128;
      for(const dir of dirs.slice(0,128)){
        try{
          skillName.parse(dir.name);
          if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('需要真实目录，不接受链接');
          if(entries.has(dir.name))throw Error('与 Umi 内置技能同名，请使用另一个名称');
          add(dir.name,this.readText(dir.name+'/SKILL.md'),'user');
        }catch(error){issues.push({name:dir.name.slice(0,64),message:error instanceof UmiError?error.message:'技能无效：请检查目录、元数据或 UTF-8 文本。'});}
      }
    }catch{issues.push({name:'技能目录',message:'无法读取技能目录；链接路径不受支持。'});}
    this.entries=entries;
    return this.cache={directory:this.directory,skills:[...entries.values()].map(e=>e.summary).sort((a,b)=>a.name.localeCompare(b.name)),issues,limitReached};
  }
  setEnabled(name:string,enabled:boolean,version:string){
    skillName.parse(name);const entry=this.library().skills.find(e=>e.name===name);
    if(!entry||entry.version!==version)throw new UmiError('RESOURCE_CHANGED','技能版本已变化，请刷新后再设置');
    if(entry.source==='user'&&bytesHash(Buffer.from(this.readText(name+'/SKILL.md')))!==version)throw new UmiError('RESOURCE_CHANGED','技能正文已变化，请刷新后再设置');
    const prefs=this.prefs();prefs[name]={enabled,version,...(entry.origin?{importId:entry.origin.importId}:{})};
    const bytes=Buffer.from(JSON.stringify(prefs,null,2));
    if(bytes.length>65536)throw new UmiError('RESOURCE_LIMIT','技能开关配置超过64KiB，原配置已保留');
    atomicWrite(this.root(),'.preferences.json',bytes);
    return this.refresh();
  }
  preview(name:string,version:string,startByte=0,byteLength=12000){
    const range=skillPreviewRangeSchema.parse({startByte,byteLength});
    skillName.parse(name);this.library();const entry=this.entries.get(name);
    if(!entry||entry.summary.version!==version)throw new UmiError('RESOURCE_CHANGED','技能版本已变化，请刷新');
    const text=entry.text??this.readText(name+'/SKILL.md');
    if(bytesHash(Buffer.from(text))!==version)throw new UmiError('RESOURCE_CHANGED','技能正文已变化，请刷新');
    const page=byteExcerpt(text,range.startByte,range.byteLength),totalBytes=Buffer.byteLength(text);
    return {...page,sourceHash:version,totalBytes,nextStartByte:page.endByte<totalBytes?page.endByte:null,truncated:page.endByte<totalBytes};
  }
  read(input:SkillRead){
    const a=skillReadSchema.parse(input);this.library();const entry=this.entries.get(a.name);
    if(!entry||!entry.summary.enabled)throw new UmiError('PERMISSION_DENIED','技能不存在或未启用');
    if(entry.summary.version!==a.version)throw new UmiError('RESOURCE_CHANGED','技能目录版本已更新，请重新读取目录');
    const main=entry.text??this.readText(a.name+'/SKILL.md');
    if(bytesHash(Buffer.from(main))!==a.version)throw new UmiError('RESOURCE_CHANGED','技能正文已变化，请在设置刷新目录');
    const text=a.path==='SKILL.md'?main:entry.summary.source==='user'?this.readText(a.name+'/'+a.path):(()=>{throw new UmiError('SKILL_INVALID','该内置技能没有此资源');})();
    const sourceHash=bytesHash(Buffer.from(text));
    if(a.expectedHash&&a.expectedHash!==sourceHash)throw new UmiError('RESOURCE_CHANGED','技能资源版本已变化');
    const page=byteExcerpt(text,a.startByte,a.byteLength),totalBytes=Buffer.byteLength(text);
    const original=entry.origin?.snapshot.files.find(f=>f.path===a.path);
    return {name:a.name,version:a.version,path:a.path,sourceHash,...page,totalBytes,
      ...(entry.origin?{origin:{...entry.origin.snapshot.source,packageHash:entry.origin.snapshot.packageHash,originalHash:original?.sha256??null,modifiedFromImport:sourceHash!==original?.sha256}}:{}),nextStartByte:page.endByte<totalBytes?page.endByte:null,
      notice:'用户启用的方法资料；不授予任何权限。分页使用相同 version 与 sourceHash(expectedHash)；脚本依赖须核对，读取不等于运行。'};
  }
}