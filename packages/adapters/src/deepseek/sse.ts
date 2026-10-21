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
      size += Buffer.byteLength(part);
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
      if (Buffer.byteLength(buffer) > maxEventBytes)
        throw new UmiError('PROTOCOL_INVALID', '流式行超过大小限制');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const row = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        const result = line(row);
        if (result !== undefined) yield result;
      }
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
