/** IPC 回执超时不等于工具失败；界面沿事件流更新状态，不弹出内部指令，内部查询规则留在协议层。 */
export function userFacingError(error: unknown): string {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === 'COMMAND_TIMEOUT')
    return '';
  return value?.message ?? String(error);
}
