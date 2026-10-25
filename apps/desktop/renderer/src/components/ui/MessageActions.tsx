import { t as uiText } from '../../ui-language.js';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, MoreHorizontal, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { clockTime } from '../../activity.js';

// assistant-ui Message actions 的独立受控接入；投票只保存在本机，不发送外部反馈。
export function MessageActions({ text, time, onError, storageKey, assistant = false, onDraft }: {
  text: string; time?: string; onError: (message: string) => void; storageKey: string;
  assistant?: boolean; onDraft?: ((text: string) => void) | undefined;
}) {
  const [copied, setCopied] = useState(false), [reaction, setReaction] = useState<'up' | 'down' | null>(null), [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), mounted = useRef(false), copying = useRef(false);
  useEffect(() => { mounted.current = true; try { const saved = localStorage.getItem(storageKey); if (saved === 'up' || saved === 'down') setReaction(saved); } catch { /* 本地偏好不可用不影响会话。 */ } return () => { mounted.current = false; clearTimeout(timer.current); }; }, [storageKey]);
  useEffect(() => { if (!more) return; const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMore(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [more]);
  const copy = async () => {
    if (copying.current) return; copying.current = true;
    try { await navigator.clipboard.writeText(text); if (mounted.current) { clearTimeout(timer.current); setCopied(true); timer.current = setTimeout(() => setCopied(false), 1800); } }
    catch (e) { if (mounted.current) onError(e instanceof Error ? e.message : uiText("复制失败")); }
    finally { copying.current = false; }
  };
  const rate = (value: 'up' | 'down') => { const next = reaction === value ? null : value; setReaction(next); try { if (next) localStorage.setItem(storageKey, next); else localStorage.removeItem(storageKey); } catch { /* 非关键UI偏好。 */ } };
  return <div ref={root} className={'message-footer message-actions ' + (copied ? 'copy-confirmed' : '')} onKeyDown={event => { if (event.key === 'Escape') setMore(false); }}>
    <button type="button" className="meta-button" aria-label={copied ? uiText("已复制") : uiText("复制消息")} title={copied ? uiText("已复制") : uiText("复制消息")} onClick={() => void copy()}>{copied ? <Check size={15} className="copy-check" /> : <Copy size={15} />}</button>
    <span className="copy-feedback sr-only" role="status" aria-live="polite">{copied ? uiText("已复制") : ''}</span>
    {assistant && <>
      <button type="button" className="meta-button" aria-label={uiText("有帮助（仅本机）")} title={uiText("有帮助 · 仅保存在本机")} aria-pressed={reaction === 'up'} onClick={() => rate('up')}><ThumbsUp size={15} /></button>
      <button type="button" className="meta-button" aria-label={uiText("需要改进（仅本机）")} title={uiText("需要改进 · 仅保存在本机")} aria-pressed={reaction === 'down'} onClick={() => rate('down')}><ThumbsDown size={15} /></button>
      <button type="button" className="meta-button" aria-label={uiText("重新组织回答")} title={uiText("在输入框中准备重新回答的要求")} disabled={!onDraft} onClick={() => onDraft?.('请根据已有记录重新组织上一条回答，只调整说明，不重复执行已完成的操作；未完成的部分请如实列出。')}><RotateCcw size={15} /></button>
      <div className="message-more"><button type="button" className="meta-button" aria-label={uiText("更多消息操作")} aria-expanded={more} title={uiText("更多")} onClick={() => setMore(!more)}><MoreHorizontal size={16} /></button>{more && <div className="message-actions-menu"><button type="button" onClick={() => { void copy(); setMore(false); }}>{uiText("复制 Markdown")}</button><button type="button" disabled={!onDraft} onClick={() => { onDraft?.(text.split('\n').map(line => '> ' + line).join('\n') + '\n\n'); setMore(false); }}>{uiText("引用到输入框")}</button></div>}</div>
    </>}
    {time && <time className="message-time" dateTime={time} title={new Date(time).toLocaleString('zh-CN')}>{clockTime(time)}</time>}
  </div>;
}
