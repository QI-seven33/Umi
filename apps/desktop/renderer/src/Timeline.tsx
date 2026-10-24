import {remarkCjkEmphasis,prepareChatMarkdown} from './remark-cjk-emphasis.js';
import {resolveFileReference} from './file-links.js';
import { MessageActions } from './components/ui/MessageActions.js';
import { InspectionSummary } from './OutputsPanel.js';
import { resourceFailureLabel } from './recovery.js';
import { userFacingError } from './ui-error.js';
import {Children,isValidElement,memo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronDown, FileText, Atom, Terminal, Search, Sparkles } from 'lucide-react';
import ReactMarkdown, {defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationState, Block } from '../../../../packages/protocol/src/reducer.js';
import { CodeBlock } from './components/ui/CodeBlock.js';
import { GenerationLoader } from './components/ui/LoadingState.js';
import type { Snapshot } from './transport.js';
import { processItems, activityLabel, toolNames, elapsedTime } from './activity.js';
import type { ActivityItem } from './activity.js';

const outcome: Record<string, string> = { prepared: '等待派发', running: '正在执行', succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', unknown: '结果未知' };
export type FileTarget = { mountId: string; path: string; changeSetId?: string; attachmentId?: string };
// 展示名称不是身份：同名附件和不同交付快照必须拥有独立预览。
export function fileTargetKey(target: FileTarget): string {
  return JSON.stringify(target.attachmentId ? ['attachment', target.attachmentId] : target.changeSetId ? ['changeset', target.changeSetId, target.path] : ['working', target.mountId, target.path]);
}
export const Markdown = memo(function Markdown({ text, mounts, onPreview }: { text: string; mounts: any[]; onPreview: (f: FileTarget) => void }) {
  const formatted=prepareChatMarkdown(text);
  return <ReactMarkdown remarkPlugins={[remarkGfm,[remarkCjkEmphasis,formatted.markers]]} urlTransform={(url,key)=>key==='href'&&resolveFileReference(url,mounts)?url:defaultUrlTransform(url)} components={{
    a: ({href,children}) => {
      const target=href?resolveFileReference(href,mounts):null;
      if(target)return <button type="button" className="inline-file-link" title={target.path} aria-label={'预览文件：'+target.path} onClick={()=>onPreview(target)}>{children}</button>;
      return href&&/^https?:\/\//i.test(href)?<a href={href} onClick={e=>{e.preventDefault();void window.umi.openUrl(href);}}>{children}</a>:<span>{children}</span>;
    },
    table:({children})=><div className="message-table-scroll"><table>{children}</table></div>,
    pre:({children})=>{
      const child=Children.toArray(children)[0];
      if(!isValidElement<{className?:string;children?:unknown}>(child))return <pre>{children}</pre>;
      const value=String(child.props.children??'').replace(/\n$/,''),lang=/language-([\w+-]+)/.exec(child.props.className??'')?.[1]??'text';
      return <CodeBlock lang={lang} codeText={value}><code>{value}</code></CodeBlock>;
    }, code: ({children}) => {
      const value=String(children);
      const target=resolveFileReference(value,mounts);
      if(target)return <button type="button" className="inline-code inline-file-link" title={target.path} aria-label={'预览文件：'+target.path} onClick={()=>onPreview(target)}>{children}</button>;
      return <code className="inline-code">{children}</code>;
    }
  }}>{formatted.text}</ReactMarkdown>;
});
function Changes({ id, conversationId, onPreview }: { id: string; conversationId: string; onPreview: (f: FileTarget) => void }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState('');
  return <details className="umi-changes" onToggle={e => { if (e.currentTarget.open && !data) void window.umi.request({ type: 'preview_changeset', conversationId, changeSetId: id }).then(setData).catch(e => setError(userFacingError(e) || '信息暂未返回，请重试。')); }}><summary><ChevronDown size={14} />文件变化与交付范围</summary>{error && <p role="alert">{error}</p>}{data?.changeSet?.changes?.map((item: any) => <button className="umi-file-row" key={item.path} onClick={() => onPreview({ mountId: data.changeSet.mountId, path: item.path, changeSetId: id })}><FileText size={14} /><span>{item.path}</span></button>)}{data && !data.changeSet?.changes?.length && <p>没有文件变化。</p>}</details>;
}
function Tool({ id, state, onPreview }: { id: string; state: ConversationState; onPreview: (f: FileTarget) => void }) {
  const t = state.tools[id]!, [summary, setSummary] = useState<any>(null), [detail, setDetail] = useState<any>(null), [error, setError] = useState(''), [open, setOpen] = useState(false), [paging, setPaging] = useState(false);
  const pageLock = useRef(false), version = useRef(0);
  useEffect(() => {
    let live = true; const ticket = ++version.current; setDetail(null); setError('');
    void window.umi.request({ type: 'tool_detail', conversationId: state.cursor.streamId, callId: id, summaryOnly: !open }).then(data => {
      if (live && ticket === version.current) { if (open) setDetail(data); setSummary(data); }
    }).catch(e => { if (live) setError(userFacingError(e) || '执行信息暂未返回，请重新展开。'); });
    return () => { live = false; };
  }, [id, state.cursor.streamId, t.status, t.resultRef, open]);
  const loadMore = async () => {
    const startByte = detail?.result?.nextStartByte, ticket = version.current;
    if (startByte == null || pageLock.current) return;
    pageLock.current = true; setPaging(true);
    try {
      const page = await window.umi.request({ type: 'tool_detail', conversationId: state.cursor.streamId, callId: id, startByte, byteLength: 64000 }) as any;
      if (ticket === version.current) setDetail((current: any) => ({ ...page, result: { ...page.result, content: current.result.content + page.result.content } }));
    } catch (e) { if (ticket === version.current) setError(userFacingError(e) || '结果暂未返回，可以重试。'); }
    finally { pageLock.current = false; setPaging(false); }
  };
  const args = summary?.arguments, path = args?.relativePath ?? args?.path, target = summary?.file;
  const hint = path ?? args?.query ?? args?.url ?? args?.find ?? args?.snapshotId ?? args?.program ?? args?.messageId ?? args?.name ?? '', Icon = t.name.startsWith('run_') ? Terminal : t.name.includes('search') || t.name === 'discover_resource' ? Search : t.name.includes('file') || t.name === 'read_attachment' ? FileText : Sparkles;
  return <div className={`umi-tool ${['failed', 'denied', 'cancelled', 'unknown'].includes(t.status) ? 'has-error' : ''}`}><button className="umi-tool-toggle" data-outcome={t.status} aria-label={`${toolNames[t.name] ?? '调用工具'}，${outcome[t.status]}`} title={outcome[t.status]} aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={14} className="umi-disclosure-icon" /><Icon size={14} /><span>{toolNames[t.name] ?? '调用工具'}</span>{!target && hint && <span className="umi-tool-hint">{String(hint)}</span>}</button>{target && <button className="umi-tool-file" onClick={() => onPreview(target)}>{String(target.path)}</button>}{open && <div className="umi-tool-detail">{error && <p role="alert">{error}</p>}{detail ? <><InspectionSummary report={detail.inspection} /><pre>{detail.result?.content ?? JSON.stringify(detail.arguments, null, 2)}</pre>{detail.result?.truncated && <button type="button" disabled={paging} className="umi-history-load" onClick={() => void loadMore()}>{paging ? '正在读取…' : '继续显示工具结果'}</button>}</> : <span>正在读取执行信息…</span>}</div>}</div>;
}
const Reasoning = memo(function Reasoning({ block, compact = false, running = false }: { block: Block; compact?: boolean; running?: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className={compact ? 'umi-reasoning-row' : 'message-reasoning'} data-turn-id={block.turnId} data-attempt-id={block.attemptId} title={block.status === 'interrupted' ? '该段思考已中断，已生成内容保留' : undefined} onToggle={e => setOpen(e.currentTarget.open)}><summary>{compact ? <><ChevronDown size={14} className="umi-disclosure-icon" /><Atom size={14} /><span>思考</span><span className="umi-reasoning-excerpt">{block.text.slice(0, 256).trim().replace(/\s+/g, ' ') || '正在生成思考内容'}</span></> : running ? <GenerationLoader compact label="正在思考" /> : <><ChevronDown size={14} />思考过程</>}</summary>{open && <div className="message-reasoning-content">{block.text}</div>}</details>;
});
function Activity({ items, state, onPreview }: { items: ActivityItem[]; state: ConversationState; onPreview: (f: FileTarget) => void }) {
  const [open, setOpen] = useState(false), label = activityLabel(items, state), active = label.startsWith('正在');
  return <section className="umi-activity-group"><button className="umi-activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{active ? <GenerationLoader compact label="" /> : <ChevronDown size={14} className={open ? 'is-open' : ''} />}<span>{label}</span></button>{open && <div className="umi-activity-list">{items.map(item => item.kind === 'tool' ? <Tool key={item.id} id={item.id} state={state} onPreview={onPreview} /> : item.kind === 'tool-draft' ? <p key={item.block.id} className="umi-recovery">{item.block.status === 'running' && state.attempts[item.block.attemptId]?.status === 'running' ? '正在生成工具请求，尚未执行' : '工具请求未完成，未执行'}（{item.block.text.length.toLocaleString()} 字符）</p> : <Reasoning key={item.block.id} block={item.block} compact />)}</div>}</section>;
}
function Run({ id, snapshot, onPreview, onError, from, to, last, onDraft }: { id: string; snapshot: Snapshot; onPreview: (f: FileTarget) => void; onError: (e: string) => void; from: string; to: string | null; last: boolean; onDraft?: ((text: string) => void) | undefined }) {
  const state = snapshot.state, r = state.runs[id]!, [expanded, setExpanded] = useState(false);
  const within = (sequence: string) => BigInt(sequence) > BigInt(from) && (to === null || BigInt(sequence) < BigInt(to));
  const blocks = state.blocks.filter(b => b.runId === id && within(b.sequence)), final = blocks.filter(b => b.kind === 'text' && b.displayRole === 'final'), process = processItems(state, id, from, to);
  const tools = Object.entries(state.tools).filter(([, t]) => t.runId === id && within(t.sequence));
  const pending = last ? Object.entries(state.approvals).filter(([, a]) => a.status === 'pending' && state.tools[a.callId]?.runId === id) : [];
  const running = ['queued', 'running', 'recovering', 'stopping'].includes(r.status), complete = r.status === 'completed', mounts = snapshot.resources?.mounts ?? [];
  const notices = (r.failureSummaries ?? (r.failureSummary ? [r.failureSummary] : [])).filter(n => within(n.sequence));
  const hasNotice = notices.length > 0;
  const budget = snapshot.context.latestRun?.runId === id ? snapshot.context.latestRun.outputBudget : undefined;
  const renderBlock = (b: Block) => b.kind === 'reasoning' ? <Reasoning key={b.id} block={b} running={b.status === 'running' && r.status === 'running'} /> : <div key={b.id} className="message-body"><Markdown text={b.text} mounts={mounts} onPreview={onPreview} />{b.status === 'interrupted' && <small>此段响应中断，尚未形成完整消息。</small>}</div>;
  if (!last && !blocks.length && !tools.length) return null;
  return <article className="message assistant" data-run-id={id}>
    {(process.length > 0 || running || pending.length > 0) && <div className="umi-process"><button className="umi-process-toggle" aria-expanded={!complete || expanded} onClick={() => setExpanded(!expanded)}><span>{complete ? `本轮结束${elapsedTime(r.startedAt, r.finishedAt) ? `，用时 ${elapsedTime(r.startedAt, r.finishedAt)}` : ''}` : Object.values(state.questions ?? {}).some(q => q.runId === id && q.status === 'pending') ? '等待你的回答' : r.status === 'waiting_permission' ? '等待你的批准' : r.budgetBlock ? '上下文预算阻塞' : r.status === 'interrupted' ? '执行中断' : r.status === 'stopped' ? '已停止' : r.status === 'failed' ? '执行受阻' : r.status === 'recovery_required' ? '需要核验原操作' : '执行中'}</span><ChevronDown size={14} /></button>
      {(!complete || expanded) && <div className="umi-process-content">{process.map(item => item.kind === 'text' ? renderBlock(item.block) : <Activity key={item.id} items={item.items} state={state} onPreview={onPreview} />)}{running && !blocks.length && !Object.values(state.questions ?? {}).some(q => q.runId === id && q.status === 'pending') && <GenerationLoader compact label="正在准备" />}</div>}
    </div>}

    {last && snapshot.resources?.resourceFailures?.length>0 && <details className="umi-changes"><summary><ChevronDown size={14}/>资源物化结果</summary>{snapshot.resources.resourceFailures.map((f:any)=><p key={f.resourceId}>{resourceFailureLabel(f)}</p>)}</details>}
    {last && Object.entries(state.tools).filter(([,t])=>t.runId===id&&t.name==='request_resource'&&t.verification).map(([callId,t])=><p className="umi-recovery" role="status" key={callId}>{t.status==='succeeded'?'原资源挂载已核验，没有重新复制。':t.status==='failed'?'原资源物化未完成，保留原副本，没有重新复制。':'原资源效果仍未知，需要继续检查。'}</p>)}
    {last && r.budgetBlock && <section className="umi-budget" role="status"><strong>上下文预算阻塞</strong><p>{r.reason}</p><p>保守估算 {r.budgetBlock.estimatedInputTokens.toLocaleString()}，输入预算 {r.budgetBlock.inputCeiling.toLocaleString()}。用户原文仍完整保存。</p><small>直接恢复不会减少上下文。可在设置中调整有效预算；达到模型上限后仍不能容纳时，需要后续有预算的原文投影。</small></section>}
    {last && r.status === 'interrupted' && !r.budgetBlock && !hasNotice && r.reason && <p className="umi-recovery" role="status">{r.reason}</p>}
    {last && !hasNotice && ['interrupted', 'stopped', 'recovery_required'].includes(r.status) && <p className="umi-recovery">可以直接发消息继续、修改要求或开始其他任务。</p>}
    {last && Object.keys(state.changesets).filter(cs => state.changesets[cs]?.runId === id).map(cs => <Changes key={cs} id={cs} conversationId={state.cursor.streamId} onPreview={onPreview} />)}
    {last && budget?.limit != null && <p className="umi-recovery" role="status">本轮输出预算：{budget.used.toLocaleString()} / {budget.limit.toLocaleString()} token{budget.missing > 0 ? "，另有用量未返回" : ""}（含思考与上下文维护，恢复不清零）</p>}
    {notices.map(n => <div key={n.messageId} className="message-body" data-run-notice={n.messageId}><small>Umi 执行说明</small><Markdown text={n.text} mounts={mounts} onPreview={onPreview} /></div>)}
    {final.map(renderBlock)}
    {complete && final.length > 0 && <MessageActions assistant onDraft={onDraft} storageKey={`umi.feedback.${state.cursor.streamId}.${r.finalMessageId ?? id}`} text={final.map(b => b.text).join('\n\n')} {...(r.finishedAt ? { time: r.finishedAt } : {})} onError={onError} />}
    {last && r.status === 'failed' && !hasNotice && final.length === 0 && <p role="alert">{r.reason ?? '任务失败，原始记录仍保留。'}</p>}
  </article>;
}
function ImageAttachment({ conversationId, attachmentId, name, onPreview }: { conversationId: string; attachmentId: string; name: string; onPreview: () => void }) {
  const [url, setUrl] = useState(''), node = useRef<HTMLButtonElement>(null);
  useEffect(() => { let live = true; const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect(); void window.umi.request({ type: 'preview_attachment', conversationId, attachmentId }).then(data => { if (live) setUrl((data as { dataUrl: string }).dataUrl); }).catch(() => { }); }, { rootMargin: '250px' }); if (node.current) observer.observe(node.current); return () => { live = false; observer.disconnect(); }; }, [conversationId, attachmentId]);
  return <button ref={node} data-attachment-id={attachmentId} type="button" className="attachment-chip done is-image" onClick={onPreview}>{url ? <img src={url} alt={name} className="attachment-thumb" /> : <FileText size={16} />}<span>{name}</span></button>;
}
/** 只减少首屏 DOM/Markdown 工作；完整消息仍在快照和模型历史中。 */
export function timelineWindow(snapshot: Snapshot, count = 8, targetId?: string) {
  const all = [...snapshot.messages].sort((a, b) => BigInt(a.projectionSequence) < BigInt(b.projectionSequence) ? -1 : 1);
  const targetIndex = targetId ? all.findIndex(message => message.id === targetId) : -1;
  const visibleCount = Math.max(count, targetIndex < 0 ? 0 : all.length - targetIndex);
  const hiddenCount = Math.max(0, all.length - visibleCount);
  return { messages: all.slice(hiddenCount), hiddenCount };
}
export function Timeline({ snapshot, onPreview, onError, navigationTarget, onDraft }: { snapshot: Snapshot; onPreview: (f: FileTarget) => void; onError: (e: string) => void; navigationTarget?: { id: string } | null; onDraft?: ((text: string) => void) | undefined }) {
  const [count, setCount] = useState(8);
  const firstVisible = useRef<string | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const previousIndex = snapshot.messages.findIndex(message => message.id === firstVisible.current);
  const retainedCount = previousIndex < 0 ? count : Math.max(count, snapshot.messages.length - previousIndex);
  const { messages, hiddenCount } = timelineWindow(snapshot, retainedCount, navigationTarget?.id);
  useLayoutEffect(() => { firstVisible.current = messages[0]?.id ?? null; });
  useLayoutEffect(() => {
    const saved = anchor.current;
    if (!saved) return;
    anchor.current = null;
    const element = document.getElementById(saved.id);
    const canvas = element?.closest<HTMLElement>('.chat-canvas');
    if (element && canvas) canvas.scrollTop += element.getBoundingClientRect().top - saved.top;
  }, [hiddenCount]);
  useLayoutEffect(() => {
    if (!navigationTarget) return;
    const element = document.getElementById('msg-' + navigationTarget.id);
    const canvas = element?.closest<HTMLElement>('.chat-canvas');
    if (element && canvas) canvas.scrollTo({ top: canvas.scrollTop + element.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 24, behavior: 'smooth' });
  }, [navigationTarget]);
  const loadEarlier = () => {
    const element = document.getElementById('msg-' + messages[0]?.id);
    if (element) anchor.current = { id: element.id, top: element.getBoundingClientRect().top };
    setCount(messages.length + 8);
  };
  // 用户原话始终留在时间线上，执行片段按同一日志序号插入；不能把整个 run 挤到第一条消息后。
  return <div className="message-stack">{hiddenCount > 0 && <button type="button" className="umi-history-load" onClick={loadEarlier}>查看更早的消息（{hiddenCount}）</button>}{messages.map((message, i) => <section className="umi-exchange" key={message.id}><article id={`msg-${message.id}`} className="message user"><div className="message-attachments">{message.attachments.map(a => a.mime.startsWith('image/') ? <ImageAttachment key={a.id} conversationId={snapshot.state.cursor.streamId} attachmentId={a.id} name={a.name} onPreview={() => onPreview({ mountId: 'attachment', path: a.name, attachmentId: a.id })} /> : <button key={a.id} data-attachment-id={a.id} className="attachment-chip done" onClick={() => onPreview({ mountId: 'attachment', path: a.name, attachmentId: a.id })}><FileText size={16} /><span>{a.name}</span><small>{a.byteLength} B</small></button>)}</div><div className="message-body"><p>{message.payload.content}</p></div><MessageActions storageKey={`umi.feedback.${snapshot.state.cursor.streamId}.${message.id}`} text={message.payload.content} time={message.createdAt} onError={onError} /></article>{snapshot.state.runs[message.runId] && <Run id={message.runId} snapshot={snapshot} from={message.projectionSequence} to={messages[i + 1]?.projectionSequence ?? null} last={!messages.slice(i + 1).some(m => m.runId === message.runId)} onDraft={onDraft} onPreview={onPreview} onError={onError} />}</section>)}</div>;
}
