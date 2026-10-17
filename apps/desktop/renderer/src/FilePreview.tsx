import { FileContent } from './FileContent.js';
import { PreviewToolbar } from './PreviewToolbar.js';
import type { PreviewMode } from './PreviewToolbar.js';
import { FrozenFilePreview } from './FrozenFilePreview.js';
import { useEffect, useRef, useState } from 'react';
import type { DesktopInput } from '../../../../packages/protocol/src/desktop.js';
import { fileTargetKey } from './Timeline.js';
import type { FileTarget } from './Timeline.js';
import { appendPreviewPage } from './preview-page.js';
import type { PreviewPage } from './preview-page.js';
import { userFacingError } from './ui-error.js';

// 只共享正在进行的同对象请求，结束就释放；不另存无界文件正文缓存。
const inflight = new Map<string, Promise<PreviewPage>>();
function readOnce(command: DesktopInput, version: string): Promise<PreviewPage> {
  const key = JSON.stringify([command, version]);
  const existing = inflight.get(key); if (existing) return existing;
  const pending = window.umi.request(command).then(value => value as PreviewPage).finally(() => inflight.delete(key));
  inflight.set(key, pending); return pending;
}
export function FilePreview(props: { conversationId: string; target: FileTarget; revision: number }) {
  return props.target.changeSetId ? <FrozenFilePreview conversationId={props.conversationId} target={props.target} /> : <LiveFilePreview {...props} />;
}
function LiveFilePreview({ conversationId, target, revision }: { conversationId: string; target: FileTarget; revision: number }) {
  const [preview, setPreview] = useState<PreviewPage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const generation = useRef(0), pageLock = useRef(false), current = useRef<PreviewPage | null>(null);
  const validatedRevision = useRef(revision);
  const [mode, setMode] = useState<PreviewMode>('preview');
  const identity = fileTargetKey(target);
  const version = JSON.stringify([conversationId, identity, reload]);
  const read = async (startByte = 0): Promise<PreviewPage> => {
    const byteLength = startByte === 0 ? 8192 : 64000;
    if (target.attachmentId) return readOnce({ type: 'preview_attachment', conversationId, attachmentId: target.attachmentId, startByte, byteLength }, version);
    return readOnce({ type: 'preview_file', conversationId, mountId: target.mountId, path: target.path, startByte, byteLength, ...(startByte && current.current?.hash ? { expectedHash: current.current.hash } : {}) }, version);
  };
  useEffect(() => {
    let live = true; const ticket = ++generation.current, requestedRevision = revision;
    current.current = null; setPreview(null); setError(''); setBusy(true);
    void read().then(value => { if (live && ticket === generation.current) { validatedRevision.current = requestedRevision; current.current = value; setPreview(value); } }).catch(e => {
      if (live) setError(userFacingError(e) || '预览回执暂未返回，可以重试。');
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; generation.current++; };
  }, [version]);
  // 环境修订只是轻量失效提示；同文件 hash 不变时保留已加载全文与滚动位置。
  useEffect(() => {
    if (target.attachmentId || !current.current?.hash || validatedRevision.current === revision) return;
    const ticket = generation.current; let live = true;
    void readOnce({ type: 'preview_file', conversationId, mountId: target.mountId, path: target.path, startByte: 0, byteLength: 4 }, JSON.stringify([version, revision]))
      .then(value => { if (live && ticket === generation.current) { if (value.hash !== current.current?.hash) setReload(n => n + 1); else validatedRevision.current = revision; } })
      .catch(() => { if (live && ticket === generation.current) setReload(n => n + 1); });
    return () => { live = false; };
  }, [revision, preview?.hash]);
  const loadMore = async () => {
    const previous = current.current, startByte = previous?.nextStartByte ?? (previous?.truncated && !target.changeSetId ? previous.endByte : null), ticket = generation.current;
    if (!previous || startByte == null || pageLock.current) return;
    pageLock.current = true; setBusy(true); setError('');
    try {
      const page = await read(startByte); if (ticket !== generation.current) return;
      const next = appendPreviewPage(previous, page); current.current = next; setPreview(next);
    } catch (e) {
      if (ticket !== generation.current) return;
      if ((e as { code?: string }).code === 'PREVIEW_CHANGED' || (e as { code?: string }).code === 'RESOURCE_CHANGED') setReload(n => n + 1);
      else setError(userFacingError(e) || '下一段预览暂未返回，可以重试。');
    } finally { pageLock.current = false; if (ticket === generation.current) setBusy(false); }
  };
  return <div className="work-preview-content" aria-busy={busy}>
    <PreviewToolbar path={preview?.displayPath ?? (target.attachmentId ? '附件 / ' + target.path : target.path)} mode={mode} onMode={setMode} busy={busy} onReload={() => setReload(n => n + 1)} actions={target.attachmentId ? [] : [{ label: '在文件夹中显示', kind: 'folder', run: () => window.umi.request({ type: 'open_file', conversationId, mountId: target.mountId, path: target.path }) }]} />
    <FileContent path={target.path} mode={mode} text={preview?.text ?? ''} dataUrl={preview?.dataUrl} unsupported={preview?.previewSupported === false} busy={busy} error={error} hasMore={Boolean(preview?.truncated)} onMore={loadMore} />
  </div>;
}
