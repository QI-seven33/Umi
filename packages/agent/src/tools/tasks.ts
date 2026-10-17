import { z } from 'zod';
import { taskCheckpointInputSchema, taskStateInputSchema } from '../../../protocol/src/task.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { TaskPort } from '../tasks.js';
import type { ToolRegistry } from './registry.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { Environment, ToolResult } from '../persistence.js';

export function registerTasks(
  registry: ToolRegistry,
  tasks: TaskPort,
  prepare: (args: unknown, env: Environment) => ExecutionContext,
) {
  const inspect = async (_args: unknown, _ctx: ExecutionContext, _cid: string, signal: AbortSignal, executionId: string): Promise<ToolResult> => {
    signal.throwIfAborted();
    const data = tasks.observation(executionId);
    return data === null
      ? { outcome: 'cancelled', content: '原任务事实未提交，未再次保存；按最新原话判断。', data: null, mutated: false }
      : { outcome: 'succeeded', content: '', data, mutated: false };
  };
  registry.register({
    name: 'record_task_checkpoint',
    description:
      '为复杂操作任务保存原话绑定的验收项、进度和下一步。创建后目标、来源和验收项不可删除或降低；更新传 taskId/baseVersion。verified 必须引用匹配的真实工具证据，文件哈希、指定命令退出、源交付、export_receipt 具体成果导出和 document_open 系统打开请求分别核验，review 保持待审。每次状态实质变化才记录；不授予权限。',
    schema: taskCheckpointInputSchema,
    effect: 'memory', inspect,
    prepare(args, env, executionId) {
      if (!executionId) throw new UmiError('PROTOCOL_INVALID', '检查点缺少执行身份');
      return { ...prepare(args, env), memoryExecutionId: executionId };
    },
    async execute(args, ctx, _cid, signal) {
      signal.throwIfAborted();
      if (!ctx.memoryExecutionId)
        throw new UmiError('PROTOCOL_INVALID', '检查点身份缺失');
      const data = tasks.save(
        ctx.memoryExecutionId,
        taskCheckpointInputSchema.parse(args),
      );
      return {
        outcome: 'succeeded',
        content: JSON.stringify(data),
        data,
        mutated: false,
      };
    },
    async reconcile(args, ctx, cid, signal) {
      return this.execute(args, ctx, cid, signal);
    },
  });
  registry.register({ name: 'set_task_state',
    description: '根据最新用户原话将已有 taskId 标为 active/suspended/cancelled。停止不等于取消；换任务先挂起旧任务，取消须引用用户依据。保留目标、原验收和历史，不授予权限、不伪称完成。再次继续原目标设 active；需求替代先挂起/取消，再以 supersedesTaskId 创建新目标。',
    schema: taskStateInputSchema, effect: 'memory', inspect,
    prepare(args, env, id) {
      if (!id) throw new UmiError('PROTOCOL_INVALID', '任务状态缺少执行身份');
      return { ...prepare(args, env), memoryExecutionId: id };
    },
    async execute(input, ctx, _cid, signal) {
      signal.throwIfAborted();
      if (!ctx.memoryExecutionId) throw new UmiError('PROTOCOL_INVALID', '任务状态身份缺失');
      const data = tasks.transition(ctx.memoryExecutionId, taskStateInputSchema.parse(input));
      return { outcome: 'succeeded', content: '', data, mutated: false };
    },
  });
  const read = z
    .object({
      taskId: z.string().min(1).max(160).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(6).default(3),
    })
    .strict();
  registry.register({
    name: 'read_task_checkpoints',
    description:
      '分页读取本会话的完整任务检查点和实时证据评估。包括上次运行的待办和阻塞，不自动执行；后续用户要求仍需读原话，验收项通过不等于完整用户目标得到保证。',
    schema: read,
    effect: 'read',
    prepare,
    async execute(input, _ctx, cid, signal) {
      signal.throwIfAborted();
      const args = read.parse(input);
      const all = tasks.list(cid);
      const entries = args.taskId
        ? all.filter((item) => item.taskId === args.taskId)
        : all.slice(args.offset, args.offset + args.limit);
      if (args.taskId && !entries.length)
        throw new UmiError('PERMISSION_DENIED', '任务不属于当前会话');
      const report = tasks.assess(cid);
      const data = {
        entries,
        assessments: report.tasks.filter((item) =>
          entries.some((entry) => entry.taskId === item.taskId),
        ),
        total: all.length,
        nextOffset:
          !args.taskId && args.offset + entries.length < all.length
            ? args.offset + entries.length
            : null,
        authority: report.authority,
      };
      return { outcome: 'succeeded', content: JSON.stringify(data), data };
    },
    async reconcile(args, ctx, cid, signal) {
      return this.execute(args, ctx, cid, signal);
    },
  });
}
