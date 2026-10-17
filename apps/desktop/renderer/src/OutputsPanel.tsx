import { userFacingError } from './ui-error.js';
import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import type { ConversationState } from '../../../../packages/protocol/src/reducer.js';
import type {
  OutputDescriptor,
  ExportReceipt,
} from '../../../../packages/protocol/src/outputs.js';

export type InspectionReport = {
  status: string;
  root: string;
  issues: { code: string; message: string }[];
  instruction: string;
};
type OutputPage = {
  entries: OutputDescriptor[];
  total: number;
  offset: number;
  nextOffset: number | null;
};
type Preview = OutputDescriptor & {
  kind: 'text' | 'binary';
  text?: string;
  message?: string;
  startByte: number;
  endByte: number;
  truncated: boolean;
};
const errorText = (e: unknown) => userFacingError(e) || '操作回执暂未返回，请查看会话状态。';
export const exportRequest = (outputId: string, target: string) =>
  `请使用 export_outputs 导出这份已生成成果，目标文件已由我选择：\n${JSON.stringify({ items: [{ outputId, target }] }, null, 2)}\n请按原批准流程执行；目标已有文件时停止，不覆盖。`;
const receiptLabels: Record<ExportReceipt['status'], string> = {
  written: '已写入并核验',
  verified: '当前目标已核验',
  conflict: '目标冲突',
  not_started: '未开始',
  unknown: '无法确认',
};

export function InspectionSummary({
  report,
}: {
  report: InspectionReport | null | undefined;
}) {
  if (!report) return null;
  return (
    <section className="umi-inspection" aria-label="执行准备检查">
      <small>最近一次准备检查 · 历史观察，执行前仍需复查</small>
      <br />
      <strong>
        {report.status === 'observed' ? '已完成只读观察' : '准备条件需要处理'}
      </strong>
      <p>{report.root}</p>
      {report.issues.map((i, index) => (
        <p key={index}>{i.message}</p>
      ))}
      <small>{report.instruction}</small>
    </section>
  );
}

function ExportRecord({
  conversationId,
  executionId,
  status,
}: {
  conversationId: string;
  executionId: string;
  status: string;
}) {
  const [receipts, setReceipts] = useState<ExportReceipt[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const inspect = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = (await window.umi.request({
        type: 'inspect_export',
        conversationId,
        executionId,
      })) as { data: { receipts: ExportReceipt[] } };
      if (live.current) setReceipts(result.data.receipts);
    } catch (e) {
      if (live.current) {
        setReceipts(null);
        setError(errorText(e));
      }
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <details
      className="umi-export-record"
      onToggle={(e) => {
        if (e.currentTarget.open && !receipts) void inspect();
      }}
    >
      <summary>
        导出记录 ·{' '}
        {status === 'succeeded'
          ? '原执行完成'
          : status === 'unknown'
            ? '原执行结果未知'
            : status === 'denied'
              ? '原执行已拒绝'
              : '查看执行结果'}
      </summary>
      <small>核验只观察原目标，不会重试写入。以下是本次观察结果。</small>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void inspect()}>
        {busy ? '正在核验…' : '重新核验原目标'}
      </button>
      {receipts?.map((r, index) => (
        <div key={index} className="umi-export-target">
          <p>
            {r.target}
            <br />
            <strong>{receiptLabels[r.status]}</strong>
            {r.reason && (
              <>
                <br />
                {r.reason}
              </>
            )}
          </p>
          {['written', 'verified'].includes(r.status) && (
            <button
              type="button"
              onClick={() => {
                void window.umi
                  .request({ type: 'open_export', conversationId, executionId, index })
                  .catch((e) => {
                    if (live.current) {
                      setReceipts(null);
                      setError(errorText(e));
                    }
                  });
              }}
            >
              打开文件位置
            </button>
          )}
        </div>
      ))}
    </details>
  );
}

