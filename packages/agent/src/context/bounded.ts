import type { UserSourceIndex } from '../../../protocol/src/memory.js';
import { hash } from '../identity.js';
import { modelToolContent } from '../tools/result.js';
import type { HistoryRow } from './projection.js';

export const PROJECTION_VERSION = 'bounded-v1' as const;
export const TOOL_PROJECTION_VERSION = 'tool-stable-v4-image-observation' as const;

// 所有位置都能回到原始 UTF-8 字节；不将残缺字符写入索引或工具摘录。
export function byteExcerpt(text: string, startByte: number, byteLength: number) {
  const bytes = Buffer.from(text);
  let start = Math.min(Math.max(0, startByte), bytes.length);
  let end = Math.min(start + byteLength, bytes.length);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  end = Math.max(start, end);
  return {
    startByte: start,
    endByte: end,
    text: bytes.subarray(start, end).toString('utf8'),
  };
}

export function userSourceIndex(row: HistoryRow): UserSourceIndex {
  const text = row.payload.content;
  const contentBytes = Buffer.byteLength(text);
  const excerpts = [byteExcerpt(text, 0, 256)];
  if (contentBytes > 256)
    excerpts.push(byteExcerpt(text, Math.max(256, contentBytes - 256), 256));
  // 这是定位提示，不是要求分类器：只引用确实存在的原话，不判定授权或替代关系。
  const markers = text.matchAll(
    /禁止|不得|不要|必须|只能|仅限|不允许|保留|不能|\bnever\b|\bmust\b|\bdo not\b|\bdon't\b|\bonly\b/gi,
  );
  for (const match of markers) {
    if (excerpts.length >= 5) break;
    const start = Buffer.byteLength(text.slice(0, match.index));
    if (excerpts.some((e) => start >= e.startByte && start < e.endByte)) continue;
    excerpts.push(byteExcerpt(text, Math.max(0, start - 32), 160));
  }
  excerpts.sort((a, b) => a.startByte - b.startByte);
  return {
    messageId: row.id,
    sourceHash: row.sourceHash ?? hash(row.payload),
    projectionSequence: row.projectionSequence,
    contentBytes,
    excerpts,
    truncated: (() => {
      let end = 0;
      for (const range of excerpts) {
        if (range.startByte > end) return true;
        end = Math.max(end, range.endByte);
      }
      return end < contentBytes;
    })(),
  };
}

// 活跃索引有固定数量上限。全量索引在窗口清单中，原话可通过只读分页工具追回。
export function selectUserSources(rows: HistoryRow[], limit = 12): UserSourceIndex[] {
  if (rows.length <= limit) return rows.map(userSourceIndex);
  const query = rows.at(-1)!.payload.content.slice(0, 1024);
  const terms = new Set(
    query.toLowerCase().match(/[a-z0-9_./-]{3,}|[\u3400-\u9fff]{2}/g) ?? [],
  );
  const pinned = new Set([rows[0]!.id, ...rows.slice(-3).map((r) => r.id)]);
  const scored = rows.map((row, position) => {
    const text = row.payload.content.toLowerCase();
    let score = /禁止|不得|不要|必须|只能|不允许|\bnever\b|\bmust\b|\bdo not\b/i.test(
      text,
    )
      ? 2
      : 0;
    for (const term of terms) if (text.includes(term)) score++;
    return { row, position, score };
  });
  scored.sort((a, b) => b.score - a.score || b.position - a.position);
  for (const item of scored) {
    if (pinned.size >= limit) break;
    pinned.add(item.row.id);
  }
  return rows.filter((row) => pinned.has(row.id)).map(userSourceIndex);
}

export function protectedUserIds(
  rows: HistoryRow[],
  archivedIds: string[],
  inputCeiling: number,
) {
  const users = rows.filter((row) => row.payload.role === 'user');
  const latest = users.at(-1);
  const ids = new Set(latest ? [latest.id] : []);
  let budget = Math.min(4096, Math.floor(inputCeiling * 0.08));
  // 短原话仍可直接保留，避免仅为几个字支付折叠的语义损失。容量和条数都有上限。
  for (const row of users) {
    const bytes = Buffer.byteLength(row.payload.content);
    if (
      ids.has(row.id) ||
      archivedIds.includes(row.id) ||
      bytes > 1024 ||
      bytes > budget ||
      ids.size >= 7
    )
      continue;
    ids.add(row.id);
    budget -= bytes;
  }
  return ids;
}

// 最近一次模型调用的工具组必须先完整反馈；新用户插话也不能使未反馈结果失去保护。
export function freshToolIds(rows: HistoryRow[]) {
  const assistant = rows.findLastIndex((row) => row.payload.role === 'assistant');
  const calls = new Set(rows[assistant]?.payload.tool_calls?.map((call) => call.id));
  return new Set(rows.slice(assistant + 1)
    .filter((row) => row.payload.role === 'tool' && calls.has(row.payload.tool_call_id!))
    .map((row) => row.id));
}

// 已发送结果在窗口内保持完整、稳定。容量由 manager 按完整消息组维护，
// 不在此按“新旧”或历史条数重裁；原始历史及去重兼容仍保留。
export function toolResultViews(rows: HistoryRow[], _inputCeiling: number) {
  return {
    messages: rows.map((row) => ({ ...structuredClone(row.payload),
      ...(row.payload.role === 'tool' ? { content: modelToolContent(row.payload.content) } : {}),
    })),
    views: [] as { messageId: string; sourceHash: string; contentBytes: number;
      excerpts: ReturnType<typeof byteExcerpt>[] }[],
  };
}
