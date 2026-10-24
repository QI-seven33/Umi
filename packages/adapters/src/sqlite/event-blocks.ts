import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { canonical, uid } from '../../../agent/src/identity.js';
import { eventSchema, type WorkEvent } from '../../../protocol/src/events.js';
import { UmiError } from '../../../protocol/src/model.js';

export const streamKeyPrefix = 'umi-stream-v1/';
export const streamMemberKey = (batch: string, offset: number) => `${streamKeyPrefix}${batch}/${offset}`;
const maxBytes = 2 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new UmiError('PROTOCOL_INVALID', '事件正文块缺失、损坏或与事件身份不一致，未跳过历史');
// DB10按原身份行读取；DB12按批次首行与范围读取。所有逻辑事件、原始边界和刷新时机保持。
// 指针属于SQLite内部格式，不穿过协议、订阅、归约器或模型工具边界。
export class EventBlocks {
  private cache = new Map<string, WorkEvent[]>();
  constructor(private readonly db: DatabaseSync) {}
  clear() { this.cache.clear(); }
  write(events: WorkEvent[], streamBatch?: string) {
    if (!this.db.isTransaction || !events.length || events.some(e => e.type !== 'model.delta'))
      throw new UmiError('PROTOCOL_INVALID', '模型正文批次必须在事件事务内写入');
    if (streamBatch) {
      // 新身份由批次UUID+偏移组成，与普通UUID事件分离；旧任意幂等键仍需查重。
      for (const [i,e] of events.entries()) if (e.eventId !== streamMemberKey(streamBatch,i) || e.idempotencyKey !== e.eventId ||
        e.conversationId!==events[0]!.conversationId || e.logEpoch!==events[0]!.logEpoch ||
        BigInt(e.sequence)!==BigInt(events[0]!.sequence)+BigInt(i))
        throw invalid();
      if (this.db.prepare(`SELECT 1 FROM events WHERE event_id IN(SELECT value FROM json_each(?))
          OR (conversation_id=? AND idempotency_key IN(SELECT value FROM json_each(?))) LIMIT 1`)
        .get(JSON.stringify(events.map(e=>e.eventId)),events[0]!.conversationId,JSON.stringify(events.map(e=>e.idempotencyKey))))
        throw new UmiError('COMMAND_CONFLICT','流批次身份已存在');
    }
    const text = canonical(events), bytes = Buffer.from(text);
    // 单条或大批次沿原标量格式，容量只控制压缩块，不拒绝原本可写的事件。
    const packed = events.length >= 2 && events.length <= 64 && bytes.length <= maxBytes;
    const id = packed ? (streamBatch ?? uid()) : undefined;
    if (id) {
      const first = events[0]!, last = events.at(-1)!;
      this.db.prepare('INSERT INTO event_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,
        first.conversationId, first.logEpoch, BigInt(first.sequence), BigInt(last.sequence), events.length,
        bytes.length, 'json-deflate-v1', digest(bytes), last.occurredAt, deflateRawSync(bytes));
    }
    const insert = this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)');
    for (const [offset, event] of events.entries()) {
      if (id && streamBatch && offset > 0) continue;
      insert.run(event.conversationId, event.logEpoch, BigInt(event.sequence), event.eventId, event.idempotencyKey,
        id ? JSON.stringify(streamBatch ? { $umiStream: id } : { $umiDelta: id, offset }) : canonical(event));
    }
    if (id && streamBatch) {
      const first=events[0]!,last=events.at(-1)!;
      this.db.prepare('INSERT INTO event_ranges VALUES(?,?,?,?,?,?)').run(id,first.eventId,
        first.conversationId,first.logEpoch,BigInt(first.sequence),BigInt(last.sequence));
    }
  }
  private block(id: string): WorkEvent[] {
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached; }
    try {
      const row = this.db.prepare('SELECT conversation_id,log_epoch,member_count,decoded_bytes,codec,hash,last_at,content,CAST(first_sequence AS TEXT) first_seq,CAST(last_sequence AS TEXT) last_seq FROM event_blocks WHERE id=?').get(id);
      if (!row || row.codec !== 'json-deflate-v1' || !(row.content instanceof Uint8Array) ||
          !Number.isInteger(row.decoded_bytes) || Number(row.decoded_bytes) < 1 || Number(row.decoded_bytes) > maxBytes) throw invalid();
      const bytes = inflateRawSync(row.content, { maxOutputLength: Number(row.decoded_bytes) });
      if (bytes.length !== row.decoded_bytes || digest(bytes) !== row.hash) throw invalid();
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(value) || value.length !== row.member_count || value.length < 2 || value.length > 64) throw invalid();
      const events = value.map(e => eventSchema.parse(e));
      for (const [i, e] of events.entries()) if (e.type !== 'model.delta' || e.conversationId !== row.conversation_id ||
          e.logEpoch !== row.log_epoch || BigInt(e.sequence) !== BigInt(String(row.first_seq)) + BigInt(i)) throw invalid();
      if (events.at(-1)!.sequence !== row.last_seq || events.at(-1)!.occurredAt !== row.last_at) throw invalid();
      // 大块仅本次读取展开；小块最多缓存8个，总展开字节不超过约2MiB。
      if (bytes.length <= maxBytes / 8) {
        this.cache.set(id, events);
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      }
      return events;
    } catch { throw invalid(); }
  }
  read(row: Record<string, unknown>): WorkEvent {
    return this.readValue(row,JSON.parse(String(row.payload)));
  }
  private readValue(row: Record<string, unknown>, value: ReturnType<typeof JSON.parse>): WorkEvent {
    let event: WorkEvent;
    if (value && typeof value === 'object' && '$umiStream' in value) return this.members(row)[0]!;
    if (value && typeof value === 'object' && '$umiDelta' in value) {
      if (typeof value.$umiDelta !== 'string' || !Number.isInteger(value.offset) || value.offset < 0 || value.offset >= 64) throw invalid();
      const found = this.block(value.$umiDelta)[value.offset];
      if (!found) throw invalid();
      event = eventSchema.parse(found); // 返回独立事件，调用方不能修改缓存中的历史正文。
    } else event = eventSchema.parse(value);
    if (event.eventId !== row.event_id || event.idempotencyKey !== row.idempotency_key ||
        event.conversationId !== row.conversation_id || event.logEpoch !== row.log_epoch || event.sequence !== row.seq) throw invalid();
    return event;
  }
  // 一个物理首行可以展开成多个逻辑事件；DB10仍逐行解释，不能重复展开旧块。
  members(row: Record<string, unknown>): WorkEvent[] {
    const value=JSON.parse(String(row.payload));
    if (!value || typeof value !== 'object' || !('$umiStream' in value)) return [this.readValue(row,value)];
    if (typeof value.$umiStream !== 'string' || Object.keys(value).length !== 1) throw invalid();
    const range=this.db.prepare(`SELECT anchor_id,conversation_id,log_epoch,CAST(first_sequence AS TEXT) first_seq,
      CAST(last_sequence AS TEXT) last_seq FROM event_ranges WHERE block_id=?`).get(value.$umiStream);
    if (!range || range.anchor_id!==row.event_id || range.conversation_id!==row.conversation_id ||
      range.log_epoch!==row.log_epoch || range.first_seq!==row.seq) throw invalid();
    const events=this.block(value.$umiStream);
    if (events.at(-1)!.sequence!==range.last_seq || events[0]!.sequence!==row.seq ||
      events[0]!.conversationId!==row.conversation_id || events[0]!.logEpoch!==row.log_epoch) throw invalid();
    for (const [i,e] of events.entries()) if(e.eventId!==streamMemberKey(value.$umiStream,i) || e.idempotencyKey!==e.eventId) throw invalid();
    if(events[0]!.eventId!==row.event_id || events[0]!.idempotencyKey!==row.idempotency_key) throw invalid();
    return events.map(e=>eventSchema.parse(e));
  }
  at(conversationId: string, epoch: string, sequence: string): WorkEvent | undefined {
    const columns='payload,event_id,idempotency_key,conversation_id,log_epoch,CAST(sequence AS TEXT) seq';
    const row=this.db.prepare(`SELECT ${columns} FROM events WHERE conversation_id=? AND log_epoch=? AND sequence=?`)
      .get(conversationId,epoch,BigInt(sequence));
    if(row)return this.read(row);
    const range=this.db.prepare(`SELECT anchor_id,CAST(last_sequence AS TEXT) last_seq FROM event_ranges WHERE conversation_id=? AND log_epoch=?
      AND first_sequence<=? ORDER BY first_sequence DESC LIMIT 1`)
      .get(conversationId,epoch,BigInt(sequence));
    if(!range || BigInt(String(range.last_seq))<BigInt(sequence))return;
    const anchor=this.db.prepare(`SELECT ${columns} FROM events WHERE event_id=?`).get(range.anchor_id!);
    if(!anchor)throw invalid();
    return this.members(anchor).find(e=>e.sequence===sequence);
  }
  byKey(conversationId: string, key: string): WorkEvent | undefined {
    const match=/^umi-stream-v1\/([0-9a-f-]{36})\/(0|[1-9][0-9]?)$/.exec(key);
    if(!match || Number(match[2])>=64)return;
    const range=this.db.prepare(`SELECT e.payload,e.event_id,e.idempotency_key,e.conversation_id,e.log_epoch,
      CAST(e.sequence AS TEXT) seq FROM event_ranges r JOIN events e ON e.event_id=r.anchor_id
      WHERE r.block_id=? AND r.conversation_id=?`).get(match[1]!,conversationId);
    if(!range)return;
    const event=this.members(range)[Number(match[2])];
    return event?.idempotencyKey===key ? event : undefined;
  }
  *iterate(conversationId: string, epoch: string, after: string, until: string): Iterable<WorkEvent> {
    if(BigInt(after)>=BigInt(until))return;
    // 游标可以落在批次内部。包含该首行后再按逻辑序号过滤，不能以物理LIMIT代替逻辑LIMIT。
    const containing=this.db.prepare(`SELECT CAST(first_sequence AS TEXT) seq,CAST(last_sequence AS TEXT) last_seq FROM event_ranges
      WHERE conversation_id=? AND log_epoch=? AND first_sequence<=? ORDER BY first_sequence DESC LIMIT 1`)
      .get(conversationId,epoch,BigInt(after));
    const start=containing && BigInt(String(containing.last_seq))>BigInt(after)?BigInt(String(containing.seq))-1n:BigInt(after);
    const rows=this.db.prepare(`SELECT payload,event_id,idempotency_key,conversation_id,log_epoch,CAST(sequence AS TEXT) seq
      FROM events WHERE conversation_id=? AND log_epoch=? AND sequence>? AND sequence<=? ORDER BY sequence`)
      .iterate(conversationId,epoch,start,BigInt(until));
    let expected=BigInt(after)+1n;
    for(const row of rows)for(const e of this.members(row)) {
      const sequence=BigInt(e.sequence);
      if(sequence<=BigInt(after) || sequence>BigInt(until))continue;
      if(sequence!==expected)throw new UmiError('CURSOR_GAP','历史事件未连续，未跳过历史');
      expected++;yield e;
    }
    if(expected!==BigInt(until)+1n)throw new UmiError('CURSOR_GAP','历史事件尾部缺失，未确认加载完成');
  }
  // 删除资料引用扫描必须展开压缩块，不能把压缩字节当作没有引用的空正文。
  *values(conversationId?: string): Iterable<WorkEvent[]> {
    const query = this.db.prepare('SELECT id FROM event_blocks' + (conversationId === undefined ? '' : ' WHERE conversation_id=?'));
    for (const row of query.iterate(...(conversationId === undefined ? [] : [conversationId]))) yield this.block(String(row.id));
  }
}
