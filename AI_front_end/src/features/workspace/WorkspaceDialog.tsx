import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { FolderOpen, X } from "lucide-react";

export function WorkspaceDialog({
  open, onClose, onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setPath(""); setPending(false); setError(null);
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !path.trim() || pending) return;
    setPending(true); setError(null);
    try {
      await onCreate(name.trim(), path.trim());
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建工作区失败。");
      setPending(false);
    }
  };

  return (
    <div className="confirm-overlay" onMouseDown={() => { if (!pending) onClose(); }}>
      <form className="workspace-dialog" onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="workspace-dialog-header">
          <div><FolderOpen size={18} /><h2>新建工作区</h2></div>
          <button type="button" className="icon-button" onClick={onClose}
            disabled={pending} aria-label="关闭"><X size={17} /></button>
        </div>
        <label className="workspace-field">
          <span>名称</span>
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)}
            maxLength={100} placeholder="例如：Umi" />
        </label>
        <label className="workspace-field">
          <span>本机目录</span>
          <input value={path} onChange={(event) => setPath(event.target.value)}
            placeholder="E:\\Projects\\Umi" />
        </label>
        {error && <p className="confirm-error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-button cancel" onClick={onClose}
            disabled={pending}>取消</button>
          <button type="submit" className="confirm-button primary"
            disabled={pending || !name.trim() || !path.trim()}>
            {pending ? "正在创建…" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}
