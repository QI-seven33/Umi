import { z } from 'zod';
import { hash } from '../identity.js';
import type { Environment } from '../persistence.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import {
  providerIdentitySchema,
  executionCapabilitiesSchema,
} from '../../../protocol/src/execution.js';
import type {
  ProviderIdentity,
  ExecutionCapabilities,
  ExecutionPlan,
  ExecutionLocator,
  ExecutionObservation,
} from '../../../protocol/src/execution.js';

export interface ExecutionProvider {
  readonly identity: ProviderIdentity;
  // 已发现的能力；prepare 不允许隐藏 ACL/镜像等效果准备。
  readonly capabilities: ExecutionCapabilities;
  start(
    plan: ExecutionPlan,
    located: (locator: ExecutionLocator) => void,
    signal: AbortSignal,
  ): Promise<ExecutionObservation>;
  reconcile(
    plan: ExecutionPlan,
    locator: ExecutionLocator,
    signal: AbortSignal,
  ): Promise<ExecutionObservation | undefined>;
}
export interface ExecutionEvidence {
  readonly plan: ExecutionPlan;
  readonly locator?: ExecutionLocator;
  readonly receipt?: ExecutionObservation;
}
// 每个端口绑定原工具上下文；不向 provider 暴露 SQLite 或批准写入口。
export interface ExecutionEvidencePort {
  environment(): Environment;
  read(): ExecutionEvidence | undefined;
  plan(): void;
  locate(locator: ExecutionLocator): void;
  finish(receipt: ExecutionObservation): void;
}
export type ExecutionEvidenceFactory = (
  context: ExecutionContext,
) => ExecutionEvidencePort;
export interface ExecutionPreparationPort {
  prepare(args: unknown, env: Environment, executionId: string): ExecutionContext;
}
export interface ProviderToolModule {
  id: string;
  version: string;
  name: string;
  description: string;
  schema: z.ZodType;
  providers: readonly ExecutionProvider[];
  preparation: ExecutionPreparationPort;
}
export class ExecutionProviders {
  private readonly providers = new Map<string, ExecutionProvider>();
  constructor(providers: readonly ExecutionProvider[]) {
    for (const provider of providers) {
      const identity = providerIdentitySchema.parse(provider.identity);
      executionCapabilitiesSchema.parse(provider.capabilities);
      const key = hash(identity);
      if (this.providers.has(key))
        throw new UmiError('PROVIDER_CONFLICT', '执行 provider 重复');
      this.providers.set(key, provider);
    }
  }
  require(plan: ExecutionPlan): ExecutionProvider {
    const provider = this.providers.get(hash(plan.provider));
    if (!provider)
      throw new UmiError('PROVIDER_MISSING', '原执行 provider/版本/实现不可用');
    if (
      hash(provider.identity) !== hash(plan.provider) ||
      hash(provider.capabilities) !== hash(plan.capabilities)
    )
      throw new UmiError('PROVIDER_CHANGED', '执行 provider 身份或能力已变化');
    const policy = plan.policy,
      caps = plan.capabilities;
    if (
      caps.filesystemMapping !== 'enforced' ||
      (policy.network === 'deny' && caps.networkDeny !== 'enforced') ||
      (policy.ui === 'deny' && caps.uiDeny !== 'enforced') ||
      // V2 尚无可信 ready/recheck/release 流程，不能靠 provider 声明补齐。
      policy.startMode === 'gated'
    )
      throw new UmiError(
        'POLICY_UNSUPPORTED',
        '请求的强制执行策略尚未证实可执行，未启动',
      );
    return provider;
  }
  original(plan: ExecutionPlan): ExecutionProvider | undefined {
    // 恢复不以当前能力否认旧执行；只允许完全相同的实现身份核验原 locator。
    const provider = this.providers.get(hash(plan.provider));
    return provider && hash(provider.identity) === hash(plan.provider)
      ? provider
      : undefined;
  }
}
