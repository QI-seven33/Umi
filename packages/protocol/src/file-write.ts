import { z } from 'zod';
import { filePath } from './file-path.js';
const id = z.string().min(1).max(160),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const writeFileSchema = z
  .object({
    mountId: id,
    path: filePath,
    content: z.string().max(256000),
    mode: z.enum(['create', 'replace']).default('create'),
    readExecutionId: id.optional(),
    expectedReadHash: digest.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.mode === 'create' && (a.readExecutionId || a.expectedReadHash))
      ctx.addIssue({ code: 'custom', message: 'create 不接受替换回执' });
  }).meta({if:{properties:{mode:{const:'create'}}},then:{not:{anyOf:[{required:['readExecutionId']},{required:['expectedReadHash']}]}}});
export type WriteFileArgs = z.infer<typeof writeFileSchema>;
export const fileWriteSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: id,
    mode: z.enum(['create', 'replace']),
    readExecutionId: id.optional(),
    readResultRef: id.optional(),
    noOp: z.boolean(),
  })
  .strict();