export function OutputsPanel({
  conversationId,
  state,
  onDraft,
}: {
  conversationId: string;
  state: ConversationState | null;
  onDraft: (text: string) => void;
}) {
  const [page, setPage] = useState<OutputPage | null>(null),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [previewError, setPreviewError] = useState(''),
    [previewBusy, setPreviewBusy] = useState(false),
    [choosing, setChoosing] = useState(false),
    [notice, setNotice] = useState('');
  const [report, setReport] = useState<InspectionReport | null>(null);
  const generation = useRef(0),
    previewGeneration = useRef(0),
    live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      previewGeneration.current++;
    };
  }, []);
  const tools = Object.entries(state?.tools ?? {});
  // 正文增量不触发列表扫描；只随成果执行状态变化刷新元数据。
  const version = tools
    .filter(([, t]) => ['create_output', 'capture_output'].includes(t.name))
    .map(([id, t]) => `${id}:${t.status}`)
    .join('|');
  const inspection = tools
    .filter(([, t]) => t.name === 'inspect_execution' && t.status === 'succeeded')
    .sort((a, b) => (BigInt(a[1].sequence) > BigInt(b[1].sequence) ? -1 : 1))[0]?.[0];
  useEffect(() => {
    let current = true;
    setReport(null);
    if (inspection)
      void window.umi
        .request({ type: 'tool_detail', conversationId, callId: inspection })
        .then((d) => {
          if (current)
            setReport((d as { inspection: InspectionReport | null }).inspection);
        })
        .catch((e) => {
          if (current) setError(errorText(e));
        });
    return () => {
      current = false;
    };
  }, [conversationId, inspection]);
  useEffect(() => {
    if (!conversationId) return;
    const ticket = ++generation.current;
    setLoading(true);
    setError('');
    setPage(null);
    void window.umi
      .request({ type: 'list_outputs', conversationId, offset, limit: 10 })
      .then((d) => {
        if (generation.current === ticket) setPage(d as OutputPage);
      })
      .catch((e) => {
        if (generation.current === ticket) setError(errorText(e));
      })
      .finally(() => {
        if (generation.current === ticket) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [conversationId, offset, refresh, version]);
  const read = async (outputId: string, startByte = 0) => {
    const ticket = ++previewGeneration.current;
    setPreviewBusy(true);
    setPreview(null);
    setPreviewError('');
    try {
      const d = await window.umi.request({
        type: 'preview_output',
        conversationId,
        outputId,
        startByte,
        byteLength: 64000,
      });
      if (ticket === previewGeneration.current) setPreview(d as Preview);
    } catch (e) {
      if (ticket === previewGeneration.current) setPreviewError(errorText(e));
    } finally {
      if (ticket === previewGeneration.current) setPreviewBusy(false);
    }
  };
  const choose = async (id: string) => {
    if (choosing) return;
    setChoosing(true);
    setNotice('');
    setError('');
    try {
      const selected = await window.umi.chooseOutputTarget(conversationId, id);
      if (live.current && selected) {
        onDraft(exportRequest(id, selected.target));
        setNotice('导出请求已放入输入框。发送后确认具体范围。');
      }
    } catch (e) {
      if (live.current) setError(errorText(e));
    } finally {
      if (live.current) setChoosing(false);
    }
  };
  if (!conversationId)
    return (
      <section className="umi-outputs">
        <h3>任务成果</h3>
        <p>选择工作区并开始对话后，成果会显示在这里。</p>
      </section>
    );
  const exports = tools
    .filter(
      ([, t]) =>
        t.name === 'export_outputs' &&
        t.executionId &&
        !['prepared', 'running'].includes(t.status),
    )
    .sort((a, b) => (BigInt(a[1].sequence) > BigInt(b[1].sequence) ? -1 : 1))
    .slice(0, 10);
  return (
    <section className="umi-outputs" aria-label="任务成果">
      <header>
        <h3>任务成果{page ? ` · ${page.total}` : ''}</h3>
        <button
          type="button"
          aria-label="刷新成果"
          disabled={loading}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      <p>生成的文件与交付记录</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">正在读取成果列表…</p>}
      {page && !page.entries.length && (
        <p>暂无成果。任务生成的文件会显示在这里。</p>
      )}
      <ul className="umi-output-list">
        {page?.entries.map((d) => (
          <li key={d.outputId}>
            <button
              type="button"
              className="umi-output-name"
              onClick={() => void read(d.outputId)}
            >
              <FileText size={14} /> {d.name}
            </button>
            <small title={d.outputId}>
              {d.size.toLocaleString()} 字节 · {d.mime}
              <br />
              内容摘要 {d.hash.slice(0, 12)}
            </small>
            <div className="umi-output-actions">
              <button
                type="button"
                disabled={choosing}
                onClick={() => void choose(d.outputId)}
              >
                请求导出
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="umi-output-actions">
        <button
          type="button"
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 10))}
        >
          上一页
        </button>
        <small>
          {page
            ? `${page.offset + 1 > page.total ? 0 : page.offset + 1}–${page.offset + page.entries.length} / ${page.total}`
            : ''}
        </small>
        <button
          type="button"
          disabled={loading || page?.nextOffset == null}
          onClick={() => {
            if (page?.nextOffset != null) setOffset(page.nextOffset);
          }}
        >
          下一页
        </button>
      </div>
      {previewBusy && <p role="status">正在核验并读取成果…</p>}
      {previewError && <p role="alert">{previewError}</p>}
      {preview && (
        <section aria-label="成果预览">
          <h4>{preview.name}</h4>
          {preview.kind === 'text' ? (
            <pre className="umi-output-preview">{preview.text}</pre>
          ) : (
            <p>{preview.message}</p>
          )}
          <small>
            已核验完整成果，当前显示字节 {preview.startByte}–{preview.endByte}。
          </small>
          {preview.kind === 'text' && preview.truncated && (
            <div className="umi-output-actions">
              <small>预览按段读取，原成果完整保留。</small>
              <button
                type="button"
                onClick={() => void read(preview.outputId, preview.endByte)}
              >
                读取下一段
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              previewGeneration.current++;
              setPreview(null);
            }}
          >
            关闭预览
          </button>
        </section>
      )}
      {!!exports.length && (
        <>
          <h4>最近的导出记录</h4>
          {exports.map(([id, t]) => (
            <ExportRecord
              key={id}
              conversationId={conversationId}
              executionId={t.executionId!}
              status={t.status}
            />
          ))}
        </>
      )}
      <InspectionSummary report={report} />
    </section>
  );
}
