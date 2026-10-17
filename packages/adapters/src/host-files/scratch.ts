import {
  lstatSync,
  statSync,
  realpathSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { z } from 'zod';
import { hash, uid } from '../../../agent/src/identity.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';

function identity(path: string) {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}`;
}
export function hostContext(_args: unknown, env: Environment): ExecutionContext {
  if (
    lstatSync(env.root).isSymbolicLink() ||
    realpathSync(env.root) !== env.root ||
    identity(env.root) !== env.root_identity
  )
    throw new UmiError('RESOURCE_CHANGED', '环境根身份已变化');
  return {
    schemaVersion: 1,
    runtimeId: 'host-structured-files',
    environmentId: env.id,
    environmentRevision: env.revision,
    bindingRoot: env.root,
    rootIdentity: env.root_identity,
    locations: [],
  };
}
function target(context: ExecutionContext, path: string): string {
  executionContextSchema.parse(context);
  if (
    context.runtimeId !== 'host-structured-files' ||
    identity(context.bindingRoot) !== context.rootIdentity ||
    lstatSync(context.bindingRoot).isSymbolicLink()
  )
    throw new UmiError('RESOURCE_CHANGED', '执行时环境根身份不一致');
  const root = join(context.bindingRoot, 'task', 'scratch'),
    destination = resolve(root, ...path.split('/'));
  const rel = relative(root, destination);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new UmiError('PERMISSION_DENIED', '工具路径越过 scratch 根');
  const pieces = ['task', 'scratch', ...path.split('/')];
  let current = context.bindingRoot;
  for (const piece of pieces) {
    current = join(current, piece);
    if (!existsSync(current)) continue;
    const s = lstatSync(current);
    if (
      s.isSymbolicLink() ||
      (!s.isDirectory() && current !== destination) ||
      (s.isFile() && s.nlink > 1)
    )
      throw new UmiError('PERMISSION_DENIED', '工具路径包含链接、硬链接或无效父目录');
  }
  return destination;
}
const schema = z
  .object({
    relativePath: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (p) =>
          !p.includes('\\') &&
          !p.includes(':') &&
          !p.startsWith('/') &&
          p
            .split('/')
            .every(
              (x) =>
                x !== '' &&
                x !== '.' &&
                x !== '..' &&
                !/[<>"|?*\x00-\x1f]/.test(x) &&
                !/[. ]$/.test(x) &&
                !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x),
            ),
        '仅允许 scratch 内普通相对文件名，拒绝穿越、设备名及 Windows 特殊路径',
      ),
    content: z.string().max(64000),
  })
  .strict();
export function registerScratch(registry: ToolRegistry) {
  registry.register({
    name: 'write_scratch',
    description:
      '在托管 scratch 区写入 UTF-8 文本，用于阶段 2 的批准、执行和恢复验证。不会交付到用户项目，需批准。',
    schema,
    effect: 'scratch-write',
    prepare(input, env) {
      const a = schema.parse(input),
        ctx = hostContext(input, env),
        file = target(ctx, a.relativePath);
      return {
        ...ctx,
        locations: [
          {
            schemaVersion: 1,
            environmentId: env.id,
            rootRef: { kind: 'task', area: 'scratch', bindingVersion: 1 },
            relativePath: a.relativePath,
            beforeHash: existsSync(file) ? hash(readFileSync(file, 'utf8')) : null,
            desiredHash: hash(a.content),
          },
        ],
      };
    },
    async execute(input, ctx, _conversationId, signal): Promise<ToolResult> {
      signal.throwIfAborted();
      const a = schema.parse(input),
        location = ctx.locations[0];
      if (
        !location ||
        location.environmentId !== ctx.environmentId ||
        location.rootRef.kind !== 'task' ||
        location.rootRef.area !== 'scratch' ||
        location.rootRef.bindingVersion !== 1 ||
        location.relativePath !== a.relativePath ||
        location.desiredHash !== hash(a.content)
      )
        throw new UmiError('PROTOCOL_INVALID', '文件定位与批准请求不一致');
      const file = target(ctx, a.relativePath),
        before = existsSync(file) ? hash(readFileSync(file, 'utf8')) : null;
      if (before !== location.beforeHash)
        throw new UmiError('RESOURCE_CHANGED', '批准后目标内容已改变');
      mkdirSync(dirname(file), { recursive: true });
      target(ctx, a.relativePath);
      signal.throwIfAborted();
      const temp = join(dirname(file), `.umi-${uid()}.tmp`);
      try {
        writeFileSync(temp, a.content, { encoding: 'utf8', flag: 'wx' });
        renameSync(temp, file);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
      const observedHash = hash(readFileSync(target(ctx, a.relativePath), 'utf8'));
      if (observedHash !== location.desiredHash)
        return {
          outcome: 'unknown',
          content: '写入后内容核验不一致，需要恢复检查',
          data: { observedHash },
        };
      return {
        outcome: 'succeeded',
        content: `托管 scratch 中的 ${a.relativePath} 已写入并核验；用户源目录未修改。`,
        data: {
          environmentId: ctx.environmentId,
          relativePath: a.relativePath,
          observedHash,
          fileIdentity: identity(file),
          observedAt: new Date().toISOString(),
        },
      };
    },
    async reconcile(input, ctx): Promise<ToolResult> {
      const a = schema.parse(input),
        loc = ctx.locations[0];
      if (
        !loc ||
        loc.environmentId !== ctx.environmentId ||
        loc.rootRef.kind !== 'task' ||
        loc.rootRef.area !== 'scratch' ||
        loc.rootRef.bindingVersion !== 1 ||
        loc.relativePath !== a.relativePath ||
        loc.desiredHash !== hash(a.content)
      )
        return {
          outcome: 'unknown',
          content: '旧定位快照不符合当前执行契约',
          data: null,
          verification: 'unknown',
        };
      const file = target(ctx, loc.relativePath),
        observedHash = existsSync(file) ? hash(readFileSync(file, 'utf8')) : null;
      if (observedHash === loc.desiredHash)
        return {
          outcome: 'succeeded',
          content: '原 scratch 目标内容已核验为预期状态；不据此确认中断前操作来源。',
          data: { observedHash, observedAt: new Date().toISOString() },
          verification: 'desired-state-verified',
        };
      return {
        outcome: 'unknown',
        content: '原目标缺失或内容已变化，禁止自动重复写入。',
        data: { observedHash },
        verification: 'unknown',
      };
    },
  });
}
