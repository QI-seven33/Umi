import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import {
  editFileSchema,
  fileEditSnapshotSchema,
  MAX_EDIT_BYTES,
  MAX_REPLACEMENT_BYTES,
} from '../../../protocol/src/file-edit.js';
import type {
  EditFileInput,
  TextFileReadReceipt,
} from '../../../protocol/src/file-edit.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import { toolModule } from '../../../agent/src/tools/modules.js';
import type { ToolModule } from '../../../agent/src/tools/modules.js';
import { ToolPreparationError } from '../../../agent/src/tools/registry.js';
import { textSources, editedKnownRanges } from './text-knowledge.js';
import type { FileReadEvidencePort } from './read-evidence.js';
import { ResourceFiles } from './resources.js';
import { atomicWrite, bytesHash, observe, sameEntry, safeFile } from './paths.js';
import { hash } from '../../../agent/src/identity.js';

/** 校验完整 UTF-8 原文；保留 BOM 和原换行，不重编码。 */
function validateTextBytes(bytes: Buffer) {
  if (bytes.length > MAX_EDIT_BYTES)
    throw new UmiError('RESOURCE_LIMIT', '编辑文件超过 4 MiB 上限');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UmiError('UNSUPPORTED_ENCODING', '局部编辑仅接受有效 UTF-8 文本');
  }
  if (text.includes('\0'))
    throw new UmiError('UNSUPPORTED_ENCODING', '二进制文件不能局部编辑');
}

function locateUniqueUtf8(bytes: Buffer, oldText: string, newText: string) {
  const oldBytes = Buffer.from(oldText),
    newBytes = Buffer.from(newText);
  for (const [s, b] of [
    [oldText, oldBytes],
    [newText, newBytes],
  ] as const) {
    if (s.includes('\0') || b.toString('utf8') !== s)
      throw new UmiError(
        'TOOL_ARGUMENTS_INVALID',
        '替换文本含 NUL 或不完整 Unicode 字符',
      );
    if (b.length > MAX_REPLACEMENT_BYTES)
      throw new UmiError('RESOURCE_LIMIT', '单个替换片段超过 64000 UTF-8 字节');
  }
  if (!oldBytes.length) throw new UmiError('TOOL_ARGUMENTS_INVALID', 'oldText 不能为空');
  const offset = bytes.indexOf(oldBytes);
  if (offset < 0)
    throw new UmiError(
      'EDIT_NOT_FOUND',
      'oldText 没有精确命中；请重新读取，换行必须一致',
    );
  if (bytes.indexOf(oldBytes, offset + 1) >= 0)
    throw new UmiError('EDIT_AMBIGUOUS', 'oldText 不唯一；请读取更完整的定位片段');
  return { offset, oldByteLength: oldBytes.length, newByteLength: newBytes.length, noOp: oldBytes.equals(newBytes), newBytes };
}

/** 精确字节替换；不规范化 CRLF/LF，不重编码原文件，不替换第二处命中。 */
export function replaceUniqueUtf8(bytes: Buffer, oldText: string, newText: string) {
  validateTextBytes(bytes);
  const located = locateUniqueUtf8(bytes, oldText, newText), { offset, newBytes } = located, oldBytes = Buffer.from(oldText);
  if (bytes.length - oldBytes.length + newBytes.length > MAX_EDIT_BYTES)
    throw new UmiError('RESOURCE_LIMIT', '替换后文件超过 4 MiB 上限');
  const desired = oldBytes.equals(newBytes)
    ? bytes
    : Buffer.concat([
        bytes.subarray(0, offset),
        newBytes,
        bytes.subarray(offset + oldBytes.length),
      ]);
  return {
    bytes: desired,
    offset,
    oldByteLength: oldBytes.length,
    newByteLength: newBytes.length,
    noOp: oldBytes.equals(newBytes),
    desiredHash: bytesHash(desired),
  };
}

export class FileEditTools {
  constructor(
    private readonly files: ResourceFiles,
    private readonly reads: FileReadEvidencePort,
  ) {}

