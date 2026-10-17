import { SqliteStore } from './store.js';
import { hash } from '../../../agent/src/identity.js';
import type {
  ExecutionEvidencePort,
  ExecutionEvidenceFactory,
} from '../../../agent/src/tools/execution-provider.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import {
  executionPlanSchema,
  executionLocatorSchema,
  executionObservationSchema,
} from '../../../protocol/src/execution.js';
import type {
  ExecutionLocator,
  ExecutionObservation,
} from '../../../protocol/src/execution.js';

export class ExecutionRepository {
  constructor(private readonly store: SqliteStore) {}
  readonly forContext: ExecutionEvidenceFactory = (context) => {
    const plan = executionPlanSchema.parse(context.execution),
      id = plan.executionId;
    const tool = this.store.tool(id),
      scope = this.store.preparedToolScope(tool);
    const frozen = this.store.readArtifact<ExecutionContext>(tool.context_ref!);
    if (hash(frozen) !== hash(context))
      throw new UmiError('PROTOCOL_INVALID', '执行证据端口不属于原冻结上下文');
    const generation = this.store.getRun(tool.run_id).generation;
    const check = (starting = false) => {
      this.store.checkLease(tool.run_id, generation);
      const current = this.store.tool(id);
      if (!['dispatched', 'unknown'].includes(current.state))
        throw new UmiError('PROTOCOL_INVALID', '执行证据要求已派发的原工具');
      if (starting) {
        if (generation !== plan.leaseGeneration)
          throw new UmiError('LEASE_LOST', '启动租约与计划不同');
        this.store.assertApprovedExecution(id, context);
      }
    };
    const row = () => this.store.snapshot(scope.conversationId).providerExecutions[id];
    const read = () => {
      const state = row();
      if (!state) return undefined;
      const saved = executionPlanSchema.parse(this.store.readArtifact(state.planRef));
      if (hash(saved) !== hash(plan))
        throw new UmiError('PROTOCOL_INVALID', '持久计划与原工具不同');
      return {
        plan: saved,
        ...(state.locatorRef
          ? {
              locator: executionLocatorSchema.parse(
                this.store.readArtifact(state.locatorRef),
              ),
            }
          : {}),
        ...(state.receiptRef
          ? {
              receipt: executionObservationSchema.parse(
                this.store.readArtifact(state.receiptRef),
              ),
            }
          : {}),
      };
    };
    const bound = (value: ExecutionLocator | ExecutionObservation) => {
      if (
        value.executionId !== id ||
        value.planHash !== hash(plan) ||
        hash(value.provider) !== hash(plan.provider)
      )
        throw new UmiError('PROTOCOL_INVALID', '定位或回执与原计划/provider 不同');
    };
    const port: ExecutionEvidencePort = {
      environment: () => {
        check(true);
        return this.store.environment(tool.environment_id);
      },
      read,
      plan: () =>
        this.store.transaction(() => {
          check(true);
          if (row()) throw new UmiError('PROTOCOL_INVALID', '原计划已存在，禁止重复启动');
          const planRef = this.store.artifact(plan, 'execution-plan-v2');
          this.store.append(scope, {
            type: 'execution.planned',
            payload: { planRef, planHash: hash(plan) },
          });
        }),
      locate: (input) =>
        this.store.transaction(() => {
          check();
          const locator = executionLocatorSchema.parse(input);
          bound(locator);
          const prior = read();
          if (!prior || prior.receipt)
            throw new UmiError('PROTOCOL_INVALID', '未计划或执行已结算');
          if (prior.locator) {
            if (hash(prior.locator) !== hash(locator))
              throw new UmiError('PROTOCOL_INVALID', '原执行定位不可替换');
            return;
          }
          const locatorRef = this.store.artifact(locator, 'execution-locator-v2');
          this.store.append(scope, {
            type: 'execution.located',
            payload: { locatorRef },
          });
        }),
      finish: (input) =>
        this.store.transaction(() => {
          check();
          const receipt = executionObservationSchema.parse(input);
          bound(receipt);
          if (
            Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr) >
            plan.maxOutputBytes
          )
            throw new UmiError('RESOURCE_LIMIT', 'provider 输出超过冻结计划上限');
          const prior = read();
          if (!prior) throw new UmiError('PROTOCOL_INVALID', '未计划不能保存回执');
          if (prior.receipt) {
            if (hash(prior.receipt) === hash(receipt)) return;
            const old = prior.receipt;
            if (
              (old.cleanup.processTree !== 'unknown' &&
                old.cleanup.containment !== 'unknown' &&
                old.reason !== 'interrupted') ||
              (old.started && !receipt.started) ||
              (old.reason === 'exited' &&
                (old.reason !== receipt.reason || old.exitCode !== receipt.exitCode)) ||
              (old.cleanup.processTree === 'confirmed' &&
                receipt.cleanup.processTree !== 'confirmed') ||
              (old.cleanup.containment === 'confirmed' &&
                receipt.cleanup.containment !== 'confirmed') ||
              (old.effects === 'verified' && receipt.effects !== 'verified')
            )
              throw new UmiError('PROTOCOL_INVALID', '新观察不能撤销已证实的原执行事实');
          }
          const receiptRef = this.store.artifact(receipt, 'execution-receipt-v2');
          this.store.append(scope, {
            type: prior.receipt ? 'execution.reconciled' : 'execution.completed',
            payload: { receiptRef },
          });
        }),
    };
    return port;
  };
}
