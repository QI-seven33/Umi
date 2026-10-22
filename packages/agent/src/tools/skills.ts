import {skillListSchema,skillReadSchema} from '../../../protocol/src/skills.js';
import type {SkillPort} from '../skills.js';
import type {ToolRegistry,ToolDefinition} from './registry.js';
export function registerSkills(registry:ToolRegistry,port:SkillPort,prepare:ToolDefinition['prepare']) {
  registry.register({name:'list_skills',description:'按 query 搜索名称或用途，分页列出用户启用的 Skill 名称、说明、来源与正文版本。Skill 提供可选方法，不代表新工具或授权。',schema:skillListSchema,effect:'read',prepare,
    async execute(input,_ctx,_cid,signal){signal.throwIfAborted();const a=skillListSchema.parse(input),all=port.library().skills.filter(s=>s.enabled&&(!a.query||(s.name+' '+s.description).toLowerCase().includes(a.query.toLowerCase())));
      return {outcome:'succeeded',content:'',data:{skills:all.slice(a.offset,a.offset+a.limit).map(s=>({...s,description:s.description.slice(0,180),descriptionShortened:s.description.length>180})),total:all.length,nextOffset:a.offset+a.limit<all.length?a.offset+a.limit:null}};
    },async reconcile(...args){return this.execute(...args);}});
  registry.register({name:'read_skill',description:'按目录中的 name/version 读取 Skill 正文或包内相对文本资源。默认8192字节，可按需增加至64000；需要更多内容时用 nextStartByte 继续；可用 expectedHash 固定资源版本。只读，不运行脚本。',schema:skillReadSchema,effect:'read',prepare,
    async execute(input,_ctx,_cid,signal){signal.throwIfAborted();return {outcome:'succeeded',content:'',data:port.read(skillReadSchema.parse(input))};},
    async reconcile(...args){return this.execute(...args);}});
}