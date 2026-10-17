import { hash } from '../identity.js';
import type { HistoryRow } from './projection.js';
import { memoryProjection } from './projection.js';
import type { ContextMemory } from '../../../protocol/src/memory.js';

export const FACT_POLICY = 'domain-changes-v1';
// 原始历史和工具消息负责保留正文；这里仅投影必要状态与追回入口。
export function factDomains(state: Record<string, unknown>, rows: HistoryRow[], memory: ContextMemory): Record<string, unknown> {
  const domains: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    // 兼容旧测试/事实入口；计数与已结算工具原文不是当前权限状态。
    if (['toolCount', 'tools', 'attachmentCount', 'inputPolicy'].includes(key) || value === undefined) continue;
    domains[`runtime.${key}`] = value;
  }
  const projected = memoryProjection(rows, memory);
  domains['memory.window'] = { ...projected.window, projectionVersion: projected.projectionVersion, requirementIndexRef: projected.requirementIndexRef };
  domains['memory.requirements'] = projected.requirements;
  domains['memory.notes'] = projected.notes;
  return domains;
}

export function factUpdates(current: Record<string, unknown>, previous?: Record<string, string>) {
  const hashes: Record<string, string> = {}, values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    hashes[key] = hash(value);
    if (previous?.[key] !== hashes[key]) values[key] = value;
  }
  for (const key of Object.keys(previous ?? {})) if (!(key in current)) values[key] = null;
  return { hashes, values };
}
