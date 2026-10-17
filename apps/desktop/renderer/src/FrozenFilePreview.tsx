import { useEffect, useRef, useState } from 'react';
import { frozenFilePageSchema } from '../../../../packages/protocol/src/file-preview.js';
import type { FrozenFilePage } from '../../../../packages/protocol/src/file-preview.js';
import type { FileTarget } from './Timeline.js';
import { userFacingError } from './ui-error.js';
import { appendPreviewPage } from './preview-page.js';
import { FileContent } from './FileContent.js';
import { PreviewToolbar } from './PreviewToolbar.js';
import type { PreviewMode } from './PreviewToolbar.js';

export function FrozenFilePreview({ conversationId, target }: { conversationId: string; target: FileTarget }) {
  const [side, setSide] = useState<'before' | 'after'>('after');
  const [page, setPage] = useState<FrozenFilePage | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [mode, setMode] = useState<PreviewMode>('preview');
  const generation = useRef(0), lock = useRef(false), current = useRef<FrozenFilePage | null>(null);
  const read = async (startByte: number) => frozenFilePageSchema.parse(await window.umi.request({
    type: 'preview_change_file', conversationId, changeSetId: target.changeSetId!, path: target.path, side, startByte, byteLength: startByte ? 64000 : 8192,
  }));
  useEffect(() => {
    let live = true; const ticket = ++generation.current;
    current.current = null; setPage(null); setError(''); setBusy(true);
    void read(0).then(value => { if (live && ticket === generation.current) { if (value.operation === 'delete' && side === 'after') { setSide('before'); return; } current.current = value; setPage(value); } })
      .catch(e => { if (live) setError(userFacingError(e) || '冻结内容读取失败，可以重试。'); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; generation.current++; };
  }, [conversationId, target.changeSetId, target.path, side, reload]);
  const more = async () => {
    const previous = current.current, ticket = generation.current;
    if (!previous || previous.nextStartByte === null || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const nextPage = await read(previous.nextStartByte); if (ticket !== generation.current) return; const next = { ...nextPage, ...appendPreviewPage(previous, nextPage) }; current.current = next; setPage(next); }
    catch (e) { if (ticket === generation.current) setError(userFacingError(e)); }
    finally { lock.current = false; if (ticket === generation.current) setBusy(false); }
  };
  return <div className="work-preview-content frozen-preview" aria-busy={busy}>
    <PreviewToolbar path={page?.displayPath ?? target.path} mode={mode} onMode={setMode} busy={busy} onReload={() => setReload(n => n + 1)} actions={page?.after && page.delivered ? [{ label: '用系统默认应用打开', kind: 'system', run: () => window.umi.request({ type: 'open_delivered', conversationId, changeSetId: target.changeSetId!, path: target.path }) }] : []} />
    <FileContent path={target.path} mode={mode} text={page?.text ?? ''} unsupported={page?.binary} busy={busy} error={error} hasMore={Boolean(page?.truncated)} onMore={more} />
  </div>;
}
