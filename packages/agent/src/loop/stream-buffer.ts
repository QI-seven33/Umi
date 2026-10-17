import type { EventBody } from '../../../protocol/src/events.js';

type Delta = Extract<EventBody, { type: 'model.delta' }>;
/** 短批次只改变事务频率；每个原片段、索引和文本仍独立持久化。 */
export class StreamBuffer {
  private pending: Delta[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  constructor(private readonly persist: (deltas: Delta[]) => void) {}
  push(delta: Delta) {
    this.check();
    this.pending.push(delta);
    this.bytes += Buffer.byteLength(delta.payload.text);
    if (this.pending.length >= 64 || this.bytes >= 8192) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.flush(); } catch (error) { this.failure = error; }
    }, 32);
  }
  check() { if (this.failure) throw this.failure; }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    this.check();
    if (!this.pending.length) return;
    const batch = this.pending;
    // 失败的批次不重复提交；事务回滚交给适配器处理。
    this.pending = []; this.bytes = 0;
    try { this.persist(batch); } catch (error) { this.failure = error; throw error; }
  }
}
