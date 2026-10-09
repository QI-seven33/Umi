import { z } from 'zod';

const ref=z.string().min(1).max(160),digest=z.string().regex(/^[a-f0-9]{64}$/);
const directory=z.string().max(1024).refine(p=>p===''||!p.startsWith('/')&&!p.includes('\\')&&!p.includes(':')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'&&!/[<>"|?*\x00-\x1f]/.test(x)&&!/[. ]$/.test(x)),'工作目录必须是普通相对目录');
export const cwdSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('mount'),mountId:ref,path:directory.default('')}).strict(),
  z.object({kind:z.literal('task'),area:z.enum(['scratch','research']),path:directory.default('')}).strict(),
]);
const envSchema=z.object({LANG:z.string().max(100).optional(),LC_ALL:z.string().max(100).optional(),CI:z.string().max(20).optional(),NO_COLOR:z.string().max(20).optional(),FORCE_COLOR:z.string().max(20).optional()}).strict();
const limits={cwd:cwdSchema,env:envSchema.default({}),stdin:z.string().max(64000).default(''),timeoutMs:z.number().int().min(100).max(300000).default(30000),maxOutputBytes:z.number().int().min(1024).max(1048576).default(65536)};
export const directCommandSchema=z.object({program:z.string().min(1).max(4096).refine(s=>!s.includes('\0')),argv:z.array(z.string().max(16000).refine(s=>!s.includes('\0'))).max(256).default([]),...limits}).strict();
export const shellCommandSchema=z.object({shell:z.enum(['powershell','cmd']),script:z.string().min(1).max(8000).refine(s=>!s.includes('\0')),...limits}).strict();
export type DirectCommand=z.infer<typeof directCommandSchema>;
export type ShellCommand=z.infer<typeof shellCommandSchema>;
export const processSnapshotSchema=z.object({schemaVersion:z.literal(1),executionId:ref,leaseGeneration:z.number().int().positive(),mode:z.enum(['direct','powershell','cmd']),
  program:z.string().min(1),argv:z.array(z.string()),commandLine:z.string().min(1).max(32766),programIdentity:ref,programHash:digest,
  cwd:z.string().min(1),cwdIdentity:ref,cwdFingerprint:digest,cwdRef:cwdSchema,env:z.record(z.string(),z.string()),stdin:z.string().max(64000),
  script:z.string().optional(),scriptHash:digest.optional(),bridgeHash:digest,timeoutMs:z.number().int().positive().max(300000),maxOutputBytes:z.number().int().positive().max(1048576),
  scope:z.enum(['host-code-execution','git-inspect','git-network','git-destructive','git-write'])}).strict();
export type ProcessSnapshot=z.infer<typeof processSnapshotSchema>;
export const processIdentitySchema=z.object({pid:z.number().int().positive(),birth:z.string().regex(/^\d+$/)}).strict();
export type ProcessIdentity=z.infer<typeof processIdentitySchema>;
export const processReceiptSchema=z.object({schemaVersion:z.literal(1),executionId:ref,exitCode:z.number().int().nullable(),
  reason:z.enum(['exited','timeout','stopped','parent_closed','not_started','launch_failed','interrupted']),jobInactive:z.boolean(),gateReleased:z.boolean(),
  observedAt:z.iso.datetime(),stdoutRef:ref,stderrRef:ref,stdoutBytes:z.number().int().nonnegative(),stderrBytes:z.number().int().nonnegative(),truncated:z.boolean(),
  byteCountBasis:z.enum(['native-observed','archived-lower-bound']),
  cwdAfter:digest.nullable(),inspectionError:z.string().nullable()}).strict();
export type ProcessReceipt=z.infer<typeof processReceiptSchema>;
