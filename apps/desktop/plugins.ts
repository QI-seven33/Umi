import { z } from 'zod';
import type { ToolRegistry } from '../../packages/agent/src/tools/registry.js';
import type { DesktopConfig } from '../../packages/protocol/src/desktop.js';
import { hostContext } from '../../packages/adapters/src/host-files/scratch.js';

// 独立开发者配置供模型查询；命令执行继续走已实现的统一批准与进程入口。
// 不管理 daemon、发行版或容器生命周期，也不将其声明为受 Umi 管理的沙箱。
export function registerExecutionPlugins(
  registry: ToolRegistry,
  config: () => DesktopConfig,
) {
  registry.register({
    name: 'get_execution_plugins',
    description:
      '读取用户在设置中启用的独立 Docker/WSL 接入及镜像/发行版。它不是授权，也不证明服务已启动。需要调用时使用 run_command/run_shell 的具体宿主批准；不要自动安装、启动服务或创建发行版。后台容器/发行版进程不受普通 Windows Job 生命周期保证。',
    schema: z.object({}).strict(),
    effect: 'read',
    prepare: hostContext,
    async execute(_a, _ctx, _c, signal) {
      signal.throwIfAborted();
      const c = config(),
        data = {
          docker: c.docker,
          wsl: c.wsl,
          executionEntry: 'run_command',
          managedSubsystem: false,
          osIsolationGuaranteed: false,
        };
      return { outcome: 'succeeded', content: JSON.stringify(data), data };
    },
    async reconcile(a, ctx, c, signal) {
      return this.execute(a, ctx, c, signal);
    },
  });
}
