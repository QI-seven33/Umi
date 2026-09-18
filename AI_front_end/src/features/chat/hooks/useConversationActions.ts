import type { Dispatch, RefObject, SetStateAction } from "react";
import type { FormEvent } from "react";

import { useChatStore } from "../../../store/chatStore";
import type { MessageVersion } from "../../../types";
import { API_BASE } from "../../../utils/constants";
import { makeId } from "../../../utils/file";
import { mapHistoryMessages } from "../utils/message";
import type { RunStreamFor } from "./useStreaming";

export type UseConversationActionsOptions = {
  activeWorkspaceId: string;
  prompt: string;
  chatCanvasRef: RefObject<HTMLElement | null>;
  loadingEarlier: boolean;
  setLoadingEarlier: (v: boolean) => void;
  deletingId: string | null;
  setDeletingId: (id: string | null) => void;
  batchDeleting: boolean;
  setBatchDeleting: (v: boolean) => void;
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setMultiSelect: (v: boolean) => void;
  setBatchDeleteOpen: (v: boolean) => void;
  setConversationMenuId: (id: string | null) => void;
  setPrompt: (v: string) => void;
  clearAttachments: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  runStreamFor: RunStreamFor;
  fetchVersions: (threadId: string) => Promise<Record<string, MessageVersion[]>>;
  reloadHistory: (mainThreadId: string) => Promise<void>;
  settleInterruptedHistory: (threadId: string, query: string) => Promise<void>;
};

