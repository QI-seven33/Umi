import { outputSnapshotSchema } from './outputs.js';
import { executionPlanSchema } from './execution.js';
import { z } from 'zod';
import { fileWriteSnapshotSchema } from './file-write.js';
import { fileEditSnapshotSchema } from './file-edit.js';
import { resourceScopeSchema } from './resource-scope.js';
import { processSnapshotSchema } from './process.js';

export class UmiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'UmiError';
  }
}
export const id = z.string().min(1).max(160);
export const settingsSchema = z
  .object({
    contextWindow: z.number().int().min(4096).max(1_000_000).optional(),
    model: z.enum(['deepseek-flash', 'deepseek-v4-pro']).default('deepseek-flash'),
    thinking: z.enum(['off', 'normal', 'high']).default('off'),
    executionPolicy: z.enum(['ask', 'auto']).default('ask'),
    uiLocale: z.enum(['zh-CN', 'en']).default('zh-CN'),
    answerLocale: z.enum(['zh-CN', 'en']).default('zh-CN'),
    reasoningLocale: z.enum(['zh-CN', 'en']).default('zh-CN'),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const callSchema = z
  .object({
    id,
    type: z.literal('function'),
    function: z.object({ name: id, arguments: z.string() }).strict(),
  })
  .strict();
export type ProviderCall = z.infer<typeof callSchema>;
export const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    images: z
      .array(
        z
          .object({
            mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
            dataUrl: z
              .string()
              .max(1_400_000)
              .regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(callSchema).optional(),
    tool_call_id: id.optional(),
  })
  .strict()
  .superRefine((m, c) => {
    if (m.images && m.role !== 'user')
      c.addIssue({ code: 'custom', message: '图片只能属于用户消息' });
    if (m.role === 'tool' && !m.tool_call_id)
      c.addIssue({ code: 'custom', message: '工具消息缺少配对身份' });
    if (
      m.role !== 'assistant' &&
      (m.reasoning_content !== undefined || m.tool_calls !== undefined)
    )
      c.addIssue({ code: 'custom', message: '仅模型响应可携带思考或工具调用' });
  });
export type WireMessage = z.infer<typeof messageSchema>;
export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'recovering'
  | 'recovery_required'
  | 'completed'
  | 'failed';
export type Phase = 'execute' | 'waiting' | 'finalize';
export const outcomeSchema = z.enum([
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'unknown',
]);
export type ToolOutcome = z.infer<typeof outcomeSchema>;

const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.includes(':') &&
      !p.startsWith('/') &&
      !p.includes('\0') &&
      !p.split('/').some((x) => x === '..' || x === '.' || x === ''),
    '路径必须相对于获准根，使用正斜线，禁止穿越和特殊路径',
  );
const rootRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('export'), executionId: id }).strict(),
  z
    .object({
      kind: z.literal('task'),
      area: z.enum(['scratch', 'artifacts', 'research', 'logs']),
      bindingVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mount'),
      mountId: id,
      area: z.enum(['working', 'baseline']),
      bindingVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('source'),
      resourceId: id,
      bindingVersion: z.number().int().positive(),
    })
    .strict(),
]);
export const locationSchema = z
  .object({
    schemaVersion: z.literal(1),
    environmentId: id,
    rootRef,
    relativePath: relative,
    beforeHash: z.string().nullable(),
    desiredHash: z.string().nullable(),
    physicalRoot: z.string().optional(),
    physicalRootIdentity: id.optional(),
    beforeIdentity: id.nullable().optional(),
  })
  .strict();
export const executionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: id,
    environmentId: id,
    environmentRevision: z.number().int().nonnegative(),
    bindingRoot: z.string(),
    rootIdentity: z.string(),
    locations: z.array(locationSchema),
    resourceScope: resourceScopeSchema.optional(),
    process: processSnapshotSchema.optional(),
    execution: executionPlanSchema.optional(),
    memoryExecutionId: id.optional(),
    interactionExecutionId: id.optional(),
    inspectionExecutionId: id.optional(),
    fileReadExecutionId: id.optional(),
    fileEdit: fileEditSnapshotSchema.optional(),
    fileWrite: fileWriteSnapshotSchema.optional(),
    output: outputSnapshotSchema.optional(),
  })
  .strict();
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export const cursorSchema = z
  .object({ streamId: id, logEpoch: id, sequence: z.string().regex(/^(0|[1-9]\d*)$/) })
  .strict();
export type Cursor = z.infer<typeof cursorSchema>;
export function validatePairs(messages: WireMessage[]): void {
  let pending = new Set<string>();
  for (const m of messages) {
    messageSchema.parse(m);
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id!))
        throw new UmiError('PROTOCOL_INVALID', '工具结果没有唯一的对应调用');
    } else {
      if (pending.size) throw new UmiError('PROTOCOL_INVALID', '工具消息组尚未完整结算');
      if (m.role === 'assistant') {
        const ids = (m.tool_calls ?? []).map((c) => c.id);
        if (new Set(ids).size !== ids.length)
          throw new UmiError('PROTOCOL_INVALID', '模型工具身份重复');
        pending = new Set(ids);
      }
    }
  }
  if (pending.size) throw new UmiError('PROTOCOL_INVALID', '未结算工具组不能发送模型');
}
