import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { HtmlPreview } from './HtmlPreview.js';
import { fileFormat } from './file-format.js';
import type { PreviewMode } from './PreviewToolbar.js';

function Syntax({ text, language }: { text: string; language?: string | undefined }) {
  const markup = useMemo(() => language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : null, [text, language]);
  // highlight.js 转义原文后产生 span，不把原始代码当作 HTML 插入宿主页面。
  return <pre className="file-code"><code className={markup ? 'hljs' : undefined} {...(markup ? { dangerouslySetInnerHTML: { __html: markup } } : { children: text })} /></pre>;
}
function htmlDocument(text: string) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach(node => node.remove());
  doc.querySelectorAll('*').forEach(node => { for (const attr of [...node.attributes]) if (/^on|^(href|xlink:href|srcset|action|formaction|target)$/i.test(attr.name)) node.removeAttribute(attr.name); });
  // 双重约束：无脚本、无同源权限的 iframe，内容 CSP 仅允许内联样式和内嵌图片。
  const meta = doc.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"; doc.head.prepend(meta);
  const style = doc.createElement('style'); style.textContent = 'html{overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#a1a1aa55 transparent}body{overflow-wrap:anywhere}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}img,svg,video{max-width:100%;height:auto}table{max-width:100%;table-layout:fixed}*{box-sizing:border-box}'; doc.head.append(style);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
export function FileContent({ path, text, dataUrl, unsupported, mode, busy, error, hasMore, onMore }: {
  path: string; text: string; dataUrl?: string | undefined; unsupported?: boolean | undefined; mode: PreviewMode;
  busy: boolean; error: string; hasMore: boolean; onMore: () => Promise<void>;
}) {
  const format = fileFormat(path), root = useRef<HTMLDivElement>(null), end = useRef<HTMLDivElement>(null), [linkError, setLinkError] = useState('');
  const html = useMemo(() => format.kind === 'html' && mode === 'preview' ? htmlDocument(text) : '', [text, mode, format.kind]);
  useEffect(() => {
    if (!hasMore || busy || error || !root.current || !end.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void onMore(); }, { root: root.current, rootMargin: '160px 0px' });
    observer.observe(end.current); return () => observer.disconnect();
  }, [text, hasMore, busy, error, onMore]);
  return <div ref={root} className="file-preview-scroll" data-mode={mode} data-format={format.kind} aria-busy={busy}>
    {error && <p className="file-preview-error" role="alert">{error}</p>}
    {unsupported ? <p className="file-preview-unsupported">此格式暂不支持内置预览</p>
      : dataUrl ? mode === 'preview' ? <img className="file-preview-image" src={dataUrl} alt={format.name} /> : <p className="file-preview-unsupported">图片没有文本原文</p>
      : mode === 'source' ? <Syntax text={text} language={format.language} />
      : format.kind === 'markdown' ? <article className="file-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        pre: ({ children }) => <div className="file-markdown-code">{children}</div>,
        code: ({ children, className }) => className?.startsWith('language-') || String(children).includes('\n') ? <Syntax text={String(children).replace(/\n$/, '')} language={className?.replace('language-', '')} /> : <code>{children}</code>,
        a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.umi.openUrl(href).catch(() => setLinkError('链接暂未打开')); }}>{children}</a>,
        img: ({ src, alt }) => typeof src === 'string' && src.startsWith('data:image/') ? <img src={src} alt={alt ?? ''} /> : <span className="file-image-label">{alt || '图片'}</span>,
      }}>{text}</ReactMarkdown></article>
      : format.kind === 'html' ? <HtmlPreview html={html} name={format.name} />
      : <Syntax text={text} language={format.language} />}
    {linkError && <p className="file-preview-error" role="status">{linkError}</p>}
    <div ref={end} className="file-preview-end" aria-hidden="true" />
  </div>;
}
