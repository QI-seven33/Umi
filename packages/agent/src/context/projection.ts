import type { WireMessage } from '../../../protocol/src/model.js';
import { validatePairs, UmiError } from '../../../protocol/src/model.js';
import type { ContextMemory, Summary } from '../../../protocol/src/memory.js';
import { hash } from '../identity.js';
import { selectUserSources, PROJECTION_VERSION } from './bounded.js';

export type HistoryRow = {
  id: string;
  payload: WireMessage;
  applied: boolean;
  projectionSequence: string;
  sourceHash?: string;
};
export function ordered(rows: HistoryRow[]): HistoryRow[] {
  return rows
    .filter((m) => m.applied)
    .sort((a, b) =>
      BigInt(a.projectionSequence) < BigInt(b.projectionSequence) ? -1 : 1,
    );
}
// 一个工具调用及其全部结果不可被压缩边界拆开；用户消息按单独的来源组维护。
export function messageGroups(rows: HistoryRow[]): HistoryRow[][] {
  const history = ordered(rows);
  validatePairs(history.map((m) => m.payload));
  const groups: HistoryRow[][] = [];
  for (let i = 0; i < history.length; i++) {
    const group = [history[i]!],
      count = history[i]!.payload.tool_calls?.length ?? 0;
    for (let j = 0; j < count; j++) group.push(history[++i]!);
    groups.push(group);
  }
  return groups;
}
export function validateArchive(
  rows: HistoryRow[],
  archiveIds: string[],
  sourceHashes: Record<string, string>,
  projectionVersion?: 'bounded-v1',
): void {
  const ids = new Set(archiveIds);
  if (ids.size !== archiveIds.length)
    throw new UmiError('PROTOCOL_INVALID', '压缩来源重复');
  const groups = messageGroups(rows);
  const latestUserId = ordered(rows)
    .filter((row) => row.payload.role === 'user')
    .at(-1)?.id;
  for (const group of groups) {
    const retired = group.filter((m) => ids.has(m.id));
    if (retired.length && retired.length !== group.length)
      throw new UmiError('PROTOCOL_INVALID', '压缩不能拆开工具消息组');
    for (const row of retired) {
      if (
        (row.payload.role === 'user' &&
          (projectionVersion !== PROJECTION_VERSION || row.id === latestUserId)) ||
        sourceHashes[row.id] !== (row.sourceHash ?? hash(row.payload))
      )
        throw new UmiError(
          'PROTOCOL_INVALID',
          '用户原话折叠需要版本化索引且不得包含最新输入；来源必须与原记录一致',
        );
      ids.delete(row.id);
    }
  }
  if (ids.size) throw new UmiError('PROTOCOL_INVALID', '压缩来源不属于已应用的会话历史');
}
export function memoryProjection(rows: HistoryRow[], memory: ContextMemory) {
  const applied = ordered(rows),
    retired = new Set(memory.archivedIds),
    kept = applied.filter((m) => !retired.has(m.id));
  const recent = memory.entries
    .filter((e) => e.value.kind !== 'reset')
    .slice(-8)
    .map((e) => ({
      entryId: e.id,
      artifactRef: e.artifactRef,
      kind: e.value.kind,
      value: {
        ...e.value.value,
        text: 'text' in e.value.value ? e.value.value.text.slice(0, 256) : undefined,
      },
      shortened: 'text' in e.value.value && e.value.value.text.length > 256,
    }));
  const activeReset = memory.entries.find((e) => e.id === memory.window.resetEntryId);
  return {
    authority:
      '用户原文是要求事实。摘要、笔记和替代候选是模型记录，不授予权限、不确认交付或工具成功。最新用户更正须结合原文解释。',
    window: {
      ...memory.window,
      keepSources:
        activeReset?.value.kind === 'reset' ? activeReset.value.value.keepSources : [],
    },
    projectionVersion: PROJECTION_VERSION,
    requirements: selectUserSources(applied.filter((m) => m.payload.role === 'user')).map(
      (source) => ({
        requirementId: `requirement:${source.messageId}`,
        ...source,
        status: '原文定位片段，非完整要求列表；结合最新更正读取原文，不自动撤销旧要求',
      }),
    ),
    requirementCount: applied.filter((m) => m.payload.role === 'user').length,
    omittedRequirements: Math.max(
      0,
      applied.filter((m) => m.payload.role === 'user').length - 12,
    ),
    foldedUsers: applied.filter((m) => m.payload.role === 'user' && retired.has(m.id))
      .length,
    requirementIndexRef: memory.window.manifestRef,
    requirementRetrieval:
      'list_user_requirements 可分页查看所有原话定位；search_history/read_history 可追回完整要求。执行涉及旧约束的任务前核对相关原话；未展示或折叠不代表撤销。',
    retainedSourceCount: kept.length,
    omittedRetainedSources: Math.max(0, kept.length - 32),
    retainedSources: kept.slice(-32).map((m) => ({
      messageId: m.id,
      role: m.payload.role,
      bytes: Buffer.byteLength(m.payload.content),
    })),
    notes: recent,
    olderEntries: Math.max(
      0,
      memory.entries.filter((e) => e.value.kind !== 'reset').length - recent.length,
    ),
    historyTools:
      'search_history / read_history 可读取原消息；read_work_memory 可分页读取笔记；read_artifact 可读取当前会话资料。',
  };
}
export function sourceViews(rows: HistoryRow[], ids: string[]) {
  const wanted = new Set(ids);
  return ordered(rows)
    .filter((m) => wanted.has(m.id))
    .map((m) => {
      const bytes = Buffer.from(m.payload.content);
      let end = Math.min(bytes.length, 1600);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      return {
        sourceId: m.id,
        role: m.payload.role,
        hash: hash(m.payload),
        totalBytes: bytes.length,
        ranges: [
          { startByte: 0, endByte: end, text: bytes.subarray(0, end).toString('utf8') },
        ],
        truncated: end < bytes.length,
        toolCalls: m.payload.tool_calls?.map((c) => ({
          id: c.id,
          name: c.function.name,
        })),
        toolCallId: m.payload.tool_call_id,
      };
    });
}
export function extractiveSummary(rows: HistoryRow[], ids: string[]): Summary | null {
  const views = sourceViews(rows, ids).slice(-16);
  if (!views.length) return null;
  return {
    items: views.map((v) => ({
      kind: 'observation' as const,
      sourceIds: [v.sourceId],
      text: `原始 ${v.role} 记录片段${v.truncated ? '（截断；完整内容需读取原记录）' : ''}：${v.ranges[0]!.text.slice(0, 900) || '正文为空；调用信息请读取原消息。'}`,
    })),
  };
}
