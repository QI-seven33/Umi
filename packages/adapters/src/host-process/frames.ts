import { z } from 'zod';
import { processIdentitySchema } from '../../../protocol/src/process.js';

// 原生桥接输入仍须经过运行时校验；端口与真实实现共享同一回执类型。
export const frameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner'), bridge: processIdentitySchema }).strict(),
  z
    .object({
      kind: z.literal('ready'),
      bridge: processIdentitySchema,
      child: processIdentitySchema,
    })
    .strict(),
  z.object({ kind: z.literal('started') }).strict(),
  z
    .object({
      kind: z.literal('data'),
      channel: z.enum(['stdout', 'stderr']),
      base64: z
        .string()
        .max(6000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exit'),
      reason: z.enum([
        'exited',
        'timeout',
        'stopped',
        'parent_closed',
        'not_started',
        'launch_failed',
      ]),
      exitCode: z.number().int().nullable(),
      jobInactive: z.boolean(),
      gateReleased: z.boolean(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal('error'), reason: z.string(), gateReleased: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal('probe'),
      state: z.enum(['absent', 'different', 'same', 'terminated', 'inaccessible']),
    })
    .strict(),
]);
export type NativeExit = Extract<z.infer<typeof frameSchema>, { kind: 'exit' }>;
