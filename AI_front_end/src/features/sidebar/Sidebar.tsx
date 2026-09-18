import { useEffect, useRef, useState } from "react";
import {
  Check, ChevronDown, ChevronRight, Folder, ListChecks, MessageSquarePlus,
  MoreHorizontal, Pencil, Pin, Plus, Search, Settings, Share2, Trash2, X,
} from "lucide-react";

import type { Conversation, Mode, Workspace } from "../../types";
import { PanelIcon } from "../../components/ui/PanelIcon";

// ─────────────────────────────────────────────────────────────
// 侧栏
// ─────────────────────────────────────────────────────────────

export function Sidebar(props: {
  mode: Mode; modeMenuOpen: boolean; onToggleModeMenu: () => void;
  onSelectMode: (m: Mode) => void; onCollapse: () => void;
  workspaces: Workspace[]; selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  expandedWorkspaceIds: Set<string>;
  onToggleWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onRequestDeleteWorkspace: (workspace: Workspace) => void;
  conversations: Conversation[]; activeId: string;
  onSelectConversation: (id: string) => void;
  conversationMenuId: string | null;
  onToggleConversationMenu: (id: string) => void;
  deletingId: string | null;
  onNewConversation: () => void;
  onRequestDeleteConversation: (id: string, title: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onCloseConversationMenu: () => void;
  multiSelect: boolean; selectedIds: Set<string>;
  onEnterMultiSelect: () => void; onExitMultiSelect: () => void;
  onToggleSelected: (id: string) => void; onSelectAll: () => void;
  onClearSelection: () => void; onRequestBatchDelete: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}) {
  const {
    mode, modeMenuOpen, onToggleModeMenu, onSelectMode, onCollapse,
    workspaces, selectedWorkspaceId, onSelectWorkspace, expandedWorkspaceIds,
    onToggleWorkspace, onCreateWorkspace,
    onRequestDeleteWorkspace,
    conversations, activeId, onSelectConversation, conversationMenuId,
    onToggleConversationMenu, deletingId, onNewConversation,
    onRequestDeleteConversation, onRenameConversation, onTogglePin,
    onCloseConversationMenu, multiSelect, selectedIds, onEnterMultiSelect,
    onExitMultiSelect, onToggleSelected, onSelectAll, onClearSelection,
    onRequestBatchDelete, onOpenSettings, onOpenSearch,
  } = props;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [workItemMenu, setWorkItemMenu] = useState<{
    kind: "workspace" | "conversation";
    id: string;
  } | null>(null);
  const cancelRenameRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renamingId) return;
    const t = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [renamingId]);

  useEffect(() => {
    if (!workItemMenu) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".workspace-item-menu")
        || target.closest(".workspace-item-menu-trigger")) return;
      setWorkItemMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [workItemMenu]);

  useEffect(() => {
    if (mode !== "work") setWorkItemMenu(null);
  }, [mode]);

  useEffect(() => {
    if (!renamingId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".conversation-rename-input")) return;
      const wrap = target.closest(".conversation-wrap");
      if (wrap && wrap.querySelector(".conversation-row.renaming")) return;
      cancelRenameRef.current = true;
      setRenamingId(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [renamingId]);

  const allSelected = conversations.length > 0 && selectedIds.size === conversations.length;

  return (
    <aside className="left-sidebar" aria-label="会话导航">
      <div className="brand-row">
        <div className="brand-menu-wrap">
          <button type="button" className="brand-button" data-menu-trigger="mode"
            onClick={onToggleModeMenu} aria-expanded={modeMenuOpen} aria-label="切换 Umi 模式">
            <img src="/umi-logo.png" alt="Umi" className="brand-logo" />
            <span>Umi</span><ChevronDown size={14} />
          </button>
          {modeMenuOpen && (
            <div className="mode-menu">
              <button type="button" className={mode === "chat" ? "selected" : ""} onClick={() => onSelectMode("chat")}>Chat</button>
              <button type="button" className={mode === "work" ? "selected" : ""} onClick={() => onSelectMode("work")}>Work</button>
            </div>
          )}
        </div>
        <button type="button" className="sidebar-toggle sidebar-toggle-inline" onClick={onCollapse} aria-label="收起侧边栏">
          <PanelIcon side="left" />
        </button>
      </div>

      {!multiSelect && (
        <button type="button" className="new-chat" onClick={onNewConversation}
          disabled={mode === "work" && !selectedWorkspaceId}>
          <MessageSquarePlus size={16} />新对话
        </button>
      )}

      {mode === "work" && (
        <section className="workspace-section" aria-label="工作区">
          <div className="workspace-section-heading">
            <span>工作区</span>
            <button type="button" className="icon-button"
              onClick={onCreateWorkspace} aria-label="新建工作区" title="新建工作区">
              <Plus size={15} />
            </button>
          </div>
          <div className="workspace-list">
            {workspaces.map((workspace) => {
              const isExpanded = expandedWorkspaceIds.has(workspace.workspaceId);
              const workspaceConversations = conversations.filter(
                (conversation) => conversation.workspaceId === workspace.workspaceId,
              );
              return (
                <section className={`workspace-group ${workspace.workspaceId === selectedWorkspaceId ? "active" : ""}`}
                  key={workspace.workspaceId}>
                  <div className="workspace-row">
                    <button type="button" className="workspace-select"
                      onClick={() => {
                        onSelectWorkspace(workspace.workspaceId);
                        onToggleWorkspace(workspace.workspaceId);
                      }}
                      title={workspace.path ?? workspace.name}
                      aria-expanded={isExpanded}>
                      <ChevronRight className={isExpanded ? "workspace-chevron expanded" : "workspace-chevron"} size={14} />
                      <Folder size={15} />
                      <span>{workspace.name}</span>
                    </button>
                    <button type="button" className="conversation-more workspace-item-menu-trigger"
                      data-menu-trigger="workspace"
                      onClick={() => setWorkItemMenu((current) => (
                        current?.kind === "workspace" && current.id === workspace.workspaceId
                          ? null
                          : { kind: "workspace", id: workspace.workspaceId }
                      ))}
                      aria-label={`管理工作区：${workspace.name}`}>
                      <MoreHorizontal size={15} />
                    </button>
                    {workItemMenu?.kind === "workspace" && workItemMenu.id === workspace.workspaceId && (
                      <div className="conversation-menu workspace-item-menu">
                        <button type="button" className="delete-conversation"
                          onClick={() => {
                            setWorkItemMenu(null);
                            onRequestDeleteWorkspace(workspace);
                          }}>
                          <Trash2 size={16} />删除工作区
                        </button>
                      </div>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="workspace-conversation-list">
                      {workspaceConversations.length === 0 ? (
                        <span className="workspace-no-conversations">暂无会话</span>
                      ) : workspaceConversations.map((conversation) => (
                        <div className={`workspace-conversation-wrap ${conversation.id === activeId ? "active" : ""}`}
                          key={conversation.id}>
                          <button type="button" className="workspace-conversation"
                            onClick={() => {
                              onSelectWorkspace(workspace.workspaceId);
                              onSelectConversation(conversation.id);
                            }}>
                            <span>{conversation.title}</span>
                          </button>
                          <button type="button" className="conversation-more workspace-item-menu-trigger"
                            data-menu-trigger="workspace-conversation"
                            onClick={() => setWorkItemMenu((current) => (
                              current?.kind === "conversation" && current.id === conversation.id
                                ? null
                                : { kind: "conversation", id: conversation.id }
                            ))}
                            aria-label={`管理会话：${conversation.title}`}>
                            <MoreHorizontal size={15} />
                          </button>
                          {workItemMenu?.kind === "conversation" && workItemMenu.id === conversation.id && (
                            <div className="conversation-menu workspace-item-menu">
                              <button type="button" className="delete-conversation"
                                onClick={() => {
                                  setWorkItemMenu(null);
                                  onRequestDeleteConversation(conversation.id, conversation.title);
                                }}>
                                <Trash2 size={16} />删除会话
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
            {workspaces.length === 0 && <span className="workspace-empty">暂无工作区</span>}
          </div>
        </section>
      )}

      {mode === "chat" && (
        <>
      <div className="session-heading">
        {multiSelect ? (
          <>
            <span className="multi-title">已选择 {selectedIds.size} 个对话</span>
            <div><button type="button" className="icon-button" onClick={onExitMultiSelect} aria-label="退出多选"><X size={16} /></button></div>
          </>
        ) : (
          <>
            <span>会话</span>
            <div>
              <button type="button" className="icon-button" onClick={onOpenSearch} aria-label="搜索会话"><Search size={16} /></button>
              <button type="button" className="icon-button" onClick={onEnterMultiSelect} aria-label="多选会话"><ListChecks size={16} /></button>
            </div>
          </>
        )}
      </div>

      <div className={`conversation-list ${multiSelect ? "multi-select-active" : ""}`}>
        {conversations.map((conversation) => {
          const isRenaming = renamingId === conversation.id;
          const isSelected = selectedIds.has(conversation.id);
          return (
            <div key={conversation.id} className="conversation-wrap">
              <div className={`conversation-row ${conversation.id === activeId && !multiSelect ? "active" : ""} ${isRenaming ? "renaming" : ""} ${multiSelect && isSelected ? "selected" : ""} ${multiSelect ? "multi" : ""}`}
                onClick={multiSelect ? () => onToggleSelected(conversation.id) : undefined}>
                {multiSelect && (
                  <span className={`conversation-check ${isSelected ? "checked" : ""}`} aria-hidden="true">
                    {isSelected && <Check size={12} strokeWidth={3} />}
                  </span>
                )}
                <div className="conversation-row-content">
                  <button type="button" className="conversation" tabIndex={isRenaming ? -1 : 0}
                    onClick={(e) => {
                      if (multiSelect) { e.stopPropagation(); onToggleSelected(conversation.id); return; }
                      onSelectConversation(conversation.id);
                    }}>
                    <span>{conversation.title}</span>
                  </button>
                  {!multiSelect && (
                    <button type="button" className="conversation-more" data-menu-trigger="conversation"
                      onClick={() => onToggleConversationMenu(conversation.id)}
                      aria-label={`管理会话：${conversation.title}`} tabIndex={isRenaming ? -1 : 0}>
                      <MoreHorizontal size={15} />
                    </button>
                  )}
                </div>
                <input ref={renameInputRef} className="conversation-rename-input" value={renameValue}
                  onFocus={(e) => { e.currentTarget.select(); onCloseConversationMenu(); }}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => {
                    if (cancelRenameRef.current) { cancelRenameRef.current = false; return; }
                    onRenameConversation(conversation.id, renameValue);
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") { cancelRenameRef.current = true; setRenamingId(null); }
                  }} />
              </div>

              {!multiSelect && conversationMenuId === conversation.id && (
                <div className="conversation-menu">
                  <button type="button" onClick={() => { setRenamingId(conversation.id); setRenameValue(conversation.title); onCloseConversationMenu(); }}>
                    <Pencil size={16} />重命名
                  </button>
                  <button type="button" onClick={() => onTogglePin(conversation.id, !conversation.pinned)}>
                    <Pin size={16} />{conversation.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button type="button" onClick={() => window.open(
                    "https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.337.search-card.all.click&vd_source=f3725ffd8b3e3f580afce36adcab43fb",
                    "_blank", "noopener,noreferrer")}>
                    <Share2 size={16} />分享
                  </button>
                  <button type="button" onClick={() => { onCloseConversationMenu(); onEnterMultiSelect(); }}>
                    <ListChecks size={16} />多选
                  </button>
                  <button type="button" className="delete-conversation"
                    onClick={() => onRequestDeleteConversation(conversation.id, conversation.title)}
                    disabled={deletingId === conversation.id}>
                    <Trash2 size={16} />{deletingId === conversation.id ? "正在删除" : "删除"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {multiSelect && (
        <div className="multi-select-bar">
          <button type="button" className="multi-bar-btn" onClick={allSelected ? onClearSelection : onSelectAll}>
            {allSelected ? "取消全选" : "全选"}
          </button>
          <button type="button" className="multi-bar-btn danger" disabled={selectedIds.size === 0} onClick={onRequestBatchDelete}>
            <Trash2 size={14} />删除
          </button>
        </div>
      )}
        </>
      )}

      {!multiSelect && (
        <button type="button" className="settings" onClick={onOpenSettings}><Settings size={16} />设置</button>
      )}
    </aside>
  );
}
