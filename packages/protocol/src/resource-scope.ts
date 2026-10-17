import { z } from 'zod';
import { filePath } from './file-path.js';

// 目录是历史记录的默认范围；单文件保存元数据快照，不在发现时读取正文。
export const resourceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory') }).strict(),
  z
    .object({
      kind: z.literal('file'),
      path: filePath.refine((p) => !p.includes('/'), '单文件范围只包含一个文件名'),
      rootIdentity: z.string().min(1),
      identity: z.string().min(1),
      size: z.number().int().nonnegative(),
      modifiedNs: z.string().regex(/^\d+$/),
      changedNs: z.string().regex(/^\d+$/),
    })
    .strict(),
]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export const materializationFailureSchema = z
  .object({
    stage: z.enum(['scan', 'copy', 'reconcile']),
    effects: z.enum(['not-started', 'partial-or-unknown']),
    mountId: z.string().optional(),
  })
  .strict();
export type MaterializationFailure = z.infer<typeof materializationFailureSchema>;
