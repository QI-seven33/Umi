import { UmiError } from '../../../protocol/src/model.js';
import { ToolRegistry } from './registry.js';
import type { ToolDefinition } from './registry.js';

export interface ToolModule {
  readonly id: string;
  readonly version: string;
  readonly requires: readonly string[];
  // 工厂仅组装工具；实际效果发生在唯一 ToolExecutor 的 execute/reconcile 中。
  create(): readonly ToolDefinition[];
}
export interface ToolModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly requires: readonly string[];
  readonly tools: readonly string[];
}

// 用显式闭包传递所需端口，兼容现有注册函数，不暴露全局服务容器。
export function toolModule(
  id: string,
  version: string,
  requires: readonly string[],
  register: (registry: ToolRegistry) => void,
): ToolModule {
  return Object.freeze({
    id,
    version,
    requires: Object.freeze([...requires]),
    create() {
      const isolated = new ToolRegistry();
      register(isolated);
      return isolated.entries();
    },
  });
}

export function installToolModules(
  registry: ToolRegistry,
  modules: readonly ToolModule[],
): readonly ToolModuleManifest[] {
  const byId = new Map<string, ToolModule>();
  for (const module of modules) {
    if (
      !/^[a-z][a-z0-9.-]{0,119}$/.test(module.id) ||
      !/^\d+\.\d+\.\d+$/.test(module.version) ||
      byId.has(module.id)
    )
      throw new UmiError('MODULE_CONFLICT', '模块身份/版本无效或重复');
    if (new Set(module.requires).size !== module.requires.length)
      throw new UmiError('MODULE_CONFLICT', '模块依赖重复');
    byId.set(module.id, module);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    ordered: ToolModule[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    const module = byId.get(id);
    if (!module)
      throw new UmiError('MODULE_DEPENDENCY_MISSING', `缺少工具模块依赖：${id}`);
    if (visiting.has(id))
      throw new UmiError('MODULE_DEPENDENCY_CYCLE', '工具模块依赖形成循环');
    visiting.add(id);
    for (const dependency of module.requires) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(module);
  }
  for (const module of modules) visit(module.id);
  const tools: ToolDefinition[] = [];
  const manifests = ordered.map((module) => {
    const definitions = [...module.create()];
    tools.push(...definitions);
    return Object.freeze({
      id: module.id,
      version: module.version,
      requires: Object.freeze([...module.requires]),
      tools: Object.freeze(definitions.map((t) => t.name)),
    });
  });
  // 全部名称检查完成后才发布，失败时不留下半套可调用工具。
  registry.registerMany(tools);
  return Object.freeze(manifests);
}
