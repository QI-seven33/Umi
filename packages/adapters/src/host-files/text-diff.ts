// 精确文本对照；超大变化段给出完整的删/增段，避免昂贵比对或漏掉中段。
export function fileDiff(before: string, after: string) {
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
