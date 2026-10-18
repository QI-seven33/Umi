import { FrozenPreview } from '../../../packages/adapters/src/host-files/frozen-preview.js';
import { registerDeliveredOpen } from '../../../packages/adapters/src/host-files/delivered-open.js';
import type { DocumentOpener } from '../../../packages/protocol/src/native-open.js';
import { UserQuestions, registerQuestions } from '../../../packages/agent/src/tools/questions.js';
import type { ConversationState } from '../../../packages/protocol/src/reducer.js';
import {
  OutputFiles,
  registerOutputs,
} from '../../../packages/adapters/src/host-files/outputs.js';
import type { OutputBoundary } from '../../../packages/adapters/src/host-files/outputs.js';
import { OutputRepository } from '../../../packages/adapters/src/sqlite/outputs.js';
import { TaskRepository } from '../../../packages/adapters/src/sqlite/tasks.js';
import { currentTaskEvidence } from '../../../packages/adapters/src/host-files/task-evidence.js';
import { registerTasks } from '../../../packages/agent/src/tools/tasks.js';
import { registerRecovery } from '../../../packages/agent/src/tools/recovery.js';
import { ExecutionRepository } from '../../../packages/adapters/src/sqlite/executions.js';
import { providerToolModule } from '../../../packages/agent/src/tools/provider-tools.js';
import type { ProviderToolModule } from '../../../packages/agent/src/tools/execution-provider.js';
import { registerAttachments } from '../../../packages/agent/src/tools/attachments.js';
import { SqliteStore } from '../../../packages/adapters/src/sqlite/store.js';
import { AgentEngine } from '../../../packages/agent/src/loop/engine.js';
import {
  ToolRegistry,
  registerHistory,
} from '../../../packages/agent/src/tools/registry.js';
import { registerMemory } from '../../../packages/agent/src/tools/memory.js';
import { ContextManager } from '../../../packages/agent/src/context/manager.js';
import type { EngineLimits } from '../../../packages/agent/src/loop/engine.js';
import type { ModelPort } from '../../../packages/agent/src/ports.js';
import type { Cursor, Settings } from '../../../packages/protocol/src/model.js';
import { UmiError } from '../../../packages/protocol/src/model.js';
import {
  hostContext,
  registerScratch,
} from '../../../packages/adapters/src/host-files/scratch.js';
import { registerWebSearch } from '../../../packages/adapters/src/deepseek-search/search.js';
import { registerWebFetch } from '../../../packages/adapters/src/deepseek-search/fetch.js';
import { registerWebPageReading } from '../../../packages/agent/src/tools/webpage.js';
import { WebPageRepository } from '../../../packages/adapters/src/sqlite/webpage.js';
import { WebSearchRepository } from '../../../packages/adapters/src/sqlite/web-search.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ResourceRepository } from '../../../packages/adapters/src/sqlite/resources.js';
import { ResourceFiles } from '../../../packages/adapters/src/host-files/resources.js';
import { registerFiles } from '../../../packages/adapters/src/host-files/tools.js';
import { registerRecycle } from '../../../packages/adapters/src/host-files/recycle.js';
import { DeliveryFiles } from '../../../packages/adapters/src/host-files/delivery.js';
import type { DeliveryBoundary } from '../../../packages/adapters/src/host-files/delivery.js';
import {
  CommandTools,
  registerCommands,
} from '../../../packages/adapters/src/host-process/tools.js';
import type { ProcessBoundary } from '../../../packages/adapters/src/host-process/tools.js';

import type { LegacyWindowsProcessPort } from '../../../packages/adapters/src/host-process/port.js';

import {
  installToolModules,
  toolModule,
} from '../../../packages/agent/src/tools/modules.js';
import type {
  ToolModule,
  ToolModuleManifest,
} from '../../../packages/agent/src/tools/modules.js';
import { fileEditModule } from '../../../packages/adapters/src/host-files/text-edit.js';
import { fileReadEvidencePort } from '../../../packages/adapters/src/host-files/read-evidence.js';

