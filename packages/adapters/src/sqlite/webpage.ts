import type { WebPageArchive, WebPageSnapshot } from '../../../agent/src/tools/webpage.js';
import { webPageSchema, WEB_TEXT_LIMIT } from '../../../agent/src/tools/webpage.js';
import { hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ToolResult } from '../../../agent/src/persistence.js';
import type { SqliteStore } from './store.js';

// 独立存完整快照，工具回执只持有引用。归属沿已结算 fetch 回执关联，不扩展数据库结构。
export class WebPageRepository implements WebPageArchive {
  constructor(private readonly store: SqliteStore) {}
  private execution(executionId: string) {
    const tool = this.store.tool(executionId), run = this.store.getRun(tool.run_id);
    if (tool.name !== 'fetch_webpage' || tool.state !== 'dispatched')
      throw new UmiError('PROTOCOL_INVALID', '网页快照必须来自当前已派发抓取');
    this.store.checkLease(run.id, run.generation);
    return { tool, run };
  }
  save(executionId: string, value: WebPageSnapshot): string {
    this.execution(executionId);
    const page = webPageSchema.parse(value);
    if (Buffer.byteLength(page.content) > WEB_TEXT_LIMIT || hash(page.content) !== page.contentHash)
      throw new UmiError('PROTOCOL_INVALID', '网页快照超限或指纹不一致');
    return this.store.artifact(page, 'web-page');
  }
  cached(executionId: string, requestedUrl: string) {
    const { run } = this.execution(executionId);
    const prior = this.store.get(`SELECT a.id FROM tool_executions t JOIN artifacts a ON a.id=t.result_ref
      WHERE t.run_id=? AND t.name='fetch_webpage' AND t.state='succeeded'
      AND json_extract(a.content,'$.data.requestedUrl')=? ORDER BY t.rowid DESC LIMIT 1`,run.id,requestedUrl);
    if (!prior) return null;
    const result = this.store.readArtifact<ToolResult>(prior.id as string);
    const id = (result.data as { snapshotId?: unknown } | null)?.snapshotId;
    return typeof id === 'string' ? { snapshotId: id, page: this.read(run.conversation_id, id) } : null;
  }
  read(conversationId: string, snapshotId: string): WebPageSnapshot {
    return webPageSchema.parse(this.store.accessibleArtifact(conversationId, snapshotId));
  }
}