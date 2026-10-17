import { hash } from '../identity.js';
import { toolModule } from './modules.js';
import { ExecutionProviders } from './execution-provider.js';
import type {
  ExecutionEvidenceFactory,
  ProviderToolModule,
} from './execution-provider.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import {
  executionPlanSchema,
  executionObservationSchema,
} from '../../../protocol/src/execution.js';
import type {
  ExecutionPlan,
  ExecutionObservation,
} from '../../../protocol/src/execution.js';
import type { ToolResult } from '../persistence.js';

function planFor(ctx: ExecutionContext): ExecutionPlan {
  if (!ctx.execution) throw new UmiError('PROTOCOL_INVALID', '缺少中立执行计划');
  return executionPlanSchema.parse(ctx.execution);
}
function result(r: ExecutionObservation): ToolResult {
  const uncertain =
    r.cleanup.processTree === 'unknown' ||
    r.cleanup.containment === 'unknown' ||
    r.reason === 'interrupted';
  return {
    outcome: uncertain
      ? 'unknown'
      : r.reason === 'exited' && r.exitCode === 0
        ? 'succeeded'
        : r.reason === 'cancelled'
          ? 'cancelled'
          : 'failed',
    mutated: r.started,
    verification: uncertain ? 'unknown' : 'provider-exit-observed',
    content: uncertain
      ? '原执行的退出或清理无法完整核验；未重复启动。'
      : '已记录原 provider 退出；退出码不证明用户任务完成，文件效果需独立核验。',
    data: r,
  };
}
const unknown = (message: string): ToolResult => ({
  outcome: 'unknown',
  mutated: false,
  verification: 'unknown',
  content: message,
  data: null,
});
export function providerToolModule(
  config: ProviderToolModule,
  evidence: ExecutionEvidenceFactory,
) {
  const providers = new ExecutionProviders(config.providers);
  return toolModule(config.id, config.version, [], (registry) =>
    registry.register({
      name: config.name,
      description: config.description,
      schema: config.schema,
      effect: 'host-code',
      approvalRequired: () => true,
      prepare(args, env, executionId) {
        if (!executionId) throw new UmiError('PROTOCOL_INVALID', '缺少执行身份');
        const ctx = executionContextSchema.parse(
          config.preparation.prepare(args, env, executionId),
        );
        const plan = planFor(ctx);
        if (plan.executionId !== executionId || ctx.process)
          throw new UmiError('PROTOCOL_INVALID', '中立计划归属错误或混用了 V1 进程快照');
        providers.require(plan);
        return ctx;
      },
      approvalDescription(_args, ctx) {
        const plan = planFor(ctx);
        return `执行 provider=${plan.provider.id}@${plan.provider.version}；tier=${plan.capabilities.tier}；planHash=${hash(plan)}。\n${JSON.stringify(plan)}`;
      },
      executionTimeoutMs: () => 310000,
      async execute(args, ctx, _conversation, signal) {
        const plan = planFor(ctx),
          port = evidence(ctx);
        signal.throwIfAborted();
        const provider = providers.require(plan);
        // 同一个参数准备器做最后复核；授权/租约由绑定证据端口再次检查。
        const fresh = config.preparation.prepare(
          args,
          port.environment(),
          plan.executionId,
        );
        if (hash(fresh) !== hash(ctx))
          return {
            outcome: 'failed',
            mutated: false,
            content: '派发后执行计划已变化，未启动。',
            data: null,
          };
        port.plan();
        signal.throwIfAborted();
        const scopedSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(plan.timeoutMs),
        ]);
        const observation = executionObservationSchema.parse(
          await provider.start(plan, (locator) => port.locate(locator), scopedSignal),
        );
        port.finish(observation);
        return result(observation);
      },
      async reconcile(_args, ctx, _conversation, signal) {
        const plan = planFor(ctx),
          port = evidence(ctx),
          stored = port.read();
        if (!stored) return unknown('派发后未保存执行计划，无法排除启动窗口；没有重跑。');
        if (hash(stored.plan) !== hash(plan)) return unknown('原计划不匹配；没有重跑。');
        if (stored.receipt && result(stored.receipt).outcome !== 'unknown')
          return result(stored.receipt);
        const provider = providers.original(plan);
        if (!provider || !stored.locator)
          return unknown('原 provider/版本/实现或持久定位缺失，不能核验；没有重跑。');
        const verified = await provider.reconcile(plan, stored.locator, signal);
        if (!verified) return unknown('原 provider 未能核验原执行；没有重跑。');
        const receipt = executionObservationSchema.parse(verified);
        port.finish(receipt);
        return result(receipt);
      },
    }),
  );
}