export class UmiApplication {
  readonly questions: UserQuestions;
  readonly frozenPreview: FrozenPreview;
  readonly store: SqliteStore;
  readonly registry: ToolRegistry;
  readonly engine: AgentEngine;
  readonly files: ResourceFiles;
  readonly commands: CommandTools;
  readonly tasks: TaskRepository;
  readonly outputs: OutputFiles;
  readonly toolModules: readonly ToolModuleManifest[];
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly queuedInput = new Map<string, string>();
  private closing = false;
  constructor(
    dataRoot: string,
    model: ModelPort,
    options: {
      outputBoundary?: (point: OutputBoundary, index: number) => void | Promise<void>;
      limits?: EngineLimits;
      context?: ContextManager;
      clock?: () => string;
      openDocument?: DocumentOpener;
      search?: { key: () => string; baseUrl: string; transport?: typeof fetch };
      deliveryBoundary?: (point: DeliveryBoundary, path: string) => void | Promise<void>;
      processRunner?: LegacyWindowsProcessPort;
      toolModules?: readonly ToolModule[];
      providerModules?: readonly ProviderToolModule[];
      processBoundary?: (
        point: ProcessBoundary,
        executionId: string,
      ) => void | Promise<void>;
    } = {},
  ) {
    this.store = new SqliteStore(dataRoot, options.clock);
    this.registry = new ToolRegistry();
    this.files = new ResourceFiles(new ResourceRepository(this.store));
    this.commands = new CommandTools(
      this.files,
      options.processRunner,
      options.processBoundary,
    );
    this.outputs = new OutputFiles(
      new OutputRepository(this.store),
      options.outputBoundary,
    );
    this.tasks = new TaskRepository(
      this.store,
      currentTaskEvidence(this.files, this.outputs),
    );
    this.questions = new UserQuestions(this.store);
    this.frozenPreview = new FrozenPreview(this.files);
    const webPages = new WebPageRepository(this.store);
    const modules: ToolModule[] = [
      toolModule('umi.web-pages', '1.0.0', [], r => registerWebPageReading(r, webPages, hostContext)),
      toolModule('umi.questions', '1.0.0', [], r => registerQuestions(r, this.questions, hostContext)),
      toolModule('umi.outputs', '1.0.0', [], (r) => registerOutputs(r, this.outputs)),
      toolModule('umi.tasks', '1.0.0', [], (r) =>
        registerTasks(r, this.tasks, hostContext),
      ),
      toolModule('umi.recovery', '1.0.0', [], (r) => registerRecovery(r, this.store, hostContext, (id, runId, generation, signal, inspectionId) => this.engine.inspectExecution(id, runId, generation, signal, inspectionId))),
      toolModule('umi.history', '1.0.0', [], (r) =>
        registerHistory(r, this.store, hostContext),
      ),
      toolModule('umi.scratch', '1.0.0', [], (r) => registerScratch(r)),
      toolModule('umi.memory', '1.0.0', [], (r) =>
        registerMemory(r, this.store, hostContext),
      ),
      toolModule('umi.attachments', '1.0.0', [], (r) =>
        registerAttachments(r, this.store, hostContext),
      ),
      toolModule('umi.files', '1.0.0', [], (r) =>
        registerFiles(
          r,
          this.files,
          new DeliveryFiles(this.files, options.deliveryBoundary),
        ),
      ),
      fileEditModule(this.files, fileReadEvidencePort(this.store)),
      toolModule('umi.recycle', '1.0.0', ['umi.files'], (r) =>
        registerRecycle(r, this.files),
      ),
      toolModule('umi.commands', '1.0.0', ['umi.files'], (r) =>
        registerCommands(r, this.commands),
      ),
    ];
    if (options.openDocument) {
      const open = options.openDocument;
      modules.push(toolModule('umi.open-delivered', '1.0.0', ['umi.files'], r => registerDeliveredOpen(r, this.files, open)));
    }
    if (options.search) {
      const search = options.search;
      modules.push(
        toolModule('umi.web-search', '1.0.0', [], (r) =>
          registerWebSearch(r, new WebSearchRepository(this.store), search.key, search.baseUrl, search.transport),
        ),
        toolModule('umi.web-fetch', '1.0.0', ['umi.web-pages'], r =>
          registerWebFetch(r, webPages, search.key, search.baseUrl, search.transport)),
      );
    }
    try {
      this.toolModules = installToolModules(this.registry, [
        ...modules,
        ...(options.providerModules ?? []).map((config) =>
          providerToolModule(config, new ExecutionRepository(this.store).forContext),
        ),
        ...(options.toolModules ?? []),
      ]);
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.engine = new AgentEngine(
      this.store,
      model,
      this.registry,
      options.context,
      options.limits,
      this.files,
      this.tasks,
    );
  }
  createConversation(workspace: string, settings: Partial<Settings> = {}) {
    const c = this.store.createConversation(workspace, settings);
    this.files.initialize(c.environmentId);
    return c;
  }
  deleteArchivedConversation(conversationId: string) {
    const runs = this.store.all('SELECT id FROM runs WHERE conversation_id=?',conversationId);
    if (runs.some(r => this.running.has(String(r.id))))
      throw new UmiError('RUN_STATE', '请等待当前任务完成停止与清理');
    return this.store.deleteArchivedConversation(conversationId);
  }
  contextStatistics(conversationId: string, projection?: ConversationState) {
    const state = projection ?? this.store.snapshot(conversationId);
    return {
      latestRequest: state.context,
      lastActualUsage: state.context.lastUsageRef
        ? this.store.readArtifact(state.context.lastUsageRef)
        : null,
      window: state.memory.window,
      maintenance: Object.entries(state.memory.maintenance).map(([id, m]) => ({
        id,
        ...m,
        usage: m.usageRef ? this.store.readArtifact(m.usageRef) : null,
      })),
      interpretation:
        'estimatedInputTokens 为 UTF-8 保守估算；实际用量来自对应 API 响应，维护费用单独展示。',
    };
  }
  previewFile(
    conversationId: string,
    mountId: string,
    path: string,
    startByte = 0,
    byteLength = 8192,
    expectedHash?: string,
  ) {
    if (
      !Number.isInteger(startByte) ||
      startByte < 0 ||
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > 64000
    )
      throw new UmiError('PROTOCOL_INVALID', '预览字节范围无效');
    const c = this.store.conversation(conversationId);
    return this.files.read(
      this.files.repo.mount(mountId, c.environment_id as string),
      path,
      startByte,
      Math.min(byteLength, 64000),
      expectedHash,
    );
  }
  previewChangeSet(conversationId: string, changeSetId: string) {
    const c = this.store.conversation(conversationId),
      cs = this.files.repo.changeSet(changeSetId, c.environment_id as string);
    const env = this.store.environment(c.environment_id as string),
      m = this.files.repo.mount(cs.mountId, env.id);
    return {
      changeSet: cs,
      preview: new DeliveryFiles(this.files).preview(cs, m, env),
      receipts: this.files.repo
        .items(cs.id)
        .map((i) =>
          i.receipt_ref
            ? this.store.readArtifact(i.receipt_ref as string)
            : { path: i.path, outcome: 'unknown' },
        ),
    };
  }
  previewProcess(
    conversationId: string,
    executionId: string,
    channel: 'stdout' | 'stderr',
    startByte = 0,
    byteLength = 8192,
  ) {
    const t = this.store.tool(executionId);
    if (this.store.getRun(t.run_id).conversation_id !== conversationId)
      throw new UmiError('PERMISSION_DENIED', '进程输出不属于当前会话');
    if (!['stdout', 'stderr'].includes(channel) || !this.commands.repo.row(executionId))
      throw new UmiError('PROTOCOL_INVALID', '输出通道或进程记录无效');
    if (
      !Number.isInteger(startByte) ||
      startByte < 0 ||
      !Number.isInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > 64000
    )
      throw new UmiError('PROTOCOL_INVALID', '输出读取范围无效');
    const bytes = Buffer.from(this.commands.repo.readOutput(executionId, channel)),
      start = Math.min(startByte, bytes.length);
    let end = Math.min(start + byteLength, bytes.length);
    if (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
      throw new UmiError('PROTOCOL_INVALID', '输出起点切开 UTF-8 字符');
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return {
      executionId,
      channel,
      startByte: start,
      endByte: end,
      totalBytes: bytes.length,
      truncated: end < bytes.length,
      text: bytes.subarray(start, end).toString('utf8'),
      receipt: this.commands.repo.receipt(executionId) ?? null,
    };
  }
  send(
    conversationId: string,
    commandId: string,
    text: string,
    attachmentIds: string[] = [],
  ) {
    const existed = this.store.get('SELECT id FROM commands WHERE conversation_id=? AND id=?', conversationId, commandId);
    const receipt = this.store.acceptInput(
      conversationId,
      commandId,
      text,
      attachmentIds,
    );
    // 幂等接收只返回原记录；不会因重发已完成命令而再次启动任务。
    if (existed) return receipt;
    if (this.running.has(receipt.runId)) this.queuedInput.set(receipt.runId, receipt.messageId);
    if (
      ['queued', 'running', 'waiting_permission'].includes(
        this.store.getRun(receipt.runId).status,
      )
    )
      this.start(receipt.runId, false);
    else if (['interrupted', 'recovery_required', 'stopped'].includes(this.store.getRun(receipt.runId).status))
      this.start(receipt.runId, true);
    return receipt;
  }
  private start(runId: string, recovery: boolean, approvedExecutionId?: string, inspectOnly = false) {
    if (this.running.has(runId)) return;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.engine.run(runId, controller.signal, recovery, approvedExecutionId, inspectOnly))
      .finally(() => {
        this.running.delete(runId);
        // 每条新消息最多补启动一次；正常已应用的输入、旧待办、退出应用都不会触发。
        const messageId = this.queuedInput.get(runId);
        this.queuedInput.delete(runId);
        if (!this.closing && messageId && !this.store.messageById(this.store.getRun(runId).conversation_id, messageId)?.applied &&
            ['stopped', 'interrupted', 'recovery_required'].includes(this.store.getRun(runId).status)) this.start(runId, true);
      });
    this.running.set(runId, { controller, done });
    void done.catch(() => {});
  }
  async wait(runId: string) {
    while (this.running.has(runId)) await this.running.get(runId)!.done;
    return this.store.getRun(runId);
  }
  approve(conversationId: string, approvalId: string, decision: 'allow' | 'deny') {
    this.store.decideApproval(conversationId, approvalId, decision);
    const a = this.store.approval(approvalId);
    const run = this.store.getRun(a.run_id),
      tool = this.store.tool(a.execution_id);
    // 已完成决定的迟到重发只确认接收，不重启已结算运行。
    if (
      tool.state === 'prepared' &&
      [
        'queued',
        'running',
        'waiting_permission',
        'interrupted',
        'recovery_required',
      ].includes(run.status) &&
      !this.running.has(a.run_id)
    )
      this.start(a.run_id, true, a.execution_id);
  }
  requestStop(conversationId: string, runId: string) {
    const r = this.store.getRun(runId);
    if (r.conversation_id !== conversationId)
      throw new UmiError('PROTOCOL_INVALID', '运行不属于当前会话');
    if (['completed', 'failed', 'stopped'].includes(r.status) || r.stop_requested) return;
    this.store.commit(
      { conversationId, runId },
      { type: 'run.stop_requested', payload: { reason: '用户点击停止' } },
    );
    const task = this.running.get(runId);
    if (task) {
      task.controller.abort();
    } else {
      for (const t of this.store.tools(runId).filter((t) => t.state === 'prepared')) {
        if (t.approval_id) this.store.invalidateApproval(t.id, '用户已停止任务');
        this.store.settle(
          t.id,
          { outcome: 'cancelled', content: '用户停止任务，工具尚未派发。', data: null },
          r.generation,
        );
      }
      this.store.commit(
        { conversationId, runId },
        {
          type: 'run.stopped',
          payload: { reason: '任务已停止；派发记录仍保留以供恢复核验' },
        },
      );
    }
  }
  async stop(conversationId: string, runId: string) {
    this.requestStop(conversationId, runId);
    await this.wait(runId);
  }
  resume(conversationId: string, runId: string) {
    const r = this.store.getRun(runId);
    if (r.conversation_id !== conversationId)
      throw new UmiError('PROTOCOL_INVALID', '运行不属于当前会话');
    if (
      ![
        'queued',
        'interrupted',
        'stopped',
        'recovery_required',
        'waiting_permission',
      ].includes(r.status)
    )
      throw new UmiError('RUN_STATE', '当前状态不能恢复');
    const budget = this.engine.recoveryBudget(runId);
    if (!budget.canResume)
      throw new UmiError(
        'CONTEXT_BUDGET_BLOCKED',
        budget.reason ?? '上下文预算阻塞尚未解除',
      );
    this.start(runId, true, undefined, true);
  }
  inspectRecovery(conversationId: string, runId: string) {
    const r = this.store.getRun(runId);
    if (r.conversation_id !== conversationId)
      throw new UmiError('PROTOCOL_INVALID', '运行不属于当前会话');
    return {
      run: r,
      budget: this.engine.recoveryBudget(runId),
      tools: this.store.tools(runId).map((t) => ({
        executionId: t.id,
        name: t.name,
        state: t.state,
        contextRef: t.context_ref,
      })),
      unresolvedEnvironment: this.store
        .unresolvedEnvironment(r.environment_id)
        .map((t) => ({ runId: t.run_id, executionId: t.id, state: t.state })),
      materializations: this.store.runtimeFacts(r.environment_id),
      taskAcceptance: this.tasks.assess(conversationId),
      commandExecutions: Object.entries(
        this.store.snapshot(conversationId).commandExecutions,
      ).filter(([, p]) => p.runId === runId),
      pendingApprovals: Object.entries(
        this.store.snapshot(conversationId).approvals,
      ).filter(([, a]) => a.status === 'pending'),
    };
  }
  async *subscribe(conversationId: string, cursor: Cursor, signal: AbortSignal) {
    // 读取固定快照后用同一日志补齐；订阅只观察，无权取消运行。
    this.store.events(conversationId, cursor);
    let current = { ...cursor };
    while (!signal.aborted) {
      for (const e of this.store.events(conversationId, current)) {
        current = { streamId: e.streamId, logEpoch: e.logEpoch, sequence: e.sequence };
        yield e;
      }
      try {
        await delay(25, undefined, { signal });
      } catch {
        break;
      }
    }
  }
  async close() {
    // 应用退出保存中断，不把窗口/订阅关闭伪装成用户停止。
    this.closing = true;
    this.queuedInput.clear();
    const tasks = [...this.running.values()];
    for (const task of tasks)
      task.controller.abort(new UmiError('APP_SHUTDOWN', '应用正在退出'));
    await Promise.allSettled(tasks.map((t) => t.done));
    this.store.close();
  }
}
