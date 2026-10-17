import type { ProcessIdentity, ProcessSnapshot } from '../../../protocol/src/process.js';
import type { NativeExit } from './frames.js';

export type WindowsProcessProbe =
  | 'absent'
  | 'different'
  | 'same'
  | 'terminated'
  | 'inaccessible';

export interface WindowsProcessCallbacks {
  owner(bridge: ProcessIdentity): void;
  // child 必须仍挂起。只有此回调成功后才可释放；拒绝时清理原 Job。
  ready(bridge: ProcessIdentity, child: ProcessIdentity): Promise<void>;
  started(): void;
  output(channel: 'stdout' | 'stderr', text: string): void;
}

/**
 * 旧 Windows V1 执行端口：携带 PID birth、挂起门控和真实 Job 回执。
 * 注入的是可信宿主实现，不能通过此接口跳过批准或伪造隔离能力。
 * 其他执行后端需要独立的中立计划/回执契约，不能直接套用此端口。
 */
export interface LegacyWindowsProcessPort {
  run(
    snapshot: ProcessSnapshot,
    callbacks: WindowsProcessCallbacks,
    signal: AbortSignal,
  ): Promise<NativeExit>;
  // 同一 PID 的 birth 不符时不得终止；无法核验返回 inaccessible。
  probe(identity: ProcessIdentity, terminate?: boolean, signal?: AbortSignal): Promise<WindowsProcessProbe>;
}
