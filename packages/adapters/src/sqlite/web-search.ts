import type { WebSearchArchive, SearchSnapshot } from '../../../agent/src/tools/web-search.js';
import { searchSnapshotSchema, SEARCH_ARCHIVE_BYTES } from '../../../agent/src/tools/web-search.js';
import { canonical } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { SqliteStore } from './store.js';
export class WebSearchRepository implements WebSearchArchive {
  constructor(private readonly store: SqliteStore) {}
  save(executionId: string, value: SearchSnapshot): string {
    const tool = this.store.tool(executionId), run = this.store.getRun(tool.run_id);
    if (tool.name !== 'search_web' || tool.state !== 'dispatched')
      throw new UmiError('PROTOCOL_INVALID', '搜索快照必须来自当前已派发搜索');
    this.store.checkLease(run.id, run.generation);
    const snapshot = searchSnapshotSchema.parse(value);
    if (Buffer.byteLength(canonical(snapshot)) > SEARCH_ARCHIVE_BYTES)
      throw new UmiError('WEB_SEARCH_TOO_LARGE', '完整搜索回执超过 4 MiB，未建立快照');
    return this.store.artifact(snapshot, 'web-search');
  }
}
