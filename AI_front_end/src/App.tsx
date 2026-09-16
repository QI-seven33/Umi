import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  RefObject,
} from "react";
import { gsap } from "gsap";
import { create } from "zustand";
import {
  ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, Copy, FileSearch,
  FileText, Folder, FolderOpen, Image as ImageIcon, ListChecks, Maximize2,
  MessageSquarePlus, MoreHorizontal, Pencil, PenLine, Pin, Plus, RefreshCcw,
  Search, Settings, Share2, Sparkles, SquareTerminal, Terminal, ThumbsDown,
  ThumbsUp, Trash2, X,
  Sun, Moon, User, FlaskConical,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "highlight.js/styles/atom-one-light.css";
import "katex/dist/katex.min.css";

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
  title: string;
  messages: Message[];
  pinned?: boolean;
  hasMore?: boolean;
  nextCursor?: number | null;
  activeLeafThreadId?: string;
  versions?: Record<string, MessageVersion[]>;
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

type StreamVersionContext = {
  human_version_group_id: string;
  human_version_num: number;
  assistant_version_group_id: string;
  assistant_version_num: number;
};

export const makeId = () => crypto.randomUUID();

export function formatTime(ts: number | null | undefined) {
  if (ts == null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toMillis(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

function formatSearchTime(ts: number | null | undefined): string {
  if (ts == null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";

  const now = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  if (isSameDay(d, now)) return `${hh}:${mm}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return "昨天";

  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatSmartTime(ts: number | null | undefined): string {
  if (ts == null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";

  const now = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  if (isSameDay(d, now)) return `${hh}:${mm}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `昨天 ${hh}:${mm}`;

  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * 把模型输出的 LaTeX 公式转换为更适合展示的形式。
 *
 * 针对轻量/终端场景的优化：
 * 1. 块级公式 \[...\] → $$...$$，交给 KaTeX 渲染（块级下通常不会出现上下标裁切）。
 * 2. 行内公式 \(...\) 和 $...$ → Unicode 纯文本，从源头杜绝 KaTeX 行内上下标被压扁的问题。
 * 3. 代码块用占位符保护，避免误伤代码里的 \[ \( $。
 */
function preprocessMath(content: string): string {
  if (!content) return content;

  // 1. 抠出代码块
  const codeBlocks: string[] = [];
  let masked = content.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 2. 块级公式 \[...\] → $$ 独占一行
  masked = masked.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_, math) => `\n\n$$\n${String(math).trim()}\n$$\n\n`
  );

  // 3. 行内公式 \(...\) → 占位符
  masked = masked.replace(
    /\\\(([\s\S]*?)\\\)/g,
    (_, math) => `\u0000MATHINLINE${String(math).trim()}\u0000`
  );

  // 4. 行内公式 $...$ → 占位符（避免匹配 $$ 内的 $）
  masked = masked.replace(
    /(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g,
    (_, math) => `\u0000MATHINLINE${String(math).trim()}\u0000`
  );

  // 5. 行内公式占位符 → Unicode 纯文本
  masked = masked.replace(
    /\u0000MATHINLINE([\s\S]*?)\u0000/g,
    (_, math) => latexToUnicode(String(math))
  );

  // 6. 还原代码块
  masked = masked.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return masked;
}

/**
 * 将 LaTeX 片段转换成 Unicode 纯文本。
 * 覆盖常见的：上下标、希腊字母、运算符、箭头、根号、集合符号等。
 */
function latexToUnicode(latex: string): string {
  // 常见 LaTeX 命令 → Unicode
  const commandMap: Array<[RegExp, string]> = [
    // 希腊字母
    [/\\alpha\b/g, "α"], [/\\beta\b/g, "β"], [/\\gamma\b/g, "γ"], [/\\delta\b/g, "δ"],
    [/\\epsilon\b/g, "ε"], [/\\varepsilon\b/g, "ε"], [/\\zeta\b/g, "ζ"], [/\\eta\b/g, "η"],
    [/\\theta\b/g, "θ"], [/\\vartheta\b/g, "ϑ"], [/\\iota\b/g, "ι"], [/\\kappa\b/g, "κ"],
    [/\\lambda\b/g, "λ"], [/\\mu\b/g, "μ"], [/\\nu\b/g, "ν"], [/\\xi\b/g, "ξ"],
    [/\\pi\b/g, "π"], [/\\rho\b/g, "ρ"], [/\\sigma\b/g, "σ"], [/\\tau\b/g, "τ"],
    [/\\upsilon\b/g, "υ"], [/\\phi\b/g, "φ"], [/\\varphi\b/g, "φ"], [/\\chi\b/g, "χ"],
    [/\\psi\b/g, "ψ"], [/\\omega\b/g, "ω"],
    [/\\Gamma\b/g, "Γ"], [/\\Delta\b/g, "Δ"], [/\\Theta\b/g, "Θ"], [/\\Lambda\b/g, "Λ"],
    [/\\Xi\b/g, "Ξ"], [/\\Pi\b/g, "Π"], [/\\Sigma\b/g, "Σ"], [/\\Phi\b/g, "Φ"],
    [/\\Psi\b/g, "Ψ"], [/\\Omega\b/g, "Ω"],
    // 运算符
    [/\\le\b/g, "≤"], [/\\leq\b/g, "≤"], [/\\ge\b/g, "≥"], [/\\geq\b/g, "≥"],
    [/\\ne\b/g, "≠"], [/\\neq\b/g, "≠"], [/\\approx\b/g, "≈"], [/\\equiv\b/g, "≡"],
    [/\\times\b/g, "×"], [/\\div\b/g, "÷"], [/\\cdot\b/g, "·"], [/\\pm\b/g, "±"],
    [/\\mp\b/g, "∓"], [/\\ast\b/g, "∗"], [/\\star\b/g, "⋆"], [/\\circ\b/g, "∘"],
    // 集合与逻辑
    [/\\in\b/g, "∈"], [/\\notin\b/g, "∉"], [/\\subset\b/g, "⊂"], [/\\supset\b/g, "⊃"],
    [/\\subseteq\b/g, "⊆"], [/\\supseteq\b/g, "⊇"], [/\\cup\b/g, "∪"], [/\\cap\b/g, "∩"],
    [/\\emptyset\b/g, "∅"], [/\\varnothing\b/g, "∅"],
    [/\\forall\b/g, "∀"], [/\\exists\b/g, "∃"], [/\\nexists\b/g, "∄"],
    [/\\neg\b/g, "¬"], [/\\land\b/g, "∧"], [/\\lor\b/g, "∨"],
    // 箭头
    [/\\to\b/g, "→"], [/\\rightarrow\b/g, "→"], [/\\leftarrow\b/g, "←"],
    [/\\Rightarrow\b/g, "⇒"], [/\\Leftarrow\b/g, "⇐"], [/\\leftrightarrow\b/g, "↔"],
    [/\\Leftrightarrow\b/g, "⇔"], [/\\mapsto\b/g, "↦"],
    // 其它
    [/\\infty\b/g, "∞"], [/\\nabla\b/g, "∇"], [/\\partial\b/g, "∂"],
    [/\\cdots\b/g, "⋯"], [/\\ldots\b/g, "…"], [/\\dots\b/g, "…"],
    [/\\quad\b/g, " "], [/\\qquad\b/g, "  "],
    [/\\,/g, " "], [/\\;/g, " "], [/\\!/g, ""],
  ];

  let result = latex;

  // 先处理 \text{...} 和 \mathrm{...} 等：只保留内部文字
  result = result.replace(/\\(?:text|mathrm|mathbf|mathit|mathbb|mathcal)\{([^{}]*)\}/g, "$1");

  // 处理 \sqrt[n]{x} 和 \sqrt{x}
  result = result.replace(/\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, (_, n, x) => `${x}^(${n})`);
  result = result.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");

  // 处理 \frac{a}{b} → (a)/(b)
  result = result.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");

  // 常见命令替换
  for (const [re, unicode] of commandMap) {
    result = result.replace(re, unicode);
  }

  // 上下标：^n → 上标字符；_n → 下标字符
  const superscripts: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ",
  };
  const subscripts: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
    "n": "ₙ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ",
    "u": "ᵤ", "v": "ᵥ", "x": "ₓ",
  };

  // 先处理 ^{...} 和 _{...}
  result = result.replace(/\^\{([^{}]*)\}/g, (_, inner) => toScript(inner, superscripts));
  result = result.replace(/_\{([^{}]*)\}/g, (_, inner) => toScript(inner, subscripts));

  // 再处理 ^x 和 _x（单字符）
  result = result.replace(/\^([0-9a-zA-Z+\-=()])/g, (_, c) => superscripts[c] ?? `^${c}`);
  result = result.replace(/_([0-9a-zA-Z+\-=()])/g, (_, c) => subscripts[c] ?? `_${c}`);

  // 去掉 LaTeX 花括号
  result = result.replace(/[{}]/g, "");

  // 去掉多余空格
  result = result.replace(/\s+/g, " ").trim();

  return result;
}

function toScript(text: string, map: Record<string, string>): string {
  // 全部可映射，则整体转
  if ([...text].every((ch) => map[ch] !== undefined)) {
    return [...text].map((ch) => map[ch]).join("");
  }
  // 否则退化为 ^{...} 形式
  return text;
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function detectKind(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/") || /\.(md|txt|json|ts|tsx|js|jsx|css|html)$/i.test(file.name))
    return "text";
  if (/\.(zip|tar|gz|rar|7z)$/i.test(file.name)) return "archive";
  return "other";
}

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PASTE_TEXT_THRESHOLD = 2000;

const ACCEPTED_FILE_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "application/pdf", "text/plain", "text/markdown", "text/csv",
  "application/json", "application/zip",
].join(",");

export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; status: "running" }
  | { type: "tool_result"; name: string; status: "done" };

export function readSseStream(
  response: Response,
  onEvent: (evt: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      promise: Promise.reject(new Error("浏览器不支持流式响应。")),
      cancel: () => { },
    };
  }
  const decoder = new TextDecoder();
  let buffer = "";

  const cancel = () => { reader.cancel().catch(() => { }); };

  const promise = (async () => {
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => { });
          throw new DOMException("Aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const packets = buffer.split("\n\n");
        buffer = packets.pop() ?? "";

        for (const packet of packets) {
          const lines = packet.replaceAll("\r", "").split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^\s/, "")).join("\n");

          if (event === "error") throw new Error(data || "服务暂时不可用，请稍后重试。");
          if (event === "message" && data) {
            onEvent({ type: "text", content: readStreamPayload(data) });
          }
          if (event === "tool_call" && data) {
            const v = JSON.parse(data);
            onEvent({ type: "tool_call", name: v.name, status: "running" });
          }
          if (event === "tool_result" && data) {
            const v = JSON.parse(data);
            onEvent({ type: "tool_result", name: v.name, status: "done" });
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return { promise, cancel };
}

function readStreamPayload(payload: string) {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value === "object" && value !== null && "content" in value &&
      typeof (value as { content: unknown }).content === "string") {
      return (value as { content: string }).content;
    }
  } catch { /* fallthrough */ }
  return payload;
}

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────

type ChatState = {
  conversations: Conversation[];
  activeId: string;
  streaming: boolean;
  draftThreadId: string;

  setConversations: (updater: Conversation[] | ((prev: Conversation[]) => Conversation[])) => void;
  setActiveId: (id: string) => void;
  setStreaming: (v: boolean) => void;
  setDraftThreadId: (id: string) => void;

  prependConversation: (c: Conversation) => void;
  removeConversation: (threadId: string) => void;
  renameConversation: (threadId: string, title: string) => void;
  setConversationPinned: (threadId: string, pinned: boolean) => void;
  setActiveMessages: (threadId: string, messages: Message[], hasMore: boolean, nextCursor: number | null, activeLeafThreadId?: string) => void;
  setConversationVersions: (threadId: string, versions: Record<string, MessageVersion[]>) => void;
  prependEarlierMessages: (threadId: string, earlier: Message[], hasMore: boolean, nextCursor: number | null) => void;
  appendMessages: (threadId: string, messages: Message[]) => void;
  updateMessage: (threadId: string, messageId: string, updater: (m: Message) => Message) => void;
};

export const useChatStore = create<ChatState>((set) => ({
  conversations: [],
  activeId: "",
  streaming: false,
  draftThreadId: "",

  setConversations: (updater) => set((s) => ({
    conversations: typeof updater === "function" ? updater(s.conversations) : updater,
  })),
  setActiveId: (id) => set({ activeId: id }),
  setStreaming: (v) => set({ streaming: v }),
  setDraftThreadId: (id) => set({ draftThreadId: id }),

  prependConversation: (c) => set((s) => ({ conversations: [c, ...s.conversations] })),
  removeConversation: (id) => set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),
  renameConversation: (id, title) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, title } : c),
  })),
  setConversationPinned: (id, pinned) => set((s) => {
    const next = s.conversations.map((c) => c.id === id ? { ...c, pinned } : c);
    next.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return { conversations: next };
  }),
  setActiveMessages: (id, messages, hasMore, nextCursor, activeLeafThreadId) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, messages, hasMore, nextCursor, activeLeafThreadId: activeLeafThreadId ?? c.activeLeafThreadId } : c
      ),
    })),
  setConversationVersions: (id, versions) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, versions } : c),
  })),
  prependEarlierMessages: (id, earlier, hasMore, nextCursor) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, messages: [...earlier, ...c.messages], hasMore, nextCursor } : c
    ),
  })),
  appendMessages: (id, messages) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? { ...c, messages: [...c.messages, ...messages] } : c
    ),
  })),
  updateMessage: (id, messageId, updater) => set((s) => ({
    conversations: s.conversations.map((c) =>
      c.id === id ? {
        ...c,
        messages: c.messages.map((m) => m.id === messageId ? updater(m) : m),
      } : c
    ),
  })),
}));

