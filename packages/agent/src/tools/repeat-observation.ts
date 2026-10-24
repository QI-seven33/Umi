import type { ExecutionContext } from '../../../protocol/src/model.js';
import { executionContextSchema } from '../../../protocol/src/model.js';
import type { PersistencePort, ToolRow, ToolResult } from '../persistence.js';
import type { ToolRegistry } from './registry.js';

// 这是重复计数的窄豁免，不是命令安全判定，也不是“目标已完成”的证据。
// 只认宿主成功结算的结构化文件内容变化；命令退出、修订号、笔记和模型声明均不算。
export function changedCommandInputs(write: ExecutionContext, command: ExecutionContext): boolean {
  const cwd = command.process?.cwdRef;
  if (!cwd || write.environmentId !== command.environmentId ||
      write.bindingRoot !== command.bindingRoot || write.rootIdentity !== command.rootIdentity) return false;
  return write.locations.some(location => {
    if (location.environmentId !== command.environmentId || location.beforeHash === location.desiredHash) return false;
    const root = location.rootRef;
    const sameRoot = cwd.kind === 'mount'
      ? root.kind === 'mount' && root.area === 'working' && root.mountId === cwd.mountId
      : root.kind === 'task' && root.area === cwd.area;
    return sameRoot && (!cwd.path || location.relativePath.startsWith(`${cwd.path}/`));
  });
}

export function commandRepeatsSinceChange(
  store: PersistencePort, registry: ToolRegistry, current: ToolRow,
  previous: readonly ToolRow[], command: ExecutionContext,
): number {
  const history = store.tools(current.run_id);
  const end = history.findIndex(tool => tool.id === current.id);
  let boundary = -1;
  for (let i = 0; i < end; i++) {
    const tool = history[i]!;
    if (tool.environment_id !== current.environment_id || tool.state !== 'succeeded' || !tool.context_ref || !tool.result_ref) continue;
    // 排除任意宿主程序：它的成功/环境修订不能证明读写了哪些内容。
    if (!['copy-write', 'file-write', 'scratch-write'].includes(registry.get(tool.name).effect)) continue;
    const result = store.readArtifact<ToolResult>(tool.result_ref);
    if (result.outcome !== 'succeeded' || result.mutated === false) continue;
    const write = executionContextSchema.parse(store.readArtifact(tool.context_ref));
    if (changedCommandInputs(write, command)) boundary = i;
  }
  const ids = new Set(history.slice(boundary + 1, end).map(tool => tool.id));
  return previous.filter(tool => ids.has(tool.id)).length;
}