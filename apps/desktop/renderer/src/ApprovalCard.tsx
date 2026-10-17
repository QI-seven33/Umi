import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { userFacingError } from './ui-error.js';
import type { ConversationState } from '../../../../packages/protocol/src/reducer.js';
import type { FileTarget } from './Timeline.js';

type Delivery = { kind: 'delivery'; changeSet: { id: string; mountId: string }; preview: { targetDirectory: string; changes: { path: string; operation: 'create' | 'modify' | 'delete'; binary: boolean; previewTruncated: boolean }[] } };
type Detail = Delivery | { kind: 'operation'; description: string };
const labels = { create: '新增', modify: '修改', delete: '删除' };
type Props = { id: string; state: ConversationState; conversationId: string; onPreview: (file: FileTarget) => void; onError: (error: string) => void };

export function ApprovalCard({ id, state, conversationId, onPreview, onError }: Props) {
  const approval = state.approvals[id]!;
  const delivery = state.tools[approval.callId]?.name === 'deliver_changeset';
  const [description, ...operationLines] = approval.description.split('\n');
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (!delivery) return;
    let live = true;
    setDetail(null); setError(''); setLoading(true);
    void window.umi.request({ type: 'approval_detail', conversationId, approvalId: id })
      .then(data => { if (live) setDetail(data as Detail); })
      .catch(e => { if (live) setError(userFacingError(e) || '交付信息暂未返回，可重试读取。'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, conversationId, delivery, reload]);
  const decide = (decision: 'allow' | 'deny') => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    void window.umi.request({ type: 'approve', conversationId, approvalId: id, decision })
      .catch(e => { lock.current = false; setBusy(false); onError(userFacingError(e)); });
    // 成功后等待同一事件流移除卡片，避免回执与下一次 poll 之间重复点击。
  };
  return <section className="umi-approval" aria-label={delivery ? '交付批准' : '操作批准'}>
    <div className="umi-approval-body">
      <strong>{delivery ? '确认交付范围' : '确认本次操作'}</strong>
      {delivery ? detail?.kind === 'delivery' ? <>
        <p>将以下修改写回 <span className="delivery-target">{detail.preview.targetDirectory}</span></p>
        <ul className="delivery-file-list">{detail.preview.changes.map(file => <li key={file.path}>
          <button type="button" className="umi-file-row" aria-label={`${labels[file.operation]}：${file.path}`} title={`${labels[file.operation]}：${file.path}`} onClick={() => onPreview({ mountId: detail.changeSet.mountId, path: file.path, changeSetId: detail.changeSet.id })}>
            <FileText size={14} /><span>{file.path}</span>
          </button>
        </li>)}</ul>
        {detail.preview.changes.some(file => file.operation === 'delete') && <p className="delivery-warning">删除项会永久删除源文件，不进入系统回收站。</p>}
        <small>点击文件查看已冻结的变化。本次批准仅覆盖这份变更集。</small>
      </> : <p>{error ? '暂未读到交付范围，可重试读取或拒绝本次操作。' : '正在读取交付范围…'}</p>
        : <><p className="operation-description">{description}</p>{operationLines.length > 0 && <details className="approval-operation-detail"><summary>查看完整操作</summary><pre>{operationLines.join('\n')}</pre></details>}</>}
      {error && <><p role="alert">{error}</p><button type="button" disabled={loading || busy} onClick={() => setReload(n => n + 1)}>重新读取范围</button></>}
    </div>
    <div className="umi-approval-actions" aria-busy={busy}>
      <span className="approval-decision-status" role="status">{busy ? '正在提交决定…' : ''}</span>
      <button type="button" className="approval-deny" disabled={busy} onClick={() => decide('deny')}>拒绝</button>
      <button type="button" className="approval-allow" disabled={busy || (delivery && detail?.kind !== 'delivery')} onClick={() => decide('allow')}>允许本次</button>
    </div>
  </section>;
}
