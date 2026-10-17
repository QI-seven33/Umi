import { z } from 'zod';
import { directCommandSchema, shellCommandSchema } from './process.js';
import { filePath } from './file-path.js';

const ref = z.string().min(1).max(160);
const text = z.string().min(1).max(1000);
export const taskCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file_hash'),
      mountId: ref,
      path: filePath,
      expectedHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('command_exit'),
      command: z.discriminatedUnion('name', [
        z.object({ name: z.literal('run_command'), args: directCommandSchema }).strict(),
        z.object({ name: z.literal('run_shell'), args: shellCommandSchema }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('delivery'), changeSetId: ref }).strict(),
  z
    .object({
      kind: z.literal('export_receipt'),
      items: z
        .array(
          z
            .object({
              target: z.string().min(1).max(4096),
              expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z.object({ kind: z.literal('document_open'), mountId: ref, path: filePath }).strict(),
  z.object({ kind: z.literal('review') }).strict(),
]);
const criterion = z
  .object({ id: ref, description: text, check: taskCheckSchema })
  .strict();
const progress = z
  .object({
    criterionId: ref,
    status: z.enum(['pending', 'in_progress', 'blocked', 'needs_review', 'verified']),
    reason: z.string().max(1000).default(''),
    evidenceExecutionId: ref.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'verified' && !value.evidenceExecutionId)
      ctx.addIssue({ code: 'custom', message: '已核验状态必须提供真实工具执行身份' });
    if (value.status !== 'verified' && value.evidenceExecutionId)
      ctx.addIssue({ code: 'custom', message: '证据只绑定已核验状态' });
    if (['blocked', 'needs_review'].includes(value.status) && !value.reason.trim())
      ctx.addIssue({ code: 'custom', message: '阻塞或待审必须说明原因' });
  });
export const taskStateInputSchema = z.object({
  taskId: ref, baseVersion: z.number().int().positive(),
  state: z.enum(['active', 'suspended', 'cancelled']),
  source: z.object({ messageId: ref, quote: text }).strict(),
}).strict();
export type TaskStateInput = z.infer<typeof taskStateInputSchema>;
export const taskCheckpointInputSchema = z
  .object({
    taskId: ref.optional(),
    baseVersion: z.number().int().nonnegative().default(0),
    supersedesTaskId: ref.optional(),
    goal: text,
    source: z.object({ messageId: ref, quote: text }).strict(),
    acknowledgedInputId: ref,
    criteria: z.array(criterion).min(1).max(12),
    progress: z.array(progress).min(1).max(12),
    nextAction: z.string().max(1000).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.criteria.map((item) => item.id);
    const statuses = value.progress.map((item) => item.criterionId);
    if (
      new Set(ids).size !== ids.length ||
      new Set(statuses).size !== statuses.length ||
      ids.length !== statuses.length ||
      statuses.some((item) => !ids.includes(item))
    )
      ctx.addIssue({ code: 'custom', message: '验收项身份唯一，进度必须完整对应每一项' });
    if (!value.taskId && value.baseVersion !== 0)
      ctx.addIssue({ code: 'custom', message: '新任务版本必须从零开始' });
  });
export type TaskCheck = z.infer<typeof taskCheckSchema>;
export type TaskCheckpointInput = z.infer<typeof taskCheckpointInputSchema>;
export type TaskCheckpoint = {
  taskId: string;
  version: number;
  executionId: string;
  runId: string;
  environmentRevision: number;
  input: TaskCheckpointInput;
};
export type TaskAssessment = {
  taskId: string;
  version: number;
  goal: string;
  sourceMessageId: string;
  acknowledgedInputId: string;
  status: 'criteria_verified' | 'needs_work' | 'blocked' | 'needs_review';
  lifecycle?: 'active' | 'suspended' | 'cancelled';
  supersedesTaskId?: string;
  progress: TaskCheckpointInput['progress'];
  nextAction: string;
};
export type TaskAcceptance = {
  status: 'untracked' | 'criteria_verified' | 'needs_work' | 'blocked' | 'needs_review';
  latestInputId: string | null;
  tasks: TaskAssessment[];
  authority: string;
};
