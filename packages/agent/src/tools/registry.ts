import { hash } from '../identity.js';
import { z } from 'zod';
import type { Environment, PersistencePort, ToolResult } from '../persistence.js';
import type { ExecutionContext, ToolSpec } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodType;
  effect:
    | 'read'
    | 'memory'
    | 'scratch-write'
    | 'network'
    | 'copy-write'
    | 'resource'
    | 'source-write'
    | 'host-code';
  prepare: (args: unknown, env: Environment, executionId?: string) => ExecutionContext;
  approvalRequired?: (args: unknown, context: ExecutionContext) => boolean;
  approvalDescription?: (args: unknown, context: ExecutionContext) => string;
  denied?: (args: unknown, context: ExecutionContext) => void;
  executionTimeoutMs?: (args: unknown) => number | null;
  approvalPollMs?: number;
  execute: (
    args: unknown,
    context: ExecutionContext,
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  // 对已派发读取的纯观察入口；不同于重新执行读取/重新创建快照。
  inspect?: (args: unknown, context: ExecutionContext, conversationId: string, signal: AbortSignal, executionId: string) => Promise<ToolResult>;
  reconcile?: (
    args: unknown,
    context: ExecutionContext,
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
};
// 准备失败的可操作诊断随工具结果保存，不因此产生副作用。
export class ToolPreparationError extends UmiError {
  constructor(code: string, message: string, readonly details: Record<string, unknown>) { super(code, message); }
}
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition) {
    this.registerMany([tool]);
  }
  entries(): readonly ToolDefinition[] {
    return [...this.definitions.values()];
  }
  registerMany(tools: readonly ToolDefinition[]) {
    const names = new Set(this.definitions.keys());
    for (const tool of tools) {
      if (names.has(tool.name))
        throw new UmiError('PROTOCOL_INVALID', '工具注册名称重复');
      names.add(tool.name);
    }
    for (const tool of tools) this.definitions.set(tool.name, tool);
  }
  get(name: string): ToolDefinition {
    const t = this.definitions.get(name);
    if (!t) throw new UmiError('UNKNOWN_TOOL', '请求了未注册工具');
    return t;
  }
  specs(): ToolSpec[] {
    return [...this.definitions.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        // 模型需要输入规格：默认值并非必填，转换后的输出也不是参数根。
        parameters: z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>,
      }));
  }
  parse(name: string, args: string): unknown {
    let value: unknown;
    try {
      value = JSON.parse(args);
    } catch {
      throw new UmiError('TOOL_ARGUMENTS_INVALID', '工具参数 JSON 不完整或不合法');
    }
    const r = this.get(name).schema.safeParse(value);
    if (!r.success)
      throw new UmiError('TOOL_ARGUMENTS_INVALID', '工具参数不符合已注册规格');
    return r.data;
  }
}
export function registerHistory(
  registry: ToolRegistry,
  store: PersistencePort,
  prepare: (args: unknown, env: Environment) => ExecutionContext,
) {
  const search = z
    .object({
      query: z.string().min(1).max(1000),
      role: z.enum(['user', 'assistant', 'all']).default('user'),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict();
  const read = z
    .object({
      messageId: z.string().min(1),
      startByte: z.number().int().nonnegative().default(0),
      byteLength: z.number().int().min(1).max(64000).default(8192),
    })
    .strict();
  registry.register({
    name: 'search_history',
    description:
      '按原文和 UTC 时间搜索当前会话历史。结果保留消息 ID 与来源；旧要求不自动替代用户最新更正。',
    schema: search,
    effect: 'read',
    prepare,
    async execute(input, _context, conversationId, signal) {
      signal.throwIfAborted();
      const a = search.parse(input);
      const found = store.searchMessages(conversationId, {
          query: a.query,
          role: a.role,
          limit: a.limit,
          ...(a.from ? { from: a.from } : {}),
          ...(a.to ? { to: a.to } : {}),
        }),
        rows = found.rows;
      const matches = rows.slice(0, a.limit).map((m) => {
        const index = m.payload.content.indexOf(a.query);
        let start = Math.max(0, index - 300),
          end = Math.min(m.payload.content.length, index + a.query.length + 1000);
        // UTF-16 切片不能切开代理对，否则字节范围不能回到原始 UTF-8 内容。
        if (start && /[\uDC00-\uDFFF]/.test(m.payload.content[start]!)) start--;
        if (
          end < m.payload.content.length &&
          /[\uDC00-\uDFFF]/.test(m.payload.content[end]!)
        )
          end++;
        return {
          messageId: m.id,
          role: m.role,
          createdAt: m.createdAt,
          encoding: 'utf-8',
          startByte: Buffer.byteLength(m.payload.content.slice(0, start)),
          endByte: Buffer.byteLength(m.payload.content.slice(0, end)),
          text: m.payload.content.slice(start, end),
          totalBytes: Buffer.byteLength(m.payload.content),
        };
      });
      return {
        outcome: 'succeeded',
        content: JSON.stringify({
          matches,
          totalMatches: found.total,
          truncated: found.total > a.limit,
        }),
        data: { matches, totalMatches: found.total, truncated: found.total > a.limit },
      };
    },
    async reconcile(input, ctx, conversationId, signal) {
      return this.execute(input, ctx, conversationId, signal);
    },
  });
  registry.register({
    name: 'read_history',
    description: '读取当前会话指定消息的原文 UTF-8 字节范围；不能访问其他会话。',
    schema: read,
    effect: 'read',
    prepare,
    async execute(input, _context, conversationId, signal) {
      signal.throwIfAborted();
      const a = read.parse(input),
        m = store.messageById(conversationId, a.messageId);
      if (!m) throw new UmiError('PERMISSION_DENIED', '原消息不属于当前会话或不存在');
      const buffer = Buffer.from(m.payload.content),
        start = Math.min(a.startByte, buffer.length);
      let end = Math.min(start + a.byteLength, buffer.length);
      while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
      if (start < buffer.length && (buffer[start]! & 0xc0) === 0x80)
        throw new UmiError('PROTOCOL_INVALID', '读取起点切开 UTF-8 字符');
      const data = {
        messageId: m.id,
        sourceHash: hash(m.payload),
        role: m.role,
        createdAt: m.createdAt,
        startByte: start,
        endByte: end,
        nextStartByte: end < buffer.length ? end : null,
        totalBytes: buffer.length,
        truncated: end < buffer.length,
        text: buffer.subarray(start, end).toString('utf8'),
      };
      return { outcome: 'succeeded', content: '', data };
    },
    async reconcile(input, ctx, conversationId, signal) {
      return this.execute(input, ctx, conversationId, signal);
    },
  });
}
