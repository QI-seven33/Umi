import { t as uiText } from '../../ui-language.js';
import type { ReactNode } from 'react';

type Line = { kind: 'context' | 'added' | 'removed'; text: string };
export function diffLines(text: string): Line[] {
  return text.split('\n').filter(line => !/^(--- 修改前|\+\+\+ 修改后|@@ )/.test(line)).map(line => ({
    kind: line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context',
    text: /^[ +\-]/.test(line) ? line.slice(1) : line,
  }));
}
// Props 驱动的独立视图，参照 assistant-ui Code diff；正文仍来自原冻结分页接口。
export function CodeDiff({ filename, text, diff = false, incomplete = false, toolbar }: {
  filename: string; text: string; diff?: boolean; incomplete?: boolean; toolbar?: ReactNode;
}) {
  const lines = diff ? diffLines(text) : text.split('\n').map(value => ({ kind: 'context' as const, text: value }));
  const added = lines.filter(line => line.kind === 'added').length, removed = lines.filter(line => line.kind === 'removed').length;
  return <section className="code-diff" aria-label={diff ? uiText("文件变化对照") : uiText("文件内容")}>
    <header className="code-diff-header"><span title={filename}>{filename}</span>{diff && <div className="code-diff-counts" title={incomplete ? uiText("当前已加载范围的增删行数") : uiText("增删行数")}><span className="diff-added">+{added}</span><span className="diff-removed">−{removed}</span>{incomplete && <small>{uiText("已加载")}</small>}</div>}{toolbar}</header>
    <div className="code-diff-lines" tabIndex={0}>{lines.map((line, i) => <div className={`code-diff-line is-${line.kind}`} key={i}><span className="diff-gutter" aria-hidden="true">{diff ? line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : '' : i + 1}</span><code>{line.text || '\u00a0'}</code></div>)}</div>
  </section>;
}
