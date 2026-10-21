import { z } from 'zod';
import type { WireMessage } from './model.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().min(1).max(160);
const metadata = z.object({
  hash: digest, mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  size: z.number().int().min(16).max(1_000_000),
  width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
}).strict().refine(m => m.width * m.height <= 16_777_216, '图片像素超过16Mi');
export const imageSnapshotSchema = z.object({
  schemaVersion: z.literal(1), metadata,
  base64: z.string().min(1).max(1_400_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const imageObservationSchema = z.object({
  kind: z.literal('image-observation'), schemaVersion: z.literal(1), imageRef: id, metadata,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('mount'), mountId: id, path: z.string().min(1), identity: id }).strict(),
    z.object({ kind: z.literal('output'), outputId: id, path: z.string().min(1) }).strict(),
  ]),
}).strict();
export type ImageObservation = z.infer<typeof imageObservationSchema>;
export type HostImageObservation = { receipt: ImageObservation; image: NonNullable<WireMessage['images']>[number] };
