import { useState } from "react";
import { Check, Copy } from "lucide-react";

// ─────────────────────────────────────────────────────────────
// 代码块
// ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="code-action-btn"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label="复制代码"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span>{copied ? "已复制" : "复制"}</span>
    </button>
  );
}

function DownloadButton({ text, lang }: { text: string; lang: string }) {
  return (
    <button
      type="button"
      className="code-action-btn"
      onClick={() => {
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `code.${lang || "txt"}`;
        a.click();
        URL.revokeObjectURL(url);
      }}
      aria-label="下载代码"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>下载</span>
    </button>
  );
}

export function CodeBlock({ lang, codeText, className, children }: any) {
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span className="code-lang">{lang || "text"}</span>
        <div className="code-actions">
          <CopyButton text={codeText} />
          <DownloadButton text={codeText} lang={lang} />
        </div>
      </div>
      <pre className="code-block">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}
