import { nativeOpenResultSchema } from '../../packages/protocol/src/native-open.js';
import { randomUUID } from 'node:crypto';
import type { DocumentOpener } from '../../packages/protocol/src/native-open.js';
import { UmiError } from '../../packages/protocol/src/model.js';

type Pending = { resolve: () => void; reject: (error: Error) => void; dispose: () => void };
// 一个系统打开请求对应一个回执；停止会撤销等待，但不会重复启动或关闭用户应用。
export class NativeOpenClient {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly send: (message: unknown) => void, private readonly instance: () => string) {}
  readonly open: DocumentOpener = (target, signal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const correlationId = randomUUID();
    const abort = () => finish(new UmiError('OPEN_INTERRUPTED', '系统打开回执中断，未重放'));
    const timer = setTimeout(() => finish(new UmiError('OPEN_TIMEOUT', '系统打开回执超时，未重复打开')), 10000);
    const finish = (error?: Error) => {
      const item = this.pending.get(correlationId);
      if (!item) return;
      this.pending.delete(correlationId); item.dispose();
      if (error) item.reject(error); else item.resolve();
    };
    this.pending.set(correlationId, { resolve, reject, dispose: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } });
    signal.addEventListener('abort', abort, { once: true });
    try { this.send({ kind: 'open_document', instanceId: this.instance(), correlationId, target }); }
    catch { finish(new UmiError('OPEN_UNAVAILABLE', '系统打开入口不可用')); }
  });
  receive(message: unknown) {
    const parsed = nativeOpenResultSchema.safeParse(message);
    if (!parsed.success || parsed.data.instanceId !== this.instance()) return false;
    const m = parsed.data;
    const item = this.pending.get(m.correlationId);
    if (!item) return true;
    this.pending.delete(m.correlationId); item.dispose();
    if (m.error) item.reject(new UmiError(m.code === 'OPEN_REJECTED' ? 'OPEN_REJECTED' : 'OPEN_UNKNOWN', m.error)); else item.resolve();
    return true;
  }
}
