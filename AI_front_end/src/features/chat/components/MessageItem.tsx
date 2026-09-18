import { useEffect, useMemo, useRef } from "react";
import {
  Check, Copy, MoreHorizontal, Pencil, Plus, RefreshCcw, ThumbsDown,
  ThumbsUp,
} from "lucide-react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "highlight.js/styles/atom-one-light.css";
import "katex/dist/katex.min.css";

import type { Attachment, Message, MessageVersion } from "../../../types";
import { ACCEPTED_FILE_TYPES } from "../../../utils/constants";
import { formatSmartTime } from "../../../utils/time";
import { CodeBlock } from "../../../components/ui/CodeBlock";
import { VersionSwitcher } from "../../../components/ui/VersionSwitcher";
import { useAttachments } from "../hooks/useAttachments";
import { preprocessMath } from "../utils/math";
import { AttachmentList } from "./AttachmentList";
import { ToolTimeline } from "./ToolTimeline";

// ─────────────────────────────────────────────────────────────
// 消息与列表
// ─────────────────────────────────────────────────────────────

export function MessageItem({
  
  message, index, isStreaming, copiedId, reactions, regeneratingId,
  onCopy, onReaction, onRegenerate, onEdit,
  editingId, editValue, onEditChange, onEditSubmit, onEditCancel,
  versions, activeBranchNum, onSwitchVersion,
  onPreviewAttachment,
}: {
  
  message: Message; index: number; isStreaming: boolean;
  copiedId: string | null;
  reactions: Record<string, "up" | "down" | null>;
  regeneratingId: string | null;
  onCopy: (m: Message) => void;
  onReaction: (m: Message, next: "up" | "down" | null) => void;
  onRegenerate: (m: Message) => void;
  onEdit: (m: Message) => void;
  editingId: string | null; editValue: string;
  onEditChange: (v: string) => void;
  onEditSubmit: (newText: string, newAttachments: Attachment[]) => void;
  onEditCancel: () => void;
  versions?: MessageVersion[];
  activeBranchNum: number | null;
  onSwitchVersion?: (branchNum: number) => void;
  onPreviewAttachment: (url: string) => void;
}) {
  const isEditing = editingId === message.id;
  const editRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasVersions = versions && versions.length > 0;

  const {
    attachments: editAttachments,
    addFiles: addEditFiles,
    removeAttachment: removeEditAttachment,
    handleDrop: handleEditDrop,
    handlePaste: handleEditPaste,
  } = useAttachments();

  const processedText = useMemo(() => preprocessMath(message.text), [message.text]);

  const safeText = useMemo(() => {
    if (!isStreaming) return processedText;
    const fenceCount = (processedText.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      return processedText + "\n```";
    }
    return processedText;
  }, [processedText, isStreaming]);

  useEffect(() => {
    if (!isEditing) return;
    const ta = editRef.current;
    if (!ta) return;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [isEditing]);

  return (
    <article id={`msg-${message.id}`}
      className={`message ${message.role} ${message.role === "user" && index > 0 ? "turn-divider" : ""}`}>
      {message.role === "assistant" && (
        <ToolTimeline
          steps={message.toolSteps ?? []}
          streaming={isStreaming}
          activeLabel="正在处理…"
          hasAnyText={Boolean(message.text)}
        />
      )}

      {isEditing ? (
        <div className="message-edit-wrapper">
          <div
            className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleEditDrop}
            onPaste={handleEditPaste}
          >
            <AttachmentList
              attachments={editAttachments}
              onRemove={removeEditAttachment}
              onPreview={onPreviewAttachment}
            />

            <textarea
              ref={editRef}
              className="message-edit-textarea"
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onEditSubmit(editValue, editAttachments);
                }
                if (e.key === "Escape") { e.preventDefault(); onEditCancel(); }
              }}
            />

            <div className="composer-tools">
              <div className="tool-group">
                <button type="button" className="round-button" aria-label="添加附件"
                  onClick={() => fileInputRef.current?.click()}>
                  <Plus size={18} />
                </button>
                <input
                  ref={fileInputRef} type="file" multiple hidden accept={ACCEPTED_FILE_TYPES}
                  onChange={(e) => {
                    if (e.target.files) addEditFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="tool-group">
                <button type="button" className="message-edit-btn cancel" onClick={onEditCancel}>取消</button>
                <button type="button" className="message-edit-btn primary"
                  onClick={() => onEditSubmit(editValue, editAttachments)}
                  disabled={!editValue.trim()}>
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="message-body">
          {message.text ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeHighlight, rehypeKatex]}
              components={{
                pre({ children }: any) {
                  return <>{children}</>;
                },
                code({ inline, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || "");
                  const isBlock = !inline && (match || String(children).includes("\n"));

                  if (!isBlock) {
                    return <code className="inline-code" {...props}>{children}</code>;
                  }

                  const lang = match ? match[1] : "";
                  const codeText = String(children).replace(/\n$/, "");
                  return (
                    <CodeBlock lang={lang} codeText={codeText} className={className}>
                      {children}
                    </CodeBlock>
                  );
                },
                a({ children, ...props }: any) {
                  return <a target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
                },
              }}
            >
              {safeText}
            </ReactMarkdown>
          ) : !isStreaming ? (
            message.role === "assistant" ? "未收到有效回复。" : null
          ) : null}
        </div>
      )}

      {!isEditing && (
        <div className="message-footer">
          <div className="message-meta">
            {message.role === "assistant" ? (
              <>
                <button type="button" className="meta-button" onClick={() => onCopy(message)} aria-label="复制"
                  data-copied={copiedId === message.id}>
                  {copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button type="button" className="meta-button" onClick={() => onReaction(message, reactions[message.id] === "up" ? null : "up")}
                  aria-label="赞同" data-active={reactions[message.id] === "up"}>
                  <ThumbsUp size={14} />
                </button>
                <button type="button" className="meta-button" onClick={() => onReaction(message, reactions[message.id] === "down" ? null : "down")}
                  aria-label="反对" data-active={reactions[message.id] === "down"}>
                  <ThumbsDown size={14} />
                </button>
                <button type="button" className="meta-button" onClick={() => onRegenerate(message)} aria-label="重新生成"
                  data-spinning={regeneratingId === message.id} disabled={isStreaming}>
                  <RefreshCcw size={14} />
                </button>
                <button type="button" className="meta-button" aria-label="更多"><MoreHorizontal size={14} /></button>
              </>
            ) : (
              <>
                <button type="button" className="meta-button" onClick={() => onCopy(message)} aria-label="复制"
                  data-copied={copiedId === message.id}>
                  {copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button type="button" className="meta-button" onClick={() => onEdit(message)} aria-label="修改" disabled={isStreaming}>
                  <Pencil size={14} />
                </button>
              </>
            )}
          </div>
          {hasVersions && onSwitchVersion && (
            <VersionSwitcher versions={versions!} activeBranchNum={activeBranchNum}
              onSwitch={onSwitchVersion} disabled={isStreaming} />
          )}
          <span className="message-time">{formatSmartTime(message.createdAt)}</span>
        </div>
      )}
    </article>
  );
}