import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Copy, FileText, X, CircleHelp, Atom, Terminal, Search, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationState, Block } from '../../../../packages/protocol/src/reducer.js';
import { CodeBlock } from './components/ui/CodeBlock.js';
import { GenerationLoader } from './components/ui/LoadingState.js';
import type { Snapshot } from './transport.js';
import { processItems, activityLabel, toolNames, clockTime, elapsedTime } from './activity.js';
import type { ActivityItem } from './activity.js';

const outcome: Record<string, string> = { prepared: '等待派发', running: '正在执行', succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', unknown: '结果未知' };
export type FileTarget = { mountId: string; path: string; changeSetId?: string; attachmentId?: string };
// 展示名称不是身份：同名附件和不同交付快照必须拥有独立预览。
export function fileTargetKey(target: FileTarget): string {
  return JSON.stringify(target.attachmentId ? ['attachment', target.attachmentId] : target.changeSetId ? ['changeset', target.changeSetId, target.path] : ['working', target.mountId, target.path]);
}
export function Markdown({ text, mounts, onPreview }: { text: string; mounts: any[]; onPreview: (f: FileTarget) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href) void window.umi.openUrl(href); }}>{children}</a>,
    pre: ({ children }) => <>{children}</>, code: ({ className, children, ...props }) => {
      const value = String(children).replace(/\n$/, ''), lang = /language-(\w+)/.exec(className ?? '')?.[1];
      if (lang || value.includes('\n')) return <CodeBlock lang={lang ?? 'text'} codeText={value}><code>{value}</code></CodeBlock>;
      const logical = /^@working\/([^/]+)\/(.+)$/.exec(value), path = logical?.[2] ?? value;
      const mount = logical ? mounts.find(m => m.mountId === logical[1] || m.resourceId === logical[1]) : mounts.length === 1 ? mounts[0] : null;
      if (mount && /^[^\s]+\.[a-zA-Z0-9]+$/.test(path) && !path.includes(':') && !path.startsWith('/')) return <button type="button" className="inline-code inline-file-link" onClick={() => onPreview({ mountId: mount.mountId, path })}>{children}</button>;
      return <code className="inline-code">{children}</code>;
    }
  }}>{text}</ReactMarkdown>;
}
function Changes({ id, conversationId, onPreview }: { id: string; conversationId: string; onPreview: (f: FileTarget) => void }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState('');
  return <details className="umi-changes" onToggle={e => { if (e.currentTarget.open && !data) void window.umi.request({ type: 'preview_changeset', conversationId, changeSetId: id }).then(setData).catch(e => setError(e.message)); }}><summary><ChevronDown size={14} />文件变化与交付范围</summary>{error && <p role="alert">{error}</p>}{data?.changeSet?.changes?.map((item: any) => <button className="umi-file-row" key={item.path} onClick={() => onPreview({ mountId: data.changeSet.mountId, path: item.path, changeSetId: id })}><FileText size={14} /><span>{item.path}</span><small>{!item.before ? '新增' : !item.after ? '删除' : '修改'}</small></button>)}{data && !data.changeSet?.changes?.length && <p>没有文件变化。</p>}</details>;
}
function MessageFooter({ text, time, onError }: { text: string; time?: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false), copying = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  const copy = async () => {
    if (copying.current) return;
    copying.current = true;
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      clearTimeout(timer.current); setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch (e) { if (mounted.current) onError(e instanceof Error ? e.message : '复制失败'); }
    finally { copying.current = false; }
  };
  return <div className={'message-footer ' + (copied ? 'copy-confirmed' : '')}>
    <button type="button" className="meta-button" aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    <span className="copy-feedback" role="status" aria-live="polite">{copied ? '已复制' : ''}</span>
    {time && <time className="message-time" dateTime={time} title={new Date(time).toLocaleString('zh-CN')}>{clockTime(time)}</time>}
  </div>;
}
function Tool({ id, state, onPreview }: { id: string; state: ConversationState; onPreview: (f: FileTarget) => void }) {
  const t = state.tools[id]!, [detail, setDetail] = useState<any>(null), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => { let live = true; void window.umi.request({ type: 'tool_detail', conversationId: state.cursor.streamId, callId: id }).then(data => { if (live) { setDetail(data); setError(''); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [id, state.cursor.streamId, t.status, t.resultRef]);
  const waitingApproval = Object.values(state.approvals).some(a => a.callId === id && a.status === 'pending');
  const args = detail?.arguments, path = args?.relativePath ?? args?.path, target = path && args?.mountId ? { mountId: args.mountId, path } : null;
  const hint = path ?? args?.query ?? args?.program ?? args?.messageId ?? '', Icon = t.name.startsWith('run_') ? Terminal : t.name.includes('search') || t.name === 'discover_resource' ? Search : t.name.includes('file') || t.name === 'read_attachment' ? FileText : Sparkles;
  return <div className={`umi-tool ${['failed', 'denied', 'cancelled', 'unknown'].includes(t.status) ? 'has-error' : ''}`}><button className="umi-tool-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={14} className="umi-disclosure-icon" /><Icon size={14} /><span>{toolNames[t.name] ?? '调用工具'}</span>{!target && hint && <span className="umi-tool-hint">{String(hint)}</span>}<small>{waitingApproval ? '等待批准' : outcome[t.status]}</small>{waitingApproval ? <CircleHelp size={13} /> : t.status === 'running' || t.status === 'prepared' ? <GenerationLoader compact label="" /> : t.status === 'succeeded' ? <Check size={13} /> : t.status === 'unknown' ? <CircleHelp size={13} /> : <X size={13} />}</button>{target && <button className="umi-tool-file" onClick={() => onPreview(target)}>{String(path)}</button>}{open && <div className="umi-tool-detail">{error && <p role="alert">{error}</p>}{detail ? <><pre>{detail.result?.content ?? JSON.stringify(detail.arguments, null, 2)}</pre>{detail.result?.truncated && <small>这里只显示部分输出。</small>}</> : <span>正在读取执行信息…</span>}</div>}</div>;
}
function Activity({ items, state, onPreview }: { items: ActivityItem[]; state: ConversationState; onPreview: (f: FileTarget) => void }) {
  const [open, setOpen] = useState(false), label = activityLabel(items, state), active = label.startsWith('正在');
  return <section className="umi-activity-group"><button className="umi-activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{active ? <GenerationLoader compact label="" /> : <ChevronDown size={14} className={open ? 'is-open' : ''} />}<span>{label}</span></button>{open && <div className="umi-activity-list">{items.map(item => item.kind === 'tool' ? <Tool key={item.id} id={item.id} state={state} onPreview={onPreview} /> : <details className="umi-reasoning-row" key={item.block.id} data-turn-id={item.block.turnId} data-attempt-id={item.block.attemptId}><summary><ChevronDown size={14} className="umi-disclosure-icon" /><Atom size={14} /><span>思考</span><span className="umi-reasoning-excerpt">{item.block.text.trim().replace(/\s+/g, ' ') || '正在生成思考内容'}</span>{item.block.status === 'interrupted' && <small>已中断</small>}</summary><div className="message-reasoning-content">{item.block.text}</div></details>)}</div>}</section>;
}
function Run({ id, snapshot, onPreview, onError, from, to, last }: { id: string; snapshot: Snapshot; onPreview: (f: FileTarget) => void; onError: (e: string) => void; from: string; to: string | null; last: boolean }) {
  const state = snapshot.state, r = state.runs[id]!, [expanded, setExpanded] = useState(false), [recovery, setRecovery] = useState<any>(null), [busy, setBusy] = useState(false);
  const within = (sequence: string) => BigInt(sequence) > BigInt(from) && (to === null || BigInt(sequence) < BigInt(to));
  const blocks = state.blocks.filter(b => b.runId === id && within(b.sequence)), final = blocks.filter(b => b.kind === 'text' && b.displayRole === 'final'), process = processItems(state, id, from, to);
  const tools = Object.entries(state.tools).filter(([, t]) => t.runId === id && within(t.sequence));
  const pending = last ? Object.entries(state.approvals).filter(([, a]) => a.status === 'pending' && state.tools[a.callId]?.runId === id) : [];
  const running = ['queued', 'running', 'recovering', 'stopping'].includes(r.status), complete = r.status === 'completed', mounts = snapshot.resources?.mounts ?? [];
  const renderBlock = (b: Block) => b.kind === 'reasoning' ? <details className="message-reasoning" key={b.id}><summary>{b.status === 'running' && r.status === 'running' ? <GenerationLoader compact label="正在思考" /> : <><ChevronDown size={14} />思考过程</>}</summary><div className="message-reasoning-content">{b.text}</div></details> : <div key={b.id} className="message-body"><Markdown text={b.text} mounts={mounts} onPreview={onPreview} />{b.status === 'interrupted' && <small>此段响应中断，尚未形成完整消息。</small>}</div>;
  if (!last && !blocks.length && !tools.length) return null;
  return <article className="message assistant" data-run-id={id}>
    {(process.length > 0 || running || pending.length > 0) && <div className="umi-process"><button className="umi-process-toggle" aria-expanded={!complete || expanded} onClick={() => setExpanded(!expanded)}><span>{complete ? `已完成${elapsedTime(r.startedAt, r.finishedAt) ? `，用时 ${elapsedTime(r.startedAt, r.finishedAt)}` : ''}` : r.status === 'waiting_permission' ? '等待你的批准' : r.budgetBlock ? '上下文预算阻塞' : r.status === 'interrupted' ? '执行中断' : r.status === 'stopped' ? '已停止' : '执行中'}</span><ChevronDown size={14} /></button>
      {(!complete || expanded) && <div className="umi-process-content">{process.map(item => item.kind === 'text' ? renderBlock(item.block) : <Activity key={item.id} items={item.items} state={state} onPreview={onPreview} />)}{running && !blocks.length && <GenerationLoader compact label="正在准备" />}</div>}
    </div>}

    {last && r.budgetBlock && <section className="umi-budget" role="status"><strong>上下文预算阻塞</strong><p>{r.reason}</p><p>保守估算 {r.budgetBlock.estimatedInputTokens.toLocaleString()}，输入预算 {r.budgetBlock.inputCeiling.toLocaleString()}。用户原文仍完整保存。</p><small>直接恢复不会减少上下文。可在设置中调整有效预算；达到模型上限后仍不能容纳时，需要后续有预算的原文投影。</small></section>}
    {last && ['interrupted', 'stopped', 'recovery_required'].includes(r.status) && <div className="umi-recovery"><button disabled={busy} onClick={() => { setBusy(true); void window.umi.request({ type: 'recovery', conversationId: state.cursor.streamId, runId: id }).then(setRecovery).catch(e => onError(e.message)).finally(() => setBusy(false)); }}>检查恢复条件</button>{recovery && <><span>{recovery.budget.reason ?? '恢复时先核验已派发操作。'}</span><button disabled={busy || !recovery.budget.canResume} onClick={() => { setBusy(true); void window.umi.request({ type: 'resume', conversationId: state.cursor.streamId, runId: id }).catch(e => onError(e.message)).finally(() => { setBusy(false); setRecovery(null); }); }}>恢复任务</button></>}</div>}
    {last && Object.keys(state.changesets).filter(cs => state.changesets[cs]?.runId === id).map(cs => <Changes key={cs} id={cs} conversationId={state.cursor.streamId} onPreview={onPreview} />)}
    {final.map(renderBlock)}
    {complete && final.length > 0 && <MessageFooter text={final.map(b => b.text).join('\n\n')} {...(r.finishedAt ? { time: r.finishedAt } : {})} onError={onError} />}
    {last && r.status === 'failed' && <p role="alert">{r.reason ?? '任务失败，原始记录仍保留。'}</p>}
  </article>;
}
function ImageAttachment({ conversationId, attachmentId, name, onPreview }: { conversationId: string; attachmentId: string; name: string; onPreview: () => void }) {
  const [url, setUrl] = useState(''), node = useRef<HTMLButtonElement>(null);
  useEffect(() => { let live = true; const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect(); void window.umi.request({ type: 'preview_attachment', conversationId, attachmentId }).then(data => { if (live) setUrl((data as { dataUrl: string }).dataUrl); }).catch(() => { }); }, { rootMargin: '250px' }); if (node.current) observer.observe(node.current); return () => { live = false; observer.disconnect(); }; }, [conversationId, attachmentId]);
  return <button ref={node} type="button" className="attachment-chip done is-image" onClick={onPreview}>{url ? <img src={url} alt={name} className="attachment-thumb" /> : <FileText size={16} />}<span>{name}</span></button>;
}
export function Timeline({ snapshot, onPreview, onError }: { snapshot: Snapshot; onPreview: (f: FileTarget) => void; onError: (e: string) => void }) {
  const messages = [...snapshot.messages].sort((a, b) => BigInt(a.projectionSequence) < BigInt(b.projectionSequence) ? -1 : 1);
  // 用户原话始终留在时间线上，执行片段按同一日志序号插入；不能把整个 run 挤到第一条消息后。
  return <div className="message-stack">{messages.map((message, i) => <section className="umi-exchange" key={message.id}><article id={`msg-${message.id}`} className="message user"><div className="message-attachments">{message.attachments.map(a => a.mime.startsWith('image/') ? <ImageAttachment key={a.id} conversationId={snapshot.state.cursor.streamId} attachmentId={a.id} name={a.name} onPreview={() => onPreview({ mountId: 'attachment', path: a.name, attachmentId: a.id })} /> : <button key={a.id} className="attachment-chip done" onClick={() => onPreview({ mountId: 'attachment', path: a.name, attachmentId: a.id })}><FileText size={16} /><span>{a.name}</span><small>{a.byteLength} B</small></button>)}</div><div className="message-body"><p>{message.payload.content}</p></div><MessageFooter text={message.payload.content} time={message.createdAt} onError={onError} /></article>{snapshot.state.runs[message.runId] && <Run id={message.runId} snapshot={snapshot} from={message.projectionSequence} to={messages[i + 1]?.projectionSequence ?? null} last={!messages.slice(i + 1).some(m => m.runId === message.runId)} onPreview={onPreview} onError={onError} />}</section>)}</div>;
}
