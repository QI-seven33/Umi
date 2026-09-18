import { useCallback } from "react";

import { useChatStore } from "../../../store/chatStore";
import type { Conversation, Message, MessageVersion, StreamVersionContext } from "../../../types";
import { API_BASE } from "../../../utils/constants";
import { mapHistoryMessages } from "../utils/message";
import type { RunStreamFor } from "./useStreaming";

export type UseMessageRegenerationOptions = {
  activeId: string;
  conversations: Conversation[];
  streaming: boolean;
  setRegeneratingId: (id: string | null) => void;
  runStreamFor: RunStreamFor;
};

export function useMessageRegeneration({
  activeId,
  conversations,
  streaming,
  setRegeneratingId,
  runStreamFor,
}: UseMessageRegenerationOptions) {
  const setActiveMessages = useChatStore((s) => s.setActiveMessages);
  const setConversationVersions = useChatStore((s) => s.setConversationVersions);
  const updateMessage = useChatStore((s) => s.updateMessage);

  const fetchVersions = useCallback(
    async (threadId: string): Promise<Record<string, MessageVersion[]>> => {
      if (!threadId) return {};
      try {
        const res = await fetch(
          `${API_BASE}/api/chat/thread/${encodeURIComponent(threadId)}/versions`,
          { method: "GET" },
        );
        if (!res.ok) return {};
        const json = await res.json();
        const raw: Record<string, Array<{
          branch_num: number; hidden_thread_id: string; kind: "root" | "edit" | "regenerate";
        }>> = json.data?.versions ?? {};
        // 后端返回 snake_case，前端模型是 camelCase，必须逐项映射，
        // 否则 VersionSwitcher 拿不到 branchNum，切换请求会缺 branch_num 被后端 422 拒绝。
        const versions: Record<string, MessageVersion[]> = {};
        for (const [anchorId, arr] of Object.entries(raw)) {
          versions[anchorId] = (arr ?? []).map((v) => ({
            branchNum: v.branch_num,
            hiddenThreadId: v.hidden_thread_id,
            kind: v.kind,
          }));
        }
        setConversationVersions(threadId, versions);
        return versions;
      } catch {
        return {};
      }
    },
    [setConversationVersions],
  );

  const reloadHistory = useCallback(
    async (mainThreadId: string): Promise<void> => {
      if (!mainThreadId) return;
      try {
        const res = await fetch(`${API_BASE}/api/chat/history`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_id: mainThreadId, limit: 50 }),
        });
        if (!res.ok) return;
        const json = await res.json();
        const messages = mapHistoryMessages(json.data?.messages ?? []);
        const hasMore: boolean = json.data?.has_more ?? false;
        const nextCursor: number | null = json.data?.next_cursor ?? null;
        const activeLeaf: string | undefined = json.data?.active_leaf_thread_id;
        setActiveMessages(mainThreadId, messages, hasMore, nextCursor, activeLeaf);
      } catch { /* silent */ }
    },
    [setActiveMessages],
  );

  /**
   * 中断（点了停止）之后的「历史收敛」。
   *
   * 后端在 CancelledError 分支里用 asyncio.shield(aupdate_state(...)) 把中断前已生成的文本写回 checkpoint，
   * 而 /api/chat/stop 是 cancel 后立即返回，所以写回要稍后才落地。这里按退避重试几次，
   * 等写回落地后，只把**本次那两条消息**的服务端字段（messageId / versionGroupId / versionNum）回填，
   * 这样「重新生成 / 编辑」又能用了；文本取更长的一份，绝不整表替换、绝不把界面上已有的内容冲掉。
   */
  const settleInterruptedHistory = useCallback(
    async (mainThreadId: string, query: string): Promise<void> => {
      if (!mainThreadId || !query) return;
      const delays = [400, 900, 1800];

      for (const delay of delays) {
        await new Promise((resolve) => setTimeout(resolve, delay));

        const state = useChatStore.getState();
        // 用户切走了会话、或又开了新的流 → 放弃收敛，避免踩到新状态
        if (state.activeId !== mainThreadId || state.streaming) return;
        const local = state.conversations.find((c) => c.id === mainThreadId);
        if (!local) return;

        const reversed = [...local.messages].reverse();
        const localAssistant = reversed.find((m) => m.role === "assistant" && !m.messageId);
        const localUser = reversed.find((m) => m.role === "user" && !m.messageId && m.text === query);
        // 已经没有待收敛的消息（例如刚才已经被补过）→ 直接结束
        if (!localAssistant || !localUser) return;

        let json: any = null;
        try {
          const res = await fetch(`${API_BASE}/api/chat/history`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thread_id: mainThreadId, limit: 50 }),
          });
          if (!res.ok) continue;
          json = await res.json();
        } catch {
          continue;
        }

        const serverMessages = mapHistoryMessages(json?.data?.messages ?? []);
        const lastIndex = serverMessages.length - 1;
        const serverAssistant = serverMessages[lastIndex];
        const serverUser = serverMessages[lastIndex - 1];
        // 只认「服务端历史最后两条 = 本次的 user + assistant」，并用 query 二次确认，避免认错轮次
        if (!serverAssistant || !serverUser) continue;
        if (serverAssistant.role !== "assistant" || serverUser.role !== "user") continue;
        if (serverUser.text !== query) continue;
        // 写回还没完成（服务端文本比本地短）→ 继续等下一轮，绝不回退
        if (serverAssistant.text.length < localAssistant.text.length) continue;

        const after = useChatStore.getState();
        if (after.activeId !== mainThreadId || after.streaming) return;

        updateMessage(mainThreadId, localUser.id, (m) => ({
          ...m,
          messageId: serverUser.messageId,
          versionGroupId: serverUser.versionGroupId,
          versionNum: serverUser.versionNum,
        }));
        updateMessage(mainThreadId, localAssistant.id, (m) => ({
          ...m,
          messageId: serverAssistant.messageId,
          versionGroupId: serverAssistant.versionGroupId,
          versionNum: serverAssistant.versionNum,
          text: serverAssistant.text.length > m.text.length ? serverAssistant.text : m.text,
        }));
        return;
      }
    },
    [updateMessage],
  );

  const handleRegenerate = useCallback(
    async (target: Message) => {
      if (streaming) return;
      const conv = conversations.find((c) => c.id === activeId);
      if (!conv) return;
      if (!target.messageId) {
        console.warn("[Umi] 无法重新生成：缺少 messageId");
        return;
      }

      // 与后端 create_version_branch 的语义对齐：新分支从该 AI 消息所在轮次的用户消息处开始，
      // 所以要先把这一轮及其之后的本地消息截掉，再由 runStreamFor 追加新的一轮。
      const aiIndex = conv.messages.findIndex((m) => m.id === target.id);
      let userIndex = aiIndex;
      while (userIndex > 0 && conv.messages[userIndex].role !== "user") userIndex--;
      const truncateBefore = userIndex >= 0 ? userIndex : 0;

      setRegeneratingId(target.id);
      try {
        const res = await fetch(`${API_BASE}/api/chat/regenerate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thread_id: activeId,
            message_id: target.messageId,
          }),
        });
        if (!res.ok) throw new Error(`重新生成失败（${res.status}）`);
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
        console.error("[Umi] 重新生成失败", e);
      } finally {
        setRegeneratingId(null);
      }
    },
    [activeId, conversations, streaming, runStreamFor, fetchVersions, reloadHistory, settleInterruptedHistory, setRegeneratingId],
  );

  return { fetchVersions, reloadHistory, handleRegenerate, settleInterruptedHistory };
}
