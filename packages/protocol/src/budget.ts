import { z } from 'zod';
import { UmiError } from './model.js';

//const obj = z.object({ /* ...字段... */ }); // 1. 调用 z.object，传一个对象
//const schema = obj.strict();                // 2. 在结果上再调用 .strict()
//export const budgetDetailsSchema = schema;  // 3. 导出
//z.object({...}) 默认行为：忽略对象里多余的字段（strip）
//.strict()：改成禁止多余字段，多一个就报错

// 预算阻塞不是模型额度耗尽。数值属于保守估算，不冒充厂商实测 token。
export const budgetDetailsSchema = z.object({
  stage: z.enum(['protected', 'projection', 'encoded', 'configuration']),
  estimatedInputTokens: z.number().int().nonnegative(), protectedInputTokens: z.number().int().nonnegative(),
  inputCeiling: z.number().int().nonnegative(), contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(), safetyHeadroom: z.number().int().nonnegative(),
  estimateBasis: z.enum(['utf8-conservative-v1', 'utf8-vision-v2']),
}).strict();

//在 budgetDetailsSchema 的基础上扩展出 budgetBlockSchema：新增 sourceFingerprint 和 policyFingerprint 两个字段，要求它们都是 64 位小写十六进制字符串（即 SHA-256 指纹）
export const budgetBlockSchema = budgetDetailsSchema.extend({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), //先要求是字符串，再用正则要求整串正好 64 个字符、只含 a-f 和 0-9
}).strict();

//z.infer<typeof X> 是 Zod 提供的类型工具：从 schema 自动推断出对应的 TS 类型
export type BudgetDetails = z.infer<typeof budgetDetailsSchema>;
export type BudgetBlock = z.infer<typeof budgetBlockSchema>;
export class ContextBudgetError extends UmiError {
  constructor(message: string, readonly details: BudgetDetails) { super('CONTEXT_BUDGET_EXCEEDED', message, false); }
}
