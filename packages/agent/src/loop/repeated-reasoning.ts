export type ReasoningRepetition = {
  periodBytes: number;
  repetitions: number;
  repeatedBytes: number;
  observedBytes: number;
};

// 只识别当前响应中逐字相同的连续思考，不给正常探索打分，也不检查正文/工具参数。
// 相比1KiB即报警的参考实现，至少要有4KiB重复及8个完整单元，降低短暂复述的误判。
const minPeriod = 128, maxPeriod = 2048, minRepeats = 8, minSpan = 4096;
const windowBytes = maxPeriod * minRepeats, scanInterval = 1024;
export class ReasoningRepetitionGuard {
  private tail: Buffer = Buffer.alloc(0);
  private pendingHigh = '';
  private sinceScan = 0;
  private observed = 0;
  private detected: ReasoningRepetition | null = null;
  get retainedBytes() { return this.tail.length; }

  observe(delta: string): ReasoningRepetition | null {
    if (this.detected || !delta) return this.detected;
    let text = this.pendingHigh + delta;
    this.pendingHigh = '';
    // ModelPort片段也可能切在UTF-16代理对中间；不把同一字符误编码成两份替换字符。
    if (/[\uD800-\uDBFF]$/.test(text)) {
      this.pendingHigh = text.slice(-1); text = text.slice(0, -1);
    }
    const bytes = Buffer.from(text);
    this.observed += bytes.length;
    this.sinceScan += bytes.length;
    if (bytes.length >= windowBytes) this.tail = Buffer.from(bytes.subarray(-windowBytes));
    else if (bytes.length) this.tail = Buffer.concat([
      this.tail.subarray(Math.max(0, this.tail.length + bytes.length - windowBytes)), bytes,
    ]);
    if (this.sinceScan < scanInterval) return null;
    this.sinceScan = 0;
    const n = this.tail.length;
    for (let period = minPeriod; period <= Math.min(maxPeriod, Math.floor(n / minRepeats)); period++) {
      const repetitions = Math.max(minRepeats, Math.ceil(minSpan / period));
      const span = period * repetitions;
      if (span > n) continue;
      // 两段平移一个周期后必须完全相等；不归一空白，不按语义或高频单词猜循环。
      if (this.tail.subarray(n - span, n - period).equals(this.tail.subarray(n - span + period))) {
        this.detected = { periodBytes: period, repetitions, repeatedBytes: span, observedBytes: this.observed };
        return this.detected;
      }
    }
    return null;
  }
}
