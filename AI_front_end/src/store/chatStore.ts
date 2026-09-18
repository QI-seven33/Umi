import { create } from "zustand";

import { createConversationSlice } from "./slices/conversationSlice";
import { createStreamingSlice } from "./slices/streamingSlice";
import { createWorkspaceSlice } from "./slices/workspaceSlice";
import type { ChatState } from "./types";

// ─────────────────────────────────────────────────────────────
// Store
// 强制约束：中间件（如 persist）只能在根 store 应用，禁止在单个 slice 内使用。
// ─────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get, api) => ({
  ...createConversationSlice(set, get, api),
  ...createStreamingSlice(set, get, api),
  ...createWorkspaceSlice(set, get, api),
}));

