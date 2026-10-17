import type { QuestionRequest } from '../../protocol/src/question.js';
import type {
  Settings,
  WireMessage,
  ExecutionContext,
  ToolOutcome,
} from '../../protocol/src/model.js';
import type { EventScope, EventBody, WorkEvent } from '../../protocol/src/events.js';
import type { ConversationState } from '../../protocol/src/reducer.js';
import type { PreparedRequest } from './ports.js';
import type {
  ContextMemory,
  MemoryEntry,
  MemoryValue,
  MaintenancePlan,
  Summary,
  MemorySource,
} from '../../protocol/src/memory.js';
// 已冻结请求的语义视图，带来源和窗口身份；宿主派生快照不冒充用户原话。
export type ContextCarry = {
  messages: WireMessage[];
  sources: string[];
  contextVersion: number;
  promptVersion: string;
  projection: { toolPolicy: string };
  metrics?: { cache?: { toolsHash: string; requestShapeHash?: string; factHashes?: Record<string, string>; factPolicy?: string } };
};
export type MessageRow = {
  id: string;
  conversationId: string;
  runId: string;
  userTurnId: string | null;
  modelTurnId: string | null;
  modelAttemptId: string | null;
  role: string;
  createdAt: string;
  applied: boolean;
  projectionSequence: string;
  payload: WireMessage;
};
export type RunRow = {
  id: string;
  conversation_id: string;
  environment_id: string;
  status: string;
  phase: string;
  generation: number;
  model_turns: number;
  stop_requested: number;
};
export type Environment = {
  id: string;
  root: string;
  root_identity: string;
  revision: number;
  active_run_id: string | null;
};
export type ToolRow = {
  id: string;
  call_id: string;
  run_id: string;
  turn_id: string;
  attempt_id: string;
  provider_call_id: string;
  name: string;
  args: string;
  request_hash: string;
  environment_id: string;
  revision: number;
  state: string;
  context_ref: string | null;
  result_ref: string | null;
  approval_id: string | null;
};
export type ApprovalRow = {
  id: string;
  execution_id: string;
  run_id: string;
  request_hash: string;
  decision: string | null;
  valid: number;
};
export type ToolResult = {
  outcome: ToolOutcome;
  content: string;
  data: unknown;
  verification?: string;
  mutated?: boolean;
};
export type AttachmentSummary = {
  id: string;
  name: string;
  mime: string;
  byteLength: number;
};
// 领域端口不暴露 SQL 或 SQLite 驱动；循环只提交事实及领域操作。
export interface PersistencePort {
  settings(id: string): Settings;
  getRun(id: string): RunRow;
  environment(id: string): Environment;
  messages(conversationId: string): MessageRow[];
  snapshot(conversationId: string): ConversationState;
  questionRequest(conversationId: string, executionId: string): QuestionRequest | undefined;
  searchMessages(
    conversationId: string,
    query: { query: string; role: string; from?: string; to?: string; limit: number },
  ): { rows: MessageRow[]; total: number };
  messageById(conversationId: string, messageId: string): MessageRow | undefined;
  runtimeFacts(environmentId: string): unknown;
  messageAttachments(conversationId: string, messageId: string): AttachmentSummary[];
  messageImages(
    conversationId: string,
    messageId: string,
  ): NonNullable<WireMessage['images']>;
  readAttachment(
    conversationId: string,
    id: string,
    startByte?: number,
    byteLength?: number,
  ): unknown;
  contextMemory(conversationId: string): ContextMemory;
  contextCarry(conversationId: string): ContextCarry | null;
  unresolvedEnvironment(environmentId: string): ToolRow[];
  pendingEnvironment(environmentId: string): ToolRow[];
  contextSourceFingerprint(runId: string): string;
  resolveMemorySource(conversationId: string, source: MemorySource): string;
  saveMemory(executionId: string, value: MemoryValue): MemoryEntry;
  accessibleArtifact(conversationId: string, artifactId: string): unknown;
  startMaintenance(plan: MaintenancePlan, generation: number): boolean;
  finishMaintenance(
    plan: MaintenancePlan,
    summary: Summary | null,
    raw: unknown,
    usage: unknown,
    generation: number,
  ): void;
  failMaintenance(
    plan: MaintenancePlan,
    code: string,
    generation: number,
    raw?: unknown,
    usage?: unknown,
  ): void;
  maintenanceCount(runId: string, modelOnly?: boolean): number;
  commit(scope: EventScope, body: EventBody): WorkEvent;
  commitModelDeltas(scope: EventScope, generation: number, deltas: Extract<EventBody, { type: 'model.delta' }>[]): void;
  readArtifact<T>(id: string): T;
  tool(id: string): ToolRow;
  tools(runId: string): ToolRow[];
  modelReceivedToolResult(executionId: string): boolean;
  approval(id: string): ApprovalRow;
  checkLease(runId: string, generation: number): void;
  claim(runId: string, recovery?: boolean): number;
  applyInputs(runId: string): void;
  persistRequest(
    scope: EventScope,
    requestId: string,
    contextId: string,
    request: PreparedRequest,
    context: unknown,
    generation: number,
  ): void;
  persistResponse(
    scope: EventScope,
    message: WireMessage,
    raw: unknown,
    usage: unknown,
    requestId: string,
    generation: number,
    finishReason: string,
  ): string;
  persistFailureSummary(runId: string, text: string, generation: number): string;
  requestApproval(
    toolId: string,
    context: ExecutionContext,
    description: string,
    generation: number,
  ): string;
  invalidateApproval(toolId: string, reason: string): void;
  decideApproval(
    conversationId: string,
    approvalId: string,
    decision: 'allow' | 'deny',
  ): void;
  dispatch(toolId: string, context: ExecutionContext, generation: number, effect?: string): void;
  settle(
    toolId: string,
    result: ToolResult,
    generation: number,
    reconciled?: boolean,
    mutated?: boolean,
    inspectionExecutionId?: string,
  ): void;
  preparedToolScope(tool: ToolRow): EventScope;
}
