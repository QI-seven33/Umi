import type { SqliteStore } from './store.js';
import { hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import { taskCheckpointInputSchema, taskStateInputSchema } from '../../../protocol/src/task.js';
import {
  directCommandSchema,
  shellCommandSchema,
} from '../../../protocol/src/process.js';
import type {
  TaskStateInput,
  TaskCheck,
  TaskCheckpoint,
  TaskCheckpointInput,
  TaskAssessment,
  TaskAcceptance,
} from '../../../protocol/src/task.js';
import type { TaskPort } from '../../../agent/src/tasks.js';
import type { ToolRow, ToolResult } from '../../../agent/src/persistence.js';

export type CurrentTaskEvidence = (
  check: TaskCheck,
  tool: ToolRow,
  result: ToolResult,
) => boolean;
const AUTHORITY =
  '仅核验所记录的验收项；目标和验收覆盖由模型提出，不保证完整覆盖用户要求，不授予权限。命令退出仅证明指定程序的退出结果；主观质量须另行审阅。';

export class TaskRepository implements TaskPort {
  constructor(
    private readonly store: SqliteStore,
    private readonly currentEvidence: CurrentTaskEvidence,
  ) {}

  list(conversationId: string): TaskCheckpoint[] {
    return Object.values(this.store.snapshot(conversationId).tasks).map((item) =>
      this.store.readArtifact<TaskCheckpoint>(item.artifactRef),
    );
  }
  // 按原执行读取已提交事实，包含被后续版本覆盖的检查点；不调用 save/transition。
  observation(executionId: string): unknown | null {
    const tool = this.store.tool(executionId), run = this.store.getRun(tool.run_id);
    const event = this.store.events(run.conversation_id).find(e => e.executionId === executionId &&
      (e.type === 'task.checkpoint_recorded' || e.type === 'task.state_changed'));
    return event && (event.type === 'task.checkpoint_recorded' || event.type === 'task.state_changed')
      ? this.store.readArtifact(event.payload.artifactRef) : null;
  }
  private latestInput(conversationId: string) {
    return this.store
      .messages(conversationId)
      .filter((row) => row.applied && row.role === 'user')
      .at(-1);
  }
  private evidence(
    conversationId: string,
    check: TaskCheck,
    executionId: string,
    inputId = this.latestInput(conversationId)?.id,
  ): boolean {
    try {
      if (check.kind === 'review') return false;
      const tool = this.store.tool(executionId);
      if (
        this.store.getRun(tool.run_id).conversation_id !== conversationId ||
        tool.state !== 'succeeded' ||
        !tool.result_ref
      )
        return false;
      const result = this.store.readArtifact<ToolResult>(tool.result_ref);
      if (result.outcome !== 'succeeded') return false;
      const args = JSON.parse(tool.args);
      const data = result.data as Record<string, unknown> | null;
      if (!data) return false;
      if (check.kind === 'file_hash') {
        if (
          tool.name !== 'stat_file' ||
          args.mountId !== check.mountId ||
          args.path !== check.path ||
          data.mountId !== check.mountId ||
          data.path !== check.path
        )
          return false;
        const entry = data.entry as { hash: string } | null;
        if ((entry?.hash ?? null) !== check.expectedHash) return false;
      } else if (check.kind === 'command_exit') {
        const normalized =
          check.command.name === 'run_command'
            ? directCommandSchema.parse(args)
            : shellCommandSchema.parse(args);
        if (
          tool.name !== check.command.name ||
          hash(normalized) !== hash(check.command.args) ||
          data.exitCode !== 0 ||
          data.reason !== 'exited' ||
          data.jobInactive !== true ||
          data.gateReleased !== true ||
          data.inspectionError
        )
          return false;
        const state = this.store.snapshot(conversationId).commandExecutions[tool.id];
        if (
          !state?.receiptRef ||
          hash(this.store.readArtifact(state.receiptRef)) !== hash(data)
        )
          return false;
      } else if (check.kind === 'document_open') {
        if (tool.name !== 'open_delivered_file' || args.path !== check.path || data.path !== check.path ||
          data.changeSetId !== args.changeSetId || data.systemAccepted !== true) return false;
      } else if (check.kind === 'export_receipt') {
        if (tool.name === 'export_outputs') {
          if (data.exportExecutionId !== tool.id) return false;
        } else if (tool.name === 'inspect_export') {
          if (args.executionId !== data.exportExecutionId) return false;
        } else return false;
      } else {
        if (
          tool.name !== 'deliver_changeset' ||
          args.changeSetId !== check.changeSetId ||
          data.changeSetId !== check.changeSetId
        )
          return false;
      }
      // 原话更正和环境变化使旧证据退回待审；恢复同一运行不会重新派发副作用。
      const events = this.store.events(conversationId);
      const settled = events.findLastIndex(
        (event) =>
          event.executionId === tool.id &&
          (event.type === 'tool.settled' || event.type === 'tool.reconciled'),
      );
      if (settled < 0) return false;
      const latestId = inputId;
      const inputIndex = events.findLastIndex(
        (event) => event.type === 'input.applied' && event.payload.messageId === latestId,
      );
      if (inputIndex > settled) return false;
      // 全局修订用于执行批准；验收按对应对象重新观察，正常交付不能使不变的副本测试失效。
      return this.currentEvidence(check, tool, result);
    } catch {
      return false;
    }
  }
  save(executionId: string, raw: TaskCheckpointInput): TaskCheckpoint {
    const input = taskCheckpointInputSchema.parse(raw);
    const tool = this.store.tool(executionId);
    const run = this.store.getRun(tool.run_id);
    if (
      tool.name !== 'record_task_checkpoint' ||
      hash(taskCheckpointInputSchema.parse(JSON.parse(tool.args))) !== hash(input)
    )
      throw new UmiError('PROTOCOL_INVALID', '检查点与原工具参数不一致');
    const priorEvent = this.store
      .events(run.conversation_id)
      .find(
        (event) =>
          event.type === 'task.checkpoint_recorded' && event.executionId === executionId,
      );
    if (priorEvent?.type === 'task.checkpoint_recorded')
      return this.store.readArtifact(priorEvent.payload.artifactRef);
    this.store.checkLease(run.id, run.generation);
    if (tool.state !== 'dispatched')
      throw new UmiError('PROTOCOL_INVALID', '检查点要求已派发工具');
    const source = this.store.messageById(run.conversation_id, input.source.messageId);
    if (
      !source?.applied ||
      source.role !== 'user' ||
      !source.payload.content.includes(input.source.quote)
    )
      throw new UmiError('PROTOCOL_INVALID', '任务来源必须逐字引用本会话已应用用户原话');
    if (input.acknowledgedInputId !== this.latestInput(run.conversation_id)?.id)
      throw new UmiError('TASK_STALE', '检查点没有核对最新用户输入');
    const all = this.list(run.conversation_id);
    if (input.supersedesTaskId) {
      const prior = this.store.snapshot(run.conversation_id).tasks[input.supersedesTaskId];
      if (!prior || !['suspended', 'cancelled'].includes(prior.lifecycle ?? 'active'))
        throw new UmiError('TASK_STALE', '替代目标须引用已挂起或取消的原任务，原验收保留');
    }
    const previous = input.taskId
      ? all.find((item) => item.taskId === input.taskId)
      : undefined;
    if (input.taskId && !previous)
      throw new UmiError('PERMISSION_DENIED', '任务不属于当前会话');
    if (
      previous &&
      (previous.version !== input.baseVersion ||
        hash({
          goal: previous.input.goal,
          source: previous.input.source,
          criteria: previous.input.criteria,
          supersedesTaskId: previous.input.supersedesTaskId ?? null,
        }) !== hash({ goal: input.goal, source: input.source, criteria: input.criteria, supersedesTaskId: input.supersedesTaskId ?? null }))
    )
      throw new UmiError(
        'TASK_STALE',
        '检查点版本冲突，目标、来源和验收项不可替换或删除',
      );
    if (!previous && all.length >= 64)
      throw new UmiError('RESOURCE_LIMIT', '会话任务检查点已达上限');
    for (const progress of input.progress) {
      if (progress.status !== 'verified') continue;
      const criterion = input.criteria.find((item) => item.id === progress.criterionId)!;
      if (
        !this.evidence(
          run.conversation_id,
          criterion.check,
          progress.evidenceExecutionId!,
        )
      )
        throw new UmiError(
          'TASK_EVIDENCE_INVALID',
          '验收证据缺失、不匹配、已过期或尚未成功',
        );
    }
    const checkpoint: TaskCheckpoint = {
      taskId: previous?.taskId ?? executionId,
      version: input.baseVersion + 1,
      executionId,
      runId: run.id,
      environmentRevision: this.store.environment(run.environment_id).revision,
      input,
    };
    return this.store.transaction(() => {
      this.store.append(this.store.preparedToolScope(tool), {
        type: 'task.checkpoint_recorded',
        payload: {
          taskId: checkpoint.taskId,
          version: checkpoint.version,
          artifactRef: this.store.artifact(checkpoint, 'task-checkpoint-v1'),
        },
      });
      return checkpoint;
    });
  }
  transition(executionId: string, raw: TaskStateInput) {
    const input = taskStateInputSchema.parse(raw), tool = this.store.tool(executionId),
      run = this.store.getRun(tool.run_id);
    if (tool.name !== 'set_task_state' || tool.state !== 'dispatched' ||
        hash(taskStateInputSchema.parse(JSON.parse(tool.args))) !== hash(input))
      throw new UmiError('PROTOCOL_INVALID', '任务状态与派发工具不一致');
    const existing = this.store.events(run.conversation_id).find((event) =>
      event.type === 'task.state_changed' && event.executionId === executionId);
    if (existing?.type === 'task.state_changed') return this.store.readArtifact(existing.payload.artifactRef);
    this.store.checkLease(run.id, run.generation);
    const checkpoint = this.list(run.conversation_id).find((item) => item.taskId === input.taskId),
      source = this.store.messageById(run.conversation_id, input.source.messageId);
    if (!checkpoint || checkpoint.version !== input.baseVersion)
      throw new UmiError('TASK_STALE', '任务身份或检查点版本不匹配');
    if (!source?.applied || source.role !== 'user' || !source.payload.content.includes(input.source.quote) ||
        source.id !== this.latestInput(run.conversation_id)?.id)
      throw new UmiError('TASK_STALE', '任务关系必须引用最新真实用户原话');
    this.store.commit(this.store.preparedToolScope(tool), { type: 'task.state_changed', payload: {
      taskId: input.taskId, state: input.state, sourceMessageId: source.id,
      artifactRef: this.store.artifact(input, 'task-state'),
    } });
    return input;
  }
  assess(conversationId: string): TaskAcceptance {
    const latestInputId = this.latestInput(conversationId)?.id ?? null;
    const states = this.store.snapshot(conversationId).tasks;
    const tasks: TaskAssessment[] = this.list(conversationId).map((checkpoint) => {
      const lifecycle = states[checkpoint.taskId]?.lifecycle ?? 'active';
      const progress = checkpoint.input.progress.map((item) => {
        if (item.status !== 'verified') return item;
        const criterion = checkpoint.input.criteria.find(
          (entry) => entry.id === item.criterionId,
        )!;
        return this.evidence(conversationId, criterion.check, item.evidenceExecutionId!, lifecycle === 'active' ? latestInputId ?? undefined : checkpoint.input.acknowledgedInputId)
          ? item
          : {
              criterionId: item.criterionId,
              status: 'needs_review' as const,
              reason: '旧证据与当前原话、环境或产物不再匹配，需重新核验',
            };
      });
      if (lifecycle === 'active' && checkpoint.input.acknowledgedInputId !== latestInputId)
        for (let index = 0; index < progress.length; index++)
          if (progress[index]!.status === 'verified')
            progress[index] = {
              criterionId: progress[index]!.criterionId,
              status: 'needs_review',
              reason: '最新用户原话尚未纳入检查点',
            };
      const status = progress.every((item) => item.status === 'verified')
        ? 'criteria_verified'
        : progress.some((item) => ['pending', 'in_progress'].includes(item.status))
          ? 'needs_work'
          : progress.some((item) => item.status === 'blocked')
            ? 'blocked'
            : 'needs_review';
      return {
        taskId: checkpoint.taskId,
        version: checkpoint.version,
        goal: checkpoint.input.goal,
        lifecycle,
        ...(checkpoint.input.supersedesTaskId ? { supersedesTaskId: checkpoint.input.supersedesTaskId } : {}),
        sourceMessageId: checkpoint.input.source.messageId,
        acknowledgedInputId: checkpoint.input.acknowledgedInputId,
        status,
        progress,
        nextAction: checkpoint.input.nextAction,
      };
    });
    const active = tasks.filter((task) => task.lifecycle === 'active');
    const status = !active.length
      ? 'untracked'
      : active.some((item) => item.status === 'needs_work')
        ? 'needs_work'
        : active.some((item) => item.status === 'blocked')
          ? 'blocked'
          : active.some((item) => item.status === 'needs_review')
            ? 'needs_review'
            : 'criteria_verified';
    return { status, latestInputId, tasks, authority: AUTHORITY };
  }
  projection(conversationId: string) {
    const report = this.assess(conversationId);
    const prioritized = [
      ...report.tasks.filter((item) => item.lifecycle === 'active' && item.status !== 'criteria_verified'),
      ...report.tasks.filter((item) => item.lifecycle === 'active' && item.status === 'criteria_verified'),
      ...report.tasks.filter((item) => item.lifecycle !== 'active'),
    ];
    return {
      ...report,
      tasks: prioritized.slice(0, 6).map((item) => ({
        ...item,
        progress: item.progress.map(({ criterionId, status, evidenceExecutionId }) => ({
          criterionId,
          status,
          evidenceExecutionId,
        })),
        goal: item.goal.slice(0, 180),
        nextAction: item.nextAction.slice(0, 240),
      })),
      total: report.tasks.length,
      omitted: Math.max(0, report.tasks.length - 6),
      instruction:
        '完整来源、验收项和阻塞原因使用 read_task_checkpoints；未展示不表示完成。继续执行前核对当前用户原话。',
    };
  }
  complete(runId: string, messageId: string, generation: number, deferred: readonly string[] = [], failure?: { code: string; reason: string }) {
    this.store.transaction(() => {
      this.store.checkLease(runId, generation);
      const run = this.store.getRun(runId);
      if (
        this.store.messages(run.conversation_id).some((item) => item.runId === runId && !item.applied) ||
        this.store
          .tools(runId)
          .some((item) => ['prepared', 'dispatched', 'unknown'].includes(item.state) &&
            !(item.state === 'unknown' && item.result_ref && deferred.includes(item.id)))
      )
        throw new UmiError('TASK_STALE', '新输入或未决副作用阻止结束');
      const report = this.assess(run.conversation_id);
      if (failure) {
        report.status = 'blocked';
        report.authority += ' 本轮执行受阻，正文收尾不证明用户目标完成。';
      }
      if (this.store.unresolvedEnvironment(run.environment_id).length) {
        report.status = 'blocked';
        report.authority += ' 当前回复已处理，历史执行仍未核验；不证明原任务或副作用完成。';
      }
      this.store.append(
        { conversationId: run.conversation_id, runId },
        {
          type: 'run.acceptance_reported',
          payload: {
            status: report.status,
            artifactRef: this.store.artifact(report, 'task-acceptance-v1'),
          },
        },
      );
      this.store.append(
        { conversationId: run.conversation_id, runId },
        failure ? { type: 'run.failed', payload: { ...failure, messageId } } : {
          type: 'run.completed', payload: { messageId },
        },
      );
    });
  }
}
