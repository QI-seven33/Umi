import type { StateCreator } from "zustand";

import type { ChatState, ConversationSlice } from "../types";

export const createConversationSlice: StateCreator<ChatState, [], [], ConversationSlice> = (set) => ({
  conversations: [],
  activeId: "",
  draftThreadId: "",

  setConversations: (updater) => set((s) => ({
    conversations: typeof updater === "function" ? updater(s.conversations) : updater,
  })),
  setActiveId: (id) => set({ activeId: id }),
  setDraftThreadId: (id) => set({ draftThreadId: id }),

  prependConversation: (c) => set((s) => ({ conversations: [c, ...s.conversations] })),
  removeConversation: (id) => set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),
  renameConversation: (id, title) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, title } : c),
  })),
  setConversationPinned: (id, pinned) => set((s) => {
    const next = s.conversations.map((c) => c.id === id ? { ...c, pinned } : c);
    next.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return { conversations: next };
  }),
  setActiveMessages: (id, messages, hasMore, nextCursor, activeLeafThreadId) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, messages, hasMore, nextCursor, activeLeafThreadId: activeLeafThreadId ?? c.activeLeafThreadId } : c
      ),
    })),
  setConversationVersions: (id, versions) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, versions } : c),
  })),
  prependEarlierMessages: (id, earlier, hasMore, nextCursor) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, messages: [...earlier, ...c.messages], hasMore, nextCursor } : c
    ),
  })),
  appendMessages: (id, messages) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, messages: [...c.messages, ...messages] } : c
    ),
  })),
  updateMessage: (id, messageId, updater) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? {
        ...c,
        messages: c.messages.map((m) => m.id === messageId ? updater(m) : m),
      } : c
    ),
  })),
});