// ─────────────────────────────────────────────────────────────
// 附件管理 Hook
// ─────────────────────────────────────────────────────────────
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    const accepted: Attachment[] = [];

    list.forEach((file) => {
      const id = makeId();
      const isImage = file.type.startsWith("image/");

      if (file.size > MAX_FILE_SIZE) {
        accepted.push({
          id, name: file.name, size: file.size, progress: 0, state: "error",
          kind: detectKind(file),
          error: `文件超过 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB 上限`
        });
        return;
      }

      const name = file.name && file.name !== "image.png" ? file.name
        : `截图-${new Date().toLocaleTimeString("zh-CN", { hour12: false })}.png`;

      accepted.push({
        id, name, size: file.size, progress: 100, state: "done",
        kind: detectKind(file),
        previewUrl: isImage ? URL.createObjectURL(file) : undefined
      });
    });

    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      return [];
    });
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (items && items.length > 0) {
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
        return;
      }
    }

    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text.length > PASTE_TEXT_THRESHOLD) {
      e.preventDefault();
      const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false }).replace(/:/g, "");
      addFiles([new File([text], `粘贴-${ts}.txt`, { type: "text/plain" })]);
    }
  }, [addFiles]);

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    handleDrop,
    handlePaste,
    setAttachments
  };
}

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

