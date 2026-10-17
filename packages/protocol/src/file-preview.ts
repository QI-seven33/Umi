import { z } from 'zod';
import { entrySchema } from './resources.js';

const version = entrySchema.nullable();
export const frozenFilePageSchema = z.object({
  displayPath: z.string().optional(),
  text: z.string(), startByte: z.number(), endByte: z.number(), totalBytes: z.number(),
  nextStartByte: z.number().nullable(), truncated: z.boolean(), hash: z.string(),
  side: z.enum(['before', 'after', 'diff']), binary: z.boolean(), delivered: z.boolean(),
  before: version, after: version, operation: z.enum(['create', 'modify', 'delete']),
}).passthrough();
export type FrozenFilePage = z.infer<typeof frozenFilePageSchema>;