  // 每项均对原版本定位。先收集全部失败，再拼接一次；不能让前项成功掩盖后项失败。
  private replacement(a: EditFileInput, bytes: Buffer, receipts?: TextFileReadReceipt[]) {
    validateTextBytes(bytes);
    const items = 'edits' in a ? a.edits : [{ oldText: a.oldText, newText: a.newText }];
    const ranges = receipts?.map(r => ({ start: r.startByte, end: r.endByte })).sort((x, y) => x.start - y.start);
    const diagnostics: { index: number; code: string; reason: string }[] = [];
    const edits: { index: number; startByte: number; oldByteLength: number; newByteLength: number; replacement: Buffer }[] = [];
    for (const [index, item] of items.entries()) {
      try {
        const found = locateUniqueUtf8(bytes, item.oldText, item.newText);
        if (ranges) {
          let covered = found.offset;
          for (const range of ranges) {
            if (range.start > covered) break;
            if (range.end > covered) covered = range.end;
          }
          if (covered < found.offset + found.oldByteLength)
            throw new UmiError('EDIT_OUTSIDE_READ', '命中片段不在本次读取范围；请读取对应原文');
        }
        edits.push({ index, startByte: found.offset, oldByteLength: found.oldByteLength, newByteLength: found.newByteLength, replacement: found.newBytes });
      } catch (error) {
        if (!(error instanceof UmiError)) throw error;
        diagnostics.push({ index, code: error.code, reason: error.message });
      }
    }
    const ordered = [...edits].sort((x, y) => x.startByte - y.startByte);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1]!, current = ordered[i]!;
      if (current.startByte < previous.startByte + previous.oldByteLength)
        diagnostics.push({ index: current.index, code: 'EDIT_OVERLAP', reason: `与第 ${previous.index + 1} 项重叠；请合并该原文片段` });
    }
    if (diagnostics.length) throw new ToolPreparationError(diagnostics[0]!.code,
      diagnostics.map(d => `第 ${d.index + 1} 项：${d.reason}`).join('；') + '。整批未写入。', { diagnostics });
    const chunks: Buffer[] = [];
    let offset = 0;
    for (const item of ordered) {
      chunks.push(bytes.subarray(offset, item.startByte), item.replacement);
      offset = item.startByte + item.oldByteLength;
    }
    chunks.push(bytes.subarray(offset));
    const desired = Buffer.concat(chunks);
    if (desired.length > MAX_EDIT_BYTES) throw new UmiError('RESOURCE_LIMIT', '整批替换后文件超过 4 MiB 上限');
    return { bytes: desired, desiredHash: bytesHash(desired), noOp: desired.equals(bytes), edits: edits.map(({ replacement: _, ...item }) => item) };
  }

  prepare(input: unknown, env: Environment, executionId?: string): ExecutionContext {
    if (!executionId) throw new UmiError('PROTOCOL_INVALID', '局部编辑缺少原执行身份');
    const a = editFileSchema.parse(input), ctx = this.files.mountContext(input, env, a.mountId, a.path, undefined, true), loc = ctx.locations[0]!;
    const m = this.files.repo.mount(a.mountId, env.id), bytes = readFileSync(safeFile(m.root, a.path, m.rootIdentity));
    const sources = textSources(this.reads,a,ctx,this.files.repo.scope(env.id).conversationId,bytes), r = sources[0]!.receipt;
    if (sources.some(s => s.receipt.hash !== r.hash || s.receipt.identity !== r.identity || s.receipt.size !== r.size))
      throw new UmiError('READ_RECEIPT_MISMATCH', '批量读取回执不是同一个文件版本与对象');
    if (loc.beforeHash !== r.hash || loc.beforeIdentity !== r.identity)
      throw new UmiError('READ_STALE', '读后文件内容或对象身份已变化；请重新读取后编辑');
    const entry = observe(m.root, a.path, m.rootIdentity);
    if (!entry || entry.hash !== r.hash || entry.identity !== r.identity || bytesHash(bytes) !== r.hash || bytes.length !== r.size)
      throw new UmiError('READ_STALE', '准备期间读取版本已变化');
    for (const { receipt } of sources)
      if (!bytes.subarray(receipt.startByte, receipt.endByte).equals(Buffer.from(receipt.text)))
        throw new UmiError('READ_RECEIPT_MISMATCH', '读取字节范围与原回执不一致');
    const desired = this.replacement(a, bytes, sources.map(s => s.receipt));
    return { ...ctx, locations: [{ ...loc, desiredHash: desired.desiredHash }],
      fileEdit: 'edits' in a || !a.readExecutionId ? {
        schemaVersion: 2, executionId, knownRanges: editedKnownRanges(sources,desired.edits), reads: sources.map(s => ({ readExecutionId: s.receipt.readExecutionId, readResultRef: s.resultRef })),
        edits: desired.edits, noOp: desired.noOp,
      } : {
        schemaVersion: 1, executionId, knownRanges: editedKnownRanges(sources,desired.edits), readExecutionId: a.readExecutionId!, readResultRef: sources[0]!.resultRef,
        startByte: desired.edits[0]!.startByte, oldByteLength: desired.edits[0]!.oldByteLength, newByteLength: desired.edits[0]!.newByteLength, noOp: desired.noOp,
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
        content: '编辑在落盘前取消。',
        data: null,
      };
    const a = editFileSchema.parse(input),
      plan = fileEditSnapshotSchema.parse(ctx.fileEdit),
      loc = ctx.locations[0]!;
    const env = this.files.repo.store.environment(ctx.environmentId);
    let fresh: ExecutionContext;
    try {
      fresh = this.prepare(a, env, plan.executionId);
    } catch (error) {
      return {
        outcome: 'failed',
        mutated: false,
        content:
          error instanceof UmiError ? error.message : '落盘前读取版本无法核验，未替换。',
        data: error instanceof ToolPreparationError ? { code: error.code, ...error.details } : error instanceof UmiError ? { code: error.code } : null,
      };
    }
    if (hash(fresh) !== hash(ctx))
      return {
        outcome: 'failed',
        mutated: false,
        content: '派发后编辑定位已变化，未替换。',
        data: null,
      };
    const m = this.files.repo.mount(a.mountId, ctx.environmentId),
      before = observe(m.root, a.path, m.rootIdentity);
    if (
      !before ||
      before.hash !== loc.beforeHash ||
      before.identity !== loc.beforeIdentity
    )
      return {
        outcome: 'failed',
        mutated: false,
        content: '副本目标在派发后变化，未替换。',
        data: null,
      };
    const bytes = readFileSync(safeFile(m.root, a.path, m.rootIdentity)),
      desired = this.replacement(a, bytes);
    if (
      desired.desiredHash !== loc.desiredHash ||
      (plan.schemaVersion === 1 && desired.edits[0]!.startByte !== plan.startByte) ||
      !sameEntry(before, observe(m.root, a.path, m.rootIdentity))
    )
      return {
        outcome: 'failed',
        mutated: false,
        content: '落盘前文件或预期替换已变化，未替换。',
        data: null,
      };
    if (signal.aborted)
      return {
        outcome: 'cancelled',
        mutated: false,
        content: '编辑在落盘前取消。',
        data: null,
      };
    if (!plan.noOp)
      atomicWrite(m.root, a.path, desired.bytes, m.rootIdentity, undefined, before);
    const after = observe(m.root, a.path, m.rootIdentity);
    if (
      !after ||
      after.hash !== loc.desiredHash ||
      (plan.noOp && !sameEntry(before, after))
    )
      throw new UmiError('RESOURCE_CHANGED', '局部编辑后回读核验失败');
    return {
      outcome: 'succeeded',
      mutated: !plan.noOp,
      verification: plan.noOp ? 'no-op-current-read-verified' : 'edited-bytes-verified',
      content: plan.noOp
        ? '替换前后相同，未落盘。'
        : plan.schemaVersion === 1 ? '工作副本唯一片段已替换并回读核验；交付仍需独立确认。' : `工作副本 ${plan.edits.length} 处精确替换已一次落盘并回读核验；交付仍需独立确认。`,
      data: {
        mountId: m.id,
        path: a.path,
        ...(plan.schemaVersion === 1 ? { readExecutionId: plan.readExecutionId } : { readExecutionIds: plan.reads.map(r => r.readExecutionId) }),
        beforeHash: loc.beforeHash,
        afterHash: after.hash,
        observed: after,
        noOp: plan.noOp,
        ...(plan.schemaVersion === 1 ? { startByte: plan.startByte, oldByteLength: plan.oldByteLength, newByteLength: plan.newByteLength } : { edits: plan.edits }),
      },
    };
  }

  async reconcile(
    input: unknown,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    const a = editFileSchema.parse(input),
      plan = fileEditSnapshotSchema.parse(ctx.fileEdit),
      loc = ctx.locations[0]!;
    const m = this.files.repo.mount(a.mountId, ctx.environmentId);
    this.files.assertPath(m.scope, a.path);
    if (
      loc.rootRef.kind !== 'mount' ||
      loc.rootRef.mountId !== m.id ||
      loc.relativePath !== a.path ||
      loc.physicalRoot !== m.root ||
      loc.physicalRootIdentity !== m.rootIdentity ||
      loc.rootRef.bindingVersion !== m.bindingVersion ||
      (plan.schemaVersion === 1 ? 'readExecutionId' in a && a.readExecutionId !== undefined && plan.readExecutionId !== a.readExecutionId : 'readExecutionIds' in a && a.readExecutionIds !== undefined && hash(plan.reads.map(r => r.readExecutionId)) !== hash(a.readExecutionIds))
    )
      throw new UmiError('RESOURCE_CHANGED', '原编辑定位无法对应当前挂载');
    const observed = observe(m.root, a.path, m.rootIdentity);
    if (
      observed?.hash === loc.desiredHash &&
      (!plan.noOp || observed.identity === loc.beforeIdentity)
    )
      return {
        outcome: 'succeeded',
        mutated: !plan.noOp,
        verification: 'desired-state-verified',
        content: '原目标已满足冻结的预期字节；没有再次替换，不断言原执行来源。',
        data: {
          mountId: m.id,
          path: a.path,
          beforeHash: loc.beforeHash,
          afterHash: observed.hash,
          observed,
          noOp: plan.noOp,
        },
      };
    if (observed?.hash === loc.beforeHash && observed.identity === loc.beforeIdentity)
      return {
        outcome: 'failed',
        mutated: false,
        verification: 'original-state-verified',
        content: '当前仍为原读取版本；未重复替换，请重新读取后决定后续。',
        data: { observed },
      };
    return {
      outcome: 'unknown',
      mutated: false,
      verification: 'unknown',
      content: '原编辑结果无法核验；未重复替换。',
      data: { observed },
    };
  }
}

export function fileEditModule(
  files: ResourceFiles,
  reads: FileReadEvidencePort,
): ToolModule {
  const edits = new FileEditTools(files, reads);
  return toolModule('umi.file-edit', '1.1.0', ['umi.files'], (registry) =>
    registry.register({
      name: 'edit_file',
      description:
        '精确编辑获准副本。单项用 oldText/newText，多处用 edits（最多32项），不能混用。宿主自动绑定当前版本的已见原文，自己成功写入的正文无需重读；回执/哈希是可省略的兼容参数，若提供则严格核对。oldText 必须全文件唯一并在已见范围内，片段不重叠；失败整批不写。保留原换行/UTF-8，源交付另需批准。',
      schema: editFileSchema,
      effect: 'copy-write',
      prepare: (a, env, id) => edits.prepare(a, env, id),
      execute: (a, ctx, _c, signal) => edits.execute(a, ctx, signal),
      reconcile: (a, ctx, _c, signal) => edits.reconcile(a, ctx, signal),
    }),
  );
}
