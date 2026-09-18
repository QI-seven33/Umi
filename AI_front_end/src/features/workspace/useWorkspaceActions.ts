import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useChatStore } from "../../store/chatStore";
import type { Mode, Workspace } from "../../types";
import { API_BASE } from "../../utils/constants";
import { makeId } from "../../utils/file";

// ─────────────────────────────────────────────────────────────
// 工作区动作 Hook：加载 / 选择 / 展开折叠 / 新建 / 删除
// ─────────────────────────────────────────────────────────────

export type UseWorkspaceActionsOptions = {
  workspaces: Workspace[];
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: Dispatch<SetStateAction<string>>;
  setExpandedWorkspaceIds: Dispatch<SetStateAction<Set<string>>>;
  setMode: (m: Mode) => void;
  setPrompt: (v: string) => void;
  clearAttachments: () => void;
};

export function useWorkspaceActions({
  workspaces,
  setWorkspaces,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  setExpandedWorkspaceIds,
  setMode,
  setPrompt,
  clearAttachments,
}: UseWorkspaceActionsOptions) {
  const setDraftThreadId = useChatStore((s) => s.setDraftThreadId);
  const setActiveId = useChatStore((s) => s.setActiveId);

  useEffect(() => {
    let cancelled = false;
    const loadWorkspaces = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/workspaces?mode=work`);
        const json = await response.json();
        if (!response.ok) throw new Error(json.message || "获取工作区失败");
        if (cancelled) return;
        const items: Workspace[] = (json.data?.workspaces ?? []).map(
          (item: {
            workspace_id: string; name: string; path: string | null; mode: Mode;
            worktree_root: string | null; created_at: string | null;
          }) => ({
            workspaceId: item.workspace_id,
            name: item.name,
            path: item.path,
            mode: item.mode,
            worktreeRoot: item.worktree_root,
            createdAt: item.created_at,
          }),
        );
        setWorkspaces(items);
        setSelectedWorkspaceId((current) =>
          items.some((item) => item.workspaceId === current)
            ? current
            : (items[0]?.workspaceId ?? "")
        );
        setExpandedWorkspaceIds((current) => {
          const next = new Set(
            items.filter((item) => current.has(item.workspaceId)).map((item) => item.workspaceId),
          );
          if (next.size === 0 && items[0]) next.add(items[0].workspaceId);
          return next;
        });
      } catch { /* silent */ }
    };
    void loadWorkspaces();
    return () => { cancelled = true; };
  }, []);

  const selectWorkspace = (workspaceId: string) => {
    if (workspaceId === selectedWorkspaceId) return;
    setSelectedWorkspaceId(workspaceId);
    const draftId = makeId();
    setDraftThreadId(draftId);
    setActiveId(draftId);
    setPrompt("");
    clearAttachments();
  };

  const toggleWorkspace = (workspaceId: string) => {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const createWorkspace = async (name: string, path: string) => {
    const response = await fetch(`${API_BASE}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path, mode: "work" }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.message || "创建工作区失败");
    const item = json.data?.workspace;
    const created: Workspace = {
      workspaceId: item.workspace_id,
      name: item.name,
      path: item.path,
      mode: item.mode,
      worktreeRoot: item.worktree_root,
      createdAt: item.created_at,
    };
    setWorkspaces((current) => [...current, created]);
    setSelectedWorkspaceId(created.workspaceId);
    setExpandedWorkspaceIds((current) => new Set(current).add(created.workspaceId));
    setMode("work");
  };

  const deleteWorkspace = async (workspaceId: string) => {
    const response = await fetch(
      `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
    const json = await response.json();
    if (!response.ok) throw new Error(json.message || "删除工作区失败");
    const remaining = workspaces.filter((item) => item.workspaceId !== workspaceId);
    setWorkspaces(remaining);
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      next.delete(workspaceId);
      return next;
    });
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId(remaining[0]?.workspaceId ?? "");
    }
  };

  return { selectWorkspace, toggleWorkspace, createWorkspace, deleteWorkspace };
}
