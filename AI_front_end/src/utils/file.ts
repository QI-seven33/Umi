import type { Attachment } from "../types";

export const makeId = () => crypto.randomUUID();

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
