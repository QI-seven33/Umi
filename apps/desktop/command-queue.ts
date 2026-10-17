// 仅停止走优先入口；普通命令仍有序。处理器负责校验实例、会话及请求字段。
export class WorkerCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  dispatch(handle: () => Promise<void>, stop = false): Promise<void> {
    if (stop) return handle();
    const current = this.tail.then(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await handle();
    });
    this.tail = current.catch(() => {});
    return current;
  }
}
