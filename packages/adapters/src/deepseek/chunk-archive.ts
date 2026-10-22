import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { UmiError } from '../../../protocol/src/model.js';

// 原始 JSON 分片无损归档；重复的协议外壳不常驻对象数组，也不作为任务输出预算。
// 每个块独立压缩，接收时最多积累一个小块；没有合并、丢弃厂商字段或改变分片顺序。
const blockTarget = 64 * 1024;
export const responseMemoryBytes = 64 * 1024 * 1024;
const maxDecodedReadBytes = 128 * 1024 * 1024;
type Archive = { format: 'umi-provider-jsonl-deflate-v1'; blocks: string[]; decodedBytes: number; eventCount: number };
export class ProviderChunkArchive {
  private pending: string[] = [];
  private pendingBytes = 0;
  private compressedBytes = 0;
  private archive: Archive = { format: 'umi-provider-jsonl-deflate-v1', blocks: [], decodedBytes: 0, eventCount: 0 };
  append(value: unknown) {
    const line = JSON.stringify(value) + '\n', bytes = Buffer.byteLength(line);
    this.pending.push(line); this.pendingBytes += bytes;
    this.archive.decodedBytes += bytes; this.archive.eventCount++;
    if (this.pendingBytes >= blockTarget) this.flush();
  }
  private flush() {
    if (!this.pending.length) return;
    const block = deflateRawSync(this.pending.join(''));
    this.compressedBytes += block.length;
    if (this.compressedBytes > responseMemoryBytes)
      throw new UmiError('PROVIDER_RESOURCE_LIMIT', '单次模型响应的压缩原始资料超过 64 MiB 内存容量；已显示内容保留，未完成工具未执行。');
    this.archive.blocks.push(block.toString('base64'));
    this.pending = []; this.pendingBytes = 0;
  }
  finish(): Archive { this.flush(); return this.archive; }
}
function decode(archive: Archive): unknown[] {
  // 仅在主动读取原始资料时展开；正常运行不重新展开协议外壳。大归档完整保留，
  // 整体展开超出读取容量时如实拒绝，不把归档的接收或任务判成失败。
  if (archive.decodedBytes > maxDecodedReadBytes)
    throw new UmiError('ARTIFACT_READ_LIMIT', '原始模型分片完整保留，但超过 128 MiB 整体展开容量；可从完整消息和原始事件读取正文及工具结果。');
  const result: unknown[] = [];
  let decoded = 0;
  for (const block of archive.blocks) {
    const text = inflateRawSync(Buffer.from(block, 'base64'), { maxOutputLength: 2_100_000 }).toString('utf8');
    decoded += Buffer.byteLength(text);
    if (decoded > maxDecodedReadBytes) throw new UmiError('ARTIFACT_READ_LIMIT', '原始模型分片超过整体展开容量');
    for (const line of text.split('\n')) if (line) result.push(JSON.parse(line));
  }
  if (decoded !== archive.decodedBytes || result.length !== archive.eventCount)
    throw new UmiError('PROTOCOL_INVALID', '模型原始资料归档计数不一致');
  return result;
}
function isArchive(value: any): value is Archive {
  return value?.format === 'umi-provider-jsonl-deflate-v1' && Array.isArray(value.blocks);
}
// SQLite 对 provider-response 透明展开，兼容旧数组和旧 length 草稿。
// 模型不需要理解压缩格式，read_artifact 及已有的资料归属/指纹检查仍沿原入口。
export function expandProviderRaw(value: any): unknown {
  if (value?.kind === 'umi-provider-stream' && isArchive(value.archive)) return decode(value.archive);
  if (value?.kind === 'output-limit' && isArchive(value.providerChunks))
    return { ...value, providerChunks: decode(value.providerChunks) };
  return value;
}
