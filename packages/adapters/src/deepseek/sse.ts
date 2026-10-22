import { UmiError } from '../../../protocol/src/model.js';

// 连续字节流经 TextDecoder 解码，正确处理中文字符、CRLF、注释和多行 data。
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxEventBytes = 2_000_000,
  activity?: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    data: string[] = [],
    size = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  function line(value: string): string | undefined {
    if (value === '') {
      const result = data.length ? data.join('\n') : undefined;
      data = [];
      size = 0;
      return result;
    }
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, '');
      size += Buffer.byteLength(part) + (data.length ? 1 : 0);
      if (size > maxEventBytes)
        throw new UmiError('PROTOCOL_INVALID', '模型事件超过大小限制');
      data.push(part);
    }
    return undefined;
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (value?.byteLength) activity?.();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // 网络读取可一次合并很多合法事件；逐行核对后只检查未闭合尾行，
      // 不能把整个网络块大小当成单条事件大小。
      let i: number, offset = 0;
      while ((i = buffer.indexOf('\n', offset)) >= 0) {
        signal.throwIfAborted();
        const row = buffer.slice(offset, i).replace(/\r$/, '');
        if (Buffer.byteLength(row) > maxEventBytes + 6)
          throw new UmiError('PROTOCOL_INVALID', '流式行超过大小限制');
        offset = i + 1;
        const result = line(row);
        if (result !== undefined) yield result;
      }
      buffer = buffer.slice(offset);
      if (Buffer.byteLength(buffer.replace(/\r$/, '')) > maxEventBytes + 6)
        throw new UmiError('PROTOCOL_INVALID', '流式行超过大小限制');
      if (done) {
        if (buffer) line(buffer.replace(/\r$/, ''));
        const result = line('');
        if (result !== undefined) yield result;
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
