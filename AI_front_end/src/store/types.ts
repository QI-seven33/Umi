import type { Conversation, Message, MessageVersion } from "../types";

// ─────────────────────────────────────────────────────────────
// Store 类型定义
// ─────────────────────────────────────────────────────────────

export type ConversationSlice = {
  conversations: Conversation[];
  activeId: string;
  draftThreadId: string;

  setConversations: (updater: Conversation[] | ((prev: Conversation[]) => Conversation[])) => void;
  setActiveId: (id: string) => void;
  setDraftThreadId: (id: string) => void;

  prependConversation: (c: Conversation) => void;
  removeConversation: (threadId: string) => void;
  renameConversation: (threadId: string, title: string) => void;
  setConversationPinned: (threadId: string, pinned: boolean) => void;
  setActiveMessages: (threadId: string, messages: Message[], hasMore: boolean, nextCursor: number | null, activeLeafThreadId?: string) => void;
  setConversationVersions: (threadId: string, versions: Record<string, MessageVersion[]>) => void;
  prependEarlierMessages: (threadId: string, earlier: Message[], hasMore: boolean, nextCursor: number | null) => void;
  appendMessages: (threadId: string, messages: Message[]) => void;
  updateMessage: (threadId: string, messageId: string, updater: (m: Message) => Message) => void;
};

export type StreamingSlice = {
  streaming: boolean;

  setStreaming: (v: boolean) => void;
};

/**
 * 工作区状态（workspaces / selectedWorkspaceId / expandedWorkspaceIds）
 * 当前仍然由 App 组件内的 useState 维护，这里只预留 slice 扩展位，
 * 本次拆分不迁移任何既有状态，避免改变状态载体。
 */
export type WorkspaceSlice = Record<never, never>;

export type ChatState = ConversationSlice & StreamingSlice & WorkspaceSlice;
