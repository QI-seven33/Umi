import { z } from 'zod';
import { id } from './model.js';
import { filePath } from './file-path.js';
export const documentTargetSchema = z.object({
  root: z.string().min(1).max(4096), rootIdentity: id,
  path: filePath, hash: z.string().regex(/^[a-f0-9]{64}$/), identity: id,
}).strict();
export type DocumentTarget = z.infer<typeof documentTargetSchema>;
export type DocumentOpener = (target: DocumentTarget, signal: AbortSignal) => Promise<void>;
export const nativeOpenRequestSchema = z.object({
  kind: z.literal('open_document'), instanceId: id, correlationId: id, target: documentTargetSchema,
}).strict();

export const nativeOpenResultSchema = z.object({ kind: z.literal('open_document_result'),
  instanceId: id, correlationId: id, error: z.string().max(4096).optional(), code: z.enum(['OPEN_REJECTED', 'OPEN_UNKNOWN']).optional() }).strict();
