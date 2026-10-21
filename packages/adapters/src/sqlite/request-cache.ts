import { DatabaseSync } from 'node:sqlite';
import { hash } from '../../../agent/src/identity.js';
import { requestCacheShape, compareRequestCache, requestContentDelta, cacheUsage } from '../../../agent/src/loop/request-cache.js';
import type { RequestCacheShape } from '../../../agent/src/loop/request-cache.js';
import type { PreparedRequest } from '../../../agent/src/ports.js';
import { UmiError } from '../../../protocol/src/model.js';
import { eventSchema } from '../../../protocol/src/events.js';

// 显式按需的离线观察入口。绝不构造SqliteStore，不迁移、不恢复、不取得业务写者身份。
// 请求分页，事件只返回少量生命周期/usage元数据；查询不挂到启动或逐帧UI刷新。
export function inspectRequestCache(databaseFile: string, conversationId: string, limit = 50, before?: number) {
  if (!conversationId || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw new UmiError('INVALID_INPUT', '需要会话身份、1至100条分页及有效游标');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const conversation = db.prepare('SELECT log_epoch FROM conversations WHERE id=?').get(conversationId);
    if (!conversation) throw new UmiError('NOT_FOUND', '会话不存在');
    const artifact = (id: string): unknown => {
      const row = db.prepare('SELECT hash,content FROM artifacts WHERE id=?').get(id);
      if (!row || typeof row.content !== 'string' || hash(row.content) !== row.hash) throw new UmiError('PROTOCOL_INVALID', '诊断资料缺失或指纹不一致');
      return JSON.parse(row.content);
    };
    const requestRows = db.prepare(`SELECT q.rowid AS ordinal,q.id,q.run_id,q.artifact_id,q.hash,c.version AS context_version FROM model_requests q
      JOIN runs r ON r.id=q.run_id JOIN context_snapshots c ON c.id=q.context_id WHERE r.conversation_id=? AND q.rowid<? ORDER BY q.rowid DESC LIMIT ?`)
      .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1).reverse();
    const hasEarlier = requestRows.length > limit;
    const ids = new Set(requestRows.slice(hasEarlier ? 1 : 0).map(row => String(row.id)));
    const attempts = new Map<string, { requestId: string; status: string; usageRef: string | null }>();
    // 查询可扫描本会话事件，但不读取delta正文到JS；仅在用户显式运行诊断时发生。
    for (const row of db.prepare(`SELECT payload FROM events WHERE conversation_id=? AND log_epoch=? AND
      json_extract(payload,'$.type') IN('model.attempt_started','usage.recorded','model.attempt_completed','model.attempt_failed') ORDER BY sequence`).iterate(conversationId, conversation.log_epoch!)) {
      const event = eventSchema.parse(JSON.parse(String(row.payload)));
      if (!event.modelAttemptId) continue;
      if (event.type === 'model.attempt_started' && ids.has(event.payload.requestId))
        attempts.set(event.modelAttemptId, { requestId: event.payload.requestId, status: 'running', usageRef: null });
      const attempt = attempts.get(event.modelAttemptId);
      if (!attempt) continue;
      if (event.type === 'usage.recorded' && event.payload.requestId === attempt.requestId) attempt.usageRef = event.payload.usageRef;
      if (event.type === 'model.attempt_completed') attempt.status = event.payload.finishReason;
      if (event.type === 'model.attempt_failed') attempt.status = event.payload.code;
    }
    let previous: RequestCacheShape | null = null, previousVersion: number | null = null;
    const rows = requestRows.flatMap((row, index) => {
      const request = artifact(String(row.artifact_id)) as PreparedRequest;
      if (hash(request) !== row.hash) throw new UmiError('PROTOCOL_INVALID', '冻结请求指纹不一致');
      const shape = requestCacheShape(request), comparison = compareRequestCache(shape, previous);
      if (previousVersion !== null && previousVersion !== Number(row.context_version)) comparison.reasons.push('context-window-version');
      previous = shape; previousVersion = Number(row.context_version);
      if (hasEarlier && index === 0) return [];
      const usage = [...attempts.values()].filter(attempt => attempt.requestId === row.id).map(attempt => ({
        status: attempt.status, recorded: attempt.usageRef !== null, ...cacheUsage(attempt.usageRef ? artifact(attempt.usageRef) : null),
      }));
      return [{ ordinal: Number(row.ordinal), requestId: String(row.id), runId: String(row.run_id), comparison,
        contentDelta: requestContentDelta(shape, comparison),
        contextVersion: Number(row.context_version), messageCount: shape?.messages.length ?? null, messageBytes: shape?.messageBytes ?? null,
        toolBytes: shape?.toolBytes ?? null, attempts: usage }];
    });
    db.exec('COMMIT');
    return { schemaVersion: 3, scope: 'conversation-request-page', comparisonBasis: 'persisted-fields-with-encoding-check', rows,
      nextBefore: hasEarlier && rows.length ? rows[0]!.ordinal : null,
      interpretation: '按持久冻结字段值比较，并单列JSON对象键顺序造成的编码变化，不输出提示正文。不解析工具参数等字符串，不重排数组或修改发送请求；不证明原HTTP字节、供应商token边界或miss原因。增量组成按字段值相同的消息前缀定位，计当前JSON编码字节，不判定任务价值或可避免未命中。usage按尝试显示，缺失为未知。页面不含上下文维护调用，不代表整任务或账单。' };
  } finally { db.close(); }
}