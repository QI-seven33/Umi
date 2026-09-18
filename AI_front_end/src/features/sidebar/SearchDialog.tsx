import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Search, X } from "lucide-react";

import { API_BASE } from "../../utils/constants";
import { formatSearchTime, toMillis } from "../../utils/time";

// ─────────────────────────────────────────────────────────────
// 搜索弹层
// ─────────────────────────────────────────────────────────────

type SearchResult = {
  thread_id: string;
  title: string;
  pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export function SearchDialog({
  open, workspaceId, onClose, onSelectConversation,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onSelectConversation: (threadId: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);

  const fetchResults = useCallback(async (q: string) => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/chat/threads/search?workspace_id=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(q)}`
      );
      const json = await res.json();
      if (myReq === reqIdRef.current) {
        setResults(json.data?.threads ?? []);
      }
    } catch { /* silent */ }
    finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setResults([]);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    void fetchResults("");
    return () => window.clearTimeout(t);
  }, [open, fetchResults]);

  useEffect(() => {
    if (open) return;
    setKeyword("");
    setResults([]);
    setLoading(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void fetchResults(keyword); }, 300);
    return () => window.clearTimeout(timer);
  }, [keyword, open, fetchResults]);

  if (!open) return null;

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <Search size={18} className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="搜索会话"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <button
            type="button"
            className="search-close"
            onClick={onClose}
            aria-label="关闭搜索"
          >
            <X size={18} />
          </button>
        </div>

        <div className="search-results">
          {loading && results.length === 0 && (
            <div className="search-status">搜索中…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="search-status">
              {keyword ? "没有找到匹配的会话" : "暂无会话"}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.thread_id}
              type="button"
              className="search-result-item"
              onClick={() => {
                onSelectConversation(r.thread_id);
                onClose();
              }}
            >
              <span className="search-result-icon" aria-hidden="true">
                <MessageSquarePlus size={16} />
              </span>
              <span className="search-result-title">{r.title}</span>
              <span className="search-result-time">
                {formatSearchTime(toMillis(r.updated_at))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
