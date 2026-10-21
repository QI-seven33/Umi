import { z } from 'zod';
import { filePath } from './file-path.js';

const id = z.string().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;
export const MAX_REPLACEMENT_BYTES = 64000;

const singleEditSchema = z
  .object({
    mountId: id,
    path: filePath,
    readExecutionId: id.optional(),
    expectedReadHash: digest.optional(),
    oldText: z.string().min(1).max(MAX_REPLACEMENT_BYTES),
    newText: z.string().max(MAX_REPLACEMENT_BYTES),
  })
  .strict();
// 旧单项参数保持兼容；批量参数针对同一个原版本，不能混用两种形态。
export type EditFileArgs = z.infer<typeof singleEditSchema>;
const editItemSchema = z.object({ oldText: z.string().min(1).max(MAX_REPLACEMENT_BYTES), newText: z.string().max(MAX_REPLACEMENT_BYTES) }).strict();
const batchEditSchema = z.object({
  mountId: id, path: filePath, expectedReadHash: digest.optional(),
  readExecutionIds: z.array(id).min(1).max(64).refine(ids => new Set(ids).size === ids.length, '读取回执不能重复').optional(),
  edits: z.array(editItemSchema).min(1).max(32),
}).strict();
// 模型端是一个参数对象；执行端继续严格区分单项/批量，禁止混用或缺项。
// 复用两种形态的字段，避免维护另一份漂移的模型规格。Registry 导出 input schema。
export const editFileSchema = z.object({
  ...singleEditSchema.partial().shape,
  ...batchEditSchema.partial().shape,
}).strict().required({ mountId: true, path: true })
  .transform((value, ctx) => {
    // 独立解析两种形态。当前 Zod 的 object.pipe(union) 会丢弃入口 strict 错误，
    // transform 保留入口检查，同时把输出准确收窄为单项或批量参数。
    const parsed = (value.edits !== undefined ? batchEditSchema : singleEditSchema).safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      return z.NEVER;
    }
    return parsed.data;
  }).meta({oneOf:[
    {required:['oldText','newText'],not:{anyOf:[{required:['edits']},{required:['readExecutionIds']}]}},
    {required:['edits'],not:{anyOf:[{required:['oldText']},{required:['newText']},{required:['readExecutionId']}]}}
  ]});
export type EditFileInput = z.infer<typeof editFileSchema>;

// 仅成功的 read_file 工具回执可作为编辑来源；stat/preview/search 不代替读取。
export const textFileReadReceiptSchema = z
  .object({
    readExecutionId: id,
    mountId: id,
    path: filePath,
    kind: z.literal('text'),
    encoding: z.literal('utf-8'),
    hash: digest,
    identity: id,
    size: z.number().int().min(0).max(MAX_EDIT_BYTES),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
    nextStartByte: z.number().int().nonnegative().nullable().optional(),
    truncated: z.boolean(),
    text: z.string().max(64000),
    lineSelection: z.object({ startLine: z.number().int().positive(), lineCount: z.number().int().positive(), rangeComplete: z.boolean() }).strict().optional(),
  })
  .strict()
  .refine((r) => r.startByte <= r.endByte && r.endByte <= r.size, '读取范围无效');
export type TextFileReadReceipt = z.infer<typeof textFileReadReceiptSchema>;

// 宿主内部的修改后已见范围：原文范围随编辑平移，新片段由模型提供；不是新读取或批准。
const knownRanges = z.array(z.object({startByte:z.number().int().nonnegative(),endByte:z.number().int().nonnegative()}).strict()).max(64).optional();
const singleEditSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    knownRanges,
    executionId: id,
    readExecutionId: id,
    readResultRef: id,
    startByte: z.number().int().nonnegative(),
    oldByteLength: z.number().int().positive().max(MAX_REPLACEMENT_BYTES),
    newByteLength: z.number().int().nonnegative().max(MAX_REPLACEMENT_BYTES),
    noOp: z.boolean(),
  })
  .strict();

export const fileEditSnapshotSchema = z.discriminatedUnion('schemaVersion', [singleEditSnapshotSchema, z.object({
  schemaVersion: z.literal(2), executionId: id, knownRanges,
  reads: z.array(z.object({ readExecutionId: id, readResultRef: id }).strict()).min(1).max(64),
  edits: z.array(z.object({ index: z.number().int().nonnegative(), startByte: z.number().int().nonnegative(), oldByteLength: z.number().int().positive().max(MAX_REPLACEMENT_BYTES), newByteLength: z.number().int().nonnegative().max(MAX_REPLACEMENT_BYTES) }).strict()).min(1).max(32),
  noOp: z.boolean(),
}).strict()]);
