// 停止与只读会话列表可穿插处理；其余命令仍有序。处理器负责校验实例、会话及字段。
export class WorkerCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  dispatch(handle: () => Promise<void>, priority = false): Promise<void> {
    if (priority) return handle();
    const current = this.tail.then(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await handle();
    });
    this.tail = current.catch(() => {});
    return current;
  }
}
