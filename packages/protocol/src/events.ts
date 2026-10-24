import { questionsSchema, answersSchema } from './question.js';
import { z } from 'zod';
import { resourceScopeSchema, materializationFailureSchema } from './resource-scope.js';
import { id, cursorSchema, outcomeSchema } from './model.js';
import { budgetBlockSchema } from './budget.js';
import { contextMetricsSchema } from './memory.js';

const event = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  z.object({ type: z.literal(type), payload });
const ref = z.object({ messageId: id, hash: id }).strict();
const status = z.enum([
  'queued',
  'running',
  'waiting_permission',
  'stopping',
  'stopped',
  'interrupted',
  'recovering',
  'recovery_required',
  'completed',
  'failed',
]);
const phase = z.enum(['execute', 'waiting', 'finalize']);
const body = z.discriminatedUnion('type', [
  event('workspace.access_changed', z.object({grantId:id,revision:z.number().int().positive(),revoked:z.boolean()}).strict()),
  event('resource.direct_bound', z.object({mountId:id,resourceId:id,grantId:id,access:z.enum(['read','edit'])}).strict()),
  event('file.change_recorded', z.object({changeId:id,state:z.enum(['intent','settled','not_applied'])}).strict()),
  event(
    'task.checkpoint_recorded',
    z
      .object({ taskId: id, version: z.number().int().positive(), artifactRef: id })
      .strict(),
  ),
  event('task.state_changed', z.object({ taskId: id, state: z.enum(['active', 'suspended', 'cancelled']),
    sourceMessageId: id, artifactRef: id }).strict()),
  event(
    'run.acceptance_reported',
    z
      .object({
        status: z.enum([
          'untracked',
          'criteria_verified',
          'needs_work',
          'blocked',
          'needs_review',
        ]),
        artifactRef: id,
      })
      .strict(),
  ),
  event('question.requested', z.object({ questionId: id, questions: questionsSchema }).strict()),
  event('question.answered', z.object({ questionId: id, answers: answersSchema }).strict()),
  event('input.accepted', ref),
  event('input.applied', z.object({ messageId: id }).strict()),
  event('settings.changed', z.object({ version: z.number().int().positive() }).strict()),
  event('run.created', z.object({ environmentId: id }).strict()),
  event('run.started', z.object({ generation: z.number().int().positive() }).strict()),
  event('run.phase_changed', z.object({ phase }).strict()),
  event('run.waiting', z.object({ approvalId: id }).strict()),
  event('run.stop_requested', z.object({ reason: z.string() }).strict()),
  event('run.stopped', z.object({ reason: z.string() }).strict()),
  event(
    'run.interrupted',
    z.object({ reason: z.string(), code: id.optional() }).strict(),
  ),
  event(
    'run.recovery_started',
    z.object({ generation: z.number().int().positive() }).strict(),
  ),
  event('run.recovery_required', z.object({ reason: z.string() }).strict()),
  event('run.resumed', z.object({}).strict()),
  event('run.completed', z.object({ messageId: id }).strict()),
  event('run.failed', z.object({ code: id, reason: z.string(), messageId: id.optional() }).strict()),
  event('run.failure_summary', z.object({ messageId: id, inputId: id, text: z.string().min(1) }).strict()),
  event('model.request_prepared', z.object({ requestId: id, contextId: id }).strict()),
  event('model.attempt_started', z.object({ requestId: id }).strict()),
  event('model.attempt_measured', z.object({ requestId: id, outcome: z.enum(['completed', 'interrupted']),
    elapsedMs: z.number().nonnegative(), firstFrameMs: z.number().nonnegative().nullable(),
    firstReasoningMs: z.number().nonnegative().nullable(), firstTextMs: z.number().nonnegative().nullable(),
  }).strict()),
  event(
    'model.block_started',
    z
      .object({
        blockId: id,
        kind: z.enum(['reasoning', 'text', 'tool']),
        displayRole: z.enum(['commentary', 'final']),
      })
      .strict(),
  ),
  event(
    'model.delta',
    z
      .object({
        blockId: id,
        kind: z.enum(['reasoning', 'text', 'tool']),
        deltaIndex: z.number().int().nonnegative(),
        text: z.string(),
      })
      .strict(),
  ),
  event('model.block_completed', z.object({ blockId: id }).strict()),
  event(
    'model.attempt_completed',
    z.object({ finishReason: id, responseRef: id }).strict(),
  ),
  event('model.repetition_observed', z.object({ periodBytes: z.number().int().positive(),
    repetitions: z.number().int().positive(), repeatedBytes: z.number().int().positive(),
    observedBytes: z.number().int().positive() }).strict()),
  event('model.attempt_failed', z.object({ code: id, reason: z.string() }).strict()),
  event('message.committed', ref),
  event('tool.prepared', z.object({ name: id, providerCallId: id }).strict()),
  event('tool.dispatch_intent', z.object({ contextRef: id }).strict()),
  event('tool.started', z.object({}).strict()),
  event('tool.measured', z.object({ elapsedMs: z.number().nonnegative(), prepareMs: z.number().nonnegative(), approvalPollingMs: z.number().nonnegative(), executeMs: z.number().nonnegative() }).strict()),
  event(
    'tool.settled',
    z.object({ outcome: outcomeSchema, resultRef: id, messageId: id }).strict(),
  ),
  event(
    'tool.reconciled',
    z
      .object({ outcome: outcomeSchema, verification: id, resultRef: id, messageId: id, inspectionExecutionId: id.optional() })
      .strict(),
  ),
  event(
    'approval.requested',
    z
      .object({ approvalId: id, requestHash: id, name: id, description: z.string(), canReuseCommand: z.boolean().optional() })
      .strict(),
  ),
  event(
    'approval.decided',
    z.object({ approvalId: id, decision: z.enum(['allow', 'deny']), decisionSource:z.enum(['user','task-grant']).optional(), sourceApprovalId:id.optional(), authorizationRef:id.optional() }).strict(),
  ),
  event(
    'approval.invalidated',
    z.object({ approvalId: id, reason: z.string() }).strict(),
  ),
  event(
    'environment.revised',
    z.object({ environmentId: id, revision: z.number().int().nonnegative() }).strict(),
  ),
  event(
    'execution.planned',
    z.object({ planRef: id, planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ),
  event('execution.located', z.object({ locatorRef: id }).strict()),
  event('execution.completed', z.object({ receiptRef: id }).strict()),
  event('execution.reconciled', z.object({ receiptRef: id }).strict()),
  event('process.planned', z.object({ snapshotRef: id }).strict()),
  event(
    'process.owner_bound',
    z.object({ bridgePid: z.number().int().positive(), bridgeBirth: id }).strict(),
  ),
  event(
    'process.ready',
    z
      .object({
        bridgePid: z.number().int().positive(),
        bridgeBirth: id,
        childPid: z.number().int().positive(),
        childBirth: id,
      })
      .strict(),
  ),
  event('process.release_intent', z.object({}).strict()),
  event('process.started', z.object({}).strict()),
  event(
    'process.output',
    z
      .object({
        outputIndex: z.number().int().nonnegative(),
        channel: z.enum(['stdout', 'stderr']),
        artifactRef: id,
        byteLength: z.number().int().nonnegative(),
      })
      .strict(),
  ),
  event(
    'process.exited',
    z
      .object({
        receiptRef: id,
        exitCode: z.number().int().nullable(),
        reason: z.string(),
        jobInactive: z.boolean(),
      })
      .strict(),
  ),
  event(
    'process.reconciled',
    z.object({ receiptRef: id, jobInactive: z.literal(true) }).strict(),
  ),
  event(
    'resource.discovered',
    z
      .object({
        candidateId: id,
        path: z.string(),
        identity: id,
        resourceScope: resourceScopeSchema.optional(),
      })
      .strict(),
  ),
  event(
    'resource.authorized',
    z
      .object({
        resourceId: id,
        access: z.enum(['read', 'edit']),
        scope: z.enum(['conversation', 'run']),
      })
      .strict(),
  ),
  event(
    'resource.materialized',
    z
      .object({
        mountId: id,
        resourceId: id,
        baselineRef: id,
        excluded: z.array(z.string()),
      })
      .strict(),
  ),
  event(
    'resource.materialization_failed',
    z
      .object({
        resourceId: id,
        code: id,
        reason: z.string(),
        failure: materializationFailureSchema.optional(),
      })
      .strict(),
  ),
  event(
    'resource.materialization_started',
    z.object({ resourceId: id, mountId: id, planRef: id }).strict(),
  ),
  event(
    'resource.materialization_root_bound',
    z.object({ mountId: id, rootIdentity: id }).strict(),
  ),
  event(
    'changeset.created',
    z.object({ changeSetId: id, mountId: id, artifactRef: id }).strict(),
  ),
  event('delivery.item_intent', z.object({ changeSetId: id, path: z.string() }).strict()),
  event(
    'delivery.item_settled',
    z
      .object({
        changeSetId: id,
        path: z.string(),
        outcome: z.enum(['applied', 'satisfied', 'not_applied', 'unknown']),
        receiptRef: id,
      })
      .strict(),
  ),
  event('context.budget_blocked', budgetBlockSchema),
  event('context.budget_cleared', z.object({}).strict()),
  event(
    'context.snapshot_created',
    z
      .object({
        contextId: id,
        requestId: id,
        estimatedInputTokens: z.number().int().nonnegative(),
        inputCeiling: z.number().int().positive(),
        estimator: id,
        metrics: contextMetricsSchema.optional(),
      })
      .strict(),
  ),
  event(
    'memory.recorded',
    z
      .object({
        entryId: id,
        kind: z.enum(['note', 'requirement', 'reset']),
        artifactRef: id,
      })
      .strict(),
  ),
  event(
    'context.maintenance_started',
    z
      .object({
        maintenanceId: id,
        planRef: id,
        baseVersion: z.number().int().positive(),
        mode: z.enum(['compact', 'reset', 'budget-reset']),
      })
      .strict(),
  ),
  event('context.maintenance_failed', z.object({ maintenanceId: id, code: id }).strict()),
  event(
    'context.window_committed',
    z
      .object({
        maintenanceId: id,
        version: z.number().int().positive(),
        summaryRef: id.nullable(),
        manifestRef: id,
        resetEntryId: id.nullable(),
      })
      .strict(),
  ),
  event(
    'context.maintenance_usage',
    z.object({ maintenanceId: id, usageRef: id }).strict(),
  ),
  event(
    'context.maintenance_response',
    z.object({ maintenanceId: id, responseRef: id }).strict(),
  ),
  event('usage.recorded', z.object({ requestId: id, usageRef: id }).strict()),
]);
const envelope = z.object({
  schemaVersion: z.literal(1),
  eventId: id,
  streamId: id,
  logEpoch: id,
  sequence: z.string().regex(/^[1-9]\d*$/),
  workspaceId: id,
  conversationId: id,
  runId: id.optional(),
  userTurnId: id.optional(),
  modelTurnId: id.optional(),
  modelAttemptId: id.optional(),
  callId: id.optional(),
  executionId: id.optional(),
  occurredAt: z.iso.datetime(),
  producer: z.enum(['system', 'provider', 'user', 'import']),
  idempotencyKey: id,
});
export const eventSchema = z.intersection(envelope, body).superRefine((e, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (e.streamId !== e.conversationId) bad('事件流与会话归属不一致');
  if (
    !e.type.startsWith('input.') &&
    !e.type.startsWith('settings.') &&
    !e.type.startsWith('resource.') &&
    !['workspace.access_changed','file.change_recorded'].includes(e.type) &&
    !e.runId
  )
    bad('执行事件缺少运行身份');
  if (
    (e.type.startsWith('changeset.') ||
      e.type.startsWith('delivery.') ||
      e.type.startsWith('process.') ||
      e.type.startsWith('execution.') || e.type.startsWith('question.')) &&
    (!e.callId || !e.executionId || !e.modelTurnId || !e.modelAttemptId)
  )
    bad('执行事件缺少完整工具身份');
  if (
    (e.type.startsWith('model.') || e.type.startsWith('tool.')) &&
    (!e.modelTurnId || !e.modelAttemptId)
  )
    bad('模型或工具事件缺少轮次身份');
  if ((e.type.startsWith('tool.') || e.type.startsWith('approval.')) && !e.callId)
    bad('工具相关事件缺少调用身份');
  if ((e.type.startsWith('tool.') || e.type.startsWith('approval.')) && !e.executionId)
    bad('执行事件缺少执行身份');
  if (
    (e.type === 'memory.recorded' || e.type === 'task.checkpoint_recorded') &&
    (!e.executionId || !e.callId || !e.modelTurnId || !e.modelAttemptId)
  )
    bad('记忆记录缺少原工具身份');
  if (e.type.startsWith('input.') && !e.userTurnId) bad('用户输入缺少用户轮次身份');
});
export type WorkEvent = z.infer<typeof eventSchema>;
export type EventBody = z.infer<typeof body>;
export type EventScope = {
  conversationId: string;
  runId?: string;
  userTurnId?: string;
  modelTurnId?: string;
  modelAttemptId?: string;
  callId?: string;
  executionId?: string;
};
export { cursorSchema, status };
