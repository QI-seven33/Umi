import { z } from 'zod';
import type { PersistencePort, ToolResult } from '../persistence.js';
import type { ToolRegistry } from './registry.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { Environment } from '../persistence.js';

export function registerRecovery(registry: ToolRegistry, store: PersistencePort,
  prepare: (args: unknown, env: Environment) => ExecutionContext,
  inspect: (id: string, runId: string, generation: number, signal: AbortSignal, inspectionExecutionId: string) => Promise<ToolResult>) {
  const schema = z.object({ executionId: z.string().min(1).max(160) }).strict();
  registry.register({ name: 'inspect_tool_execution',
    description: '核验本会话原 executionId 的已派发/未知操作，只查原身份和回执，不重跑旧命令，不执行 prepared 工具。结果仍 unknown 时不能新建副作用；最新用户要求优先，已完成操作不重放。',
    schema, effect: 'read',
    prepare(args, env, id) {
      if (!id) throw new UmiError('PROTOCOL_INVALID', '核验缺少工具身份');
      return { ...prepare(args, env), inspectionExecutionId: id };
    },
    async execute(input, ctx, _cid, signal) {
      if (!ctx.inspectionExecutionId) throw new UmiError('PROTOCOL_INVALID', '核验身份缺失');
      const owner = store.tool(ctx.inspectionExecutionId), run = store.getRun(owner.run_id);
      return inspect(schema.parse(input).executionId, run.id, run.generation, signal, owner.id);
    },
  });
}
