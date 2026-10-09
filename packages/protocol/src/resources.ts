import { z } from 'zod';
import { id } from './model.js';

// 对模型开放的是逻辑位置；Windows 设备名、流路径和穿越在协议入口即拒绝。
export const filePath = z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('\\') &&
  !p.includes(':') && !p.split('/').some(x=>['.git','node_modules','.venv','__pycache__'].includes(x.toLowerCase())) && p.split('/').every(x => x && x !== '.' && x !== '..' &&
  !/[<>"|?*\x00-\x1f]/.test(x) && !/[. ]$/.test(x) &&
  !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x)), '必须使用普通相对路径，禁止穿越、设备名及特殊流');
export const entrySchema = z.object({ hash: id, identity: id, size: z.number().int().nonnegative() }).strict();
export const manifestSchema = z.record(filePath, entrySchema);
export type Manifest = z.infer<typeof manifestSchema>;
export const candidateSchema = z.object({ id, environmentId:id, path:z.string(), identity:id, initial:z.boolean(), createdAt:z.iso.datetime() }).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const mountSchema = z.object({ id, environmentId:id, resourceId:id, root:z.string(), rootIdentity:id,
  bindingVersion:z.number().int().positive(), baselineRef:id, sourceRoot:z.string(), sourceIdentity:id }).strict();
export type Mount = z.infer<typeof mountSchema>;
export const changeSchema = z.object({ path:filePath, before:entrySchema.nullable(), after:entrySchema.nullable() }).strict();
export const changeSetSchema = z.object({ schemaVersion:z.literal(1), id, environmentId:id, mountId:id,
  baselineRef:id, createdAt:z.iso.datetime(), changes:z.array(changeSchema).min(1).max(200) }).strict().refine(cs=>new Set(cs.changes.map(c=>c.path)).size===cs.changes.length,'变更集不能重复包含同一文件');
export type ChangeSet = z.infer<typeof changeSetSchema>;
export type DeliveryReceipt = { changeSetId:string; path:string; outcome:'applied'|'satisfied'|'not_applied'|'unknown';
  observed:Manifest[string]|null; reason:string; observedAt:string };
