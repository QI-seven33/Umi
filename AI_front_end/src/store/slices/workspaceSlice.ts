import type { StateCreator } from "zustand";

import type { ChatState, WorkspaceSlice } from "../types";

/**
 * 预留 slice：工作区状态仍在 App 组件内，等真正需要跨组件共享时再在此扩展。
 */
export const createWorkspaceSlice: StateCreator<ChatState, [], [], WorkspaceSlice> = () => ({});
