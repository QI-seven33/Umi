import { hash } from '../identity.js';
import { commandRepeatsSinceChange } from './repeat-observation.js';
import type { PersistencePort, ToolResult } from '../persistence.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import { ToolPreparationError, type ToolRegistry } from './registry.js';
import { setTimeout as delay, setImmediate as yieldToHost } from 'node:timers/promises';

// 仅对读取目标的可核验事实计进展；不以调用ID或宿主命令退出造成的修订当作内容变化。
function readObservationKey(context: ExecutionContext) {
  return hash({ runtimeId: context.runtimeId, environmentId: context.environmentId,
    bindingRoot: context.bindingRoot, rootIdentity: context.rootIdentity,
    resourceScope: context.resourceScope ?? null, locations: context.locations });
}
export class ToolExecutor {
  constructor(
    private readonly store: PersistencePort,
    private readonly registry: ToolRegistry,
  ) {}
  // 模型显式选择核验：只访问原回执/身份，不进入 prepared 的执行分支。
  async inspect(toolId: string, ownerRunId: string, generation: number, signal: AbortSignal, inspectionExecutionId?: string): Promise<ToolResult> {
    const owner = this.store.getRun(ownerRunId), t = this.store.tool(toolId), prior = this.store.getRun(t.run_id);
    this.store.checkLease(ownerRunId, generation);
    if (prior.conversation_id !== owner.conversation_id || t.environment_id !== owner.environment_id)
      throw new UmiError('PERMISSION_DENIED', '原执行不属于当前会话环境');
    if (t.state === 'prepared')
      return { outcome: 'failed', content: '原工具未派发，核验不能执行它。', data: null };
    if (!['dispatched', 'unknown'].includes(t.state))
      return { outcome: 'succeeded', content: '', data: { executionId: t.id, state: t.state,
        result: t.result_ref ? this.store.readArtifact(t.result_ref) : null } };
    const definition = this.registry.get(t.name);
    let result: ToolResult;
    const entry = definition.effect === 'memory'
      ? this.store.contextMemory(owner.conversation_id).entries.find(e => e.executionId === t.id) : undefined;
    if (entry)
      result = { outcome: 'succeeded', content: '', data: { entryId: entry.id, artifactRef: entry.artifactRef,
        kind: entry.value.kind, status: entry.value.kind === 'reset' ? 'requested' : 'recorded',
        authority: '模型记录，不代表权限或执行结果' }, mutated: false };
    else if (['read', 'network', 'memory'].includes(definition.effect) && !definition.inspect)
      result = { outcome: 'cancelled', content: '原读取或记忆反馈未确认，未重放；需要时按最新要求发起新工具。', data: null };
    else if (!t.context_ref || !(definition.inspect ?? definition.reconcile))
      result = { outcome: 'unknown', content: '原执行没有可核验回执，未重新执行。', data: null };
    else {
      try {
        const args = this.registry.parse(t.name, t.args), ctx = executionContextSchema.parse(this.store.readArtifact(t.context_ref));
        result = definition.inspect
          ? await definition.inspect(args, ctx, owner.conversation_id, signal, t.id)
          : await definition.reconcile!(args, ctx, owner.conversation_id, signal);
      } catch {
        signal.throwIfAborted();
        result = { outcome: 'unknown', content: '原执行无法核验，未重跑。', data: null };
      }
    }
    this.store.checkLease(ownerRunId, generation);
    this.store.settle(t.id, result, prior.generation, true,
      result.mutated ?? (!['read', 'network', 'memory'].includes(definition.effect) && result.outcome === 'succeeded'), inspectionExecutionId);
    return { outcome: 'succeeded', content: '', data: { executionId: t.id, state: result.outcome, result } };
  }
  async execute(toolId: string, generation: number, signal: AbortSignal): Promise<void> {
    const timing = { prepareMs: 0, approvalPollingMs: 0, executeMs: 0 }, started = performance.now();
    try { await this.executeMeasured(toolId, generation, signal, timing); }
    finally {
      const tool = this.store.tool(toolId);
      // 停止后的原执行者仍可记录等待耗时；旧代执行者不能追加观察。
      if (this.store.getRun(tool.run_id).generation === generation)
        this.store.commit(this.store.preparedToolScope(tool), { type: 'tool.measured', payload: { elapsedMs: performance.now() - started, ...timing } });
    }
  }
  private async executeMeasured(toolId: string, generation: number, signal: AbortSignal,
    timing: { prepareMs: number; approvalPollingMs: number; executeMs: number }): Promise<void> {
    // 连续同步读取也要在工具边界处理 IPC；微任务连跑不能饿死用户停止请求。
    await yieldToHost(undefined, { signal });
    let t = this.store.tool(toolId);
    this.store.checkLease(t.run_id, generation);
    let args: unknown;
    try {
      //用工具名找到 schema，解析参数
      args = this.registry.parse(t.name, t.args);
    } catch (e) {
      this.store.settle(
        toolId,
        {
          outcome: 'failed',
          content: e instanceof UmiError ? e.message : '工具参数无效',
          data: e instanceof ToolPreparationError ? {code:e.code,...e.details} : e instanceof UmiError ? {code:e.code} : null,
        },
        generation,
      );
      return;
    }
    //判断"是不是修改类工具"
    const definition = this.registry.get(t.name),
      mutating = !['read', 'network', 'memory'].includes(definition.effect);
    //工具已经派发/未知 → reconcile
    if (t.state === 'dispatched' || t.state === 'unknown') {
      let result: ToolResult;
      try {
        //有 context_ref 且有 reconcile 方法 → 调 reconcile 去核对
        if (!t.context_ref || !definition.reconcile)
          //否则 → 标记 unknown（无法自动核验）
          result = {
            outcome: 'unknown',
            content: '中断前的执行结果无法自动核验',
            data: null,
            verification: 'unknown',
          };
        else
          result = await definition.reconcile(
            args,
            executionContextSchema.parse(this.store.readArtifact(t.context_ref)),
            this.store.getRun(t.run_id).conversation_id,
            signal,
          );
      } catch {
        result = {
          outcome: 'unknown',
          content: '原执行位置或结果无法核验，未重复执行工具',
          data: null,
          verification: 'unknown',
        };
      }
      this.store.settle(
        toolId,
        result,
        generation,
        true,
        result.mutated ?? (mutating && result.outcome === 'succeeded'),
      );
      if (result.outcome === 'unknown')
        throw new UmiError(
          'TOOL_OUTCOME_UNKNOWN',
          '存在无法核验的副作用，需要检查原环境',
        );
      return;
    }
    //状态不是 prepared → 直接返回
    if (t.state !== 'prepared') return;
    if (this.store.messages(this.store.getRun(t.run_id).conversation_id)
      .some((m) => m.runId === t.run_id && !m.applied)) {
      if (t.approval_id) this.store.invalidateApproval(t.id, '收到新用户要求，旧批准失效');
      this.store.settle(t.id, { outcome: 'cancelled', content: '新输入须先交给模型判断，旧工具未执行。', data: null }, generation);
      return;
    }
    if (!['read', 'memory'].includes(definition.effect) &&
        this.store.unresolvedEnvironment(t.environment_id).some((prior) => prior.id !== t.id)) {
      this.store.settle(t.id, { outcome: 'failed', content: '环境存在未决执行，先用 inspect_tool_execution 核验原身份；没有派发新操作。',
        data: { code: 'TOOL_OUTCOME_UNKNOWN', executionIds: this.store.unresolvedEnvironment(t.environment_id).map((prior) => prior.id) } }, generation);
      return;
    }
    //复调用检查（防死循环）
    //找出本次 run 里、和这个工具同名同参数的其他调用
    const previous = this.store
      .tools(t.run_id)
      .filter((x) => x.id !== t.id && x.name === t.name && x.args === t.args);
    //如果之前同样的调用被拒绝过 → 这次也直接拒绝，不再问。
    if (previous.some((x) => x.state === 'denied')) {
      this.store.settle(
        toolId,
        {
          outcome: 'denied',
          content: '相同操作已被拒绝，未重复请求或执行。',
          data: null,
        },
        generation,
      );
      return;
    }
    // 原次数限制保留；比较同一对象版本，不把编辑后的复读或省略哈希后的必要修改误判为停滞。
    let equivalent = previous.length;
    if (equivalent >= 3 && (definition.effect === 'read' ||
        (definition.effect === 'copy-write' && ['edit_file','write_file'].includes(t.name)))) {
      try {
        const observed = executionContextSchema.parse(definition.prepare(args, this.store.environment(t.environment_id), t.id));
        if (observed.locations.some(location => location.beforeHash !== null)) {
          const key = readObservationKey(observed);
          equivalent = previous.filter(prior => !prior.context_ref ||
            readObservationKey(executionContextSchema.parse(this.store.readArtifact(prior.context_ref))) === key).length;
        }
      } catch {
        // 不能证明版本变化时不豁免；原拒绝/未知执行检查已经在上面执行。
      }
    }
    // 同一命令在已观察到的文件变更后可重新验证；仍必须经过下方的新批准与未知执行核验。
    // 不扫描目录，也不把程序退出造成的环境修订当作内容变化。
    if (equivalent >= 3 && definition.effect === 'host-code') {
      try {
        const observed = executionContextSchema.parse(definition.prepare(args, this.store.environment(t.environment_id), t.id));
        if (observed.process) equivalent = commandRepeatsSinceChange(this.store, this.registry, t, previous, observed);
      } catch {
        // 无法证明输入变化时维持原计数；不凭猜测放宽执行。
      }
    }
    if (equivalent >= 3) {
      this.store.settle(
        toolId,
        {
          outcome: 'failed',
          content: '相同工具请求重复且没有新信息，已阻止继续执行。',
          data: { code: 'TASK_STALLED', inputId: this.store.messages(this.store.getRun(t.run_id).conversation_id)
            .filter(m => m.role === 'user' && m.applied).at(-1)?.id },
        },
        generation,
      );
      throw new UmiError('TASK_STALLED', '重复操作未取得进展');
    }
    //核心循环（准备 + 等批准）
    let context: ExecutionContext;
    while (true) {
      signal.throwIfAborted();
      t = this.store.tool(toolId);
      this.store.checkLease(t.run_id, generation);
      if (this.store.messages(this.store.getRun(t.run_id).conversation_id)
        .some((m) => m.runId === t.run_id && !m.applied)) {
        if (t.approval_id) this.store.invalidateApproval(t.id, '收到新用户要求，旧批准失效');
        this.store.settle(t.id, { outcome: 'cancelled', content: '新输入须先交给模型判断，旧工具未执行。', data: null }, generation);
        return;
      }
      // 等待期间批准身份会持久化；准备失败也必须使用最新记录使其失效。
      const prepareStarted = performance.now();
      try {
        //调 definition.prepare(...) —— 准备执行上下文（如校验路径、绑定环境版本）
        context = executionContextSchema.parse(
          definition.prepare(args, this.store.environment(t.environment_id), t.id),
        );
        //失败 → 让已有批准失效 + 结算 failed + 返回
      } catch (e) {
        if (t.approval_id) this.store.invalidateApproval(toolId, '原对象无法核验');
        this.store.settle(
          toolId,
          {
            outcome: 'failed',
            content: e instanceof UmiError ? e.message : '无法准备工具执行位置',
            data: e instanceof ToolPreparationError ? { code: e.code, ...e.details } : e instanceof UmiError ? { code: e.code } : null,
          },
          generation,
        );
        return;
      }
      finally { timing.prepareMs += performance.now() - prepareStarted; }
      //判断需不需要批准
      const needsApproval =
        definition.approvalRequired?.(args, context) ??
        ['scratch-write', 'resource', 'source-write', 'host-code'].includes(
          definition.effect,
        );
      if (!needsApproval) break;
      //批准逻辑
      t = this.store.tool(toolId);
      if (t.approval_id) {
        const approval = this.store.approval(t.approval_id);
        if (approval.decision === 'deny') {
          definition.denied?.(args, context);
          this.store.settle(
            toolId,
            { outcome: 'denied', content: '用户拒绝了本次操作，未执行。', data: null },
            generation,
          );
          return;
        }
        if (
          !approval.valid ||
          approval.request_hash !== hash({ name: t.name, args: t.args, context })
        ) {
          this.store.invalidateApproval(toolId, '批准对象、内容或环境版本已变化');
          continue;
        }
        if (approval.decision === 'allow') break;
      } else {
        const location = context.locations[0];
        this.store.requestApproval(
          toolId,
          context,
          definition.approvalDescription?.(args, context) ??
            `需要在 Umi 托管 scratch 区写入 ${location?.relativePath ?? '文件'}，用于当前任务；不会写入用户项目。`,
          generation,
        );
      }
      // 等待只检查持久决定，不请求模型。断线不会使 signal 中止。
      const waitStarted = performance.now();
      try { await delay(definition.approvalPollMs ?? 25, undefined, { signal }); }
      finally { timing.approvalPollingMs += performance.now() - waitStarted; }
    }
    //真正执行
    this.store.checkLease(t.run_id, generation);
    const scope = this.store.preparedToolScope(t);
    this.store.commit(
      { conversationId: scope.conversationId, runId: t.run_id },
      { type: 'run.resumed', payload: {} },
    );
    this.store.commit(
      { conversationId: scope.conversationId, runId: t.run_id },
      { type: 'run.phase_changed', payload: { phase: 'execute' } },
    );
    this.store.dispatch(toolId, context, generation, definition.effect);
    this.store.commit(scope, { type: 'tool.started', payload: {} });
    let result: ToolResult;
    // 人类回答没有工具执行超时；停止/新输入仍使用同一个可取消 signal。
    const timeout = definition.executionTimeoutMs ? definition.executionTimeoutMs(args) : 60000;
    const executionSignal = timeout === null ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const executeStarted = performance.now();
    try {
      result = await definition.execute(
        args,
        context,
        scope.conversationId,
        executionSignal,
      );
    } catch (e) {
      if (mutating) {
        result = {
          outcome: 'unknown',
          content: '操作执行中断或失败，实际效果需核验。',
          data: { code: e instanceof UmiError ? e.code : 'EXECUTION_ERROR' },
        };
      } else {
        result = {
          outcome: signal.aborted ? 'cancelled' : 'failed',
          content: e instanceof UmiError ? e.message : '工具执行失败',
          data: { code: e instanceof UmiError ? e.code : 'EXECUTION_ERROR' },
        };
      }
    }
    finally { timing.executeMs += performance.now() - executeStarted; }
    this.store.settle(
      toolId,
      result,
      generation,
      false,
      result.mutated ?? (mutating && result.outcome === 'succeeded'),
    );
    if (result.outcome === 'unknown')
      throw new UmiError('TOOL_OUTCOME_UNKNOWN', '工具副作用未知，未自动重试');
  }
}
