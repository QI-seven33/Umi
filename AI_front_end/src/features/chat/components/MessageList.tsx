import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { Attachment, Message, MessageVersion, Mode } from "../../../types";
import { MessageItem } from "./MessageItem";

export function MessageList({
  mode, canvasRef, hasMessages, messages, streamingMessageId,
  copiedId, reactions, regeneratingId,
  onCopy, onReaction, onRegenerate, onEdit,
  hasMore, loadingEarlier, onLoadEarlier,
  editingId, editValue, onEditChange, onEditSubmit, onEditCancel,
  versionsMap, onSwitchVersion,
  onPreviewAttachment,
}: {
  mode: Mode; canvasRef: RefObject<HTMLElement | null>;
  hasMessages: boolean; messages: Message[];
  streamingMessageId: string | null;
  copiedId: string | null;
  reactions: Record<string, "up" | "down" | null>;
  regeneratingId: string | null;
  onCopy: (m: Message) => void;
  onReaction: (m: Message, next: "up" | "down" | null) => void;
  onRegenerate: (m: Message) => void;
  onEdit: (m: Message) => void;
  hasMore?: boolean; loadingEarlier?: boolean; onLoadEarlier?: () => void;
  editingId: string | null; editValue: string;
  onEditChange: (v: string) => void;
  onEditSubmit: (newText: string, newAttachments: Attachment[]) => void;
  onEditCancel: () => void;
  versionsMap?: Record<string, MessageVersion[]>;
  onSwitchVersion?: (versionGroupId: string, branchNum: number) => void;
  onPreviewAttachment: (url: string) => void;
}) {
  const topSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = topSentinelRef.current;
    const root = canvasRef.current;
    if (!el || !root || !hasMore || loadingEarlier) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingEarlier) onLoadEarlier?.();
      },
      { root, threshold: 0.1, rootMargin: "80px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingEarlier, onLoadEarlier, canvasRef]);

  return (
    <section ref={canvasRef} className={`chat-canvas ${hasMessages ? "has-messages" : ""}`}>
      {!hasMessages ? (
        <div className="empty-state">
          <img src="/umi-logo.png" alt="" className="hero-logo" />
          <div className="hero-title">
            <h1>Umi</h1>
            <span>{mode === "work" ? "work" : "Chat"}</span>
          </div>
          <p>{mode === "work" ? "选择一个工作目录，开始处理本地任务。" : "和 Umi 开始一段新的对话。"}</p>
        </div>
      ) : (
        <div className="message-stack">
          {hasMore && !loadingEarlier && <div ref={topSentinelRef} className="load-sentinel" aria-hidden="true" />}
          {messages.map((message, index) => {
            const groupId = message.versionGroupId;
            const versions = groupId ? versionsMap?.[groupId] : undefined;
            const activeBranchNum = versions ? message.versionNum : null;
            return (
              <MessageItem key={`${message.id}-${index}`}
                message={message} index={index}
                isStreaming={streamingMessageId === message.id}
                copiedId={copiedId} reactions={reactions} regeneratingId={regeneratingId}
                onCopy={onCopy} onReaction={onReaction}
                onRegenerate={onRegenerate} onEdit={onEdit}
                editingId={editingId} editValue={editValue}
                onEditChange={onEditChange} onEditSubmit={onEditSubmit} onEditCancel={onEditCancel}
                versions={versions} activeBranchNum={activeBranchNum}
                onSwitchVersion={
                  onSwitchVersion && groupId
                    ? (bn) => onSwitchVersion(groupId, bn)
                    : undefined
                }
                onPreviewAttachment={onPreviewAttachment}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
