// 预览由具体命令 maxOutputBytes 控制，归档独立且有磁盘容量上限。
// 已归档范围可分页；超限或回执缺失必须标明不完整。
export const PROCESS_ARCHIVE_BYTES = 64 * 1024 * 1024;

// 只保留连续的脱敏 UTF-8 前缀。首次溢出后不补入后续片段，避免隐藏中间空洞。
export class ProcessArchiveBudget {
  private bytes = 0;
  truncated = false;
  constructor(readonly limitBytes = PROCESS_ARCHIVE_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > PROCESS_ARCHIVE_BYTES)
      throw new RangeError('进程归档预算无效');
  }
  take(text: string): string {
    if (this.truncated) return '';
    const bytes = Buffer.from(text);
    let length = Math.min(bytes.length, this.limitBytes - this.bytes);
    while (length < bytes.length && length > 0 && (bytes[length]! & 0xc0) === 0x80) length--;
    this.bytes += length;
    this.truncated = length < bytes.length;
    return bytes.subarray(0, length).toString('utf8');
  }
}