export function useConversationActions({
  activeWorkspaceId,
  prompt,
  chatCanvasRef,
  loadingEarlier,
  setLoadingEarlier,
  deletingId,
  setDeletingId,
  batchDeleting,
  setBatchDeleting,
  selectedIds,
  setSelectedIds,
  setMultiSelect,
  setBatchDeleteOpen,
  setConversationMenuId,
  setPrompt,
  clearAttachments,
  scrollToBottom,
  runStreamFor,
  fetchVersions,
  reloadHistory,
  settleInterruptedHistory,
}: UseConversationActionsOptions) {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) => s.streaming);
  const setActiveId = useChatStore((s) => s.setActiveId);
  const setDraftThreadId = useChatStore((s) => s.setDraftThreadId);
  const prependConversation = useChatStore((s) => s.prependConversation);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const renameConversationInStore = useChatStore((s) => s.renameConversation);
  const setConversationPinned = useChatStore((s) => s.setConversationPinned);
  const setActiveMessages = useChatStore((s) => s.setActiveMessages);
  const prependEarlierMessages = useChatStore((s) => s.prependEarlierMessages);

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || streaming || !activeWorkspaceId) return;

    const isDraft = !conversations.some((c) => c.id === activeId);
    const threadId = activeId;

    if (isDraft) {
      prependConversation({
        id: threadId, workspaceId: activeWorkspaceId,
        title: text.slice(0, 24), messages: [],
      });
      setDraftThreadId("");
    }

    setPrompt("");
    clearAttachments();
    scrollToBottom("auto");

    const mainConv = useChatStore.getState().conversations.find((c) => c.id === threadId);
    const execThread = mainConv?.activeLeafThreadId || threadId;
    const outcome = await runStreamFor(execThread, text, threadId);
    if (outcome === "done") {
      await reloadHistory(threadId);
    } else {
      // 主动中断：不能立刻拉 history —— 后端在 CancelledError 里用 asyncio.shield 把中断前的文本
      // 写回 checkpoint，而 /api/chat/stop 是 cancel 后立即返回，此刻读到的历史还是旧的，会把界面上
      // 已经渲染出来的文本覆盖回退。改为保留本地文本，并退避重试地把服务端字段收敛回来。
      await settleInterruptedHistory(threadId, text);
    }
  };

  const newConversation = () => {
    if (!activeWorkspaceId) return;
    const newId = makeId();
    setDraftThreadId(newId);
    setActiveId(newId);
    setPrompt("");
    clearAttachments();
  };

  const deleteConversation = async (conversationId: string) => {
    if (deletingId) return;
    setDeletingId(conversationId);
    try {
      const response = await fetch(`${API_BASE}/api/chat/thread`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: conversationId }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`删除失败（${response.status}）`);
      const remaining = conversations.filter((c) => c.id !== conversationId);
      removeConversation(conversationId);
      if (activeId === conversationId) {
        if (remaining.length > 0) { setActiveId(remaining[0].id); setDraftThreadId(""); }
        else { const newId = makeId(); setDraftThreadId(newId); setActiveId(newId); }
      }
      setConversationMenuId(null);
    } finally { setDeletingId(null); }
  };

  const renameConversation = async (id: string, nextTitle: string) => {
    const title = nextTitle.trim();
    if (!title) return;
    const previous = conversations.find((c) => c.id === id)?.title;
    if (previous === title) return;
    renameConversationInStore(id, title);
    try {
      const res = await fetch(`${API_BASE}/api/chat/thread/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, title }),
      });
      if (!res.ok) throw new Error(`重命名失败（${res.status}）`);
    } catch { if (previous !== undefined) renameConversationInStore(id, previous); }
  };

  const togglePin = async (id: string, pinned: boolean) => {
    setConversationPinned(id, pinned);
    try {
      const res = await fetch(`${API_BASE}/api/chat/thread/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, pinned }),
      });
      if (!res.ok) throw new Error(`置顶失败（${res.status}）`);
    } catch { setConversationPinned(id, !pinned); }
  };

  const handleSelectConversation = async (id: string) => {
    setActiveId(id);
    setConversationMenuId(null);
    void fetchVersions(id);
    const target = conversations.find((c) => c.id === id);
    if (target && target.messages.length > 0) {
      requestAnimationFrame(() => {
        const canvas = chatCanvasRef.current;
        if (canvas) canvas.scrollTop = canvas.scrollHeight;
      });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/chat/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, limit: 20 }),
      });
      const json = await res.json();
      const messages = mapHistoryMessages(json.data?.messages ?? []);
      const hasMore: boolean = json.data?.has_more ?? false;
      const nextCursor: number | null = json.data?.next_cursor ?? null;
      const activeLeaf: string | undefined = json.data?.active_leaf_thread_id;
      setActiveMessages(id, messages, hasMore, nextCursor, activeLeaf);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const canvas = chatCanvasRef.current;
          if (canvas) canvas.scrollTop = canvas.scrollHeight;
        });
      });
    } catch { /* silent */ }
  };

  const loadEarlierMessages = async (threadId: string) => {
    if (loadingEarlier) return;
    const target = conversations.find((c) => c.id === threadId);
    if (!target || !target.hasMore || target.nextCursor == null) return;
    setLoadingEarlier(true);
    const canvas = chatCanvasRef.current;
    const prevScrollHeight = canvas?.scrollHeight ?? 0;
    try {
      const res = await fetch(`${API_BASE}/api/chat/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId, limit: 20, before: Number(target.nextCursor) }),
      });
      const json = await res.json();
      const earlier = mapHistoryMessages(json.data?.messages ?? []);
      const hasMore: boolean = json.data?.has_more ?? false;
      const nextCursor: number | null = json.data?.next_cursor ?? null;
      prependEarlierMessages(threadId, earlier, hasMore, nextCursor);
      requestAnimationFrame(() => {
        if (canvas) canvas.scrollTop += canvas.scrollHeight - prevScrollHeight;
      });
    } catch { /* silent */ }
    finally { setLoadingEarlier(false); }
  };

  const batchDelete = async () => {
    if (selectedIds.size === 0 || batchDeleting) return;
    setBatchDeleting(true);
    const ids = Array.from(selectedIds);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => fetch(`${API_BASE}/api/chat/thread`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_id: id }),
        }).then((res) => {
          if (!res.ok && res.status !== 404) throw new Error(`删除失败（${res.status}）`);
        })),
      );
      const succeeded = ids.filter((_, i) => results[i].status === "fulfilled");
      succeeded.forEach((id) => removeConversation(id));
      if (succeeded.includes(activeId)) {
        const remaining = conversations.filter((c) => !succeeded.includes(c.id));
        if (remaining.length > 0) { setActiveId(remaining[0].id); setDraftThreadId(""); }
        else { const newId = makeId(); setDraftThreadId(newId); setActiveId(newId); }
      }
      setSelectedIds(new Set()); setMultiSelect(false); setBatchDeleteOpen(false);
    } finally { setBatchDeleting(false); }
  };

  return {
    sendMessage,
    newConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    handleSelectConversation,
    loadEarlierMessages,
    batchDelete,
  };
}
