import type { QuestionRequest } from './question.js';
import type { ResourceScope, MaterializationFailure } from './resource-scope.js';
import type { WorkEvent } from './events.js';
import type { Cursor, RunStatus, Phase, ToolOutcome } from './model.js';
import { UmiError } from './model.js';
import type { BudgetBlock } from './budget.js';
import type { ContextMetrics, ContextWindow } from './memory.js';

export type Block = {
  id: string;
  runId: string;
  turnId: string;
  attemptId: string;
  kind: 'reasoning' | 'text' | 'tool';
  displayRole: 'commentary' | 'final';
  text: string;
  deltaIndex: number;
  status: 'running' | 'completed' | 'interrupted';
  sequence: string;
};
export type ConversationState = {
  cursor: Cursor;
  environmentRevision?: number;
  runs: Record<
    string,
    {
      status: RunStatus;
      phase: Phase;
      finalMessageId?: string;
      failureSummary?: { messageId: string; inputId: string; text: string };
      acceptance?: { status: string; artifactRef: string };
      reason?: string;
      code?: string;
      budgetBlock?: BudgetBlock;
      startedAt?: string;
      finishedAt?: string;
    }
  >;
  turns: Record<
    string,
    { runId: string; requestId: string; contextId: string; attemptIds: string[] }
  >;
  attempts: Record<
    string,
    {
      runId: string;
      turnId: string;
      status: 'running' | 'completed' | 'interrupted';
      finishReason?: string;
      responseRef?: string;
    }
  >;
  blocks: Block[];
  tools: Record<
    string,
    {
      name: string;
      runId: string;
      turnId: string;
      attemptId: string;
      executionId: string;
      sequence: string;
      resultRef?: string;
      verification?: string;
      status: 'prepared' | 'running' | ToolOutcome;
    }
  >;
  questions?: Record<string, QuestionRequest>;
  approvals: Record<
    string,
    {
      callId: string;
      description: string;
      status: 'pending' | 'allow' | 'deny' | 'invalidated';
    }
  >;
  messages: {
    id: string;
    hash: string;
    runId?: string;
    turnId?: string;
    attemptId?: string;
  }[];
  resources: Record<
    string,
    {
      mountId?: string;
      access?: 'read' | 'edit';
      scope?: 'conversation' | 'run';
      baselineRef?: string;
      excluded?: string[];
      materializationError?: {
        code: string;
        reason: string;
        failure?: MaterializationFailure;
      };
    }
  >;
  changesets: Record<
    string,
    {
      runId: string;
      mountId: string;
      artifactRef: string;
      items: Record<string, { status: string; receiptRef?: string }>;
    }
  >;
  candidates: Record<
    string,
    { path: string; identity: string; resourceScope?: ResourceScope }
  >;
  providerExecutions: Record<
    string,
    {
      callId: string;
      runId: string;
      status: 'planned' | 'located' | 'completed';
      planRef: string;
      planHash: string;
      locatorRef?: string;
      receiptRef?: string;
    }
  >;
  commandExecutions: Record<
    string,
    {
      callId: string;
      runId: string;
      status: 'planned' | 'ready' | 'running' | 'exited';
      snapshotRef: string;
      outputs: {
        outputIndex: number;
        channel: 'stdout' | 'stderr';
        artifactRef: string;
        byteLength: number;
      }[];
      owner?: { pid: number; birth: string };
      child?: { pid: number; birth: string };
      started?: boolean;
      receiptRef?: string;
      jobInactive?: boolean;
      exitCode?: number | null;
    }
  >;
  materializations: Record<
    string,
    {
      resourceId: string;
      planRef: string;
      rootIdentity?: string;
      status: 'planned' | 'ready' | 'failed';
    }
  >;
  tasks: Record<string, { version: number; artifactRef: string; executionId: string;
    lifecycle?: 'active' | 'suspended' | 'cancelled'; stateSourceMessageId?: string; stateRef?: string }>;
  memory: {
    window: ContextWindow;
    entries: Record<string, { kind: string; artifactRef: string }>;
    maintenance: Record<
      string,
      {
        runId: string;
        planRef: string;
        status: 'started' | 'failed' | 'completed';
        code?: string;
        usageRef?: string;
        responseRef?: string;
      }
    >;
  };
  context: {
    contextId?: string;
    requestId?: string;
    estimatedInputTokens?: number;
    inputCeiling?: number;
    metrics?: ContextMetrics;
    lastUsageRef?: string;
    lastUsageRequestId?: string;
  };
};
export function initialState(streamId: string, logEpoch: string): ConversationState {
  return {
    cursor: { streamId, logEpoch, sequence: '0' },
    runs: {},
    turns: {},
    attempts: {},
    blocks: [],
    tools: {},
    approvals: {},
    questions: {},
    messages: [],
    resources: {},
    changesets: {},
    candidates: {},
    materializations: {},
    commandExecutions: {},
    providerExecutions: {},
    tasks: {},
    memory: {
      window: { version: 1, summaryRef: null, manifestRef: null, resetEntryId: null },
      entries: {},
      maintenance: {},
    },
    context: {},
  };
}
// 归约只处理持久事实；不会读取时钟、路径或模型。实时与历史调用同一个函数。
export function reduceConversation(
  previous: ConversationState,
  e: WorkEvent,
): ConversationState {
  if (e.streamId !== previous.cursor.streamId || e.logEpoch !== previous.cursor.logEpoch)
    throw new UmiError('CURSOR_INVALID', '事件属于其他会话或日志版本');
  const seq = BigInt(e.sequence),
    prior = BigInt(previous.cursor.sequence);
  if (seq <= prior) return previous;
  if (seq !== prior + 1n) throw new UmiError('CURSOR_GAP', '事件存在缺口，必须先补齐');
  // 高频文字事件只复制被改变的块；其他事实共享只读引用，旧快照保持不变。
  if (e.type === 'model.delta') {
    const index = previous.blocks.findIndex(b => b.id === e.payload.blockId);
    const b = previous.blocks[index];
    if (
      !b ||
      b.runId !== e.runId ||
      b.turnId !== e.modelTurnId ||
      b.attemptId !== e.modelAttemptId ||
      b.kind !== e.payload.kind ||
      b.status !== 'running' ||
      e.payload.deltaIndex !== b.deltaIndex + 1
    )
      throw new UmiError('PROTOCOL_INVALID', '模型块归属、顺序或生命周期错误');

    const blocks = previous.blocks.slice();
    blocks[index] = { ...b, text: b.text + e.payload.text, deltaIndex: e.payload.deltaIndex };
    return { ...previous, cursor: { ...previous.cursor, sequence: e.sequence }, blocks };
  }
  const s = structuredClone(previous);
  s.cursor.sequence = e.sequence;
  const run = e.runId ? s.runs[e.runId] : undefined;
  const requireRun = () => {
    if (!run) throw new UmiError('PROTOCOL_INVALID', '事件运行尚未创建');
    return run;
  };
  const requireAttempt = () => {
    const a = s.attempts[e.modelAttemptId!];
    if (!a || a.turnId !== e.modelTurnId || a.runId !== e.runId)
      throw new UmiError('PROTOCOL_INVALID', '模型 attempt 归属错误');
    return a;
  };
  const requireTool = () => {
    const t = s.tools[e.callId!];
    if (
      !t ||
      t.runId !== e.runId ||
      t.turnId !== e.modelTurnId ||
      t.attemptId !== e.modelAttemptId ||
      t.executionId !== e.executionId
    )
      throw new UmiError('PROTOCOL_INVALID', '工具 call/turn/attempt/execution 归属错误');
    return t;
  };
  // 人类交互随最新意图失效；历史问题/回答仍保留。
  if (['input.accepted', 'run.stop_requested', 'run.interrupted', 'run.stopped', 'run.failed'].includes(e.type)) {
    for (const question of Object.values(s.questions ?? {}))
      if (question.runId === e.runId && question.status === 'pending') question.status = 'cancelled';
  }
  switch (e.type) {
    case 'question.requested': {
      const tool = requireTool();
      if (tool.name !== 'ask_user_question' || tool.status !== 'running' || e.payload.questionId !== e.executionId || s.questions?.[e.payload.questionId])
        throw new UmiError('PROTOCOL_INVALID', '问题执行身份错误');
      (s.questions ??= {})[e.payload.questionId] = { callId: e.callId!, runId: e.runId!, questions: e.payload.questions, status: 'pending' };
      break;
    }
    case 'question.answered': {
      requireTool();
      const question = s.questions?.[e.payload.questionId];
      if (!question || question.status !== 'pending' || question.callId !== e.callId || e.payload.questionId !== e.executionId)
        throw new UmiError('PROTOCOL_INVALID', '问题不能重复回答');
      question.status = 'answered'; question.answers = e.payload.answers;
      break;
    }
    case 'environment.revised':
      s.environmentRevision = e.payload.revision;
      break;
    case 'task.state_changed': {
      requireTool();
      const task = s.tasks[e.payload.taskId];
      if (!task) throw new UmiError('PROTOCOL_INVALID', '任务身份不存在');
      task.lifecycle = e.payload.state;
      task.stateSourceMessageId = e.payload.sourceMessageId;
      task.stateRef = e.payload.artifactRef;
      break;
    }
    case 'task.checkpoint_recorded': {
      requireTool();
      const prior = s.tasks[e.payload.taskId];
      if (e.payload.version !== (prior?.version ?? 0) + 1)
        throw new UmiError('TASK_STALE', '任务检查点版本不连续');
      s.tasks[e.payload.taskId] = {
        ...s.tasks[e.payload.taskId],
        version: e.payload.version,
        artifactRef: e.payload.artifactRef,
        executionId: e.executionId!,
      };
      break;
    }
    case 'run.acceptance_reported':
      requireRun().acceptance = e.payload;
      break;
    case 'context.budget_blocked':
      requireRun().budgetBlock = e.payload;
      break;
    case 'context.budget_cleared':
      delete requireRun().budgetBlock;
      break;
    case 'memory.recorded':
      requireTool();
      if (s.memory.entries[e.payload.entryId])
        throw new UmiError('PROTOCOL_INVALID', '记忆重复记录');
      s.memory.entries[e.payload.entryId] = {
        kind: e.payload.kind,
        artifactRef: e.payload.artifactRef,
      };
      break;
    case 'context.maintenance_started':
      requireRun();
      if (
        e.payload.baseVersion !== s.memory.window.version ||
        s.memory.maintenance[e.payload.maintenanceId]
      )
        throw new UmiError('PROTOCOL_INVALID', '维护版本或身份错误');
      s.memory.maintenance[e.payload.maintenanceId] = {
        runId: e.runId!,
        planRef: e.payload.planRef,
        status: 'started',
      };
      break;
    case 'context.maintenance_failed':
    case 'context.window_committed':
    case 'context.maintenance_usage':
    case 'context.maintenance_response': {
      const m = s.memory.maintenance[e.payload.maintenanceId];
      if (!m || m.runId !== e.runId)
        throw new UmiError('PROTOCOL_INVALID', '上下文维护归属错误');
      if (m.status !== 'started')
        throw new UmiError('PROTOCOL_INVALID', '已结算维护不能再次改写');
      if (e.type === 'context.maintenance_usage') {
        if (m.usageRef) throw new UmiError('PROTOCOL_INVALID', '维护用量重复');
        m.usageRef = e.payload.usageRef;
        break;
      }
      if (e.type === 'context.maintenance_response') {
        if (m.responseRef) throw new UmiError('PROTOCOL_INVALID', '维护响应重复');
        m.responseRef = e.payload.responseRef;
        break;
      }
      if (e.type === 'context.maintenance_failed') {
        m.status = 'failed';
        m.code = e.payload.code;
      } else {
        if (e.payload.version !== s.memory.window.version + 1)
          throw new UmiError('PROTOCOL_INVALID', '上下文版本不连续');
        m.status = 'completed';
        s.memory.window = {
          version: e.payload.version,
          summaryRef: e.payload.summaryRef,
          manifestRef: e.payload.manifestRef,
          resetEntryId: e.payload.resetEntryId,
        };
      }
      break;
    }
    case 'context.snapshot_created':
      s.context = {
        ...s.context,
        contextId: e.payload.contextId,
        requestId: e.payload.requestId,
        estimatedInputTokens: e.payload.estimatedInputTokens,
        inputCeiling: e.payload.inputCeiling,
        ...(e.payload.metrics ? { metrics: e.payload.metrics } : {}),
      };
      break;
    case 'usage.recorded':
      s.context.lastUsageRef = e.payload.usageRef;
      s.context.lastUsageRequestId = e.payload.requestId;
      break;
    case 'execution.planned':
      if (requireTool().status !== 'running' || s.providerExecutions[e.executionId!])
        throw new UmiError('PROTOCOL_INVALID', '中立执行未派发或重复计划');
      s.providerExecutions[e.executionId!] = {
        callId: e.callId!,
        runId: e.runId!,
        status: 'planned',
        planRef: e.payload.planRef,
        planHash: e.payload.planHash,
      };
      break;
    case 'execution.located':
    case 'execution.completed':
    case 'execution.reconciled': {
      requireTool();
      const p = s.providerExecutions[e.executionId!];
      if (
        !p ||
        p.callId !== e.callId ||
        p.runId !== e.runId ||
        (p.status === 'completed' && e.type !== 'execution.reconciled')
      )
        throw new UmiError('PROTOCOL_INVALID', '中立执行计划或归属错误');
      if (e.type === 'execution.reconciled' && !p.receiptRef)
        throw new UmiError('PROTOCOL_INVALID', '缺少原观察回执');
      if (e.type === 'execution.located') {
        if (p.locatorRef) throw new UmiError('PROTOCOL_INVALID', '原定位不能覆盖');
        p.locatorRef = e.payload.locatorRef;
        p.status = 'located';
      } else {
        p.receiptRef = e.payload.receiptRef;
        p.status = 'completed';
      }
      break;
    }
    case 'process.planned':
      if (requireTool().status !== 'running' || s.commandExecutions[e.executionId!])
        throw new UmiError('PROTOCOL_INVALID', '进程执行尚未派发或重复计划');
      s.commandExecutions[e.executionId!] = {
        callId: e.callId!,
        runId: e.runId!,
        status: 'planned',
        snapshotRef: e.payload.snapshotRef,
        outputs: [],
      };
      break;
    case 'process.owner_bound':
    case 'process.ready':
    case 'process.release_intent':
    case 'process.started':
    case 'process.output':
    case 'process.exited':
    case 'process.reconciled': {
      requireTool();
      const p = s.commandExecutions[e.executionId!];
      if (!p || p.callId !== e.callId)
        throw new UmiError('PROTOCOL_INVALID', '进程计划或归属错误');
      if (e.type === 'process.ready') {
        if (
          p.status !== 'planned' ||
          p.owner?.pid !== e.payload.bridgePid ||
          p.owner?.birth !== e.payload.bridgeBirth
        )
          throw new UmiError('PROTOCOL_INVALID', '进程就绪状态或所有者错误');
        p.status = 'ready';
        p.child = { pid: e.payload.childPid, birth: e.payload.childBirth };
      }
      if (e.type === 'process.owner_bound') {
        if (p.status !== 'planned' || p.owner)
          throw new UmiError('PROTOCOL_INVALID', '桥接身份绑定状态错误');
        p.owner = { pid: e.payload.bridgePid, birth: e.payload.bridgeBirth };
      }
      if (e.type === 'process.release_intent') {
        if (p.status !== 'ready')
          throw new UmiError('PROTOCOL_INVALID', '进程尚未挂起就绪');
        p.status = 'running';
      }
      if (e.type === 'process.started') {
        if (p.status !== 'running' || p.started)
          throw new UmiError('PROTOCOL_INVALID', '进程启动缺少释放意图或已启动');
        p.started = true;
      }
      if (e.type === 'process.output') {
        if (
          p.status !== 'running' ||
          !p.started ||
          e.payload.outputIndex !== p.outputs.length
        )
          throw new UmiError('PROTOCOL_INVALID', '进程输出顺序或状态错误');
        p.outputs.push(e.payload);
      }
      if (e.type === 'process.exited') {
        if (p.status === 'exited') throw new UmiError('PROTOCOL_INVALID', '进程回执重复');
        p.status = 'exited';
        p.receiptRef = e.payload.receiptRef;
        p.jobInactive = e.payload.jobInactive;
        p.exitCode = e.payload.exitCode;
      }
      if (e.type === 'process.reconciled') {
        if (p.status !== 'exited' || p.jobInactive !== false)
          throw new UmiError('PROTOCOL_INVALID', '进程没有待核验的清理回执');
        p.receiptRef = e.payload.receiptRef;
        p.jobInactive = true;
      }
      break;
    }
    case 'resource.discovered':
      s.candidates[e.payload.candidateId] = {
        path: e.payload.path,
        identity: e.payload.identity,
        ...(e.payload.resourceScope ? { resourceScope: e.payload.resourceScope } : {}),
      };
      break;
    case 'resource.materialization_started':
      s.materializations[e.payload.mountId] = {
        resourceId: e.payload.resourceId,
        planRef: e.payload.planRef,
        status: 'planned',
      };
      break;
    case 'resource.materialization_root_bound': {
      const m = s.materializations[e.payload.mountId];
      if (!m) throw new UmiError('PROTOCOL_INVALID', '物化计划缺失');
      m.rootIdentity = e.payload.rootIdentity;
      break;
    }
    case 'resource.authorized':
      s.resources[e.payload.resourceId] = {
        ...s.resources[e.payload.resourceId],
        access: e.payload.access,
        scope: e.payload.scope,
      };
      break;
    case 'resource.materialized': {
      const { materializationError: _error, ...priorResource } =
        s.resources[e.payload.resourceId] ?? {};
      s.resources[e.payload.resourceId] = {
        ...priorResource,
        mountId: e.payload.mountId,
        baselineRef: e.payload.baselineRef,
        excluded: e.payload.excluded,
      };
      if (s.materializations[e.payload.mountId])
        s.materializations[e.payload.mountId]!.status = 'ready';
      break;
    }
    case 'resource.materialization_failed':
      s.resources[e.payload.resourceId] = {
        ...s.resources[e.payload.resourceId],
        materializationError: {
          code: e.payload.code,
          reason: e.payload.reason,
          ...(e.payload.failure ? { failure: e.payload.failure } : {}),
        },
      };
      for (const m of Object.values(s.materializations))
        if (m.resourceId === e.payload.resourceId && m.status === 'planned')
          m.status = 'failed';
      break;
    case 'changeset.created':
      requireTool();
      s.changesets[e.payload.changeSetId] = {
        runId: e.runId!,
        mountId: e.payload.mountId,
        artifactRef: e.payload.artifactRef,
        items: {},
      };
      break;
    case 'delivery.item_intent':
    case 'delivery.item_settled': {
      requireTool();
      const cs = s.changesets[e.payload.changeSetId];
      if (!cs) throw new UmiError('PROTOCOL_INVALID', '交付变更集尚未创建');
      cs.items[e.payload.path] =
        e.type === 'delivery.item_intent'
          ? { status: 'intent' }
          : { status: e.payload.outcome, receiptRef: e.payload.receiptRef };
      break;
    }
    case 'run.created':
      s.runs[e.runId!] = { status: 'queued', phase: 'execute', startedAt: e.occurredAt };
      break;
    case 'run.started':
    case 'run.resumed':
      requireRun().status = 'running';
      delete requireRun().reason;
      delete requireRun().code;
      delete requireRun().finishedAt;
      break;
    case 'run.phase_changed':
      requireRun().phase = e.payload.phase;
      break;
    case 'run.waiting':
      requireRun().status = 'waiting_permission';
      requireRun().phase = 'waiting';
      break;
    case 'run.stop_requested':
      requireRun().status = 'stopping';
      break;
    case 'run.stopped':
      requireRun().status = 'stopped';
      requireRun().finishedAt = e.occurredAt;
      break;
    case 'run.interrupted':
      requireRun().status = 'interrupted';
      requireRun().finishedAt = e.occurredAt;
      requireRun().reason = e.payload.reason;
      if (e.payload.code) requireRun().code = e.payload.code;
      break;
    case 'run.recovery_started':
      requireRun().status = 'recovering';
      break;
    case 'run.recovery_required':
      requireRun().status = 'recovery_required';
      requireRun().reason = e.payload.reason;
      break;
    case 'run.failure_summary':
      if (!s.messages.some(m => m.id === e.payload.messageId && m.runId === e.runId))
        throw new UmiError('PROTOCOL_INVALID', '受阻说明缺少本轮正文');
      requireRun().failureSummary = e.payload;
      break;
    case 'run.failed':
      if (e.payload.messageId) {
        requireRun().finalMessageId = e.payload.messageId;
        const message = s.messages.find(m => m.id === e.payload.messageId && m.runId === e.runId);
        if (!message) throw new UmiError('PROTOCOL_INVALID', '失败收尾缺少本轮正文');
        for (const b of s.blocks)
          if (b.runId === e.runId && b.attemptId === message.attemptId && b.kind === 'text' && b.status === 'completed')
            b.displayRole = 'final';
      }
      requireRun().status = 'failed';
      requireRun().finishedAt = e.occurredAt;
      requireRun().reason = e.payload.reason;
      requireRun().code = e.payload.code;
      break;
    case 'run.completed': {
      requireRun().status = 'completed';
      requireRun().finalMessageId = e.payload.messageId;
      requireRun().finishedAt = e.occurredAt;
      // 完成事实决定哪个完整响应是最终正文；实时消费和旧历史重放都使用这一投影。
      const message = s.messages.find(
        (m) => m.id === e.payload.messageId && m.runId === e.runId,
      );
      if (message?.attemptId && s.attempts[message.attemptId]?.status === 'completed')
        for (const b of s.blocks)
          if (
            b.runId === e.runId &&
            b.attemptId === message.attemptId &&
            b.kind === 'text' &&
            b.status === 'completed'
          )
            b.displayRole = 'final';
      break;
    }
    case 'model.request_prepared':
      requireRun();
      if (s.turns[e.modelTurnId!])
        throw new UmiError('PROTOCOL_INVALID', '模型 turn 重复创建');
      s.turns[e.modelTurnId!] = {
        runId: e.runId!,
        requestId: e.payload.requestId,
        contextId: e.payload.contextId,
        attemptIds: [],
      };
      break;
    case 'model.attempt_started': {
      const t = s.turns[e.modelTurnId!];
      if (
        !t ||
        t.runId !== e.runId ||
        t.requestId !== e.payload.requestId ||
        s.attempts[e.modelAttemptId!] ||
        t.attemptIds.some((id) => s.attempts[id]?.status === 'running')
      )
        throw new UmiError('PROTOCOL_INVALID', '模型 attempt 开始的归属或生命周期错误');
      t.attemptIds.push(e.modelAttemptId!);
      s.attempts[e.modelAttemptId!] = {
        runId: e.runId!,
        turnId: e.modelTurnId!,
        status: 'running',
      };
      break;
    }
    case 'model.block_started':
      if (requireAttempt().status !== 'running')
        throw new UmiError('PROTOCOL_INVALID', '模型 attempt 已结束');
      if (s.blocks.some((b) => b.id === e.payload.blockId))
        throw new UmiError('PROTOCOL_INVALID', '模型块重复创建');
      s.blocks.push({
        id: e.payload.blockId,
        runId: e.runId!,
        turnId: e.modelTurnId!,
        attemptId: e.modelAttemptId!,
        kind: e.payload.kind,
        displayRole: e.payload.displayRole,
        text: '',
        deltaIndex: -1,
        status: 'running',
        sequence: e.sequence,
      });
      break;
    case 'model.block_completed': {
      const b = s.blocks.find((b) => b.id === e.payload.blockId);
      if (
        !b ||
        b.runId !== e.runId ||
        b.turnId !== e.modelTurnId ||
        b.attemptId !== e.modelAttemptId ||
        b.status !== 'running'
      )
        throw new UmiError('PROTOCOL_INVALID', '模型块结束归属错误');
      b.status = 'completed';
      break;
    }
    case 'model.attempt_completed': {
      const a = requireAttempt();
      if (
        a.status !== 'running' ||
        s.blocks.some((b) => b.attemptId === e.modelAttemptId && b.status === 'running')
      )
        throw new UmiError('PROTOCOL_INVALID', '模型 attempt 完成状态不一致');
      a.status = 'completed';
      a.finishReason = e.payload.finishReason;
      a.responseRef = e.payload.responseRef;
      break;
    }
    // 测量不改变生命周期，不进入模型事实；按 request/attempt 区分重试耗时。
    case 'model.attempt_measured': {
      const attempt = requireAttempt();
      if (attempt.status !== 'running' || s.turns[e.modelTurnId!]?.requestId !== e.payload.requestId)
        throw new UmiError('PROTOCOL_INVALID', '模型测量归属或生命周期错误');
      break;
    }
    case 'model.attempt_failed':
      if (requireAttempt().status !== 'running')
        throw new UmiError('PROTOCOL_INVALID', '模型 attempt 已结算');
      requireAttempt().status = 'interrupted';
      for (const b of s.blocks)
        if (b.attemptId === e.modelAttemptId) b.status = 'interrupted';
      break;
    case 'message.committed':
    case 'input.accepted':
      s.messages.push({
        id: e.payload.messageId,
        hash: e.payload.hash,
        ...(e.runId ? { runId: e.runId } : {}),
        ...(e.modelTurnId ? { turnId: e.modelTurnId } : {}),
        ...(e.modelAttemptId ? { attemptId: e.modelAttemptId } : {}),
      });
      break;
    case 'tool.prepared':
      if (requireAttempt().status !== 'completed' || s.tools[e.callId!])
        throw new UmiError('PROTOCOL_INVALID', '工具没有完整模型响应或重复准备');
      s.tools[e.callId!] = {
        name: e.payload.name,
        runId: e.runId!,
        turnId: e.modelTurnId!,
        attemptId: e.modelAttemptId!,
        executionId: e.executionId!,
        sequence: e.sequence,
        status: 'prepared',
      };
      break;
    case 'tool.dispatch_intent':
    case 'tool.started': {
      const t = requireTool();
      if (!['prepared', 'running'].includes(t.status))
        throw new UmiError('PROTOCOL_INVALID', '已结算工具不能再次派发');
      t.status = 'running';
      break;
    }
    case 'tool.settled':
    case 'tool.reconciled': {
      const t = requireTool();
      t.status = e.payload.outcome;
      t.resultRef = e.payload.resultRef;
      const question = s.questions?.[e.executionId!];
      if (question?.status === 'pending') question.status = 'cancelled';
      if (e.type === 'tool.reconciled') t.verification = e.payload.verification;
      break;
    }
    case 'tool.measured':
      requireTool(); // 观察耗时，不改变工具或批准状态。
      break;
    case 'approval.requested':
      if (requireTool().status !== 'prepared' || s.approvals[e.payload.approvalId])
        throw new UmiError('PROTOCOL_INVALID', '批准对象状态错误');
      s.approvals[e.payload.approvalId] = {
        callId: e.callId!,
        description: e.payload.description,
        status: 'pending',
      };
      break;
    case 'approval.decided':
    case 'approval.invalidated': {
      requireTool();
      const a = s.approvals[e.payload.approvalId];
      if (!a || a.callId !== e.callId)
        throw new UmiError('PROTOCOL_INVALID', '批准对象不存在或归属错误');
      a.status = e.type === 'approval.decided' ? e.payload.decision : 'invalidated';
      break;
    }
  }
  return s;
}
export function projectConversation(s: ConversationState) {
  return {
    ...s,
    activeReasoning: s.blocks.filter(
      (b) =>
        b.kind === 'reasoning' &&
        b.status === 'running' &&
        s.runs[b.runId]?.status === 'running',
    ),
    processes: Object.entries(s.runs).map(([runId, r]) => ({
      runId,
      collapsedByDefault: r.status === 'completed',
      status: r.status,
      blocks: s.blocks.filter((b) => b.runId === runId),
      finalMessageId: r.finalMessageId ?? null,
    })),
  };
}
