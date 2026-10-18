import { DATABASE_VERSION } from './database.js';
import { answersSchema } from './question.js';
import { listOutputsSchema } from './outputs.js';
import { z } from 'zod';
import { id, cursorSchema, settingsSchema } from './model.js';
import { filePath } from './resources.js';

const conversation = { conversationId: id };
const range = {
  startByte: z.number().int().nonnegative().default(0),
  byteLength: z.number().int().min(1).max(64000).default(8192),
};
// 渲染器不能请求任意程序、SQL 或宿主绝对路径；create 仅接收主进程签发的选择证据。
export const desktopCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list'), archived: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('restore'), ...conversation }).strict(),
  z.object({ type: z.literal('delete_conversation'), ...conversation, confirm: z.literal(true) }).strict(),
  z
    .object({ type: z.literal('approval_detail'), ...conversation, approvalId: id })
    .strict(),
  z.object({ type: z.literal('create'), selectionId: id }).strict(),
  z.object({ type: z.literal('new_conversation'), ...conversation }).strict(),
  z.object({ type: z.literal('tool_detail'), ...conversation, callId: id, summaryOnly: z.boolean().optional(), startByte: z.number().int().nonnegative().optional(), byteLength: z.number().int().min(1).max(64000).optional() }).strict(),
  z.object({ type: z.literal('snapshot'), ...conversation }).strict(),
  z.object({ type: z.literal('events'), ...conversation, cursor: cursorSchema }).strict(),
  z
    .object({
      type: z.literal('send'),
      ...conversation,
      commandId: id,
      text: z.string().min(1).max(2_000_000),
      attachmentIds: z.array(id).max(8).default([]),
    })
    .strict(),
  z.object({ type: z.literal('receipt'), ...conversation, commandId: id }).strict(),
  z
    .object({ type: z.literal('settings'), ...conversation, settings: settingsSchema })
    .strict(),
  z
    .object({
      type: z.literal('approve'),
      ...conversation,
      approvalId: id,
      decision: z.enum(['allow', 'deny']),
    })
    .strict(),
  z.object({ type: z.literal('answer_question'), ...conversation, questionId: id, answers: answersSchema }).strict(),
  z.object({ type: z.literal('stop'), ...conversation, runId: id }).strict(),
  z.object({ type: z.literal('resume'), ...conversation, runId: id }).strict(),
  z.object({ type: z.literal('recovery'), ...conversation, runId: id }).strict(),
  z
    .object({
      type: z.literal('rename'),
      ...conversation,
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  listOutputsSchema.extend({ type: z.literal('list_outputs'), ...conversation }),
  z
    .object({
      type: z.literal('preview_output'),
      ...conversation,
      outputId: id,
      ...range,
    })
    .strict(),
  z
    .object({ type: z.literal('inspect_export'), ...conversation, executionId: id })
    .strict(),
  z
    .object({
      type: z.literal('open_export'),
      ...conversation,
      executionId: id,
      index: z.number().int().min(0).max(19),
    })
    .strict(),
  z.object({ type: z.literal('preview_change_file'), ...conversation, changeSetId: id, path: filePath,
    side: z.enum(['before', 'after', 'diff']), ...range }).strict(),
  z.object({ type: z.literal('open_delivered'), ...conversation, changeSetId: id, path: filePath }).strict(),
  z.object({ type: z.literal('archive'), ...conversation }).strict(),
  z
    .object({
      type: z.literal('preview_file'),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      ...conversation,
      mountId: id,
      path: filePath,
      ...range,
    })
    .strict(),
  z
    .object({
      type: z.literal('open_file'),
      ...conversation,
      mountId: id,
      path: filePath,
    })
    .strict(),
  z
    .object({ type: z.literal('preview_changeset'), ...conversation, changeSetId: id })
    .strict(),
  z
    .object({
      type: z.literal('upload_attachment'),
      ...conversation,
      name: z.string().min(1).max(180),
      mime: z.enum(['text/plain', 'text/markdown', 'application/json', 'text/csv']),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('upload_image'),
      ...conversation,
      name: z.string().min(1).max(180),
      base64: z.string().min(1).max(1_333_336),
    })
    .strict(),
  z
    .object({ type: z.literal('preview_attachment'), ...conversation, attachmentId: id, ...range })
    .strict(),
  z
    .object({
      type: z.literal('read_attachment'),
      ...conversation,
      attachmentId: id,
      ...range,
    })
    .strict(),
]);
export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export type DesktopInput = z.input<typeof desktopCommandSchema>;
export const ipcRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    correlationId: id,
    instanceId: id,
    payload: desktopCommandSchema,
  })
  .strict();
export const readySchema = z
  .object({
    protocolVersion: z.literal(1),
    instanceId: id,
    databaseVersion: z.literal(DATABASE_VERSION),
    name: z.literal('Umi'),
    node: z.string(),
    sqlite: z.boolean(),
    modelConfigured: z.boolean(),
    osSandbox: z.literal(false),
  })
  .strict();
export const ipcResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['ack', 'result']),
      instanceId: id,
      correlationId: id,
      payload: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      instanceId: id,
      correlationId: id,
      code: z.string().max(120),
      message: z.string().max(4096),
    })
    .strict(),
]);
export const bootErrorSchema = z
  .object({
    kind: z.literal('boot_error'),
    code: z.string().max(120),
    message: z.string().max(4096),
  })
  .strict();
export const desktopConfigSchema = z
  .object({
    apiKey: z.string().max(512).optional(),
    baseUrl: z.string().url().default('https://api.deepseek.com'),
    docker: z
      .object({
        enabled: z.boolean(),
        image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,150}$/),
      })
      .strict()
      .default({ enabled: false, image: 'node:24' }),
    wsl: z
      .object({
        enabled: z.boolean(),
        distribution: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,100}$/),
      })
      .strict()
      .default({ enabled: false, distribution: 'Ubuntu' }),
  })
  .strict();
export type DesktopConfig = z.infer<typeof desktopConfigSchema>;
export type DesktopBridge = {
  request: (command: DesktopInput) => Promise<unknown>;
  setTheme: (
    theme: 'light' | 'dark' | 'system',
  ) => Promise<{ material: 'mica' | 'solid' }>;
  chooseWorkspace: () => Promise<{ selectionId: string; name: string } | null>;
  chooseOutputTarget: (
    conversationId: string,
    outputId: string,
  ) => Promise<{ target: string } | null>;
  status: () => Promise<z.infer<typeof readySchema>>;
  config: () => Promise<{
    baseUrl: string;
    hasKey: boolean;
    docker: DesktopConfig['docker'];
    wsl: DesktopConfig['wsl'];
  }>;
  configure: (config: DesktopConfig) => Promise<void>;
  checkPlugin: (
    plugin: 'docker' | 'wsl',
  ) => Promise<{ available: boolean; message: string }>;
  openUrl: (url: string) => Promise<void>;
};
