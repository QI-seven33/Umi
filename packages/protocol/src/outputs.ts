import { z } from 'zod';
import { filePath } from './file-path.js';

const ref = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const outputTarget = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(p) && !/[\x00-\x1f]/.test(p),
    '导出必须指定本地绝对文件路径',
  );
export const createOutputSchema = z
  .object({
    name: filePath,
    mime: z.string().min(1).max(120).default('text/plain'),
    content: z.string().max(256000),
  })
  .strict();
export const captureOutputSchema = z
  .object({
    name: filePath,
    mime: z.string().min(1).max(120).default('application/octet-stream'),
    path: filePath,
  })
  .strict();
export const listOutputsSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const readOutputSchema = z
  .object({
    outputId: ref,
    startByte: z.number().int().nonnegative().default(0),
    byteLength: z.number().int().min(1).max(64000).default(8192),
    representation: z.enum(['auto', 'base64']).default('auto'),
  })
  .strict();
export const exportOutputsSchema = z
  .object({
    items: z
      .array(z.object({ outputId: ref, target: outputTarget }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export const inspectExportSchema = z.object({ executionId: ref }).strict();
export const outputDescriptorSchema = z
  .object({
    outputId: ref,
    name: filePath,
    mime: z.string().min(1).max(120),
    hash: digest,
    size: z
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024),
    relativePath: filePath,
  })
  .strict();
export const outputSnapshotSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      descriptor: outputDescriptorSchema,
      capturePath: filePath.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('export'),
      executionId: ref,
      items: z
        .array(
          z
            .object({
              descriptor: outputDescriptorSchema,
              target: outputTarget,
              root: z.string(),
              rootIdentity: ref,
              path: filePath,
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);
export type OutputDescriptor = z.infer<typeof outputDescriptorSchema>;
export type OutputSnapshot = z.infer<typeof outputSnapshotSchema>;
export type ExportPlan = Extract<OutputSnapshot, { kind: 'export' }>;
export type ExportReceipt = {
  target: string;
  outputId: string;
  hash: string;
  status: 'written' | 'verified' | 'conflict' | 'not_started' | 'unknown';
  identity?: string;
  reason?: string;
};
