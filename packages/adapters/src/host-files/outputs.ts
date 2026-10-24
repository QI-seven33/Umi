import { readFileSync } from 'node:fs';
import { dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import {
  createOutputSchema,
  captureOutputSchema,
  exportOutputsSchema,
  readOutputSchema,
  listOutputsSchema,
  inspectExportSchema,
  outputSnapshotSchema,
} from '../../../protocol/src/outputs.js';
import type {
  OutputDescriptor,
  ExportPlan,
  ExportReceipt,
} from '../../../protocol/src/outputs.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { hash } from '../../../agent/src/identity.js';
import { filePath } from '../../../protocol/src/file-path.js';
import { OutputRepository } from '../sqlite/outputs.js';
import { hostContext } from './scratch.js';
import {
  bytesHash,
  createExclusive,
  observe,
  safeFile,
  safeRoot,
  rootIdentity,
} from './paths.js';

export type OutputBoundary =
  | 'before-intent'
  | 'after-intent'
  | 'after-effect'
  | 'after-receipt';
const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const failure = (message: string) => new UmiError('OUTPUT_INVALID', message);

export class OutputFiles {
  constructor(
    readonly repo: OutputRepository,
    private readonly boundary?: (
      point: OutputBoundary,
      index: number,
    ) => void | Promise<void>,
    private readonly protectTarget: (target:string)=>void = ()=>{},
  ) {}

  private bytes(env: Environment, descriptor: OutputDescriptor) {
    hostContext({}, env);
    const entry = observe(env.root, descriptor.relativePath, env.root_identity);
    if (!entry || entry.hash !== descriptor.hash || entry.size !== descriptor.size)
      throw failure('成果内容已变化或不可核验，请生成新成果');
    const bytes = readFileSync(
      safeFile(env.root, descriptor.relativePath, env.root_identity),
    );
    if (bytesHash(bytes) !== descriptor.hash) throw failure('成果在读取期间变化');
    return bytes;
  }

  descriptor(conversationId: string, outputId: string, verifyBytes = true) {
    const store = this.repo.store,
      tool = store.tool(outputId);
    if (
      !['create_output', 'capture_output'].includes(tool.name) ||
      tool.state !== 'succeeded' ||
      store.getRun(tool.run_id).conversation_id !== conversationId ||
      !tool.context_ref ||
      !tool.result_ref
    )
      throw failure('成果不属于当前会话的成功创建执行');
    const ctx = executionContextSchema.parse(store.readArtifact(tool.context_ref));
    const snapshot = outputSnapshotSchema.parse(ctx.output);
    const result = store.readArtifact<ToolResult>(tool.result_ref);
    if (
      snapshot.kind !== 'create' ||
      snapshot.descriptor.outputId !== tool.id ||
      result.outcome !== 'succeeded' ||
      hash(result.data) !== hash(snapshot.descriptor)
    )
      throw failure('成果执行、定位与回执不一致');
    const env = store.environment(tool.environment_id);
    if (verifyBytes) this.bytes(env, snapshot.descriptor);
    return { env, descriptor: snapshot.descriptor };
  }

  list(conversationId: string, input: unknown) {
    const args = listOutputsSchema.parse(input);
    const cid = this.repo.store.conversation(conversationId);
    const where =
      "environment_id=? AND name IN('create_output','capture_output') AND state='succeeded'";
    const rows = this.repo.store.all(
      'SELECT id FROM tool_executions WHERE ' +
        where +
        ' ORDER BY rowid LIMIT ? OFFSET ?',
      cid.environment_id as string,
      args.limit,
      args.offset,
    );
    const total = this.repo.store.get(
      'SELECT count(*) n FROM tool_executions WHERE ' + where,
      cid.environment_id as string,
    )!.n as number;
    return {
      entries: rows.map(
        (row) => this.descriptor(conversationId, row.id as string, false).descriptor,
      ),
      total,
      offset: args.offset,
      nextOffset: args.offset + rows.length < total ? args.offset + rows.length : null,
      integrity: '仅列冻结元数据；当前字节须 read_output 或导出时核验',
    };
  }

  prepareCreate(
    input: unknown,
    env: Environment,
    executionId: string | undefined,
    capture = false,
  ): ExecutionContext {
    if (!executionId) throw failure('成果创建缺少执行身份');
    const ctx = hostContext(input, env);
    const a = capture
      ? captureOutputSchema.parse(input)
      : createOutputSchema.parse(input);
    let bytes: Buffer, capturePath: string | undefined;
    let source: ReturnType<typeof observe>;
    if ('path' in a) {
      capturePath = `task/artifacts/${a.path}`;
      source = observe(env.root, capturePath, env.root_identity);
      if (!source) throw failure('自有成果目录中不存在该普通文件');
      bytes = readFileSync(safeFile(env.root, capturePath, env.root_identity));
      if (bytesHash(bytes) !== source.hash) throw failure('收录期间文件变化');
    } else {
      bytes = Buffer.from(a.content, 'utf8');
      if (a.content.includes('\0') || bytes.toString('utf8') !== a.content)
        throw failure('文本成果必须为有效 UTF-8；二进制使用 capture_output');
    }
    const descriptor: OutputDescriptor = {
      outputId: executionId,
      name: a.name,
      mime: a.mime,
      hash: bytesHash(bytes),
      size: bytes.length,
      relativePath: `task/artifacts/outputs/${executionId}.bin`,
    };
    if (observe(env.root, descriptor.relativePath, env.root_identity))
      throw failure('原成果位置已存在，不会覆盖');
    return {
      ...ctx,
      output: { kind: 'create', descriptor, ...(capturePath ? { capturePath } : {}) },
      locations: [
        {
          schemaVersion: 1,
          environmentId: env.id,
          rootRef: { kind: 'task', area: 'artifacts', bindingVersion: 1 },
          relativePath: descriptor.relativePath,
          beforeHash: null,
          desiredHash: descriptor.hash,
        },
        ...(capturePath
          ? [
              {
                schemaVersion: 1 as const,
                environmentId: env.id,
                rootRef: {
                  kind: 'task' as const,
                  area: 'artifacts' as const,
                  bindingVersion: 1,
                },
                relativePath: capturePath,
                beforeHash: source!.hash,
                beforeIdentity: source!.identity,
                desiredHash: source!.hash,
              },
            ]
          : []),
      ],
    };
  }

  async create(
    input: unknown,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted)
      return {
        outcome: 'cancelled',
        mutated: false,
        content: '成果创建已取消。',
        data: null,
      };
    const snapshot = outputSnapshotSchema.parse(ctx.output);
    if (snapshot.kind !== 'create') throw failure('不是成果创建上下文');
    const env = this.repo.store.environment(ctx.environmentId);
    const fresh = this.prepareCreate(
      input,
      env,
      snapshot.descriptor.outputId,
      !!snapshot.capturePath,
    );
    if (hash(fresh) !== hash(ctx))
      return {
        outcome: 'failed',
        mutated: false,
        content: '收录对象或成果定位变化，未创建。',
        data: null,
      };
    const bytes = snapshot.capturePath
      ? readFileSync(safeFile(env.root, snapshot.capturePath, env.root_identity))
      : Buffer.from(createOutputSchema.parse(input).content);
    if (bytesHash(bytes) !== snapshot.descriptor.hash)
      return {
        outcome: 'failed',
        mutated: false,
        content: '收录内容变化，未创建。',
        data: null,
      };
    createExclusive(env.root, snapshot.descriptor.relativePath, bytes, env.root_identity);
    this.bytes(env, snapshot.descriptor);
    return {
      outcome: 'succeeded',
      mutated: true,
      verification: 'output-bytes-verified',
      content: '成果已生成并核验；尚未导出到用户目标。',
      data: snapshot.descriptor,
    };
  }

  async recoverCreate(ctx: ExecutionContext): Promise<ToolResult> {
    const snapshot = outputSnapshotSchema.parse(ctx.output);
    if (snapshot.kind !== 'create') throw failure('不是原成果创建');
    const env = this.repo.store.environment(ctx.environmentId);
    hostContext({}, env);
    const entry = observe(env.root, snapshot.descriptor.relativePath, env.root_identity);
    if (!entry)
      return {
        outcome: 'failed',
        mutated: false,
        content: '原成果尚未生成；未再次创建。',
        data: null,
      };
    this.bytes(env, snapshot.descriptor);
    return {
      outcome: 'succeeded',
      mutated: true,
      verification: 'desired-state-verified',
      content: '原成果位置符合冻结字节；只核验，未重建。',
      data: snapshot.descriptor,
    };
  }

  read(conversationId: string, input: unknown) {
    const a = readOutputSchema.parse(input),
      { env, descriptor } = this.descriptor(conversationId, a.outputId);
    const bytes = this.bytes(env, descriptor);
    const start = Math.min(a.startByte, bytes.length);
    let text: string | null = null,
      end = Math.min(start + a.byteLength, bytes.length);
    if (a.representation === 'auto') {
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {}
      if (text?.includes('\0')) text = null;
      if (text !== null) {
        if (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
          throw failure('预览起点切开 UTF-8 字符');
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        text = bytes.subarray(start, end).toString('utf8');
      }
    }
    return {
      ...descriptor,
      kind: text === null ? 'binary' : 'text',
      startByte: start,
      endByte: end,
      truncated: end < bytes.length,
      ...(text !== null
        ? { text }
        : a.representation === 'base64'
          ? { base64: bytes.subarray(start, end).toString('base64') }
          : {
              endByte: start,
              truncated: bytes.length > 0,
              message:
                '二进制成果仅显示元数据；可显式分段读取 base64，尚无办公文档可视化渲染。',
            }),
    };
  }

  prepareExport(
    input: unknown,
    env: Environment,
    executionId?: string,
  ): ExecutionContext {
    if (!executionId) throw failure('导出缺少原执行身份');
    const store = this.repo.store,
      args = exportOutputsSchema.parse(input),
      ctx = hostContext(input, env);
    const conversationId = store.get(
      'SELECT id FROM conversations WHERE environment_id=?',
      env.id,
    )!.id as string;
    const items = args.items.map((a) => {
      const { descriptor, env: original } = this.descriptor(conversationId, a.outputId);
      if (original.id !== env.id) throw failure('成果不属于当前环境');
      const target = resolve(a.target);
      this.protectTarget(target);
      const root = safeRoot(dirname(target)),
        path = basename(target);
      filePath.parse(path);
      const within = relative(store.dataRoot, target);
      if (
        !isAbsolute(within) &&
        within !== '..' &&
        !within.startsWith('..\\') &&
        !within.startsWith('../')
      )
        throw failure('不能把成果导出到 Umi 内部数据目录');
      const identity = rootIdentity(root);
      if (observe(root, path, identity))
        throw failure('导出目标已存在；默认不覆盖，请选择新名称');
      return {
        descriptor,
        target: resolve(root, path),
        root,
        rootIdentity: identity,
        path,
      };
    });
    if (new Set(items.map((i) => key(i.target))).size !== items.length)
      throw failure('导出目标重复或存在大小写冲突');
    if (items.reduce((n, i) => n + i.descriptor.size, 0) > 16 * 1024 * 1024)
      throw failure('单批导出超过 16 MiB');
    const signature = hash(items.map((i) => [key(i.target), i.descriptor.hash]).sort());
    for (const tool of env.active_run_id ? store.tools(env.active_run_id) : []) {
      if (tool.name !== 'export_outputs' || tool.state !== 'denied' || !tool.context_ref)
        continue;
      const previous = executionContextSchema.parse(
        store.readArtifact(tool.context_ref),
      ).output;
      if (
        previous?.kind === 'export' &&
        hash(previous.items.map((i) => [key(i.target), i.descriptor.hash]).sort()) ===
          signature
      )
        throw failure('本次任务的等价导出已被拒绝，不能重建成果重复申请');
    }
    return {
      ...ctx,
      output: { kind: 'export', executionId, items },
      locations: items.map((item) => ({
        schemaVersion: 1,
        environmentId: env.id,
        rootRef: { kind: 'export', executionId },
        relativePath: item.path,
        physicalRoot: item.root,
        physicalRootIdentity: item.rootIdentity,
        beforeHash: null,
        beforeIdentity: null,
        desiredHash: item.descriptor.hash,
      })),
    };
  }

  private plan(ctx: ExecutionContext): ExportPlan {
    const plan = outputSnapshotSchema.parse(ctx.output);
    if (plan.kind !== 'export') throw failure('不是冻结导出上下文');
    const tool = this.repo.store.tool(plan.executionId);
    if (
      tool.environment_id !== ctx.environmentId ||
      tool.name !== 'export_outputs' ||
      !tool.context_ref ||
      hash(this.repo.store.readArtifact(tool.context_ref)) !== hash(ctx)
    )
      throw failure('导出与真实执行上下文不一致');
    return plan;
  }

  private result(plan: ExportPlan, receipts: ExportReceipt[]): ToolResult {
    const unknown = receipts.some((i) => i.status === 'unknown');
    const complete = receipts.every((i) => ['written', 'verified'].includes(i.status));
    return {
      outcome: unknown ? 'unknown' : complete ? 'succeeded' : 'failed',
      mutated: receipts.some((i) =>
        ['written', 'verified', 'unknown'].includes(i.status),
      ),
      verification: unknown ? 'unknown' : 'export-targets-observed',
      content: complete
        ? '全部成果已导出并逐项核验。'
        : '导出未全部完成；请依据逐项目标与回执继续，未自动重试。',
      data: { exportExecutionId: plan.executionId, receipts },
    };
  }

  async export(
    ctx: ExecutionContext,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const plan = this.plan(ctx),
      store = this.repo.store,
      tool = store.tool(plan.executionId);
    const approval = tool.approval_id ? store.approval(tool.approval_id) : undefined;
    if (
      tool.state !== 'dispatched' ||
      !approval?.valid ||
      approval.decision !== 'allow' ||
      approval.request_hash !== hash({ name: tool.name, args: tool.args, context: ctx })
    )
      throw failure('导出必须具有原具体批准和派发事实');
    const receipts: ExportReceipt[] = [];
    for (const [index, item] of plan.items.entries()) {
      const base = {
        target: item.target,
        outputId: item.descriptor.outputId,
        hash: item.descriptor.hash,
      };
      if (signal.aborted) {
        receipts.push({ ...base, status: 'not_started', reason: '取消后未开始' });
        continue;
      }
      let intended = false;
      try {
        const { env, descriptor } = this.descriptor(
          conversationId,
          item.descriptor.outputId,
        );
        const bytes = this.bytes(env, descriptor);
        if (hash(descriptor) !== hash(item.descriptor)) throw failure('冻结成果变化');
        if (observe(item.root, item.path, item.rootIdentity))
          throw failure('目标在派发后出现，未覆盖');
        await this.boundary?.('before-intent', index);
        if (signal.aborted) {
          receipts.push({ ...base, status: 'not_started', reason: '落盘前取消' });
          continue;
        }
        this.repo.save(this.repo.intentRef(plan.executionId, index), item);
        intended = true;
        await this.boundary?.('after-intent', index);
        signal.throwIfAborted();
        createExclusive(item.root, item.path, bytes, item.rootIdentity);
        await this.boundary?.('after-effect', index);
        const entry = observe(item.root, item.path, item.rootIdentity);
        if (entry?.hash !== descriptor.hash) throw failure('导出后目标不符合冻结字节');
        const receipt: ExportReceipt = {
          ...base,
          status: 'written',
          identity: entry.identity,
        };
        this.repo.save(this.repo.receiptRef(plan.executionId, index), receipt);
        receipts.push(receipt);
        await this.boundary?.('after-receipt', index);
      } catch (error) {
        // 有 intent 后的任何异常需只观察恢复，不能把可能写入的目标标成“未发生”。
        const uncertain = intended && (error as NodeJS.ErrnoException).code !== 'EEXIST';
        const receipt: ExportReceipt = {
          ...base,
          status: uncertain ? 'unknown' : 'conflict',
          reason: error instanceof Error ? error.message : '导出失败',
        };
        receipts[index] = receipt;
        if (!uncertain)
          this.repo.save(this.repo.receiptRef(plan.executionId, index), receipt);
        if (uncertain) {
          for (const remaining of plan.items.slice(index + 1))
            receipts.push({
              target: remaining.target,
              outputId: remaining.descriptor.outputId,
              hash: remaining.descriptor.hash,
              status: 'not_started',
            });
          break;
        }
      }
    }
    const result = this.result(plan, receipts);
    if (signal.aborted && result.outcome !== 'unknown')
      return {
        ...result,
        outcome: 'cancelled',
        content: '导出已取消；已交付项和未开始项分别保留，不补导出。',
      };
    return result;
  }

  recoverExport(ctx: ExecutionContext): ToolResult {
    const plan = this.plan(ctx);
    hostContext({}, this.repo.store.environment(ctx.environmentId));
    const receipts = plan.items.map((item, index): ExportReceipt => {
      const base = {
        target: item.target,
        outputId: item.descriptor.outputId,
        hash: item.descriptor.hash,
      };
      const prior = this.repo.read<ExportReceipt>(
        this.repo.receiptRef(plan.executionId, index),
      );
      if (prior?.status === 'conflict') return { ...prior };
      const intent = this.repo.read(this.repo.intentRef(plan.executionId, index));
      if (!intent)
        return {
          ...base,
          status: 'not_started',
          reason: '没有原逐项意图；未写入或补导出',
        };
      if (hash(intent) !== hash(item))
        return { ...base, status: 'unknown', reason: '原意图不一致' };
      try {
        const actual = observe(item.root, item.path, item.rootIdentity);
        const previous = this.repo.read<ExportReceipt>(
          this.repo.receiptRef(plan.executionId, index),
        );
        if (
          actual?.hash === item.descriptor.hash &&
          (!previous?.identity || previous.identity === actual.identity)
        )
          return {
            ...base,
            status: 'verified',
            identity: actual.identity,
            reason: '只核验当前目标，不断言原操作者',
          };
        return {
          ...base,
          status: actual || previous ? 'unknown' : 'not_started',
          reason: '目标不符合原冻结交付',
        };
      } catch {
        return { ...base, status: 'unknown', reason: '原目标位置无法核验' };
      }
    });
    return this.result(plan, receipts);
  }

  inspectExport(conversationId: string, executionId: string) {
    const tool = this.repo.store.tool(executionId);
    if (
      this.repo.store.getRun(tool.run_id).conversation_id !== conversationId ||
      !tool.context_ref
    )
      throw failure('导出不属于当前会话');
    return this.recoverExport(
      executionContextSchema.parse(this.repo.store.readArtifact(tool.context_ref)),
    );
  }

  exportedPath(conversationId: string, executionId: string, index: number) {
    const data = this.inspectExport(conversationId, executionId).data as {
      receipts: ExportReceipt[];
    };
    const receipt = data.receipts[index];
    if (!receipt || receipt.status !== 'verified')
      throw failure('目标尚未交付或现状变化，不能打开');
    return receipt.target;
  }
}

export function registerOutputs(registry: ToolRegistry, files: OutputFiles) {
  for (const capture of [false, true])
    registry.register({
      name: capture ? 'capture_output' : 'create_output',
      description: capture
        ? '将 task/artifacts 下普通文件收录为冻结成果，支持二进制，单文件最多 4 MiB；path 相对此目录。只收录自有输出，不访问任意来源。'
        : '创建独立 UTF-8 文本成果，无需申请来源编辑。返回 outputId/hash/name/mime/size；尚未导出。修改时生成新成果，不覆盖旧成果。',
      schema: capture ? captureOutputSchema : createOutputSchema,
      effect: 'copy-write',
      approvalRequired: () => false,
      prepare: (a, env, id) => files.prepareCreate(a, env, id, capture),
      execute: (a, ctx, _cid, s) => files.create(a, ctx, s),
      reconcile: (_a, ctx) => files.recoverCreate(ctx),
    });
  registry.register({
    name: 'list_outputs',
    description:
      '分页列本会话历史成功创建的冻结成果，不读取正文、不证明当前文件完整。需要 read_output 核验字节；可跨运行续作。',
    schema: listOutputsSchema,
    effect: 'read',
    prepare: hostContext,
    async execute(a, _ctx, cid, signal) {
      signal.throwIfAborted();
      return {
        outcome: 'succeeded',
        content: '冻结成果列表。',
        data: files.list(cid, a),
      };
    },
    async reconcile(a, ctx, cid, signal) {
      return this.execute(a, ctx, cid, signal);
    },
  });
  registry.register({
    name: 'read_output',
    description:
      '核验并分页预览本会话冻结成果。文本返回真实字节范围；二进制默认仅元数据，显式 base64 可读取片段。不是导出。',
    schema: readOutputSchema,
    effect: 'read',
    prepare: hostContext,
    async execute(a, _ctx, cid, s) {
      s.throwIfAborted();
      return {
        outcome: 'succeeded',
        content: '成果预览已核验。',
        data: files.read(cid, a),
      };
    },
    async reconcile(a, ctx, cid, s) {
      return this.execute(a, ctx, cid, s);
    },
  });
  registry.register({
    name: 'inspect_export',
    description:
      '只读核验本会话原导出目标，逐项返回已核验/冲突/未开始/未知；不会补导出或写文件，可作为新一轮 export_receipt 证据。',
    schema: inspectExportSchema,
    effect: 'read',
    prepare: hostContext,
    async execute(input, _ctx, cid, signal) {
      signal.throwIfAborted();
      return {
        ...files.inspectExport(cid, inspectExportSchema.parse(input).executionId),
        mutated: false,
      };
    },
    async reconcile(input, ctx, cid, signal) {
      return this.execute(input, ctx, cid, signal);
    },
  });
  registry.register({
    name: 'export_outputs',
    description:
      '申请导出本会话具体冻结成果到具体绝对文件路径。只新建，重名不覆盖；父目录必须存在。最多20项/16MiB。逐项回执，部分失败/恢复不重导；源修改仍用 deliver_changeset。',
    schema: exportOutputsSchema,
    effect: 'source-write',
    prepare: (a, env, id) => files.prepareExport(a, env, id),
    approvalDescription(_a, ctx) {
      const plan = outputSnapshotSchema.parse(ctx.output);
      if (plan.kind !== 'export') throw failure('缺少导出计划');
      return (
        `将以下 ${plan.items.length} 份冻结成果新建到指定目标：\n` +
        plan.items
          .map(
            (i) =>
              `${i.descriptor.name}（${i.descriptor.size} 字节，内容已冻结） → ${i.target}`,
          )
          .join('\n') +
        '\n仅批准这些目标；已有文件不覆盖，生成成果不等于已经导出。'
      );
    },
    execute: (_a, ctx, cid, s) => files.export(ctx, cid, s),
    async reconcile(_a, ctx, _cid, s) {
      s.throwIfAborted();
      return files.recoverExport(ctx);
    },
  });
}
