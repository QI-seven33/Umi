import {z} from 'zod';
import {id} from './model.js';

// 范围相对于原消息 content 或资料的规范 JSON 文本，单位为 UTF-8 字节。
const range={startByte:z.number().int().nonnegative(),endByte:z.number().int().positive()};
export const memorySourceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('message'),messageId:id,...range}).strict(),
  z.object({kind:z.literal('artifact'),artifactId:id,...range}).strict(),
]).refine(s=>s.endByte>s.startByte,'来源结束位置必须大于起点');
export type MemorySource=z.infer<typeof memorySourceSchema>;
export const noteInputSchema=z.object({category:z.enum(['observation','inference','decision','failure','next_step']),text:z.string().min(1).max(8000),
  sources:z.array(memorySourceSchema).min(1).max(8)}).strict();
export const requirementInputSchema=z.object({source:memorySourceSchema,text:z.string().min(1).max(8000),
  supersedes:z.array(id).max(8).default([])}).strict();
export const resetInputSchema=z.object({reason:z.string().min(1).max(1000),keepSources:z.array(memorySourceSchema).max(16).default([])}).strict();
export const memoryValueSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('note'),value:noteInputSchema}).strict(),
  z.object({kind:z.literal('requirement'),value:requirementInputSchema}).strict(),
  z.object({kind:z.literal('reset'),value:resetInputSchema}).strict(),
]);
export type MemoryValue=z.infer<typeof memoryValueSchema>;
export type MemoryEntry={id:string;executionId:string;artifactRef:string;value:MemoryValue};
export const summarySchema=z.object({items:z.array(z.object({kind:z.enum(['observation','inference','decision','failure','next_step']),
  text:z.string().min(1).max(1600),sourceIds:z.array(id).min(1).max(8)}).strict()).min(1).max(24)}).strict();
export type Summary=z.infer<typeof summarySchema>;
export type ContextWindow={version:number;summaryRef:string|null;manifestRef:string|null;resetEntryId:string|null};
export type ContextMemory={window:ContextWindow;archivedIds:string[];summary:Summary|null;entries:MemoryEntry[]};
export const contextMetricsSchema=z.object({contextVersion:z.number().int().positive(),contextWindow:z.number().int().positive(),
  maxOutputTokens:z.number().int().positive(),safetyHeadroom:z.number().int().nonnegative(),pressureThreshold:z.number().int().positive(),
  protectedInputTokens:z.number().int().nonnegative(),rawInputTokens:z.number().int().nonnegative(),retainedMessages:z.number().int().nonnegative(),
  archivedMessages:z.number().int().nonnegative(),requirements:z.number().int().nonnegative(),notes:z.number().int().nonnegative(),
  estimateBasis:z.enum(['utf8-conservative-v1','utf8-vision-v2']),model:id}).strict();
export type ContextMetrics=z.infer<typeof contextMetricsSchema>;
export const maintenancePlanSchema=z.object({id,conversationId:id,runId:id,baseVersion:z.number().int().positive(),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
  mode:z.enum(['compact','reset','budget-reset']),reason:z.string().min(1).max(2000),archiveIds:z.array(id),sourceHashes:z.record(id,z.string().regex(/^[a-f0-9]{64}$/)),
  beforeEstimate:z.number().int().nonnegative(),candidateEstimate:z.number().int().nonnegative(),summaryInput:z.unknown(),request:z.unknown().nullable(),resetEntryId:id.nullable()}).strict();
export type MaintenancePlan=z.infer<typeof maintenancePlanSchema>;