export function PanelIcon({ side = "left", size = 17 }: { side?: "left" | "right"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="4" ry="4" />
      {side === "left"
        ? <line x1="9.5" y1="4" x2="9.5" y2="20" />
        : <line x1="14.5" y1="4" x2="14.5" y2="20" />}
    </svg>
  );
}

export function ThinkingIndicator({ label = "Umi正在暴打宿傩..." }: { label?: string }) {
  return (
    <span className="thinking-indicator" aria-label={label}>
      <span className="thinking-dot" />
      <span key={label} className="thinking-label">{label}</span>
    </span>
  );
}

export function AttachmentList({
  attachments, onRemove, onPreview,
}: { attachments: Attachment[]; onRemove: (id: string) => void; onPreview: (url: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-list">
      {attachments.map((a) => (
        <div key={a.id} className={`attachment-chip ${a.state} ${a.kind === "image" ? "is-image" : ""}`}>
          <div className="attachment-icon">
            {a.kind === "image" && a.previewUrl
              ? <img src={a.previewUrl} alt={a.name} className="attachment-thumb" onClick={() => onPreview(a.previewUrl!)} />
              : a.kind === "image" ? <ImageIcon size={16} /> : <FileText size={16} />}
          </div>
          <div className="attachment-info">
            <div className="attachment-name">{a.name}</div>
            <div className="attachment-meta">
              {a.state === "done" && formatSize(a.size)}
              {a.state === "error" && (a.error || "上传失败")}
            </div>
          </div>
          <button type="button" className="attachment-remove" onClick={() => onRemove(a.id)} aria-label={`移除 ${a.name}`}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

const TOOL_VERBS: Record<string, string> = {
  deepseek_server_web_search: "联网搜索",
  read_file: "读取文件",
  run_command: "运行命令",
  edit_file: "编辑文件",
};
const TOOL_ICONS: Record<string, LucideIcon> = {
  deepseek_server_web_search: Search,
  read_file: FileSearch,
  run_command: Terminal,
  edit_file: PenLine,
};
function verbOf(name: string) { return TOOL_VERBS[name] ?? name; }

export function ToolTimeline({
  steps, streaming, activeLabel, hasAnyText,
}: {
  steps: ToolStep[];
  streaming: boolean;
  activeLabel: string;
  hasAnyText: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!streaming || hasAnyText) return null;

  const anyRunning = steps.some((s) => s.status === "running");
  const hasSteps = steps.length > 0;

  return (
    <div data-slot="tool-timeline" className={cn("tool-timeline")}>
      {hasSteps && (
        <button type="button" className="tool-timeline-trigger"
          onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronRight size={14} className={cn("tool-timeline-chevron", open && "open")} />
          <span className={cn("tool-timeline-label", anyRunning && "shimmer")}>
            {anyRunning ? activeLabel : "已完成"}
          </span>
        </button>
      )}

      {hasSteps && (
        <div className={cn("tool-timeline-panel", open && "open")}>
          <div className="tool-timeline-inner">
            {steps.map((step, index) => {
              const Icon = TOOL_ICONS[step.name] ?? Search;
              const active = index === steps.length - 1 && step.status === "running";
              return (
                <div key={`${step.name}-${index}`} className="tool-step">
                  <Icon size={13} className="tool-step-icon" />
                  <span className={cn("tool-step-verb", active && "shimmer")}>
                    {verbOf(step.name)}
                  </span>
                  <span className="tool-step-chip">{step.name}</span>
                  <span className={cn("tool-step-status", step.status)}>
                    {step.status === "running" ? "…" : step.status === "error" ? "!" : "✓"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="tool-timeline-thinking">
        <ThinkingIndicator />
      </div>
    </div>
  );
}


function VersionSwitcher({
  versions, activeBranchNum, onSwitch, disabled,
}: {
  versions: MessageVersion[];
  activeBranchNum: number | null;
  onSwitch: (branchNum: number) => void;
  disabled?: boolean;
}) {
  if (versions.length <= 1) return null;
  const sorted = [...versions].sort((a, b) => a.branchNum - b.branchNum);
  const idx = activeBranchNum === null ? -1 : sorted.findIndex((v) => v.branchNum === activeBranchNum);
  const activeIdx = idx >= 0 ? idx : sorted.length - 1;

  return (
    <div className="version-switcher" role="group" aria-label="版本切换">
      <button type="button" className="version-arrow"
        onClick={() => onSwitch(sorted[Math.max(0, activeIdx - 1)].branchNum)}
        disabled={disabled || activeIdx <= 0} aria-label="上一个版本">‹</button>
      <span className="version-count">{activeIdx + 1} / {sorted.length}</span>
      <button type="button" className="version-arrow"
        onClick={() => onSwitch(sorted[Math.min(sorted.length - 1, activeIdx + 1)].branchNum)}
        disabled={disabled || activeIdx >= sorted.length - 1} aria-label="下一个版本">›</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 代码块
// ─────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="code-action-btn"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label="复制代码"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

function DownloadButton({ text, lang }: { text: string; lang: string }) {
  return (
    <button
      type="button"
      className="code-action-btn"
      onClick={() => {
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `code.${lang || "txt"}`;
        a.click();
        URL.revokeObjectURL(url);
      }}
      aria-label="下载代码"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>下载</span>
    </button>
  );
}

function CodeBlock({ lang, codeText, className, children }: any) {
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span className="code-lang">{lang || "text"}</span>
        <div className="code-actions">
          <CopyButton text={codeText} />
          <DownloadButton text={codeText} lang={lang} />
        </div>
      </div>
      <pre className="code-block">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 消息与列表
// ─────────────────────────────────────────────────────────────

function MessageItem({
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
            "未收到有效回复。"
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

function MessageList({
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
            <span>{mode === "work" ? "工作区" : "Chat"}</span>
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

// ─────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────

function Composer(props: {
  mode: Mode; workspace: string; pickerRef: RefObject<HTMLInputElement | null>;
  onPickWorkspace: (e: ChangeEvent<HTMLInputElement>) => void;
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
  const { mode, workspace, pickerRef, onPickWorkspace, prompt, onPromptChange,
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
              <button type="button" onClick={() => pickerRef.current?.click()}>
                <FolderOpen size={16} />从本机选择目录
              </button>
              <p>目录只用于当前界面展示。</p>
            </div>
          )}
          <input ref={pickerRef} className="directory-input" type="file"
            onChange={onPickWorkspace}
            {...({ webkitdirectory: "" } as { webkitdirectory: string })} multiple />
        </div>
      )}

      <div className={`composer ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); onDragOver(e); }}
        onDragLeave={() => { setDragging(false); onDragLeave(); }}
        onDrop={(e) => { setDragging(false); onDrop(e); }}
        onPaste={onPaste}>
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} onPreview={onPreviewAttachment} />

        <textarea ref={textareaRef} value={prompt} onChange={onPromptChange}
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
                  {permission === "询问模式" ? <CircleHelp size={14} /> : <Sparkles size={14} />}
                  {permission}<ChevronDown size={14} />
                </button>
                {permissionMenuOpen && (
                  <div className="permission-menu">
                    <button type="button" className={permission === "询问模式" ? "selected" : ""}
                      onClick={() => { onSelectPermission("询问模式"); setPermissionMenuOpen(false); }}>
                      <CircleHelp size={16} />
                      <span><strong>询问模式</strong><small>执行操作前先征求确认</small></span>
                      <Check size={14} />
                    </button>
                    <button type="button" className={permission === "自动模式" ? "selected" : ""}
                      onClick={() => { onSelectPermission("自动模式"); setPermissionMenuOpen(false); }}>
                      <Sparkles size={16} />
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

// ─────────────────────────────────────────────────────────────
// 弹窗 / 面板 / 侧栏
// ─────────────────────────────────────────────────────────────

function ConfirmDialog({
  open, title, description, confirmText = "确认", cancelText = "取消",
  destructive = false, onConfirm, onCancel,
}: {
  open: boolean; title: string; description: string;
  confirmText?: string; cancelText?: string; destructive?: boolean;
  onConfirm: () => Promise<void> | void; onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!open) { setPending(false); setError(null); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) onCancel(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const handleConfirm = async () => {
    setPending(true); setError(null);
    try { await onConfirm(); }
    catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
      setPending(false);
    }
  };

  return (
    <div className="confirm-overlay" role="presentation"
      onMouseDown={() => { if (!pending) onCancel(); }}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="confirm-title">{title}</h2>
        <p className="confirm-description">{description}</p>
        {error && <p className="confirm-error">{error}</p>}
        <div className="confirm-actions">
          <button className="confirm-button cancel" onClick={onCancel} disabled={pending}>{cancelText}</button>
          <button className={`confirm-button ${destructive ? "danger" : "primary"}`}
            onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? "正在删除…" : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function Dropdown({
  value, options, onChange, label,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const current = options.find((o) => o.value === value);

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={`dropdown-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="dropdown-value">{current?.label ?? label ?? "请选择"}</span>
        <ChevronDown size={16} className={`dropdown-chevron ${open ? "open" : ""}`} />
      </button>

      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`dropdown-item ${opt.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              role="option"
              aria-selected={opt.value === value}
            >
              <span className="dropdown-item-label">{opt.label}</span>
              {opt.value === value && <Check size={14} className="dropdown-item-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsDialog({
  open, onClose, themeMode, onSelectTheme, language, onSelectLanguage,
}: {
  open: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onSelectTheme: (m: ThemeMode) => void;
  language: Language;
  onSelectLanguage: (l: Language) => void;
}) {
  const [activeTab, setActiveTab] = useState("general");
  if (!open) return null;

  const tabs = [
    { id: "general", label: "通用设置", icon: <Settings size={16} /> },
    { id: "account", label: "账号管理", icon: <User size={16} /> },
    { id: "data", label: "数据管理", icon: <ListChecks size={16} /> },
    { id: "terms", label: "服务协议", icon: <FileText size={16} /> },
    { id: "lab", label: "Umi实验室", icon: <FlaskConical size={16} /> },
  ];

  const languageOptions = [
    { value: "system", label: "跟随系统" },
    { value: "zh", label: "简体中文" },
    { value: "en", label: "English" },
  ];

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>系统设置</h2>
          <button type="button" className="settings-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-body">
          <aside className="settings-nav">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-item ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </aside>

          <main className="settings-content">
            {activeTab === "general" && (
              <>
                <div className="settings-section">
                  <label className="settings-label">主题</label>
                  <div className="settings-theme-cards">
                    {[
                      { id: "light", label: "浅色", icon: <Sun size={18} /> },
                      { id: "dark", label: "深色", icon: <Moon size={18} /> },
                      { id: "system", label: "跟随系统", icon: <Maximize2 size={18} /> },
                    ].map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`settings-theme-card ${themeMode === t.id ? "active" : ""}`}
                        onClick={() => onSelectTheme(t.id as ThemeMode)}
                      >
                        <div className="theme-card-icon">{t.icon}</div>
                        <span>{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-section">
                  <label className="settings-label">语言</label>
                  <div className="settings-row">
                    <Dropdown
                      value={language}
                      options={languageOptions}
                      onChange={(v) => onSelectLanguage(v as Language)}
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === "lab" && (
              <div className="settings-lab">
                <div className="settings-lab-icon">
                  <FlaskConical size={32} />
                </div>
                <h3 className="settings-lab-title">Umi 实验室</h3>
                <p className="settings-lab-desc">
                  这里是未来专属皮肤和实验功能的孵化地。<br />
                  敬请期待。
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 搜索弹层
// ─────────────────────────────────────────────────────────────

type SearchResult = {
  thread_id: string;
  title: string;
  pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
};

function SearchDialog({
  open, onClose, onSelectConversation,
}: {
  open: boolean;
  onClose: () => void;
  onSelectConversation: (threadId: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);

  const fetchResults = useCallback(async (q: string) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/chat/threads/search?q=${encodeURIComponent(q)}`
      );
      const json = await res.json();
      if (myReq === reqIdRef.current) {
        setResults(json.data?.threads ?? []);
      }
    } catch { /* silent */ }
    finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setResults([]);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    void fetchResults("");
    return () => window.clearTimeout(t);
  }, [open, fetchResults]);

  useEffect(() => {
    if (open) return;
    setKeyword("");
    setResults([]);
    setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void fetchResults(keyword); }, 300);
    return () => window.clearTimeout(timer);
  }, [keyword, open, fetchResults]);

  if (!open) return null;

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <Search size={18} className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索会话"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <button
            type="button"
            className="search-close"
            onClick={onClose}
            aria-label="关闭搜索"
          >
            <X size={18} />
          </button>
        </div>

        <div className="search-results">
          {loading && results.length === 0 && (
            <div className="search-status">搜索中…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="search-status">
              {keyword ? "没有找到匹配的会话" : "暂无会话"}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.thread_id}
              type="button"
              className="search-result-item"
              onClick={() => {
                onSelectConversation(r.thread_id);
                onClose();
              }}
            >
              <span className="search-result-icon" aria-hidden="true">
                <MessageSquarePlus size={16} />
              </span>
              <span className="search-result-title">{r.title}</span>
              <span className="search-result-time">
                {formatSearchTime(toMillis(r.updated_at))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DeliveryPanel({
  panelRef, onOpenWorkspacePicker, onClose,
}: { panelRef: RefObject<HTMLElement | null>; onOpenWorkspacePicker: () => void; onClose: () => void }) {
  return (
    <aside ref={panelRef} className="delivery-panel" aria-label="交付状态">
      <div className="delivery-layers" aria-hidden="true"><span /><span /><span /></div>
      <div className="work-panel-controls">
        <button type="button" className="sidebar-toggle" aria-label="展开工作面板"><Maximize2 size={16} /></button>
        <button type="button" className="sidebar-toggle" onClick={onClose} aria-label="收起工作面板">
          <PanelIcon side="right" />
        </button>
      </div>
      <div className="work-panel-body">
        <button type="button" className="work-search"><Search size={19} /><span>搜索或输入网址</span></button>
        <button type="button" className="work-action" onClick={onOpenWorkspacePicker}>
          <FolderOpen size={19} /><span>打开项目文件夹</span>
        </button>
        <button type="button" className="work-action"><MessageSquarePlus size={19} /><span>新聊天窗口</span></button>
        <button type="button" className="work-action"><SquareTerminal size={19} /><span>打开终端</span></button>
      </div>
    </aside>
  );
}

function Sidebar(props: {
  mode: Mode; modeMenuOpen: boolean; onToggleModeMenu: () => void;
  onSelectMode: (m: Mode) => void; onCollapse: () => void;
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
    conversations, activeId, onSelectConversation, conversationMenuId,
    onToggleConversationMenu, deletingId, onNewConversation,
    onRequestDeleteConversation, onRenameConversation, onTogglePin,
    onCloseConversationMenu, multiSelect, selectedIds, onEnterMultiSelect,
    onExitMultiSelect, onToggleSelected, onSelectAll, onClearSelection,
    onRequestBatchDelete, onOpenSettings, onOpenSearch,
  } = props;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
        <button type="button" className="new-chat" onClick={onNewConversation}>
          <MessageSquarePlus size={16} />新对话
        </button>
      )}

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

      {!multiSelect && (
        <button type="button" className="settings" onClick={onOpenSettings}><Settings size={16} />设置</button>
      )}
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────
// 交付面板动画
// ─────────────────────────────────────────────────────────────

function useDeliveryPanelAnimation(open: boolean, mounted: boolean) {
  const panelRef = useRef<HTMLElement | null>(null);
  const openTlRef = useRef<gsap.core.Timeline | null>(null);

  const playOpen = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    openTlRef.current?.kill();
    const layers = Array.from(panel.querySelectorAll<HTMLElement>(".delivery-layers span"));
    const items = Array.from(panel.querySelectorAll<HTMLElement>(".work-panel-body > *"));
    const controls = panel.querySelector<HTMLElement>(".work-panel-controls");
    const closeIcon = panel.querySelector<SVGElement>(".work-panel-controls .sidebar-toggle:last-child svg");
    gsap.set(layers, { xPercent: 105, opacity: 1 });
    gsap.set(items, { yPercent: 130, rotate: 8, opacity: 0 });
    gsap.set(controls, { opacity: 0, y: -8 });
    if (closeIcon) gsap.set(closeIcon, { rotate: 0, transformOrigin: "50% 50%" });
    const tl = gsap.timeline({
      onComplete: () => {
        gsap.set(items, { clearProps: "transform" });
        gsap.set(controls, { clearProps: "transform" });
        openTlRef.current = null;
      },
    });
    if (layers.length) {
      tl.to(layers, { xPercent: 0, duration: 0.5, ease: "power4.out", stagger: 0.07 }, 0);
      tl.to(layers, { opacity: 0, duration: 0.25, ease: "power2.out" }, 0.45);
    }
    if (closeIcon) tl.to(closeIcon, { rotate: 180, duration: 0.8, ease: "power4.out" }, 0.15);
    if (controls) tl.to(controls, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.15);
    if (items.length) tl.to(items, {
      yPercent: 0, rotate: 0, opacity: 1, duration: 0.65, ease: "power4.out",
      stagger: { each: 0.08, from: "start" },
    }, 0.22);
    openTlRef.current = tl;
  }, []);

  const playClose = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    openTlRef.current?.kill();
    openTlRef.current = null;
    const layers = Array.from(panel.querySelectorAll<HTMLElement>(".delivery-layers span"));
    const items = Array.from(panel.querySelectorAll<HTMLElement>(".work-panel-body > *"));
    const controls = panel.querySelector<HTMLElement>(".work-panel-controls");
    const closeIcon = panel.querySelector<SVGElement>(".work-panel-controls .sidebar-toggle:last-child svg");
    if (layers.length) gsap.to(layers, { xPercent: 105, duration: 0.3, ease: "power3.in", stagger: 0.03 });
    if (items.length) gsap.to(items, { yPercent: 35, rotate: 4, opacity: 0, duration: 0.22, ease: "power2.in", stagger: 0.03 });
    if (controls) gsap.to(controls, { opacity: 0, y: -6, duration: 0.2, ease: "power2.in" });
    if (closeIcon) gsap.to(closeIcon, { rotate: 0, duration: 0.3, ease: "power2.inOut" });
  }, []);

  useLayoutEffect(() => { if (mounted) { if (open) playOpen(); else playClose(); } },
    [mounted, open, playOpen, playClose]);
  useLayoutEffect(() => () => { openTlRef.current?.kill(); }, []);
  return panelRef;
}

// ─────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────

const MODEL_OPTIONS: ModelOption[] = [
  { id: "mini", name: "Umi · Mini", description: "更快、更轻量" },
  { id: "pro", name: "Umi · Pro", description: "平衡性能与速度" },
  { id: "max", name: "Umi · Max", description: "最强推理能力" },
];

function mapHistoryMessages(raw: Array<{
  messageId: string | null; versionGroupId: string | null; versionNum: number;
  role: "user" | "assistant"; text: string; createdAt: number | null;
}>): Message[] {
  return raw.map((m) => ({
    id: m.messageId || `tmp-${makeId()}`,
    messageId: m.messageId ?? "",
    versionGroupId: m.versionGroupId ?? "",
    versionNum: m.versionNum ?? 0,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  }));
}

function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [workspace, setWorkspace] = useState("");
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

  const {
    attachments, addFiles, removeAttachment, clearAttachments, handleDrop, handlePaste
  } = useAttachments();

  const pickerRef = useRef<HTMLInputElement>(null);
  const chatCanvasRef = useRef<HTMLElement>(null);
  const deliveryPanelRef = useDeliveryPanelAnimation(rightOpen, mode === "work");
  const abortRef = useRef<AbortController | null>(null);
  const streamCancelRef = useRef<(() => void) | null>(null);

  const conversations = useChatStore((s) => s.conversations);
  const setConversations = useChatStore((s) => s.setConversations);
  const activeId = useChatStore((s) => s.activeId);
  const setActiveId = useChatStore((s) => s.setActiveId);
  const streaming = useChatStore((s) => s.streaming);
  const setStreaming = useChatStore((s) => s.setStreaming);
  const setDraftThreadId = useChatStore((s) => s.setDraftThreadId);
  const prependConversation = useChatStore((s) => s.prependConversation);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const setActiveMessages = useChatStore((s) => s.setActiveMessages);
  const setConversationVersions = useChatStore((s) => s.setConversationVersions);
  const prependEarlierMessages = useChatStore((s) => s.prependEarlierMessages);
  const appendMessages = useChatStore((s) => s.appendMessages);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const renameConversationInStore = useChatStore((s) => s.renameConversation);
  const setConversationPinned = useChatStore((s) => s.setConversationPinned);

  const closeConversationMenu = () => setConversationMenuId(null);

  const activeConversation = useMemo(() => {
    const found = conversations.find((c) => c.id === activeId);
    if (found) return found;
    return { id: activeId, title: "新对话", messages: [] as Message[] };
  }, [activeId, conversations]);

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
    const loadThreads = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/chat/threads`);
        const json = await res.json();
        if (cancelled) return;
        const threads: Conversation[] = (json.data?.threads ?? []).map(
          (t: { thread_id: string; title: string; pinned: boolean; active_leaf_thread_id?: string | null }) => ({
            id: t.thread_id, title: t.title, messages: [], pinned: t.pinned ?? false,
            activeLeafThreadId: t.active_leaf_thread_id ?? undefined,
          }),
        );
        setConversations(threads);
      } catch { /* silent */ }
    };
    void loadThreads();
    return () => { cancelled = true; };
  }, []);

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

  useEffect(() => () => {
    streamCancelRef.current?.();
    abortRef.current?.abort();
  }, []);

  const handleCopy = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId((c) => (c === message.id ? null : c)), 3000);
    } catch { /* silent */ }
  };

  const handleReaction = (message: Message, next: "up" | "down" | null) => {
    setReactions((prev) => ({ ...prev, [message.id]: next }));
  };

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const canvas = chatCanvasRef.current;
    if (!canvas) return;
    canvas.scrollTo({ top: canvas.scrollHeight, behavior });
  }, []);

  const runStreamFor = async (
    execThreadId: string,
    query: string,
    displayThreadId: string,
    truncateBeforeIndex?: number,
    versionContext?: StreamVersionContext,
  ) => {
    const appendTo = displayThreadId;

    if (truncateBeforeIndex !== undefined) {
      const conv = useChatStore.getState().conversations.find((c) => c.id === appendTo);
      if (conv) {
        useChatStore.getState().setActiveMessages(
          appendTo, conv.messages.slice(0, truncateBeforeIndex), false, null,
        );
      }
    }

    const userMessage: Message = {
      id: makeId(), messageId: "",
      versionGroupId: versionContext?.human_version_group_id ?? "",
      versionNum: versionContext?.human_version_num ?? 0,
      role: "user", text: query, createdAt: Date.now(),
    };
    const assistantId = makeId();
    const assistantMessage: Message = {
      id: assistantId, messageId: "",
      versionGroupId: versionContext?.assistant_version_group_id ?? "",
      versionNum: versionContext?.assistant_version_num ?? 0,
      role: "assistant", text: "", createdAt: Date.now(),
    };
    appendMessages(appendTo, [userMessage, assistantMessage]);
    setStreaming(true);
    setStreamingMessageId(assistantId);
    requestAnimationFrame(() => scrollToBottom("auto"));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: execThreadId,
          query,
          ...versionContext,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`服务连接失败（${response.status}）。`);

      const { promise, cancel } = readSseStream(
        response,
        (evt) => {
          updateMessage(appendTo, assistantId, (m) => {
            if (evt.type === "text") return { ...m, text: m.text + evt.content };
            if (evt.type === "tool_call") {
              const steps = m.toolSteps ?? [];
              const last = steps[steps.length - 1];
              if (last && last.name === evt.name && last.status === "running") return m;
              return { ...m, toolSteps: [...steps, { name: evt.name, status: "running", startedAt: Date.now() }] };
            }
            if (evt.type === "tool_result") {
              const steps = (m.toolSteps ?? []).slice();
              for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].name === evt.name && steps[i].status === "running") {
                  steps[i] = { ...steps[i], status: "done" }; break;
                }
              }
              return { ...m, toolSteps: steps };
            }
            return m;
          });
          requestAnimationFrame(() => {
            const canvas = chatCanvasRef.current;
            if (canvas) {
              const d = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight;
              if (d < 200) canvas.scrollTop = canvas.scrollHeight;
            }
          });
        },
        controller.signal,
      );

      streamCancelRef.current = cancel;
      await promise;
    } catch (err) {
      if (controller.signal.aborted) {
        updateMessage(appendTo, assistantId, (item) =>
          item.text ? item : { ...item, text: "（已中止生成）" });
      } else {
        updateMessage(appendTo, assistantId, (item) =>
          item.text ? item : { ...item, text: "正在赶往新宿战场的路上..." });
      }
    } finally {
      streamCancelRef.current = null;
      abortRef.current = null;
      setStreamingMessageId(null);
      setStreaming(false);
    }
  };

  const fetchVersions = async (threadId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/thread/${threadId}/versions`);
      const json = await res.json();
      const raw = json.data?.versions ?? {};
      const versions: Record<string, MessageVersion[]> = {};
      for (const [anchorId, arr] of Object.entries(raw)) {
        versions[anchorId] = (arr as Array<{
          branch_num: number; hidden_thread_id: string; kind: "root" | "edit" | "regenerate";
        }>).map((v) => ({
          branchNum: v.branch_num,
          hiddenThreadId: v.hidden_thread_id,
          kind: v.kind,
        }));
      }
      setConversationVersions(threadId, versions);
      return versions;
    } catch { return {}; }
  };

  const reloadHistory = async (mainThreadId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/chat/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: mainThreadId, limit: 50 }),
      });
      const json = await res.json();
      const messages = mapHistoryMessages(json.data?.messages ?? []);
      const hasMore: boolean = json.data?.has_more ?? false;
      const nextCursor: number | null = json.data?.next_cursor ?? null;
      const activeLeaf: string | undefined = json.data?.active_leaf_thread_id;
      setActiveMessages(mainThreadId, messages, hasMore, nextCursor, activeLeaf);
    } catch { /* silent */ }
  };

  const switchVersion = async (
    mainThreadId: string,
    anchorMessageId: string,
    branchNum: number,
  ) => {
    if (streaming) return;
    try {
      const res = await fetch(`${API_BASE}/api/chat/version/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: mainThreadId,
          version_group_id: anchorMessageId,
          branch_num: branchNum,
        }),
      });
      await res.json();
      await reloadHistory(mainThreadId);
      await fetchVersions(mainThreadId);
    } catch { /* silent */ }
  };

  const handleRegenerate = async (message: Message) => {
    if (streaming) return;
    const sourceThreadId = activeId;
    const conv = conversations.find((c) => c.id === sourceThreadId);
    if (!conv) return;
    if (!message.messageId) {
      console.warn("[Umi] 无法重新生成：缺少 messageId");
      return;
    }

    const aiIndex = conv.messages.findIndex((m) => m.id === message.id);
    let userIndex = aiIndex;
    while (userIndex > 0 && conv.messages[userIndex].role !== "user") userIndex--;
    const truncateBefore = userIndex >= 0 ? userIndex : 0;

    setRegeneratingId(message.id);
    try {
      const res = await fetch(`${API_BASE}/api/chat/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: sourceThreadId,
          message_id: message.messageId,
        }),
      });
      const json = await res.json();
      const query: string = json.data?.query ?? "";
      const execThreadId: string = json.data?.exec_thread_id ?? "";
      const versionContext: StreamVersionContext = {
        human_version_group_id: json.data?.human_version_group_id ?? "",
        human_version_num: json.data?.human_version_num ?? 0,
        assistant_version_group_id: json.data?.assistant_version_group_id ?? "",
        assistant_version_num: json.data?.assistant_version_num ?? 0,
      };
      if (!query || !execThreadId || !versionContext.human_version_group_id
        || !versionContext.assistant_version_group_id) return;

      await runStreamFor(execThreadId, query, sourceThreadId, truncateBefore, versionContext);
      await fetchVersions(sourceThreadId);
      await reloadHistory(sourceThreadId);
    } catch { /* silent */ }
    finally { setRegeneratingId(null); }
  };

  const handleEdit = (message: Message) => {
    if (streaming) return;
    setEditingId(message.id);
    setEditValue(message.text);
  };
  const handleEditCancel = () => { setEditingId(null); setEditValue(""); };

  const handleEditSubmit = async (newText: string, editAttachments: Attachment[]) => {
    if (!editingId || !newText.trim() || streaming) return;
    const sourceThreadId = activeId;
    const newContent = newText.trim();
    const targetId = editingId;

    const conv = conversations.find((c) => c.id === sourceThreadId);
    if (!conv) return;

    const target = conv.messages.find((m) => m.id === targetId);
    if (!target?.messageId) {
      console.warn("[Umi] 无法编辑：缺少 messageId");
      return;
    }

    const targetIndex = conv.messages.findIndex((m) => m.id === targetId);
    const truncateBefore = targetIndex >= 0 ? targetIndex : 0;

    setEditingId(null);
    try {
      const res = await fetch(`${API_BASE}/api/chat/edit-resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: sourceThreadId,
          message_id: target.messageId,
          new_content: newContent,
          new_content_with_attachments: editAttachments.length > 0
            ? `${newContent}\n\n[附件: ${editAttachments.map(a => a.name).join(", ")}]`
            : newContent,
        }),
      });
      const json = await res.json();
      const query: string = json.data?.query ?? "";
      const execThreadId: string = json.data?.exec_thread_id ?? "";
      const versionContext: StreamVersionContext = {
        human_version_group_id: json.data?.human_version_group_id ?? "",
        human_version_num: json.data?.human_version_num ?? 0,
        assistant_version_group_id: json.data?.assistant_version_group_id ?? "",
        assistant_version_num: json.data?.assistant_version_num ?? 0,
      };
      if (!query || !execThreadId || !versionContext.human_version_group_id
        || !versionContext.assistant_version_group_id) return;

      await runStreamFor(execThreadId, query, sourceThreadId, truncateBefore, versionContext);
      await fetchVersions(sourceThreadId);
      await reloadHistory(sourceThreadId);
    } catch { /* silent */ }
    finally { setEditValue(""); }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || streaming) return;

    const isDraft = !conversations.some((c) => c.id === activeId);
    const threadId = activeId;

    if (isDraft) {
      prependConversation({
        id: threadId, title: text.slice(0, 24), messages: [],
      });
      setDraftThreadId("");
    }

    setPrompt("");
    clearAttachments();
    scrollToBottom("auto");

    const mainConv = useChatStore.getState().conversations.find((c) => c.id === threadId);
    const execThread = mainConv?.activeLeafThreadId || threadId;
    await runStreamFor(execThread, text, threadId);
    await reloadHistory(threadId);
  };

  const handleStop = () => {
    streamCancelRef.current?.();
    streamCancelRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreamingMessageId(null);
    setStreaming(false);
    fetch(`${API_BASE}/api/chat/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: activeId }),
    }).catch(() => { });
  };

  const newConversation = () => {
    const newId = makeId();
    setDraftThreadId(newId);
    setActiveId(newId);
    setPrompt("");
    clearAttachments();
  };

  const chooseWorkspace = (event: ChangeEvent<HTMLInputElement>) => {
    const firstFile = event.target.files?.[0];
    if (!firstFile) return;
    const relativePath = firstFile.webkitRelativePath || firstFile.name;
    setWorkspace(relativePath.split("/")[0]);
  };

  const deleteConversation = async (conversationId: string) => {
    if (deletingId) return;
    setDeletingId(conversationId);
    try {
      const response = await fetch(`${API_BASE}/api/chat/thread`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: conversationId }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`删除失败（${response.status}）`);
      const remaining = conversations.filter((c) => c.id !== conversationId);
      removeConversation(conversationId);
      if (activeId === conversationId) {
        if (remaining.length > 0) { setActiveId(remaining[0].id); setDraftThreadId(""); }
        else { const newId = makeId(); setDraftThreadId(newId); setActiveId(newId); }
      }
      setConversationMenuId(null);
    } finally { setDeletingId(null); }
  };

  const renameConversation = async (id: string, nextTitle: string) => {
    const title = nextTitle.trim();
    if (!title) return;
    const previous = conversations.find((c) => c.id === id)?.title;
    if (previous === title) return;
    renameConversationInStore(id, title);
    try {
      const res = await fetch(`${API_BASE}/api/chat/thread/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, title }),
      });
      if (!res.ok) throw new Error(`重命名失败（${res.status}）`);
    } catch { if (previous !== undefined) renameConversationInStore(id, previous); }
  };

  const togglePin = async (id: string, pinned: boolean) => {
    setConversationPinned(id, pinned);
    try {
      const res = await fetch(`${API_BASE}/api/chat/thread/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, pinned }),
      });
      if (!res.ok) throw new Error(`置顶失败（${res.status}）`);
    } catch { setConversationPinned(id, !pinned); }
  };

  const handleSelectConversation = async (id: string) => {
    setActiveId(id);
    setConversationMenuId(null);
    void fetchVersions(id);
    const target = conversations.find((c) => c.id === id);
    if (target && target.messages.length > 0) {
      requestAnimationFrame(() => {
        const canvas = chatCanvasRef.current;
        if (canvas) canvas.scrollTop = canvas.scrollHeight;
      });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/chat/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: id, limit: 20 }),
      });
      const json = await res.json();
      const messages = mapHistoryMessages(json.data?.messages ?? []);
      const hasMore: boolean = json.data?.has_more ?? false;
      const nextCursor: number | null = json.data?.next_cursor ?? null;
      const activeLeaf: string | undefined = json.data?.active_leaf_thread_id;
      setActiveMessages(id, messages, hasMore, nextCursor, activeLeaf);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const canvas = chatCanvasRef.current;
          if (canvas) canvas.scrollTop = canvas.scrollHeight;
        });
      });
    } catch { /* silent */ }
  };

  const loadEarlierMessages = async (threadId: string) => {
    if (loadingEarlier) return;
    const target = conversations.find((c) => c.id === threadId);
    if (!target || !target.hasMore || target.nextCursor == null) return;
    setLoadingEarlier(true);
    const canvas = chatCanvasRef.current;
    const prevScrollHeight = canvas?.scrollHeight ?? 0;
    try {
      const res = await fetch(`${API_BASE}/api/chat/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId, limit: 20, before: Number(target.nextCursor) }),
      });
      const json = await res.json();
      const earlier = mapHistoryMessages(json.data?.messages ?? []);
      const hasMore: boolean = json.data?.has_more ?? false;
      const nextCursor: number | null = json.data?.next_cursor ?? null;
      prependEarlierMessages(threadId, earlier, hasMore, nextCursor);
      requestAnimationFrame(() => {
        if (canvas) canvas.scrollTop += canvas.scrollHeight - prevScrollHeight;
      });
    } catch { /* silent */ }
    finally { setLoadingEarlier(false); }
  };

  const enterMultiSelect = () => { setMultiSelect(true); setSelectedIds(new Set()); setConversationMenuId(null); setModeMenuOpen(false); };
  const exitMultiSelect = () => { setMultiSelect(false); setSelectedIds(new Set()); setConversationMenuId(null); };
  const toggleSelected = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelectedIds(new Set(conversations.map((c) => c.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const batchDelete = async () => {
    if (selectedIds.size === 0 || batchDeleting) return;
    setBatchDeleting(true);
    const ids = Array.from(selectedIds);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => fetch(`${API_BASE}/api/chat/thread`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread_id: id }),
        }).then((res) => {
          if (!res.ok && res.status !== 404) throw new Error(`删除失败（${res.status}）`);
        })),
      );
      const succeeded = ids.filter((_, i) => results[i].status === "fulfilled");
      succeeded.forEach((id) => removeConversation(id));
      if (succeeded.includes(activeId)) {
        const remaining = conversations.filter((c) => !succeeded.includes(c.id));
        if (remaining.length > 0) { setActiveId(remaining[0].id); setDraftThreadId(""); }
        else { const newId = makeId(); setDraftThreadId(newId); setActiveId(newId); }
      }
      setSelectedIds(new Set()); setMultiSelect(false); setBatchDeleteOpen(false);
    } finally { setBatchDeleting(false); }
  };

  return (
    <main className={`app-shell ${leftOpen ? "left-expanded" : "left-collapsed"} ${mode === "work" && rightOpen ? "right-expanded" : "right-collapsed"}`}>
      <Sidebar
        mode={mode} modeMenuOpen={modeMenuOpen}
        onToggleModeMenu={() => setModeMenuOpen((o) => !o)}
        onSelectMode={(next) => { if (next === "work") setRightOpen(true); setMode(next); setModeMenuOpen(false); }}
        onCollapse={() => setLeftOpen(false)}
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
        onOpenSearch={() => setSearchOpen(true)}
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
          mode={mode} workspace={workspace} pickerRef={pickerRef}
          onPickWorkspace={chooseWorkspace}
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
          onOpenWorkspacePicker={() => pickerRef.current?.click()}
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

      {searchOpen && (
        <SearchDialog
          open={searchOpen}
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