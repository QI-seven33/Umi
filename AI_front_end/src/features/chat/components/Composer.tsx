import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent } from "react";
import {
  ArrowUp, Check, ChevronDown, ShieldCheck, Folder, Plus,Zap
} from "lucide-react";

import type { Attachment, Mode, ModelOption, PermissionMode } from "../../../types";
import { ACCEPTED_FILE_TYPES } from "../../../utils/constants";
import { AttachmentList } from "./AttachmentList";

// ─────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────

export function Composer(props: {
  mode: Mode; workspace: string; onCreateWorkspace: () => void;
  prompt: string; onPromptChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  attachments: Attachment[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewAttachment: (url: string) => void;
  permission: PermissionMode; onSelectPermission: (p: PermissionMode) => void;
  modelOptions: ModelOption[]; selectedModel: string; onSelectModel: (id: string) => void;
  streaming: boolean;
  onSubmit: (e: FormEvent) => void; onStop: () => void;
  isAtBottom: boolean; onScrollToBottom: () => void;
}) {
  const { mode, workspace, onCreateWorkspace, prompt, onPromptChange,
    onDragOver, onDragLeave, onDrop, onPaste, attachments, onAddFiles, onRemoveAttachment,
    onPreviewAttachment, permission, onSelectPermission, modelOptions, selectedModel,
    onSelectModel, streaming, onSubmit, onStop, isAtBottom, onScrollToBottom } = props;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [prompt]);

  return (
    <form className="composer-section" onSubmit={onSubmit}>
      {mode === "work" && (
        <div className="workspace-picker-wrap">
          <button type="button" className="workspace-picker" data-menu-trigger="workspace"
            onClick={() => setWorkspaceMenuOpen((o) => !o)}>
            <Folder size={14} />{workspace || "选择工作区"}<ChevronDown size={14} />
          </button>
          {workspaceMenuOpen && (
            <div className="workspace-menu">
              <button type="button" onClick={() => { setWorkspaceMenuOpen(false); onCreateWorkspace(); }}>
                <Plus size={16} />新建工作区
              </button>
            </div>
          )}
        </div>
      )}

      <div className={`composer ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); onDragOver(e); }}
        onDragLeave={() => { setDragging(false); onDragLeave(); }}
        onDrop={(e) => { setDragging(false); onDrop(e); }}
        onPaste={onPaste}>
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} onPreview={onPreviewAttachment} />

        <textarea ref={textareaRef} value={prompt} onChange={onPromptChange}
          disabled={mode === "work" && !workspace}
          placeholder={mode === "work"
            ? (workspace ? "描述你希望 Umi 完成的任务..." : "选择一个工作区开始...")
            : "发消息给 Umi..."}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }} />

        <div className="composer-tools">
          <div className="tool-group">
            <button type="button" className="round-button" aria-label="添加附件"
              onClick={() => fileInputRef.current?.click()}>
              <Plus size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple hidden accept={ACCEPTED_FILE_TYPES}
              onChange={(e) => { if (e.target.files) onAddFiles(e.target.files); e.target.value = ""; }} />
            {mode === "work" && (
              <div className="permission-wrap">
                <button type="button" className="permission-button" data-menu-trigger="permission"
                  onClick={() => setPermissionMenuOpen((o) => !o)} aria-expanded={permissionMenuOpen}>
                  {permission === "询问模式" ? <ShieldCheck  size={14} /> : <Zap  size={14} />}
                  {permission}<ChevronDown size={14} />
                </button>
                {permissionMenuOpen && (
                  <div className="permission-menu">
                    <button type="button" className={permission === "询问模式" ? "selected" : ""}
                      onClick={() => { onSelectPermission("询问模式"); setPermissionMenuOpen(false); }}>
                      <ShieldCheck  size={16} />
                      <span><strong>询问模式</strong><small>执行操作前先征求确认</small></span>
                      <Check size={14} />
                    </button>
                    <button type="button" className={permission === "自动模式" ? "selected" : ""}
                      onClick={() => { onSelectPermission("自动模式"); setPermissionMenuOpen(false); }}>
                      <Zap  size={16} />
                      <span><strong>自动模式</strong><small>在工作区内自动执行操作</small></span>
                      <Check size={14} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="tool-group">
            <div className="model-selector">
              <button type="button" className="model-button" data-menu-trigger="model"
                onClick={() => setModelMenuOpen((o) => !o)} aria-expanded={modelMenuOpen}>
                {modelOptions.find((m) => m.id === selectedModel)?.name}<ChevronDown size={16} />
              </button>
              {modelMenuOpen && (
                <div className="model-menu">
                  {modelOptions.map((model) => (
                    <button key={model.id} type="button"
                      className={`model-menu-item ${model.id === selectedModel ? "selected" : ""}`}
                      onClick={() => { onSelectModel(model.id); setModelMenuOpen(false); }}>
                      <span className="model-menu-text">
                        <strong>{model.name}</strong><small>{model.description}</small>
                      </span>
                      {model.id === selectedModel && <Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {streaming ? (
              <button type="button" className="send-button stop" aria-label="终止生成" onClick={onStop}>
                <span className="stop-square" />
              </button>
            ) : (
              <button className="send-button" type="submit" disabled={!prompt.trim()} aria-label="发送消息">
                <ArrowUp size={18} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>

        {!isAtBottom && (
          <button type="button" className="scroll-to-bottom" onClick={onScrollToBottom} aria-label="回到底部">
            <ChevronDown size={16} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <p className="disclaimer">内容由AI生成，仔细甄别</p>
    </form>
  );
}
