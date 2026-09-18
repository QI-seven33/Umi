export type Mode = "chat" | "work";
export type Role = "user" | "assistant";
export type PermissionMode = "询问模式" | "自动模式";
export type ThemeMode = "light" | "dark" | "system";
export type Language = "system" | "zh" | "en";

export type ModelOption = { id: string; name: string; description: string };

export type MessageVersion = {
  branchNum: number;
  hiddenThreadId: string;
  kind: "root" | "edit" | "regenerate";
};

export type Conversation = {
  id: string;
  workspaceId: string;
  title: string;
  messages: Message[];
  pinned?: boolean;
  hasMore?: boolean;
  nextCursor?: number | null;
  activeLeafThreadId?: string;
  versions?: Record<string, MessageVersion[]>;
};

export type Workspace = {
  workspaceId: string;
  name: string;
  path: string | null;
  mode: Mode;
  worktreeRoot: string | null;
  createdAt: string | null;
};

export type Attachment = {
  id: string; name: string; size: number; progress: number;
  state: "uploading" | "done" | "error";
  kind: "image" | "text" | "archive" | "other";
  previewUrl?: string; error?: string;
};

export interface ToolStep {
  name: string; status: "running" | "done" | "error"; startedAt: number;
}

export interface Message {
  id: string;
  messageId: string;
  versionGroupId: string;
  versionNum: number;
  role: "user" | "assistant";
  text: string;
  createdAt: number | null;
  toolSteps?: ToolStep[];
}

export type StreamVersionContext = {
  human_version_group_id: string;
  human_version_num: number;
  assistant_version_group_id: string;
  assistant_version_num: number;
};
