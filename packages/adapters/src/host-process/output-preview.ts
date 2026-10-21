// 只处理已经脱敏、归档的文本。摘录不是新输出，范围始终指向原归档 UTF-8 字节。
type Range = { startByte: number; endByte: number };
function excerpt(bytes: Buffer, start: number, end: number) {
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  end = Math.max(start, end);
  return { text: bytes.subarray(start, end).toString('utf8'), range: { startByte: start, endByte: end } };
}
function streamPreview(bytes: Buffer, limit: number) {
  const split = bytes.length > limit;
  const head = excerpt(bytes, 0, split ? Math.floor(limit / 2) : bytes.length);
  const tail = split
    ? excerpt(bytes, Math.max(head.range.endByte, bytes.length - (limit - head.range.endByte)), bytes.length)
    : null;
  const omitted: Range | null = split && head.range.endByte < tail!.range.startByte
    ? { startByte: head.range.endByte, endByte: tail!.range.startByte } : null;
  return {
    head: head.text, tail: tail?.text ?? '',
    keptBytes: head.range.endByte + (tail ? tail.range.endByte - tail.range.startByte : 0),
    nextStartByte: omitted?.startByte ?? null,
    ranges: { archivedBytes: bytes.length, head: head.range, tail: tail?.range ?? null, omitted },
  };
}

// stdout/stderr 共用原预算；stderr 保留至少四分之一的需求份额，也可使用 stdout 空余。
// 长输出各取首尾，避免末尾错误被开头日志淹没；不按关键词猜测失败原因。
export function commandOutputPreview(stdout: string, stderr: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('输出预览预算无效');
  const limitBytes = Math.min(8000, maxBytes);
  // 每个流只编码一次；大归档不为每个首尾片段重复分配整份 Buffer。
  const out = Buffer.from(stdout), err = Buffer.from(stderr);
  const stderrBudget = Math.min(err.length, Math.max(Math.floor(limitBytes / 4), limitBytes - out.length));
  const stderrView = streamPreview(err, stderrBudget);
  const stdoutView = streamPreview(out, Math.min(out.length, limitBytes - stderrView.keptBytes));
  return {
    stdout: stdoutView.head, stderr: stderrView.head,
    stdoutTail: stdoutView.tail, stderrTail: stderrView.tail,
    stdoutNextStartByte: stdoutView.nextStartByte,
    stderrNextStartByte: stderrView.nextStartByte,
    previewTruncated: stdoutView.ranges.omitted !== null || stderrView.ranges.omitted !== null,
    outputPreview: {
      schemaVersion: 1, strategy: 'head-tail', limitBytes,
      keptBytes: stdoutView.keptBytes + stderrView.keptBytes,
      stdout: stdoutView.ranges, stderr: stderrView.ranges,
    },
  };
}
