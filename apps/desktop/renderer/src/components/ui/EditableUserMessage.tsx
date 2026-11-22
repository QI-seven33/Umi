import { Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t as uiText, useUiLanguage } from '../../ui-language.js';
import type { UserRow } from '../../transport.js';
import type { DesktopInput } from '../../../../../../packages/protocol/src/desktop.js';
import { MessageActions } from './MessageActions.js';

type EditRequest = Extract<DesktopInput, { type: 'edit_message' }>;
export function EditableUserMessage({ message, conversationId, lastMessageId, onError }: {
  message: UserRow; conversationId: string; lastMessageId: string; onError: (text: string) => void;
}) {
  useUiLanguage();
  const [editing, setEditing] = useState(false), [text, setText] = useState(message.payload.content);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), mounted = useRef(false), baseLast = useRef(lastMessageId);
  const pending = useRef<EditRequest | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const begin = () => { baseLast.current = lastMessageId; setText(message.payload.content); setError(''); pending.current = null; setEditing(true); };
  const submit = async () => {
    if (lock.current || !text.trim() || (!pending.current && text === message.payload.content)) return;
    lock.current = true; setBusy(true); setError('');
    const request = pending.current ??= { type: 'edit_message', conversationId, commandId: crypto.randomUUID(),
      targetMessageId: message.id, expectedLastMessageId: baseLast.current, text };
    try {
      // 超时重试继续查询同一命令回执；不依据变化中的草稿重复创建任务。
      const receipt = await window.umi.request({ type: 'receipt', conversationId, commandId: request.commandId });
      if (!receipt) await window.umi.request(request);
      pending.current = null;
      if (mounted.current) setEditing(false);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : uiText('提交失败，请重试'));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <>
    {editing ? <form className="umi-message-editor" aria-label={uiText('编辑消息')} aria-busy={busy}
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea autoFocus aria-label={uiText('修改消息内容')} value={text} maxLength={2_000_000}
        disabled={busy || Boolean(pending.current)} onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape' && !busy) { event.preventDefault(); setEditing(false); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
        }} />
      {error && <p className="umi-message-edit-error" role="alert">{error}</p>}
      <div className="umi-message-edit-footer">
      <p className="umi-message-edit-note"><Info size={14} aria-hidden="true" /><span>{uiText('后续对话将被替换；已有文件和命令效果保留。')}</span></p>
      <div className="umi-message-edit-actions">
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>{uiText('取消')}</button>
        <button type="submit" className="is-primary" disabled={busy || !text.trim() || (!pending.current && text === message.payload.content)}>
          {busy ? uiText('正在提交…') : pending.current ? uiText('重试提交') : uiText('重新发送')}
        </button>
      </div>
      </div>
    </form> : <div className="message-body"><p>{message.payload.content}</p></div>}
    <MessageActions storageKey={`umi.feedback.${conversationId}.${message.id}`} text={message.payload.content}
      time={message.createdAt} onError={onError} onEdit={editing ? undefined : begin} />
  </>;
}
