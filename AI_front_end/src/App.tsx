import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { PanelIcon } from "./components/ui/PanelIcon";
import { Composer, MessageList } from "./features/chat";
import { useAttachments } from "./features/chat/hooks/useAttachments";
import { useConversationActions } from "./features/chat/hooks/useConversationActions";
import { useMessageInteractions } from "./features/chat/hooks/useMessageInteractions";
import { useMessageRegeneration } from "./features/chat/hooks/useMessageRegeneration";
import { useStreaming } from "./features/chat/hooks/useStreaming";
import { useVersionSwitch } from "./features/chat/hooks/useVersionSwitch";
import { SettingsDialog } from "./features/settings";
import { SearchDialog, Sidebar } from "./features/sidebar";
import {
  DeliveryPanel,
  WorkspaceDialog,
  useDeliveryPanelAnimation,
  useWorkspaceActions,
} from "./features/workspace";
import { useChatStore } from "./store/chatStore";
import type {
  Conversation,
  Language,
  Message,
  Mode,
  PermissionMode,
  ThemeMode,
  Workspace,
} from "./types";
import { API_BASE, DEFAULT_CHAT_WORKSPACE_ID, MODEL_OPTIONS } from "./utils/constants";
import { makeId } from "./utils/file";

// ─────────────────────────────────────────────────────────────
// App：布局组装 + 弹窗控制 + 业务 Hook 组合
// ─────────────────────────────────────────────────────────────

