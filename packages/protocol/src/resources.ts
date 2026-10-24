import { z } from 'zod';
import { id } from './model.js';
import { resourceScopeSchema } from './resource-scope.js';

import { filePath } from './file-path.js';
export { filePath } from './file-path.js';
export const entrySchema = z
  .object({ hash: id, identity: id, size: z.number().int().nonnegative() })
  .strict();
export const manifestSchema = z.record(filePath, entrySchema);
export type Manifest = z.infer<typeof manifestSchema>;
export const candidateSchema = z
  .object({
    id,
    environmentId: id,
    path: z.string(),
    identity: id,
    initial: z.boolean(),
    scope: resourceScopeSchema.default({ kind: 'directory' }),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const mountSchema = z
  .object({
    id,
    environmentId: id,
    resourceId: id,
    root: z.string(),
    rootIdentity: id,
    bindingVersion: z.number().int().positive(),
    baselineRef: id,
    scope: resourceScopeSchema.default({ kind: 'directory' }),
    sourceRoot: z.string(),
    sourceIdentity: id,
    direct: z.object({grantId: id, revision: z.number().int().positive()}).strict().optional(),
  })
  .strict();
export type Mount = z.infer<typeof mountSchema>;
export const changeSchema = z
  .object({
    path: filePath,
    before: entrySchema.nullable(),
    after: entrySchema.nullable(),
  })
  .strict();
export const changeSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    environmentId: id,
    mountId: id,
    baselineRef: id,
    resourceScope: resourceScopeSchema.optional(),
    createdAt: z.iso.datetime(),
    changes: z.array(changeSchema).min(1).max(200),
  })
  .strict()
  .refine(
    (cs) => new Set(cs.changes.map((c) => c.path)).size === cs.changes.length,
    '变更集不能重复包含同一文件',
  );
export type ChangeSet = z.infer<typeof changeSetSchema>;
export type DeliveryReceipt = {
  changeSetId: string;
  path: string;
  outcome: 'applied' | 'satisfied' | 'not_applied' | 'unknown';
  observed: Manifest[string] | null;
  reason: string;
  observedAt: string;
};
