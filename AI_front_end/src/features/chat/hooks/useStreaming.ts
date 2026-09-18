import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { useChatStore } from "../../../store/chatStore";
import type { Message, StreamVersionContext } from "../../../types";
import { API_BASE } from "../../../utils/constants";
import { makeId } from "../../../utils/file";
import { readSseStream } from "../../../utils/stream";

// ─────────────────────────────────────────────────────────────
// 流式 Hook
// SSE 生命周期高度耦合：runStreamFor / handleStop / AbortController
// 与流取消句柄整体保留在此，不再继续拆分。
// ─────────────────────────────────────────────────────────────

/** done = 正常收流结束；aborted = 用户主动中断（本地已渲染的文本要保留，不能被 history 覆盖） */
export type StreamOutcome = "done" | "aborted";

export type RunStreamFor = (
  execThreadId: string,
  query: string,
  displayThreadId: string,
  truncateBeforeIndex?: number,
  versionContext?: StreamVersionContext,
) => Promise<StreamOutcome>;

export type UseStreamingOptions = {
  activeId: string;
  activeWorkspaceId: string;
  chatCanvasRef: RefObject<HTMLElement | null>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  setStreamingMessageId: (id: string | null) => void;
};

export function useStreaming({
  activeId,
  activeWorkspaceId,
  chatCanvasRef,
  scrollToBottom,
  setStreamingMessageId,
}: UseStreamingOptions) {
  const abortRef = useRef<AbortController | null>(null);
  const streamCancelRef = useRef<(() => void) | null>(null);
  // 用户是否按下了「停止」。必须显式记录：按 Streams 规范，reader.cancel()（以及拿到 response 之后的
  // controller.abort()）会让挂起的 read() 以 { done: true } **正常结束**，而不是抛 AbortError，
  // 所以「promise 有没有抛错」不能用来判断是否被主动中断。
  const stopRequestedRef = useRef(false);

  const appendMessages = useChatStore((s) => s.appendMessages);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const setStreaming = useChatStore((s) => s.setStreaming);

  const runStreamFor: RunStreamFor = async (
    execThreadId: string,
    query: string,
    displayThreadId: string,
    truncateBeforeIndex?: number,
    versionContext?: StreamVersionContext,
  ) => {
    const appendTo = displayThreadId;
    const targetConversation = useChatStore.getState().conversations.find(
      (conversation) => conversation.id === displayThreadId
    );
    const streamWorkspaceId = targetConversation?.workspaceId || activeWorkspaceId;
    if (!streamWorkspaceId) return "done";

    if (truncateBeforeIndex !== undefined) {
      const conv = useChatStore.getState().conversations.find((c) => c.id === appendTo);
      if (conv) {
        useChatStore.getState().setActiveMessages(
          appendTo, conv.messages.slice(0, truncateBeforeIndex), false, null,
        );
      }
    }

    const userMessage: Message = {
      id: makeId(), messageId: "",
      versionGroupId: versionContext?.human_version_group_id ?? "",
      versionNum: versionContext?.human_version_num ?? 0,
      role: "user", text: query, createdAt: Date.now(),
    };
    const assistantId = makeId();
    const assistantMessage: Message = {
      id: assistantId, messageId: "",
      versionGroupId: versionContext?.assistant_version_group_id ?? "",
      versionNum: versionContext?.assistant_version_num ?? 0,
      role: "assistant", text: "", createdAt: Date.now(),
    };
    appendMessages(appendTo, [userMessage, assistantMessage]);
    setStreaming(true);
    setStreamingMessageId(assistantId);
    requestAnimationFrame(() => scrollToBottom("auto"));

    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    let outcome: StreamOutcome = "done";

    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: execThreadId,
          workspace_id: streamWorkspaceId,
          query,
          ...versionContext,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`服务连接失败（${response.status}）。`);

      const { promise, cancel } = readSseStream(
        response,
        (evt) => {
          updateMessage(appendTo, assistantId, (m) => {
            if (evt.type === "text") return { ...m, text: m.text + evt.content };
            if (evt.type === "tool_call") {
              const steps = m.toolSteps ?? [];
              const last = steps[steps.length - 1];
              if (last && last.name === evt.name && last.status === "running") return m;
              return { ...m, toolSteps: [...steps, { name: evt.name, status: "running", startedAt: Date.now() }] };
            }
            if (evt.type === "tool_result") {
              const steps = (m.toolSteps ?? []).slice();
              for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].name === evt.name && steps[i].status === "running") {
                  steps[i] = { ...steps[i], status: "done" }; break;
                }
              }
              return { ...m, toolSteps: steps };
            }
            return m;
          });
          requestAnimationFrame(() => {
            const canvas = chatCanvasRef.current;
            if (canvas) {
              const d = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
              if (d < 200) canvas.scrollTop = canvas.scrollHeight;
            }
          });
        },
        controller.signal,
      );

      streamCancelRef.current = cancel;
      await promise;
    } catch {
      // 中断路径统一在 finally 里判定，这里只兜底真正的失败
      if (!controller.signal.aborted && !stopRequestedRef.current) {
        updateMessage(appendTo, assistantId, (item) =>
          item.text ? item : { ...item, text: "请求失败，请重试。" }
        );
      }
    } finally {
      // 被中断时 promise 可能是 resolve 而不是 reject（见 stopRequestedRef 的说明），
      // 所以必须用标记 / aborted 判定，否则 outcome 会被算成 "done"，
      // 调用方就会去拉 history，把界面上已经生成出来的文本覆盖回退。
      if (controller.signal.aborted || stopRequestedRef.current) {
        outcome = "aborted";
        updateMessage(appendTo, assistantId, (item) =>
          item.text ? item : { ...item, text: "（已中止生成）" }
        );
      }
      stopRequestedRef.current = false;
      streamCancelRef.current = null;
      abortRef.current = null;
      setStreamingMessageId(null);
      setStreaming(false);
    }

    return outcome;
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    streamCancelRef.current?.();
    streamCancelRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreamingMessageId(null);
    setStreaming(false);
    fetch(`${API_BASE}/api/chat/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: activeId }),
    }).catch(() => { });
  };

  useEffect(() => () => {
    streamCancelRef.current?.();
    abortRef.current?.abort();
  }, []);

  return { runStreamFor, handleStop };
}
