import { useCallback, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";

import type { Attachment } from "../../../types";
import { MAX_FILE_SIZE, PASTE_TEXT_THRESHOLD } from "../../../utils/constants";
import { detectKind, makeId } from "../../../utils/file";

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
