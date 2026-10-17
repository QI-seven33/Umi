import type { DeliveryReceipt } from '../../../protocol/src/resources.js';
import { byteExcerpt } from '../../../agent/src/context/bounded.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { FrozenFilePage } from '../../../protocol/src/file-preview.js';
import type { ResourceFiles } from './resources.js';

// 精确文本对照；超大变化段给出完整的删/增段，避免昂贵比对或漏掉中段。
export function frozenDiff(before: string, after: string) {
  const a = before.split('\n'), b = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  if (prefix === a.length && prefix === b.length) return '没有文本变化。';
  const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix);
  const context = a.slice(Math.max(0, prefix - 3), prefix).map(line => ' ' + line);
  const changes: string[] = [];
  if ((old.length + 1) * (next.length + 1) <= 500_000) {
    const width = next.length + 1, lengths = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--)
      lengths[i * width + j] = old[i] === next[j] ? 1 + lengths[(i + 1) * width + j + 1]! : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) changes.push(' ' + old[i++]), j++;
      else if (j === next.length || (i < old.length && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) changes.push('-' + old[i++]);
      else changes.push('+' + next[j++]);
    }
  } else {
    for (const line of old) changes.push('-' + line);
    for (const line of next) changes.push('+' + line);
  }
  const tail = a.slice(a.length - suffix, a.length - suffix + 3).map(line => ' ' + line);
  return ['--- 修改前', '+++ 修改后', `@@ 原第 ${Math.max(1, prefix - 2)} 行起；- 删除 / + 新增 @@`, ...context, ...changes, ...tail].join('\n');
}

export class FrozenPreview {
  // 单一最近对象、最多 8MiB 派生文本；不持有无界缓存或改动冻结内容。
  private cached: { key: string; text: string } | null = null;
  constructor(private readonly files: ResourceFiles) {}

  read(conversationId: string, changeSetId: string, path: string,
    side: 'before' | 'after' | 'diff', startByte: number, byteLength: number): FrozenFilePage {
    const store = this.files.repo.store;
    const env = store.environment(store.conversation(conversationId).environment_id as string);
    const cs = this.files.repo.changeSet(changeSetId, env.id);
    const entry = cs.changes.find(item => item.path === path);
    if (!entry) throw new UmiError('PERMISSION_DENIED', '文件不属于这份冻结变更');
    const hash = `${entry.before?.hash ?? 'absent'}:${entry.after?.hash ?? 'absent'}:${side}`;
    const key = `${cs.id}:${path}:${hash}`;
    let text = this.cached?.key === key ? this.cached.text : null;
    let binary = false;
    if (text === null) {
      const decode = (value: typeof entry.before) => {
        if (!value) return '';
        const bytes = this.files.blob(env, value.hash);
        try {
          const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          if (value.includes('\0')) throw Error('binary');
          return value;
        } catch { binary = true; return ''; }
      };
      const before = side === 'after' ? '' : decode(entry.before);
      const after = side === 'before' ? '' : decode(entry.after);
      text = binary ? '二进制内容不作文本对照；请核对文件大小与完整哈希。' : side === 'diff' ? frozenDiff(before, after) : side === 'before' ? before : after;
      this.cached = !binary && Buffer.byteLength(text) <= 8 * 1024 * 1024 ? { key, text } : null;
    }
    const page = byteExcerpt(text, startByte, byteLength), totalBytes = Buffer.byteLength(text);
    if (startByte > totalBytes || page.startByte !== startByte || (page.endByte === startByte && startByte < totalBytes))
      throw new UmiError('PREVIEW_RANGE_INVALID', '分页必须从字符边界开始，窗口须容纳一个完整字符');
    return { ...page, totalBytes, nextStartByte: page.endByte < totalBytes ? page.endByte : null,
      truncated: page.endByte < totalBytes, hash, side, binary,
      delivered: this.files.repo.items(cs.id).some(item => item.path === path && item.receipt_ref &&
        ['applied', 'satisfied'].includes(store.readArtifact<DeliveryReceipt>(item.receipt_ref as string).outcome)),
      before: entry.before, after: entry.after, operation: !entry.before ? 'create' : !entry.after ? 'delete' : 'modify' };
  }
}
