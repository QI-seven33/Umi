import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, CSSProperties, DragEvent, FormEvent, ReactNode } from "react";
import {
  ArrowUp, Check, ChevronDown, ChevronRight, Plus
} from "lucide-react";
import { ShieldCheck, Zap } from "lucide-react";
import type { Attachment, ModelOption, ThinkingLevel, ExecutionPolicy, WorkContextStats } from "../../../types/index.js";
import {insertPlainText} from '../attachments.js';
import {asTextDocument} from '../longInput.js';
import { ACCEPTED_FILE_TYPES } from "../../../utils/constants.js";
import { AttachmentList } from "./AttachmentList.js";
import { THINKING_LABELS } from "../models.js";

// ─────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────

export function Composer(props: {
  workspace: string;
  approvalPanel?: ReactNode;
  prompt: string; onPromptChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  attachments: Attachment[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewAttachment: (url: string) => void;
  modelOptions: ModelOption[]; selectedModel: string; onSelectModel: (id: string) => void;
  thinking: ThinkingLevel; onSelectThinking: (level: ThinkingLevel) => void;
  contextStats?: WorkContextStats | null;
  executionPolicy: ExecutionPolicy; onSelectExecutionPolicy: (policy: ExecutionPolicy) => void;
  streaming: boolean; submitting?:boolean;
  onSubmit: (e: FormEvent) => void; onStop: () => void;
  isAtBottom: boolean; onScrollToBottom: () => void;
}) {
  const { workspace, prompt, onPromptChange,
    onDragOver, onDragLeave, onDrop, onPaste, attachments, onAddFiles, onRemoveAttachment,
    onPreviewAttachment, modelOptions, selectedModel,
    onSelectModel, thinking, onSelectThinking, executionPolicy, onSelectExecutionPolicy,
    contextStats,
    streaming, onSubmit, onStop, isAtBottom, onScrollToBottom } = props;
  const currentModel = modelOptions.find((item) => item.id === selectedModel);
  const contextPercent = Math.min(
    100,
    Math.round((100 * (contextStats?.tokens ?? 0)) / (contextStats?.budget || 1)),
  );
  const contextLabel = !contextStats ? "上下文统计尚未就绪" :
    `${contextPercent}% · ${(contextStats.tokens / 1000).toFixed(1)}K / ${(contextStats.budget / 1000).toFixed(1)}K ` +
    (contextStats.cached ? "已保存统计，等待更新" : contextStats.scope === "latest_request" ? "最近请求" : "已存会话") +
    (contextStats.token_source === "provider" ? "实际输入" : "估算输入");
  const contextDetail = !contextStats ? contextLabel : `${contextLabel}；模型窗口 ${contextStats.context_window.toLocaleString()}；` +
    `输出预留 ${contextStats.output_reserved.toLocaleString()}；安全余量 ${contextStats.safety_margin.toLocaleString()}；` +
    `已压缩 ${contextStats.summarized_messages} 条记录，用户原文保留` +
    (contextStats.images_omitted ? "；当前模型不支持历史图像，原始记录保留" :
      contextStats.includes_images ? "；图片用量以服务端返回为准" : "");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLFormElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null);
  const thinkingOptionsRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [thinkingMenuSide, setThinkingMenuSide] = useState<"left" | "right" | "inline">("left");
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    if (!modelMenuOpen || !thinkingMenuOpen) return;
    const place = () => {
      const bounds = modelMenuRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const submenuWidth = 144;
      const space = submenuWidth + 8 + 16;
      setThinkingMenuSide(window.innerWidth - bounds.right >= space ? "right" :
        bounds.left >= space ? "left" : "inline");
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [modelMenuOpen, thinkingMenuOpen]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [prompt, Boolean(props.approvalPanel)]);

  // 输入区高度会随附件 / 多行文本变化：把实测高度写到 --composer-h，
  // 让聊天区底部留白同步，避免输入区变高时遮挡消息。
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty("--composer-h", `${el.offsetHeight}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--composer-h");
    };
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".permission-wrap, .model-selector")) {
        setPermissionMenuOpen(false);
        setModelMenuOpen(false);
        setThinkingMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (props.approvalPanel) { setPermissionMenuOpen(false); setModelMenuOpen(false); setThinkingMenuOpen(false); }
  }, [Boolean(props.approvalPanel)]);

  const insert=(text:string)=>{const ta=textareaRef.current;if(!ta)return;const next=insertPlainText(ta.value,ta.selectionStart,ta.selectionEnd,text);ta.value=next.value;onPromptChange({target:ta,currentTarget:ta} as ChangeEvent<HTMLTextAreaElement>);requestAnimationFrame(()=>{ta.focus();ta.setSelectionRange(next.caret,next.caret);});};
  const canSend=Boolean(workspace&&currentModel?.available&&!props.submitting&&(prompt.trim()||attachments.length)&&attachments.every(item=>item.state==='done'&&(item.kind!=='image'||currentModel.capabilities.vision)));
  return (
    <form ref={sectionRef} className="composer-section" onSubmit={onSubmit}>
      {props.approvalPanel ? <div className="composer composer-approval" aria-label="等待批准">
        <div className="approval-dock-header"><span><ShieldCheck size={15}/><strong>等待你的批准</strong></span>
          {streaming && <button type="button" className="send-button stop" aria-label="停止任务" title="停止任务" onClick={onStop}><span className="stop-square"/></button>}
        </div>
        <div className="approval-dock-content">{props.approvalPanel}</div>
      </div> : <div className={`composer ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); onDragOver(e); }}
        onDragLeave={() => { setDragging(false); onDragLeave(); }}
        onDrop={(e) => { setDragging(false); onDrop(e); }}
        onPaste={e=>{if(e.clipboardData.files.length){onPaste(e);return;}const text=e.clipboardData.getData("text/plain");if(text){e.preventDefault();if(asTextDocument(text))onAddFiles([new File([text],'已粘贴的文本.txt',{type:'text/plain'})]);else insert(text);}}}>
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} onPreview={onPreviewAttachment} />
        {attachments.some((item) => item.kind === "image") && !currentModel?.capabilities.vision &&
          <p className="confirm-error">当前 Pro 不支持图片输入，请切换至 DeepSeek Flash。</p>}

        <textarea ref={textareaRef} value={prompt} onChange={onPromptChange}
          disabled={!workspace}
          placeholder={workspace ? "描述你希望 Umi 完成的任务..." : "选择一个工作区开始..."}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode!==229) {
              e.preventDefault();
              if(canSend)e.currentTarget.form?.requestSubmit();
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
            {<div className="permission-wrap">
              <button type="button"
                className={`permission-button work-permission-button policy-${executionPolicy}`}
                data-menu-trigger="permission" aria-expanded={permissionMenuOpen}
                onClick={() => setPermissionMenuOpen((open) => !open)}>
                {executionPolicy === "ask"
                  ? <ShieldCheck size={14} strokeWidth={1.9} />
                  : <Zap size={14} strokeWidth={1.9} />}
                <strong>{executionPolicy === "ask" ? "询问执行" : "自动执行"}</strong>
                <ChevronDown size={13} strokeWidth={2} />
              </button>
              {permissionMenuOpen && <div className="permission-menu work-permission-menu">
                {([
                  {
                    value: "ask" as ExecutionPolicy, title: "询问执行", detail: "新增资源、源文件交付与宿主命令需要批准",
                    icon: <ShieldCheck size={15} strokeWidth={1.9} />
                  },
                  {
                    value: "auto" as ExecutionPolicy, title: "自动执行", detail: "常规操作自动执行，风险操作仍询问",
                    icon: <Zap size={15} strokeWidth={1.9} />
                  },
                ]).map((item) => <button type="button" key={item.value}
                  className={`policy-${item.value}${executionPolicy === item.value ? " selected" : ""}`}
                  onClick={() => { onSelectExecutionPolicy(item.value); setPermissionMenuOpen(false); }}>
                  {item.icon}<span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <Check size={15} />
                </button>)}
              </div>}
            </div>}
          </div>
          <div className="tool-group">
            {(
              <div className="context-orb-wrap">
                <button type="button" className="context-orb" aria-label={contextDetail}>
                  <span className="context-orb-ring"
                    style={{ "--context-percent": `${contextPercent}%` } as CSSProperties} />
                </button>
                <span className="context-tip" role="tooltip">
                  {contextLabel}
                </span>
              </div>
            )}
            <div className="model-selector" onKeyDown={event => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (thinkingMenuOpen) {
                setThinkingMenuOpen(false);
                thinkingTriggerRef.current?.focus();
              } else {
                setModelMenuOpen(false);
                modelTriggerRef.current?.focus();
              }
            }}>
              <button ref={modelTriggerRef} type="button" className="model-button" data-menu-trigger="model"
                onClick={() => {setThinkingMenuOpen(false);setModelMenuOpen((o) => !o);}}
                aria-expanded={modelMenuOpen} aria-controls={menuId}>
                <span className="model-button-name">{currentModel?.name ?? "模型不可用"}</span>
                {currentModel?.capabilities.thinking &&
                  <span className={`model-button-effort level-${thinking}`}>{THINKING_LABELS[thinking]}</span>}
                <ChevronDown size={15} />
              </button>
              {modelMenuOpen && (
                <div ref={modelMenuRef} id={menuId} className="model-menu">
                  <div className="model-menu-list" role="group" aria-label="模型选择">
                    {modelOptions.map((model) => (
                      <button key={model.id} type="button"
                        className={`model-menu-item ${model.id === selectedModel ? "selected" : ""}`}
                        aria-pressed={model.id === selectedModel} title={`API 模型：${model.id}`}
                        onClick={() => { onSelectModel(model.id); setThinkingMenuOpen(false); setModelMenuOpen(false); }}
                        disabled={!model.available}>
                        <span className="model-menu-text">
                          <strong>{model.name}</strong><small>{model.available ? model.description : "未配置或不可用"}</small>
                        </span>
                        <span className="model-menu-check" aria-hidden="true">{model.id === selectedModel && <Check size={16} />}</span>
                      </button>
                    ))}
                  </div>
                  {currentModel?.capabilities.thinking && (
                    <div className="thinking-row-wrap" data-submenu-side={thinkingMenuSide}>
                      <div className="model-menu-divider" />
                      <button ref={thinkingTriggerRef} type="button" className="thinking-row"
                        aria-expanded={thinkingMenuOpen} aria-controls={`${menuId}-thinking`}
                        onKeyDown={event => {
                          if (event.key !== "ArrowRight") return;
                          event.preventDefault();
                          setThinkingMenuOpen(true);
                          requestAnimationFrame(() => thinkingOptionsRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
                        }}
                        onClick={() => setThinkingMenuOpen((open) => !open)}>
                        <span>思考强度</span>
                        <span className="thinking-row-value">
                          {THINKING_LABELS[thinking]}<ChevronRight size={14} />
                        </span>
                      </button>
                      {thinkingMenuOpen && (
                        <div ref={thinkingOptionsRef} id={`${menuId}-thinking`} className="thinking-submenu" role="radiogroup" aria-label="思考强度">
                          {(["off", "normal", "high"] as const).map(level => (
                            <button key={level} type="button" role="radio" aria-checked={thinking === level}
                              className={`thinking-option${thinking === level ? " selected" : ""}`}
                              onClick={() => {onSelectThinking(level);setThinkingMenuOpen(false);thinkingTriggerRef.current?.focus();}}
                              onKeyDown={event => {
                                const options = Array.from(thinkingOptionsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
                                const index = options.indexOf(event.currentTarget);
                                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                  event.preventDefault();
                                  options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
                                }
                              }}>
                              <span>{THINKING_LABELS[level]}</span>
                              <span className="model-menu-check" aria-hidden="true">{thinking === level && <Check size={16} />}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {streaming ? (
              <button type="button" className="send-button stop" aria-label="终止生成" onClick={onStop}>
                <span className="stop-square" />
              </button>
            ) : (
              <button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" title="发送（Enter）；换行（Shift+Enter）">
                <ArrowUp size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        {!isAtBottom && !modelMenuOpen && !thinkingMenuOpen && !permissionMenuOpen && (
          <button type="button" className="scroll-to-bottom" onClick={onScrollToBottom} aria-label="回到底部">
            <ChevronDown size={16} strokeWidth={2.2} />
          </button>
        )}
      </div>}

      <div className="composer-footer">
        <p className="disclaimer">内容由AI生成，请仔细甄别</p>
      </div>
    </form>
  );
}
