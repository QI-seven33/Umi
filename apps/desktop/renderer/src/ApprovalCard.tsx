import { t as uiText } from './ui-language.js';
import { useEffect, useRef, useState } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { userFacingError } from './ui-error.js';
import type { ConversationState } from '../../../../packages/protocol/src/reducer.js';
import type { FileTarget } from './Timeline.js';

type Delivery = { kind: 'delivery'; changeSet: { id: string; mountId: string }; preview: { targetDirectory: string; changes: { path: string; operation: 'create' | 'modify' | 'delete'; binary: boolean; previewTruncated: boolean }[] } };
type Detail = Delivery | { kind: 'operation'; description: string };
type Props = { executionPolicy?: 'ask'|'auto'; id: string; state: ConversationState; conversationId: string; onPreview: (file: FileTarget) => void; onError: (error: string) => void };

export function ApprovalCard({ id, state, conversationId, onPreview, onError,executionPolicy }: Props) {
  const labels = { create: uiText("新增"), modify: uiText("修改"), delete: uiText("删除") };
  const approval = state.approvals[id]!;
  const toolName = state.tools[approval.callId]?.name;
  const delivery = toolName === 'deliver_changeset';
  const command = toolName === 'run_command' || toolName === 'run_shell';
  const program = /^程序：(.+)$/m.exec(approval.description)?.[1]?.split(/[\\/]/).at(-1);
  const directory = /^工作目录：(.+)$/m.exec(approval.description)?.[1];
  const [description, ...operationLines] = [...new Set(approval.description.split('\n').filter(Boolean))];
  const [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (!delivery) return;
    let live = true;
    setDetail(null); setError(''); setLoading(true);
    void window.umi.request({ type: 'approval_detail', conversationId, approvalId: id })
      .then(data => { if (live) setDetail(data as Detail); })
      .catch(e => { if (live) setError(userFacingError(e) || uiText("交付信息暂未返回，可重试读取。")); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [id, conversationId, delivery, reload]);
  const decide = (decision: 'allow' | 'deny',scope:'once'|'task'='once') => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    void window.umi.request({ type: 'approve', conversationId, approvalId: id, decision,scope })
      .catch(e => { lock.current = false; setBusy(false); onError(userFacingError(e)); });
    // 成功后等待同一事件流移除卡片，避免回执与下一次 poll 之间重复点击。
  };
  return <section className="umi-approval" aria-label={delivery ? uiText("交付批准") : uiText("操作批准")}>
    <div className="umi-approval-body">
      <div className="approval-heading"><ShieldCheck size={16}/><strong>{delivery ? uiText("确认交付范围") : uiText("需要你的许可")}</strong></div>
      {delivery ? detail?.kind === 'delivery' ? <>
        <p>{uiText("将以下修改写回")}<span className="delivery-target">{detail.preview.targetDirectory}</span></p>
        <ul className="delivery-file-list">{detail.preview.changes.map(file => <li key={file.path}>
          <button type="button" className="umi-file-row" aria-label={`${labels[file.operation]}：${file.path}`} title={`${labels[file.operation]}：${file.path}`} onClick={() => onPreview({ mountId: detail.changeSet.mountId, path: file.path, changeSetId: detail.changeSet.id })}>
            <FileText size={14} /><span>{file.path}</span>
          </button>
        </li>)}</ul>
        {detail.preview.changes.some(file => file.operation === 'delete') && <p className="delivery-warning">{uiText("删除项会永久删除源文件，不进入系统回收站。")}</p>}
        <small>{uiText("点击文件查看已冻结的变化。本次批准仅覆盖这份变更集。")}</small>
      </> : <p>{error ? uiText("暂未读到交付范围，可重试读取或拒绝本次操作。") : uiText("正在读取交付范围…")}</p>
        : <><p className="operation-description">{command ? <>{uiText(toolName==='run_shell'?'运行脚本':'运行命令')}{program&&<span className="approval-program">{program}</span>}</> : description}</p>{command&&directory&&<code className="approval-directory" title={directory}>{directory}</code>}{(operationLines.length > 0 || command) && <details className="approval-operation-detail"><summary>{uiText("查看完整操作")}</summary><pre>{approval.description}</pre></details>}</>}
      {approval.canReuseCommand&&executionPolicy==='auto'&&<small>{uiText("本任务可复用这条命令；停止或新任务后失效。命令没有文件与网络沙箱。")}</small>}
      {error && <><p role="alert">{error}</p><button type="button" disabled={loading || busy} onClick={() => setReload(n => n + 1)}>{uiText("重新读取范围")}</button></>}
    </div>
    <div className="umi-approval-actions" aria-busy={busy}>
      <span className="approval-decision-status" role="status">{busy ? uiText("正在提交决定…") : ''}</span>
      <button type="button" className="approval-deny" disabled={busy} onClick={() => decide('deny')}>{uiText("拒绝")}</button>
      {approval.canReuseCommand&&executionPolicy==='auto'&&<button type="button" className="approval-allow-task" disabled={busy} onClick={()=>decide("allow","task")}>{uiText("本任务允许重复")}</button>}
      <button type="button" className="approval-allow" disabled={busy || (delivery && detail?.kind !== 'delivery')} onClick={() => decide('allow')}>{uiText("允许本次")}</button>
    </div>
  </section>;
}