function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<Workspace | null>(null);
  const [permission, setPermission] = useState<PermissionMode>("询问模式");
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, "up" | "down" | null>>({});
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [selectedModel, setSelectedModel] = useState("pro");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [language, setLanguage] = useState<Language>("system");

  const conversations = useChatStore((s) => s.conversations);
  const setConversations = useChatStore((s) => s.setConversations);
  const activeId = useChatStore((s) => s.activeId);
  const setActiveId = useChatStore((s) => s.setActiveId);
  const streaming = useChatStore((s) => s.streaming);
  const setDraftThreadId = useChatStore((s) => s.setDraftThreadId);

  const {
    attachments, addFiles, removeAttachment, clearAttachments, handleDrop, handlePaste
  } = useAttachments();

  const chatCanvasRef = useRef<HTMLElement>(null);
  const deliveryPanelRef = useDeliveryPanelAnimation(rightOpen, mode === "work");

  const closeConversationMenu = () => setConversationMenuId(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((item) => item.workspaceId === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );
  const activeWorkspaceId = mode === "chat"
    ? DEFAULT_CHAT_WORKSPACE_ID
    : selectedWorkspaceId;

  const activeConversation = useMemo(() => {
    const found = conversations.find((c) => c.id === activeId);
    if (found) return found;
    return {
      id: activeId, workspaceId: activeWorkspaceId,
      title: "新对话", messages: [] as Message[],
    };
  }, [activeId, activeWorkspaceId, conversations]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const canvas = chatCanvasRef.current;
    if (!canvas) return;
    canvas.scrollTo({ top: canvas.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (isDark: boolean) => {
      root.setAttribute("data-theme", isDark ? "dark" : "light");
    };

    if (themeMode === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(media.matches);
      const listener = (e: MediaQueryListEvent) => applyTheme(e.matches);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    } else {
      applyTheme(themeMode === "dark");
    }
  }, [themeMode]);

  useEffect(() => {
    const state = useChatStore.getState();
    const draftId = state.draftThreadId || makeId();
    if (!state.draftThreadId) setDraftThreadId(draftId);
    if (!state.activeId) setActiveId(draftId);
  }, [setActiveId, setDraftThreadId]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".conversation-menu") || target.closest(".mode-menu")
        || target.closest(".permission-menu") || target.closest(".model-menu")
        || target.closest(".workspace-menu") || target.closest(".dropdown-menu")) return;
      if (target.closest("[data-menu-trigger]")) return;
      setModeMenuOpen(false);
      setConversationMenuId(null);
      if (mode === "work" && rightOpen) {
        const inDeliveryPanel = target.closest(".delivery-panel");
        const inRightRailToggle = target.closest(".right-rail-toggle");
        if (!inDeliveryPanel && !inRightRailToggle) setRightOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [rightOpen, mode]);

  useEffect(() => {
    const canvas = chatCanvasRef.current;
    if (!canvas) return;
    const onScroll = () => {
      const d = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
      setIsAtBottom(d < 80);
    };
    canvas.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => canvas.removeEventListener("scroll", onScroll);
  }, [activeConversation?.messages.length]);

  useEffect(() => {
    let cancelled = false;
    const draftId = makeId();
    setConversations([]);
    setDraftThreadId(draftId);
    setActiveId(draftId);
    setConversationMenuId(null);
    setMultiSelect(false);
    setSelectedIds(new Set());

    const workspaceIds = mode === "chat"
      ? [DEFAULT_CHAT_WORKSPACE_ID]
      : workspaces.map((workspace) => workspace.workspaceId);
    if (workspaceIds.length === 0) return () => { cancelled = true; };

    const loadThreads = async () => {
      try {
        const responses = await Promise.all(workspaceIds.map(async (workspaceId) => {
          const response = await fetch(
            `${API_BASE}/api/chat/threads?workspace_id=${encodeURIComponent(workspaceId)}`,
          );
          const json = await response.json();
          if (!response.ok) throw new Error(json.message || "获取会话失败");
          return json;
        }));
        if (cancelled) return;
        const threads: Conversation[] = responses.flatMap((json) => (json.data?.threads ?? []).map(
          (thread: {
            thread_id: string; workspace_id: string; title: string; pinned: boolean;
            active_leaf_thread_id?: string | null;
          }) => ({
            id: thread.thread_id,
            workspaceId: thread.workspace_id,
            title: thread.title,
            messages: [],
            pinned: thread.pinned ?? false,
            activeLeafThreadId: thread.active_leaf_thread_id ?? undefined,
          }),
        ));
        setConversations(threads);
      } catch { /* silent */ }
    };
    void loadThreads();
    return () => { cancelled = true; };
  }, [mode, workspaces, setActiveId, setConversations, setDraftThreadId]);

  useEffect(() => {
    if (!multiSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !batchDeleteOpen) {
        setMultiSelect(false); setSelectedIds(new Set()); setConversationMenuId(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [multiSelect, batchDeleteOpen]);

  const { selectWorkspace, toggleWorkspace, createWorkspace, deleteWorkspace } = useWorkspaceActions({
    workspaces, setWorkspaces, selectedWorkspaceId, setSelectedWorkspaceId,
    setExpandedWorkspaceIds, setMode, setPrompt, clearAttachments,
  });

  const { runStreamFor, handleStop } = useStreaming({
    activeId, activeWorkspaceId, chatCanvasRef, scrollToBottom, setStreamingMessageId,
  });

  const { fetchVersions, reloadHistory, handleRegenerate, settleInterruptedHistory } = useMessageRegeneration({
    activeId, conversations, streaming, setRegeneratingId, runStreamFor,
  });

  const { switchVersion } = useVersionSwitch({ streaming, reloadHistory, fetchVersions });

  const {
    handleCopy, handleReaction, handleEdit, handleEditCancel, handleEditSubmit,
  } = useMessageInteractions({
    activeId, conversations, streaming, editingId, setEditingId, setEditValue,
    setCopiedId, setReactions, runStreamFor, fetchVersions, reloadHistory,
    settleInterruptedHistory,
  });

  const {
    sendMessage, newConversation, deleteConversation, renameConversation, togglePin,
    handleSelectConversation, loadEarlierMessages, batchDelete,
  } = useConversationActions({
    activeWorkspaceId, prompt, chatCanvasRef,
    loadingEarlier, setLoadingEarlier, deletingId, setDeletingId,
    batchDeleting, setBatchDeleting, selectedIds, setSelectedIds,
    setMultiSelect, setBatchDeleteOpen, setConversationMenuId,
    setPrompt, clearAttachments, scrollToBottom,
    runStreamFor, fetchVersions, reloadHistory, settleInterruptedHistory,
  });

  const enterMultiSelect = () => { setMultiSelect(true); setSelectedIds(new Set()); setConversationMenuId(null); setModeMenuOpen(false); };
  const exitMultiSelect = () => { setMultiSelect(false); setSelectedIds(new Set()); setConversationMenuId(null); };
  const toggleSelected = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(conversations.map((c) => c.id)));
  const clearSelection = () => setSelectedIds(new Set());

  return (
    <main className={`app-shell ${leftOpen ? "left-expanded" : "left-collapsed"} ${mode === "work" && rightOpen ? "right-expanded" : "right-collapsed"}`}>
      <Sidebar
        mode={mode} modeMenuOpen={modeMenuOpen}
        onToggleModeMenu={() => setModeMenuOpen((o) => !o)}
        onSelectMode={(next) => { if (next === "work") setRightOpen(true); setMode(next); setModeMenuOpen(false); setSearchOpen(false); }}
        onCollapse={() => setLeftOpen(false)}
        workspaces={workspaces} selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        expandedWorkspaceIds={expandedWorkspaceIds}
        onToggleWorkspace={toggleWorkspace}
        onCreateWorkspace={() => setWorkspaceDialogOpen(true)}
        onRequestDeleteWorkspace={setDeleteWorkspaceTarget}
        conversations={conversations} activeId={activeId}
        onSelectConversation={(id) => void handleSelectConversation(id)}
        conversationMenuId={conversationMenuId}
        onToggleConversationMenu={(id) => setConversationMenuId((c) => (c === id ? null : id))}
        deletingId={deletingId}
        onNewConversation={newConversation}
        onRequestDeleteConversation={(id, title) => setDeleteTarget({ id, title })}
        onRenameConversation={(id, title) => void renameConversation(id, title)}
        onTogglePin={(id, pinned) => void togglePin(id, pinned)}
        onCloseConversationMenu={closeConversationMenu}
        multiSelect={multiSelect} selectedIds={selectedIds}
        onEnterMultiSelect={enterMultiSelect} onExitMultiSelect={exitMultiSelect}
        onToggleSelected={toggleSelected} onSelectAll={selectAll}
        onClearSelection={clearSelection} onRequestBatchDelete={() => setBatchDeleteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => { if (activeWorkspaceId) setSearchOpen(true); }}
      />

      {!leftOpen && (
        <button type="button" className="sidebar-toggle rail-toggle left-rail-toggle"
          onClick={() => setLeftOpen(true)} aria-label="展开侧边栏">
          <PanelIcon side="left" />
        </button>
      )}

      <section className="main-area">
        <header className="topbar"><span>{mode === "work" ? "工作台" : "对话"}</span></header>

        <section className="chat-canvas-wrap">
          <MessageList
            hasMore={activeId ? (conversations.find((c) => c.id === activeId)?.hasMore ?? false) : false}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={() => activeId && void loadEarlierMessages(activeId)}
            mode={mode} canvasRef={chatCanvasRef}
            hasMessages={Boolean(activeConversation?.messages.length)}
            messages={activeConversation?.messages ?? []}
            streamingMessageId={streamingMessageId}
            copiedId={copiedId} reactions={reactions} regeneratingId={regeneratingId}
            onCopy={handleCopy} onReaction={handleReaction}
            onRegenerate={handleRegenerate} onEdit={handleEdit}
            editingId={editingId} editValue={editValue}
            onEditChange={setEditValue} onEditSubmit={handleEditSubmit} onEditCancel={handleEditCancel}
            versionsMap={activeConversation?.versions}
            onSwitchVersion={(anchorId, branchNum) => void switchVersion(activeId, anchorId, branchNum)}
            onPreviewAttachment={(url) => setPreviewSrc(url)}
          />
        </section>

        <Composer
          mode={mode} workspace={selectedWorkspace?.name ?? ""}
          onCreateWorkspace={() => setWorkspaceDialogOpen(true)}
          prompt={prompt} onPromptChange={(e) => setPrompt(e.target.value)}
          onDragOver={(e) => { e.preventDefault(); }} onDragLeave={() => { }} onDrop={handleDrop}
          onPaste={handlePaste}
          attachments={attachments} onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment} onPreviewAttachment={(url) => setPreviewSrc(url)}
          permission={permission} onSelectPermission={(p) => setPermission(p)}
          modelOptions={MODEL_OPTIONS} selectedModel={selectedModel}
          onSelectModel={(id) => setSelectedModel(id)}
          streaming={streaming} onSubmit={sendMessage} onStop={handleStop}
          isAtBottom={isAtBottom} onScrollToBottom={() => scrollToBottom("smooth")}
        />
      </section>

      {mode === "work" && (
        <DeliveryPanel panelRef={deliveryPanelRef}
          onCreateWorkspace={() => setWorkspaceDialogOpen(true)}
          onClose={() => setRightOpen(false)} />
      )}
      {mode === "work" && !rightOpen && (
        <button type="button" className="sidebar-toggle rail-toggle right-rail-toggle"
          onClick={() => setRightOpen(true)} aria-label="展开交付状态">
          <PanelIcon side="right" />
        </button>
      )}

      {previewSrc && <div className="lightbox" onClick={() => setPreviewSrc(null)}><img src={previewSrc} alt="" /></div>}

      {deleteTarget && (
        <ConfirmDialog open={!!deleteTarget}
          title="删除后，该对话将不可恢复" description="由该对话产生的分析链接也不会失效"
          confirmText="删除" cancelText="取消" destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => { await deleteConversation(deleteTarget.id); setDeleteTarget(null); }} />
      )}
      {batchDeleteOpen && (
        <ConfirmDialog open={batchDeleteOpen}
          title={`删除选中的 ${selectedIds.size} 个对话？`} description="删除后，这些对话将不可恢复。"
          confirmText="删除" cancelText="取消" destructive
          onCancel={() => setBatchDeleteOpen(false)} onConfirm={batchDelete} />
      )}

      <WorkspaceDialog open={workspaceDialogOpen}
        onClose={() => setWorkspaceDialogOpen(false)}
        onCreate={createWorkspace} />

      {deleteWorkspaceTarget && (
        <ConfirmDialog open={!!deleteWorkspaceTarget}
          title={`删除工作区“${deleteWorkspaceTarget.name}”？`}
          description="该工作区下的会话将被删除，本机目录和其中的文件会保留。"
          confirmText="删除" cancelText="取消" destructive
          onCancel={() => setDeleteWorkspaceTarget(null)}
          onConfirm={async () => {
            await deleteWorkspace(deleteWorkspaceTarget.workspaceId);
            setDeleteWorkspaceTarget(null);
          }} />
      )}

      {searchOpen && (
        <SearchDialog
          open={searchOpen}
          workspaceId={activeWorkspaceId}
          onClose={() => setSearchOpen(false)}
          onSelectConversation={(id) => void handleSelectConversation(id)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          themeMode={themeMode}
          onSelectTheme={setThemeMode}
          language={language}
          onSelectLanguage={setLanguage}
        />
      )}
    </main>
  );
}

export default App;
