import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { Attachment, Conversation, Message, MessageVersion, StreamVersionContext } from "../../../types";
import { API_BASE } from "../../../utils/constants";
import type { RunStreamFor } from "./useStreaming";

export type UseMessageInteractionsOptions = {
  activeId: string;
  conversations: Conversation[];
  streaming: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  setEditValue: (v: string) => void;
  setCopiedId: Dispatch<SetStateAction<string | null>>;
  setReactions: Dispatch<SetStateAction<Record<string, "up" | "down" | null>>>;
  runStreamFor: RunStreamFor;
  fetchVersions: (threadId: string) => Promise<Record<string, MessageVersion[]>>;
  reloadHistory: (threadId: string) => Promise<void>;
  settleInterruptedHistory: (threadId: string, query: string) => Promise<void>;
};

export function useMessageInteractions({
  activeId,
  conversations,
  streaming,
  editingId,
  setEditingId,
  setEditValue,
  setCopiedId,
  setReactions,
  runStreamFor,
  fetchVersions,
  reloadHistory,
  settleInterruptedHistory,
}: UseMessageInteractionsOptions) {
  const handleCopy = useCallback(async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId((c) => (c === message.id ? null : c)), 3000);
    } catch { /* silent */ }
  }, [setCopiedId]);

  const handleReaction = useCallback(
    (message: Message, next: "up" | "down" | null) => {
      setReactions((prev) => ({ ...prev, [message.id]: next }));
    },
    [setReactions],
  );

  const handleEdit = useCallback((message: Message) => {
    if (message.role !== "user") return;
    if (streaming) return;
    if (!message.messageId) {
      console.warn("[Umi] 无法编辑：缺少 messageId");
      return;
    }
    setEditingId(message.id);
    setEditValue(message.text);
  }, [streaming, setEditingId, setEditValue]);

  const handleEditCancel = useCallback(() => {
    setEditingId(null);
    setEditValue("");
  }, [setEditingId, setEditValue]);

  const handleEditSubmit = useCallback(
    async (newText: string, newAttachments: Attachment[]) => {
      if (!editingId || !newText.trim() || streaming) return;
      const newContent = newText.trim();

      const conv = conversations.find((c) => c.id === activeId);
      const targetIndex = conv ? conv.messages.findIndex((m) => m.id === editingId) : -1;
      const target = targetIndex >= 0 ? conv!.messages[targetIndex] : undefined;
      if (!target?.messageId) {
        console.warn("[Umi] 无法编辑：缺少 messageId");
        return;
      }
      // 编辑重发会新建分支：同样先截掉被编辑消息及其之后的内容，再追加新的一轮。
      const truncateBefore = targetIndex >= 0 ? targetIndex : 0;

      setEditingId(null);
      try {
        const res = await fetch(`${API_BASE}/api/chat/edit-resend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thread_id: activeId,
            message_id: target.messageId,
            new_content: newContent,
            new_content_with_attachments: newAttachments.length > 0
              ? `${newContent}\n\n[附件: ${newAttachments.map(a => a.name).join(", ")}]`
              : newContent,
          }),
        });
        if (!res.ok) throw new Error(`编辑失败（${res.status}）`);
        const json = await res.json();
        const query: string = json.data?.query ?? "";
        const execThread: string = json.data?.exec_thread_id ?? activeId;
        const versionContext: StreamVersionContext = {
          human_version_group_id: json.data?.human_version_group_id ?? "",
          human_version_num: json.data?.human_version_num ?? 0,
          assistant_version_group_id: json.data?.assistant_version_group_id ?? "",
          assistant_version_num: json.data?.assistant_version_num ?? 0,
        };
        if (!query || !versionContext.human_version_group_id
          || !versionContext.assistant_version_group_id) return;

        const outcome = await runStreamFor(execThread, query, activeId, truncateBefore, versionContext);
        if (outcome === "done") {
          await fetchVersions(activeId);
          await reloadHistory(activeId);
        } else {
          // 中断：界面文本原地保留，稍后把服务端字段收敛回来
          await settleInterruptedHistory(activeId, query);
        }
      } catch (e) {
        console.error("[Umi] 编辑重发失败", e);
      } finally {
        setEditValue("");
      }
    },
    [editingId, conversations, activeId, streaming, runStreamFor, fetchVersions, reloadHistory, settleInterruptedHistory, setEditingId, setEditValue],
  );

  return { handleCopy, handleReaction, handleEdit, handleEditCancel, handleEditSubmit };
}
