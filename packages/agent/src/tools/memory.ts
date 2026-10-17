import { z } from 'zod';
import {
  noteInputSchema,
  requirementInputSchema,
  resetInputSchema,
} from '../../../protocol/src/memory.js';
import type { MemoryValue } from '../../../protocol/src/memory.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { PersistencePort, Environment } from '../persistence.js';
import { canonical, hash } from '../identity.js';
import { ordered } from '../context/projection.js';
import { userSourceIndex, PROJECTION_VERSION } from '../context/bounded.js';
import type { ToolRegistry } from './registry.js';
export function registerMemory(
  registry: ToolRegistry,
  store: PersistencePort,
  prepare: (args: unknown, env: Environment) => ExecutionContext,
) {
  for (const definition of [
    {
      name: 'record_work_note',
      kind: 'note' as const,
      schema: noteInputSchema,
      description:
        '保存有来源的任务笔记。observation 必须逐字引用单一来源；判断用 inference。笔记不授予权限或确认执行成功。',
    },
    {
      name: 'record_requirement',
      kind: 'requirement' as const,
      schema: requirementInputSchema,
      description:
        '逐字引用用户原话建立要求候选。supersedes 只记录模型对更早要求的替代建议，不删除或撤销原要求。',
    },
    {
      name: 'request_context_reset',
      kind: 'reset' as const,
      schema: resetInputSchema,
      description:
        '请求安全切换活跃上下文窗口，说明原因和需要保留的来源。系统在完整工具组结算后处理，原历史保留且可检索。',
    },
  ]) {
    registry.register({
      ...definition,
      effect: 'memory',
      prepare(a, env, executionId) {
        if (!executionId) throw new UmiError('PROTOCOL_INVALID', '记忆工具缺少执行身份');
        return { ...prepare(a, env), memoryExecutionId: executionId };
      },
      async execute(a, ctx, _cid, signal) {
        signal.throwIfAborted();
        if (!ctx.memoryExecutionId)
          throw new UmiError('PROTOCOL_INVALID', '记忆执行身份缺失');
        const entry = store.saveMemory(ctx.memoryExecutionId, {
          kind: definition.kind,
          value: a,
        } as MemoryValue);
        const data = {
          entryId: entry.id,
          artifactRef: entry.artifactRef,
          kind: entry.value.kind,
          status: entry.value.kind === 'reset' ? 'requested' : 'recorded',
          authority: '模型记录，不代表权限或执行结果',
        };
        return {
          outcome: 'succeeded',
          content: '',
          data,
          mutated: false,
        };
      },
      async reconcile(a, ctx, cid, signal) {
        return this.execute(a, ctx, cid, signal);
      },
    });
  }
  const requirements = z
    .object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(10).default(5),
      messageId: z.string().min(1).max(160).optional(),
    })
    .strict();
  registry.register({
    name: 'list_user_requirements',
    description:
      '分页读取本会话全部已应用用户原话的定位索引，包括折叠来源。片段非完整要求，read_history 可读完整原文；未展示不代表撤销，不授予权限。',
    schema: requirements,
    effect: 'read',
    prepare,
    async execute(input, _ctx, cid, signal) {
      signal.throwIfAborted();
      const args = requirements.parse(input);
      const rows = ordered(store.messages(cid)).filter(
        (row) => row.payload.role === 'user',
      );
      const page = args.messageId
        ? rows.filter((row) => row.id === args.messageId)
        : rows.slice(args.offset, args.offset + args.limit);
      if (args.messageId && !page.length)
        throw new UmiError('PERMISSION_DENIED', '原话不属于当前会话的已应用输入');
      const retired = new Set(store.contextMemory(cid).archivedIds);
      const data = {
        projectionVersion: PROJECTION_VERSION,
        authority: '原文定位片段；不判断完成、授权或撤销。结合后续更正读取完整原话。',
        entries: page.map((row) => ({
          ...userSourceIndex(row),
          folded: retired.has(row.id),
          attachments: store.messageAttachments(cid, row.id),
        })),
        total: rows.length,
        offset: args.offset,
        nextOffset:
          !args.messageId && args.offset + page.length < rows.length
            ? args.offset + page.length
            : null,
      };
      return { outcome: 'succeeded', content: '', data };
    },
    async reconcile(input, ctx, cid, signal) {
      return this.execute(input, ctx, cid, signal);
    },
  });
  const read = z
    .object({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(10).default(5),
      entryId: z.string().min(1).optional(),
    })
    .strict();
  registry.register({
    name: 'read_work_memory',
    description:
      '分页读取当前会话的模型笔记、要求候选和窗口版本。原始要求仍以用户消息为准。',
    schema: read,
    effect: 'read',
    prepare,
    async execute(a, _ctx, cid, signal) {
      signal.throwIfAborted();
      const args = read.parse(a),
        memory = store.contextMemory(cid),
        entries = args.entryId
          ? memory.entries.filter((e) => e.id === args.entryId)
          : memory.entries.slice(args.offset, args.offset + args.limit);
      if (args.entryId && !entries.length)
        throw new UmiError('PERMISSION_DENIED', '笔记不属于当前会话');
      const data = {
        window: memory.window,
        entries,
        total: memory.entries.length,
        offset: args.offset,
        truncated: !args.entryId && args.offset + entries.length < memory.entries.length,
      };
      return { outcome: 'succeeded', content: '', data };
    },
    async reconcile(a, ctx, cid, signal) {
      return this.execute(a, ctx, cid, signal);
    },
  });
  const artifact = z
    .object({
      artifactId: z.string().min(1).max(160),
      startByte: z.number().int().nonnegative().default(0),
      byteLength: z.number().int().min(1).max(64000).default(8192),
    })
    .strict();
  registry.register({
    name: 'read_artifact',
    description:
      '读取当前会话拥有的工具结果、上下文清单和笔记资料的规范 JSON 字节范围。禁止跨会话读取。',
    schema: artifact,
    effect: 'read',
    prepare,
    async execute(a, _ctx, cid, signal) {
      signal.throwIfAborted();
      const args = artifact.parse(a),
        buffer = Buffer.from(canonical(store.accessibleArtifact(cid, args.artifactId))),
        start = Math.min(args.startByte, buffer.length);
      let end = Math.min(start + args.byteLength, buffer.length);
      if (start < buffer.length && (buffer[start]! & 0xc0) === 0x80)
        throw new UmiError('PROTOCOL_INVALID', '读取起点切开 UTF-8 字符');
      while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
      const data = {
        artifactId: args.artifactId,
        sourceHash: hash(canonical(store.accessibleArtifact(cid, args.artifactId))),
        startByte: start,
        endByte: end,
        nextStartByte: end < buffer.length ? end : null,
        totalBytes: buffer.length,
        truncated: end < buffer.length,
        text: buffer.subarray(start, end).toString('utf8'),
      };
      return { outcome: 'succeeded', content: '', data };
    },
    async reconcile(a, ctx, cid, signal) {
      return this.execute(a, ctx, cid, signal);
    },
  });
}
