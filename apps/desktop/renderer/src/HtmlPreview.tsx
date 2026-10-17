import { memo, useLayoutEffect, useMemo, useRef } from 'react';

/** 响应式文档沿用实际宽度；存在固定像素宽度时才扩大独立视口并缩放。 */
export const HtmlPreview = memo(function HtmlPreview({ html, name }: { html: string; name: string }) {
  const widthHint = useMemo(() => Math.max(0, ...Array.from(html.matchAll(/(?:^|[;{\s])(?:min-)?width\s*:\s*(\d{3,4})px/gmi), match => Math.min(1920, Number(match[1])))), [html]);
  const viewport = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const node = viewport.current, iframe = frame.current; if (!node || !iframe) return;
    const fit = () => {
      const width = node.clientWidth, height = node.clientHeight; if (!width || !height) return;
      const documentWidth = Math.max(widthHint, width), scale = width / documentWidth;
      iframe.style.width = `${documentWidth}px`; iframe.style.height = `${height / scale}px`;
      iframe.style.transform = `scale(${scale})`;
    };
    fit(); const observer = new ResizeObserver(fit); observer.observe(node);
    return () => observer.disconnect();
  }, [widthHint]);
  return <div ref={viewport} className="file-html-viewport"><iframe ref={frame} className="file-html-preview" sandbox="" referrerPolicy="no-referrer" title={name} srcDoc={html} /></div>;
});
