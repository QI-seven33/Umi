import { useEffect, useState } from "react";

export function ConfirmDialog({
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
