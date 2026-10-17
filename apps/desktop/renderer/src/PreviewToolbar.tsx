import { useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, FolderOpen, RotateCw } from 'lucide-react';
import { userFacingError } from './ui-error.js';
export type PreviewMode = 'source' | 'preview';
export type FileOpenAction = { label: string; kind: 'system' | 'folder'; run: () => Promise<unknown> };
export function PreviewToolbar({ path, mode, onMode, busy, onReload, actions = [] }: {
  path: string; mode: PreviewMode; onMode: (mode: PreviewMode) => void; busy: boolean;
  onReload: () => void; actions?: FileOpenAction[];
}) {
  const openLock = useRef(false), menu = useRef<HTMLDetailsElement>(null), [opening, setOpening] = useState(false), [result, setResult] = useState('');
  const invoke = async (action: FileOpenAction) => {
    if (openLock.current) return; openLock.current = true; setOpening(true); setResult(''); if (menu.current) menu.current.open = false;
    try { await action.run(); setResult(action.kind === 'system' ? '已发送系统打开请求' : '已在文件夹中显示'); }
    catch (e) { setResult(userFacingError(e) || '打开失败，请重试'); }
    finally { openLock.current = false; setOpening(false); }
  };
  return <header className="file-preview-header">
    <div className="file-preview-path" title={path}>{path}</div>
    <div className="file-preview-tools">
      <details ref={menu} className="file-options-menu" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
        <summary aria-label="文件查看与打开方式" title="查看与打开方式">{mode === 'source' ? '原文' : '预览'}<ChevronDown size={12} /></summary>
        <div className="file-options-card">
          <div className="file-view-options" role="group" aria-label="文件查看方式">{([['source', '原文'], ['preview', '预览']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} onClick={() => { onMode(value); if (menu.current) menu.current.open = false; }}><span>{label}</span>{mode === value && <Check size={13} />}</button>)}</div>
          <div className="file-open-options" aria-label="打开方式"><span className="file-open-caption">打开方式</span>{actions.map(action => <button type="button" key={action.label} disabled={opening} onClick={() => void invoke(action)}>{action.kind === 'system' ? <ExternalLink size={14} /> : <FolderOpen size={14} />}{action.label}</button>)}<button type="button" onClick={() => { void navigator.clipboard.writeText(path).then(() => setResult('已复制路径')).catch(() => setResult('路径未能复制')); if (menu.current) menu.current.open = false; }}>复制路径</button></div>
        </div>
      </details>
      <button className="file-preview-reload" type="button" title="重新加载" aria-label="重新加载" disabled={busy} onClick={() => { setResult(''); onReload(); }}><RotateCw size={14} /></button>
      <button type="button" className="file-open-trigger" aria-label="打开方式" title="打开方式" onClick={() => { if (menu.current) menu.current.open = !menu.current.open; }}><ExternalLink size={14} /></button>
    </div>
    {result && <button className="file-action-result" role="status" title="点击关闭" onClick={() => setResult('')}>{result}</button>}
  </header>;
}
