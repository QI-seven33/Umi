import type { SqliteStore } from './store.js';
import { canonical, hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import { imageObservationSchema, imageSnapshotSchema } from '../../../protocol/src/image-observation.js';
import type { HostImageObservation, ImageObservation } from '../../../protocol/src/image-observation.js';
import { bytesHash } from '../host-files/paths.js';

// 仅已结算read_image的成对工具消息可成为观察来源，不能从任意JSON或模型文字提图。
export function storedImageObservations(store: SqliteStore, conversationId: string) {
  store.conversation(conversationId);
  return store.all(`SELECT m.id,m.payload,t.result_ref FROM tool_executions t
    JOIN runs r ON r.id=t.run_id JOIN messages m ON m.run_id=t.run_id AND m.attempt_id=t.attempt_id
      AND m.role='tool' AND json_extract(m.payload,'$.tool_call_id')=t.provider_call_id
    WHERE r.conversation_id=? AND t.name='read_image' AND t.state='succeeded' AND t.result_ref IS NOT NULL ORDER BY m.rowid`, conversationId)
    .map(row => {
      const result = store.readArtifact<{ outcome: string; data: unknown }>(row.result_ref as string);
      const message = JSON.parse(row.payload as string);
      if (result.outcome !== 'succeeded' || message.content !== canonical(result))
        throw new UmiError('PROTOCOL_INVALID', '图片观察与原工具回执不一致');
      return { messageId: row.id as string, receipt: imageObservationSchema.parse(result.data) };
    });
}
export function loadImageObservations(store: SqliteStore, conversationId: string, messageIds: string[]): Record<string, HostImageObservation> {
  const wanted = new Set(messageIds), snapshots = new Map<string, HostImageObservation['image']>();
  const result: Record<string, HostImageObservation> = {};
  for (const row of storedImageObservations(store, conversationId)) {
    if (!wanted.has(row.messageId)) continue;
    let image = snapshots.get(row.receipt.imageRef);
    if (!image) {
      const snapshot = imageSnapshotSchema.parse(store.readArtifact(row.receipt.imageRef));
      const bytes = Buffer.from(snapshot.base64, 'base64');
      if (hash(snapshot.metadata) !== hash(row.receipt.metadata) || bytes.length !== snapshot.metadata.size || bytesHash(bytes) !== snapshot.metadata.hash)
        throw new UmiError('PROTOCOL_INVALID', '图片观察快照与保存版本不一致');
      image = { mime: snapshot.metadata.mime, dataUrl: `data:${snapshot.metadata.mime};base64,${snapshot.base64}` };
      snapshots.set(row.receipt.imageRef, image);
    } else {
      // 相同引用在不同回执里也必须绑定同一完整元数据。
      const first = Object.values(result).find(o => o.receipt.imageRef === row.receipt.imageRef)!;
      if (hash(first.receipt.metadata) !== hash(row.receipt.metadata)) throw new UmiError('PROTOCOL_INVALID', '图片版本回执冲突');
    }
    result[row.messageId] = { receipt: row.receipt, image };
  }
  return result;
}
export function saveObservedImage(store: SqliteStore, conversationId: string, snapshot: unknown): string {
  const value = imageSnapshotSchema.parse(snapshot), retired = new Set(store.contextMemory(conversationId).archivedIds);
  const active = new Map<string, ImageObservation['metadata']>();
  for (const row of storedImageObservations(store, conversationId)) if (!retired.has(row.messageId)) active.set(row.receipt.metadata.hash, row.receipt.metadata);
  if (!active.has(value.metadata.hash) && active.size >= 8)
    throw new UmiError('IMAGE_LIMIT', '当前上下文已保留8张不同图片；可用request_context_reset归档旧工具组后再读取。原图和历史不删除。');
  const fingerprint = hash(value), prior = store.get("SELECT id FROM artifacts WHERE kind='image-observation-snapshot' AND hash=? LIMIT 1", fingerprint);
  if (prior) { store.readArtifact(prior.id as string); return prior.id as string; }
  return store.artifact(value, 'image-observation-snapshot');
}
