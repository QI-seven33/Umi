import type {
  TaskCheckpointInput,
  TaskStateInput,
  TaskCheckpoint,
  TaskAcceptance,
} from '../../protocol/src/task.js';

// 任务状态端口与 SQL、文件系统及模型分开；唯一循环只读投影并提交结束事实。
export interface TaskPort {
  save(executionId: string, input: TaskCheckpointInput): TaskCheckpoint;
  list(conversationId: string): TaskCheckpoint[];
  observation(executionId: string): unknown | null;
  transition(executionId: string, input: TaskStateInput): unknown;
  assess(conversationId: string): TaskAcceptance;
  projection(conversationId: string): unknown;
  complete(runId: string, messageId: string, generation: number, deferred?: readonly string[], failure?: { code: string; reason: string }): void;
}
