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
