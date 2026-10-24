import { EventBlocks } from './event-blocks.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import type { DatabaseSync } from 'node:sqlite';
import { initialState, type ConversationState } from '../../../protocol/src/reducer.js';

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
let revision: string | undefined;
function projectionRevision() {
  if (revision) return revision;
  // 协议（含事件子Schema）、归约或缓存格式构建变化即失效，不替代迁移指纹。
  const directory = new URL('../../../protocol/src/', import.meta.url);
  const hash = createHash('sha256').update('umi-projection-cache-1').update(readFileSync(new URL(import.meta.url)));
  for (const name of readdirSync(directory).filter(name => name.endsWith('.js')).sort())
    hash.update(name).update(readFileSync(new URL(name, directory)));
  return revision = hash.digest('hex');
}

/** 可整表删除后重建；写入失败不改变业务提交的成败。 */
export class ConversationProjectionCache {
  private readonly saved = new Map<string, { sequence: string; bytes: number }>();
  private readonly version: string;
  constructor(private readonly db: DatabaseSync) {
    this.version = projectionRevision();
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_projections(
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      version TEXT NOT NULL,log_epoch TEXT NOT NULL,sequence TEXT NOT NULL,
      event_id TEXT NOT NULL,state_hash TEXT NOT NULL,state BLOB NOT NULL)`);
  }
  load(id: string, epoch: string, nextSequence: string): ConversationState | undefined {
    try {
      const row = this.db.prepare('SELECT * FROM conversation_projections WHERE conversation_id=?').get(id);
      if (!row || row.version !== this.version || row.log_epoch !== epoch ||
          typeof row.sequence !== 'string' || !/^[1-9][0-9]*$/.test(row.sequence) ||
          BigInt(row.sequence) >= BigInt(nextSequence) || !(row.state instanceof Uint8Array) ||
          digest(row.state) !== row.state_hash) return;
      const event = new EventBlocks(this.db).at(id,epoch,row.sequence);
      if (!event || event.eventId !== row.event_id) return;
      const state = deserialize(row.state) as ConversationState;
      if (!state || state.cursor?.streamId !== id || state.cursor.logEpoch !== epoch || state.cursor.sequence !== row.sequence) return;
      // 缓存只接受本归约器生成的结构。v8序列化保留undefined，避免重启改变对象形状。
      const shape = initialState(id, epoch);
      for (const key of Object.keys(shape) as (keyof ConversationState)[]) {
        const expected = shape[key], actual = state[key];
        if (Array.isArray(expected) ? !Array.isArray(actual) : !actual || typeof actual !== 'object' || Array.isArray(actual)) return;
      }
      this.saved.set(id, { sequence: row.sequence, bytes: row.state.byteLength });
      return state;
    } catch { return; }
  }
  forget(id: string) { this.saved.delete(id); }
  clearMemory() { this.saved.clear(); }
  save(state: ConversationState): number | undefined {
    const { streamId: id, logEpoch: epoch, sequence } = state.cursor;
    if (this.db.isTransaction) return;
    if (sequence === '0') return 0;
    const saved = this.saved.get(id);
    if (saved?.sequence === sequence) return saved.bytes;
    let byteLength: number | undefined;
    try {
      const current=this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND log_epoch=? AND next_sequence=?')
        .get(id,epoch,BigInt(sequence)+1n);
      if(!current)return;
      const event = new EventBlocks(this.db).at(id,epoch,sequence);
      if (!event) return;
      const bytes = serialize(state);
      byteLength = bytes.byteLength;
      this.db.prepare('INSERT INTO conversation_projections VALUES(?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET version=excluded.version,log_epoch=excluded.log_epoch,sequence=excluded.sequence,event_id=excluded.event_id,state_hash=excluded.state_hash,state=excluded.state')
        .run(id, this.version, epoch, sequence, event.eventId, digest(bytes), bytes);
      this.saved.set(id, { sequence, bytes: byteLength });
    } catch { /* 只丢失加速，不丢失原始历史；下一次仍可完整重建。 */ }
    return byteLength;
  }
}
