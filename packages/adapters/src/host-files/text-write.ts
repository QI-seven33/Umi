import { readFileSync } from 'node:fs';
import { hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import {
  writeFileSchema,
  fileWriteSnapshotSchema,
} from '../../../protocol/src/file-write.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import type { FileReadEvidencePort } from './read-evidence.js';
import { requireTextRead } from './read-evidence.js';
import {
  createExclusive,
  atomicWrite,
  bytesHash,
  observe,
  safeFile,
  sameEntry,
} from './paths.js';
import type { ResourceFiles } from './resources.js';

function textBytes(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  if (content.includes('\0') || bytes.toString('utf8') !== content)
    throw new UmiError(
      'UNSUPPORTED_ENCODING',
      '文本写入拒绝 NUL 或不完整 Unicode；当前工具只处理 UTF-8 文本',
    );
  return bytes;
}
export class FileWriteTools {
  constructor(
    private readonly files: ResourceFiles,
    private readonly reads: FileReadEvidencePort,
  ) {}
  prepare(input: unknown, env: Environment, executionId?: string): ExecutionContext {
    const a = writeFileSchema.parse(input),
      bytes = textBytes(a.content);
    const ctx = this.files.mountContext(
      input,
      env,
      a.mountId,
      a.path,
      bytesHash(bytes),
      true,
    );
    const loc = ctx.locations[0]!;
    if (!executionId) throw new UmiError('PROTOCOL_INVALID', '文本写入缺少原执行身份');
    let readExecutionId: string | undefined, readResultRef: string | undefined;
    if (a.mode === 'create') {
      if (loc.beforeHash !== null)
        throw new UmiError(
          'FILE_EXISTS',
          '目标已存在；新建不会覆盖，请完整读取后显式 replace 或局部 edit_file',
        );
    } else {
      const bound = requireTextRead(
        this.reads,
        {
          mountId: a.mountId,
          path: a.path,
          readExecutionId: a.readExecutionId!,
          expectedReadHash: a.expectedReadHash!,
        },
        env.id,
        this.files.repo.scope(env.id).conversationId,
      );
      const r = bound.receipt;
      if (r.startByte !== 0 || r.endByte !== r.size || r.truncated)
        throw new UmiError(
          'FULL_READ_REQUIRED',
          '整文件替换需要完整读取；大于单次读取预算时请使用 edit_file',
        );
      if (loc.beforeHash !== r.hash || loc.beforeIdentity !== r.identity)
        throw new UmiError('READ_STALE', '读后内容或对象身份已变化，请重新读取');
      const m = this.files.repo.mount(a.mountId, env.id);
      const current = readFileSync(safeFile(m.root, a.path, m.rootIdentity));
      if (bytesHash(current) !== r.hash || !current.equals(Buffer.from(r.text)))
        throw new UmiError('READ_STALE', '准备期间读取版本变化或回执字节不完整');
      readExecutionId = a.readExecutionId;
      readResultRef = bound.resultRef;
    }
    return {
      ...ctx,
      fileWrite: {
        schemaVersion: 1,
        executionId,
        mode: a.mode,
        noOp: loc.beforeHash === loc.desiredHash,
        ...(readExecutionId ? { readExecutionId, readResultRef: readResultRef! } : {}),
      },
    };
  }
  async execute(
    input: unknown,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted)
      return {
        outcome: 'cancelled',
        mutated: false,
        content: '写入在落盘前取消。',
        data: null,
      };
    const a = writeFileSchema.parse(input),
      plan = fileWriteSnapshotSchema.parse(ctx.fileWrite),
      loc = ctx.locations[0]!;
    const env = this.files.repo.store.environment(ctx.environmentId);
    let fresh;
    try {
      fresh = this.prepare(a, env, plan.executionId);
    } catch (e) {
      return {
        outcome: 'failed',
        mutated: false,
        content: e instanceof Error ? e.message : '落盘前核验失败',
        data: { code: e instanceof UmiError ? e.code : 'PRECONDITION_FAILED' },
      };
    }
    if (hash(fresh) !== hash(ctx))
      return {
        outcome: 'failed',
        mutated: false,
        content: '派发后写入定位变化，未落盘',
        data: null,
      };
    const m = this.files.repo.mount(a.mountId, env.id),
      before = observe(m.root, a.path, m.rootIdentity);
    if (
      (before?.hash ?? null) !== loc.beforeHash ||
      (before?.identity ?? null) !== loc.beforeIdentity
    )
      return {
        outcome: 'failed',
        mutated: false,
        content: '落盘前目标变化，未写入',
        data: null,
      };
    if (signal.aborted)
      return {
        outcome: 'cancelled',
        mutated: false,
        content: '写入在落盘前取消。',
        data: null,
      };
    if (!plan.noOp) {
      if (plan.mode === 'create') {
        try {
          createExclusive(m.root, a.path, textBytes(a.content), m.rootIdentity);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST')
            return {
              outcome: 'failed',
              mutated: false,
              content: '目标在新建前出现，未覆盖。',
              data: { code: 'FILE_EXISTS' },
            };
          throw e;
        }
      } else
        atomicWrite(
          m.root,
          a.path,
          textBytes(a.content),
          m.rootIdentity,
          undefined,
          before,
        );
    }
    const after = observe(m.root, a.path, m.rootIdentity);
    if (
      !after ||
      after.hash !== loc.desiredHash ||
      (plan.noOp && !sameEntry(before, after))
    )
      throw new UmiError('RESOURCE_CHANGED', '文本写入后回读失败');
    return {
      outcome: 'succeeded',
      mutated: !plan.noOp,
      verification: plan.noOp ? 'no-op-current-read-verified' : 'written-bytes-verified',
      content: plan.noOp
        ? '内容相同，未落盘。'
        : '工作副本文本已写入并回读核验；源文件交付仍需独立批准。',
      data: {
        mountId: m.id,
        path: a.path,
        mode: plan.mode,
        observed: after,
        noOp: plan.noOp,
      },
    };
  }
  async reconcile(
    input: unknown,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const a = writeFileSchema.parse(input),
      m = this.files.repo.mount(a.mountId, ctx.environmentId),
      loc = ctx.locations[0]!;
    this.files.assertPath(m.scope, a.path);
    if (
      loc.rootRef.kind !== 'mount' ||
      loc.rootRef.mountId !== m.id ||
      loc.relativePath !== a.path ||
      loc.physicalRoot !== m.root ||
      loc.physicalRootIdentity !== m.rootIdentity ||
      loc.rootRef.bindingVersion !== m.bindingVersion
    )
      throw new UmiError('RESOURCE_CHANGED', '原文本写入定位无法对应当前挂载');
    // 旧已派发 write_file 没有 fileWrite：只观察原冻结哈希，不通过新契约再次执行。
    const noOp = ctx.fileWrite?.noOp ?? false;
    const after = observe(m.root, a.path, m.rootIdentity);
    if (
      after?.hash === loc.desiredHash &&
      (!noOp || after.identity === loc.beforeIdentity)
    )
      return {
        outcome: 'succeeded',
        mutated: !noOp,
        verification: 'desired-state-verified',
        content: '原目标符合冻结字节；未再次写入，不断言原执行来源。',
        data: { mountId: m.id, path: a.path, observed: after },
      };
    if (
      (after?.hash ?? null) === loc.beforeHash &&
      (after?.identity ?? null) === loc.beforeIdentity
    )
      return {
        outcome: 'failed',
        mutated: false,
        verification: 'original-state-verified',
        content: '原目标仍为写入前状态；未再次操作。',
        data: { observed: after },
      };
    return {
      outcome: 'unknown',
      mutated: false,
      verification: 'unknown',
      content: '原写入结果无法核验；未再次操作。',
      data: { observed: after },
    };
  }
}
export function registerTextWrite(
  registry: ToolRegistry,
  files: ResourceFiles,
  reads: FileReadEvidencePort,
) {
  const writes = new FileWriteTools(files, reads);
  registry.register({
    name: 'write_file',
    description:
      '写 UTF-8 工作副本文本。mode=create（默认）只新建，存在时拒绝；mode=replace 必须先完整 read_file 并绑定 readExecutionId/expectedReadHash。部分修改用 edit_file；新建可创建父目录。无变化不写；源交付独立批准。',
    schema: writeFileSchema,
    effect: 'copy-write',
    prepare: (a, env, id) => writes.prepare(a, env, id),
    execute: (a, ctx, _c, s) => writes.execute(a, ctx, s),
    reconcile: (a, ctx, _c, s) => writes.reconcile(a, ctx, s),
  });
}
