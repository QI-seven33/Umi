import { z } from 'zod';

const id = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'));
export const providerIdentitySchema = z
  .object({
    id,
    version: id,
    implementationHash: digest,
  })
  .strict();
export const executionCapabilitiesSchema = z
  .object({
    tier: id,
    filesystemMapping: z.enum(['enforced', 'rejected', 'unknown']),
    networkDeny: z.enum(['enforced', 'rejected', 'unknown']),
    uiDeny: z.enum(['enforced', 'rejected', 'unknown']),
    gatedStart: z.enum(['enforced', 'rejected', 'unknown']),
    recovery: z.enum(['supported', 'unsupported', 'unknown']),
  })
  .strict();
const file = z.object({ path, identity: id, hash: digest }).strict();
export const executionPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    executionId: id,
    leaseGeneration: z.number().int().positive(),
    provider: providerIdentitySchema,
    capabilities: executionCapabilitiesSchema,
    workload: z
      .object({
        program: file,
        argv: z
          .array(
            z
              .string()
              .max(16000)
              .refine((s) => !s.includes('\0')),
          )
          .max(256),
        cwd: file,
        dependencies: z.array(file).max(64),
        environment: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/),
            z
              .string()
              .max(4096)
              .refine((s) => !s.includes('\0')),
          )
          .refine((e) => Object.keys(e).length <= 64),
        stdin: z.string().max(64000),
      })
      .strict(),
    policy: z
      .object({
        filesystem: z
          .array(
            z
              .object({ root: path, identity: id, access: z.enum(['read', 'write']) })
              .strict(),
          )
          .min(1)
          .max(32),
        network: z.enum(['deny', 'unrestricted']),
        ui: z.enum(['deny', 'unrestricted']),
        startMode: z.enum(['immediate', 'gated']),
        inheritEnvironment: z.literal(false),
      })
      .strict(),
    timeoutMs: z.number().int().min(100).max(300000),
    maxOutputBytes: z.number().int().min(1024).max(1048576),
  })
  .strict();
export const executionLocatorSchema = z
  .object({
    schemaVersion: z.literal(2),
    executionId: id,
    planHash: digest,
    provider: providerIdentitySchema,
    // 后端负责 token 的核验；本字段不是任意 PID 杀进程授权。
    kind: id,
    token: z.string().min(1).max(4096),
  })
  .strict();
export const executionObservationSchema = z
  .object({
    schemaVersion: z.literal(2),
    executionId: id,
    planHash: digest,
    provider: providerIdentitySchema,
    reason: z.enum(['exited', 'timeout', 'cancelled', 'not_started', 'interrupted']),
    exitCode: z.number().int().nullable(),
    started: z.boolean(),
    cleanup: z
      .object({
        processTree: z.enum(['confirmed', 'not-required', 'unknown']),
        containment: z.enum(['confirmed', 'not-required', 'unknown']),
      })
      .strict(),
    effects: z.enum(['verified', 'not-verified', 'unknown']),
    observedAt: z.iso.datetime(),
    stdout: z.string().max(1048576),
    stderr: z.string().max(1048576),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      (r.reason === 'not_started' && r.started) ||
      (r.reason === 'exited' && !r.started)
    )
      ctx.addIssue({ code: 'custom', message: '启动事实与退出原因矛盾' });
    if (r.reason !== 'exited' && r.exitCode !== null)
      ctx.addIssue({ code: 'custom', message: '未观察普通退出不能编造退出码' });
    if (r.reason === 'not_started' && r.effects === 'verified')
      ctx.addIssue({ code: 'custom', message: '未启动不能声明已核验执行效果' });
  });
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type ExecutionLocator = z.infer<typeof executionLocatorSchema>;
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
