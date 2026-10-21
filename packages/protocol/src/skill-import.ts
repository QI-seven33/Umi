import {z} from 'zod';
import {filePath} from './file-path.js';
import {skillName,skillVersion} from './skills.js';

export const githubSkillInput=z.object({
  repository:z.string().trim().min(1).max(240),
  path:z.union([z.literal(''),filePath.max(240)]).default(''),
  ref:z.string().trim().max(200).default(''),
}).strict();
export type GithubSkillInput=z.infer<typeof githubSkillInput>;
export const importId=z.uuid();
export const gitSha=z.string().regex(/^[a-f0-9]{40}$/);
export const importFile=z.object({path:filePath.max(240),bytes:z.number().int().min(0).max(1048576),sha256:skillVersion,gitSha}).strict();
export const importSource=z.object({
  repository:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  owner:z.string().regex(/^[A-Za-z0-9-]{1,100}$/),repo:z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  path:z.union([z.literal(''),filePath.max(240)]),requestedRef:z.string().max(200),commit:gitSha,
}).strict();
export const importSnapshot=z.object({
  name:skillName,description:z.string().max(1024),version:skillVersion,
  license:z.string().max(2048),compatibility:z.string().max(500),
  source:importSource,files:z.array(importFile).min(1).max(128),
  totalBytes:z.number().int().min(1).max(8388608),packageHash:skillVersion,
  preview:z.string().max(12000),previewTruncated:z.boolean(),
}).strict();
export type SkillImportSnapshot=z.infer<typeof importSnapshot>;
export const importRecord=z.object({
  id:importId,createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),
  state:z.enum(['fetching','staged','installing','installed','failed','cancelled']),
  input:githubSkillInput,progress:z.string().max(160),error:z.string().max(500).optional(),
  snapshot:importSnapshot.optional(),planHash:skillVersion.optional(),
}).strict().superRefine((r,ctx)=>{
  if(['staged','installing','installed'].includes(r.state)&&(!r.snapshot||!r.planHash))
    ctx.addIssue({code:'custom',message:'导入记录缺少冻结包'});
});
export type SkillImportRecord=z.infer<typeof importRecord>;
export type SkillImportSummary=Omit<SkillImportRecord,'snapshot'> & {name?:string;files?:number;bytes?:number};
export const importOrigin=z.object({schemaVersion:z.literal(1),importId,planHash:skillVersion,snapshot:importSnapshot}).strict();
export type SkillOrigin=z.infer<typeof importOrigin>;