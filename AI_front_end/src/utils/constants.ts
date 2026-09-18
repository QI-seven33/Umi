import { FileSearch, PenLine, Search, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { ModelOption } from "../types";

// ─────────────────────────────────────────────────────────────
// 全局常量
// ─────────────────────────────────────────────────────────────

export const DEFAULT_CHAT_WORKSPACE_ID = "default_chat";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const PASTE_TEXT_THRESHOLD = 2000;

export const ACCEPTED_FILE_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "application/pdf", "text/plain", "text/markdown", "text/csv",
  "application/json", "application/zip",
].join(",");

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "mini", name: "Umi · Mini", description: "更快、更轻量" },
  { id: "pro", name: "Umi · Pro", description: "平衡性能与速度" },
  { id: "max", name: "Umi · Max", description: "最强推理能力" },
];

const TOOL_VERBS: Record<string, string> = {
  deepseek_server_web_search: "联网搜索",
  read_file: "读取文件",
  run_command: "运行命令",
  edit_file: "编辑文件",
};
export const TOOL_ICONS: Record<string, LucideIcon> = {
  deepseek_server_web_search: Search,
  read_file: FileSearch,
  run_command: Terminal,
  edit_file: PenLine,
};
export function verbOf(name: string) { return TOOL_VERBS[name] ?? name; }
