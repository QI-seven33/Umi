import { useEffect, useRef, useState } from "react";
import {
  Folder, FolderOpen,
  MoreHorizontal, Plus, SquarePen, Trash2,
} from "lucide-react";

import type { Conversation, Workspace, ThemeMode } from "../../types/index.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { activityLabel } from "./activity.js";
import { PanelIcon } from "../../components/ui/PanelIcon.js";

// ─────────────────────────────────────────────────────────────
// 侧栏
// ─────────────────────────────────────────────────────────────

export function Sidebar(props: {
  onCollapse: () => void;
  workspaces: Workspace[]; selectedWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  expandedWorkspaceIds: Set<string>;
  onToggleWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  conversations: Conversation[]; activeId: string;
  onSelectConversation: (id: string) => void;
  onNewConversation: (workspaceId?: string) => void;
  onRequestDeleteConversation: (id: string, title: string) => void;
  avatar: string | null; username: string; themeMode: ThemeMode;
  onSelectTheme: (theme: ThemeMode) => void;
  onOpenSettings: () => void;
}) {
  const {
    onCollapse,
    workspaces, selectedWorkspaceId, onSelectWorkspace, expandedWorkspaceIds,
    onToggleWorkspace, onCreateWorkspace,
    conversations, activeId, onSelectConversation,
    onNewConversation,
    onRequestDeleteConversation,
    avatar, username, themeMode, onSelectTheme, onOpenSettings,
  } = props;

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [workItemMenu, setWorkItemMenu] = useState<{
    kind: "workspace" | "conversation";
    id: string;
  } | null>(null);
  const [workspaceTip, setWorkspaceTip] = useState<{
    workspace: Workspace; top: number; left: number;
  } | null>(null);
  const workspaceTipTimerRef = useRef<number | null>(null);

  const hideWorkspaceTip = () => {
    if (workspaceTipTimerRef.current !== null) window.clearTimeout(workspaceTipTimerRef.current);
    workspaceTipTimerRef.current = null;
    setWorkspaceTip(null);
  };

  const scheduleWorkspaceTip = (workspace: Workspace, element: HTMLElement) => {
    hideWorkspaceTip();
    const rect = element.getBoundingClientRect();
    workspaceTipTimerRef.current = window.setTimeout(() => {
      setWorkspaceTip({ workspace, top: rect.top - 4, left: rect.right + 8 });
      workspaceTipTimerRef.current = null;
    }, 650);
  };



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

  useEffect(() => () => {
    if (workspaceTipTimerRef.current !== null) window.clearTimeout(workspaceTipTimerRef.current);
  }, []);




  return (
    <aside className="left-sidebar" aria-label="会话导航">
      <div className="brand-row">
        <div className="brand-menu-wrap">
          <div className="brand-button">
            <img src="/umi-lockup.png" alt="Umi" className="brand-logo" />
          </div>
        </div>
        <button type="button" className="sidebar-toggle sidebar-toggle-inline" onClick={onCollapse} aria-label="收起侧边栏">
          <PanelIcon side="left" />
        </button>
      </div>

      <button type="button" className="new-chat" onClick={() => onNewConversation()}
        disabled={!selectedWorkspaceId}>
        <SquarePen size={16} strokeWidth={1.7} />新对话
      </button>

      {(
        <section className="workspace-section" aria-label="工作区">
          <div className="workspace-section-heading">
            <span>工作区</span>
            <button type="button" className="icon-button"
              onClick={onCreateWorkspace} aria-label="新建工作区" title="新建工作区">
              <Plus size={16} strokeWidth={1.7} />
            </button>
          </div>
          <div className="workspace-list">
            {workspaces.map((workspace) => {
              const isExpanded = expandedWorkspaceIds.has(workspace.workspaceId);
              const workspaceConversations = conversations.filter(
                (conversation) => conversation.workspaceId === workspace.workspaceId,
              ).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
                || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
              return (
                <section className={`workspace-group ${workspace.workspaceId === selectedWorkspaceId ? "active" : ""}`}
                  key={workspace.workspaceId}>
                  <div className="workspace-row"
                    onMouseEnter={(event) => scheduleWorkspaceTip(workspace, event.currentTarget)}
                    onMouseLeave={hideWorkspaceTip}>
                    <button type="button" className="workspace-select"
                      onClick={() => {
                        onSelectWorkspace(workspace.workspaceId);
                        onToggleWorkspace(workspace.workspaceId);
                      }}
                      aria-expanded={isExpanded}>
                      {isExpanded ? <FolderOpen size={16} strokeWidth={1.7} /> : <Folder size={16} strokeWidth={1.7} />}
                      <span>{workspace.name}</span>
                    </button>
                    <button type="button" className="workspace-new-chat"
                      onClick={() => { onSelectWorkspace(workspace.workspaceId); onNewConversation(workspace.workspaceId); }}
                      aria-label={`在 ${workspace.name} 中新建对话`} title="在此工作区新建对话">
                      <SquarePen size={14} strokeWidth={1.7} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="workspace-conversation-list">
                      {workspaceConversations.length === 0 ? (
                        <span className="workspace-no-conversations">暂无会话</span>
                      ) : workspaceConversations.map((conversation) => (
                        <div className={`workspace-conversation-wrap ${conversation.id === activeId ? "active" : ""}`}
                          key={conversation.id}>
                          <button type="button" className="workspace-conversation"
                            aria-current={conversation.id === activeId ? "page" : undefined}
                            onClick={() => {
                              onSelectWorkspace(workspace.workspaceId);
                              onSelectConversation(conversation.id);
                            }}>
                            <span>{conversation.title}</span>
                          </button>
                          <time className="conversation-activity-time"
                            dateTime={conversation.updatedAt ? new Date(conversation.updatedAt).toISOString() : undefined}
                            title={conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleString("zh-CN") : undefined}>
                            {activityLabel(conversation.updatedAt, now)}
                          </time>
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

      <ProfileMenu avatar={avatar} username={username} themeMode={themeMode} onSelectTheme={onSelectTheme}
        onOpenSettings={onOpenSettings} />

      {workspaceTip && (
        <div className="workspace-tooltip" role="tooltip"
          style={{ top: workspaceTip.top, left: workspaceTip.left }}>
          <strong>{workspaceTip.workspace.name}</strong>
          {workspaceTip.workspace.path && <span>{workspaceTip.workspace.path}</span>}
          {formatCreatedAt(workspaceTip.workspace.createdAt)
            && <small>{formatCreatedAt(workspaceTip.workspace.createdAt)}</small>}
        </div>
      )}
    </aside>
  );
}

/** 「创建于 2026年9月29日 21:31」 */
function formatCreatedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `创建于 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
