import type { ModelPort, PreparedRequest, ModelFrame } from './ports.js';
import { UmiError } from '../../protocol/src/model.js';
import { type ReasoningRepetition, ReasoningRepetitionGuard } from './loop/repeated-reasoning.js';

// 只限制等待提供商数据的空闲时间。持续生成、SSE 心跳和拆开的字节都续期；
// 交还调用者处理/落库时停止计时，避免把本地处理耗时算成网络失联。
export async function* streamWithIdleTimeout(
  model: ModelPort, request: PreparedRequest, signal: AbortSignal, timeoutMs: number,
  onRepetition?: (observation: ReasoningRepetition) => void,
): AsyncGenerator<ModelFrame> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const repetition = new ReasoningRepetitionGuard();
  let repetitionReported = false;
  const combined = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined, waiting = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const activity = () => {
    if (!waiting || combined.aborted) return;
    clear();
    timer = setTimeout(() => controller.abort(new UmiError('PROVIDER_TIMEOUT',
      '模型连接连续 ' + timeoutMs / 1000 + ' 秒未收到数据，已暂停；已显示内容保留，未完成工具未执行。', true)), timeoutMs);
  };
  const iterator = model.stream(request, combined, activity)[Symbol.asyncIterator]();
  try {
    while (true) {
      combined.throwIfAborted();
      waiting = true;
      activity();
      let next: IteratorResult<ModelFrame>;
      try { next = await iterator.next(); combined.throwIfAborted(); }
      finally { waiting = false; clear(); }
      if (next.done) return;
      const frame = next.value;
      // 先交给原消费方保存本片段；检测不裁剪原稿，也不将残缺调用提升为完整响应。
      yield frame;
      combined.throwIfAborted();
      if (frame.kind === 'delta' && frame.channel === 'reasoning') {
        const repeated = repetition.observe(frame.text);
        if (repeated && !repetitionReported) {
          repetitionReported = true;
          // 重复文本只是观察，不能证明推理失效；不截流、不重试、不向模型插入规则。
          onRepetition?.(repeated);
        }
      }
    }
  } catch (error) {
    // 用户停止优先；适配器的取消异常不应掩盖真正的空闲超时原因。
    if (signal.aborted) throw signal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    waiting = false;
    clear();
    controller.abort();
    try { await iterator.return?.(); } catch { /* 取消清理不覆盖原完成/失败原因。 */ }
  }
}
