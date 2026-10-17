import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import { textFileReadReceiptSchema } from '../../../protocol/src/file-edit.js';
import type {
  PersistencePort,
  ToolRow,
  ToolResult,
} from '../../../agent/src/persistence.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';

export interface FileReadEvidence {
  readonly tool: Pick<ToolRow, 'id' | 'name' | 'state' | 'args' | 'environment_id'>;
  readonly conversationId: string;
  readonly context: ExecutionContext;
  readonly resultRef: string;
  readonly result: ToolResult;
  readonly modelReceived: boolean;
}
export interface FileReadEvidencePort {
  read(executionId: string): FileReadEvidence | undefined;
}

// 模块只取得读取事实的端口，不能通过它写 SQL、批准或修改旧回执。
export function fileReadEvidencePort(
  store: Pick<PersistencePort, 'tool' | 'getRun' | 'readArtifact' | 'modelReceivedToolResult'>,
): FileReadEvidencePort {
  return {
    read(executionId) {
      let tool: ToolRow;
      try {
        tool = store.tool(executionId);
      } catch {
        return undefined;
      }
      if (!tool.context_ref || !tool.result_ref) return undefined;
      return {
        tool,
        conversationId: store.getRun(tool.run_id).conversation_id,
        context: store.readArtifact<ExecutionContext>(tool.context_ref),
        resultRef: tool.result_ref,
        result: store.readArtifact<ToolResult>(tool.result_ref),
        modelReceived: store.modelReceivedToolResult(executionId),
      };
    },
  };
}

// 两种文本编辑共用同一读证据校验；这里没有批准和写入能力。
export function requireTextRead(
  reads: FileReadEvidencePort,
  a: { mountId: string; path: string; readExecutionId: string; expectedReadHash: string },
  environmentId: string,
  conversationId: string,
) {
  const evidence = reads.read(a.readExecutionId);
  if (
    !evidence ||
    evidence.tool.name !== 'read_file' ||
    evidence.tool.state !== 'succeeded' ||
    evidence.result.outcome !== 'succeeded' ||
    evidence.tool.environment_id !== environmentId ||
    evidence.conversationId !== conversationId
  )
    throw new UmiError('READ_RECEIPT_REQUIRED', '需要当前会话成功的 read_file 执行回执');
  if (!evidence.modelReceived)
    throw new UmiError('MODEL_READ_REQUIRED', '读取范围尚未完整反馈给模型；请重新 read_file 后再编辑，不以隐藏正文替换文件');
  const parsed = textFileReadReceiptSchema.safeParse(evidence.result.data);
  if (!parsed.success)
    throw new UmiError('READ_RECEIPT_REQUIRED', '读取回执不是可绑定的 UTF-8 文本');
  const r = parsed.data,
    ctx = executionContextSchema.parse(evidence.context),
    loc = ctx.locations[0];
  const args = JSON.parse(evidence.tool.args) as { mountId: string; path: string };
  if (
    evidence.tool.id !== a.readExecutionId ||
    r.readExecutionId !== a.readExecutionId ||
    ctx.fileReadExecutionId !== a.readExecutionId ||
    ctx.environmentId !== environmentId ||
    args.mountId !== a.mountId ||
    args.path !== a.path ||
    r.mountId !== a.mountId ||
    r.path !== a.path ||
    r.hash !== a.expectedReadHash ||
    !loc ||
    loc.rootRef.kind !== 'mount' ||
    loc.rootRef.mountId !== a.mountId ||
    loc.relativePath !== a.path ||
    loc.beforeHash !== r.hash ||
    loc.beforeIdentity !== r.identity
  )
    throw new UmiError('READ_RECEIPT_MISMATCH', '读取回执、哈希或文件位置不匹配');
  return { receipt: r, resultRef: evidence.resultRef };
}
