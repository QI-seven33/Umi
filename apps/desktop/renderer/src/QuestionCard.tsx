import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { QuestionRequest, Answers } from '../../../../packages/protocol/src/question.js';
import { userFacingError } from './ui-error.js';

export function QuestionCard({ id, request, conversationId, onStop }: {
  id: string; request: QuestionRequest; conversationId: string; onStop: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { optionIndex: number | null; text: string } | undefined>>(() => Object.fromEntries(request.questions.map(q => [q.id, undefined])));
  const [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), question = request.questions[index]!;
  const answered = (questionId: string) => { const answer = answers[questionId]; return Boolean(answer && (answer.optionIndex !== null || answer.text.trim())); };
  const complete = request.questions.every(q => answered(q.id));
  const submit = async () => {
    if (!complete || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    const selected: Answers = request.questions.map(q => ({ questionId: q.id, ...answers[q.id]! }));
    try { await window.umi.request({ type: 'answer_question', conversationId, questionId: id, answers: selected }); }
    catch (e) { lock.current = false; setBusy(false); setError(userFacingError(e)); }
  };
  return <section className="umi-question" aria-label="需要你的回答" aria-busy={busy}>
    <header className="umi-question-header"><span>需要你的回答{request.questions.length > 1 && <small>{index + 1} / {request.questions.length}</small>}</span><button type="button" onClick={onStop}>停止任务</button></header>
    <div className="umi-question-body"><fieldset key={question.id} disabled={busy}>
      <legend>{question.prompt}</legend>
      <div className="question-options">{question.options.map((option, optionIndex) => {
        const selected = answers[question.id]?.optionIndex === optionIndex;
        return <label key={optionIndex} className={`umi-question-option ${selected ? 'is-selected' : ''}`} title={option.description}>
          <input type="radio" name={`${id}-${question.id}`} checked={selected} onChange={() => setAnswers(value => ({ ...value, [question.id]: { optionIndex, text: option.label } }))} />
          <span>{option.label}{selected && option.description && <small>{option.description}</small>}</span>
        </label>;
      })}
      <label className={`umi-question-option ${answers[question.id]?.optionIndex === null ? 'is-selected' : ''}`}><input type="radio" name={`${id}-${question.id}`}
        checked={Boolean(answers[question.id] && answers[question.id]?.optionIndex === null)}
        onChange={() => setAnswers(value => ({ ...value, [question.id]: { optionIndex: null, text: '' } }))} /><span>自定义回答</span></label></div>
      {answers[question.id]?.optionIndex === null && <textarea autoFocus aria-label={`自定义回答：${question.prompt}`} maxLength={8000} value={answers[question.id]?.text ?? ''} rows={2}
        onChange={e => setAnswers(value => ({ ...value, [question.id]: { optionIndex: null, text: e.target.value } }))} />}
    </fieldset></div>
    {error && <p role="alert">{error}</p>}
    <div className="umi-question-actions"><div>{index > 0 && <button type="button" disabled={busy} className="question-previous" onClick={() => setIndex(index - 1)}><ChevronLeft size={14} />上一问</button>}</div>
      {index < request.questions.length - 1 ? <button type="button" disabled={!answered(question.id) || busy} onClick={() => setIndex(index + 1)}>下一问<ChevronRight size={14} /></button>
        : <button type="button" disabled={!complete || busy} onClick={() => void submit()}>{busy ? '正在提交…' : '提交回答'}</button>}
    </div>
  </section>;
}
