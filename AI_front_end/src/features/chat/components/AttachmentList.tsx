import { FileText, Image as ImageIcon, X } from "lucide-react";

import type { Attachment } from "../../../types";
import { formatSize } from "../../../utils/file";

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
