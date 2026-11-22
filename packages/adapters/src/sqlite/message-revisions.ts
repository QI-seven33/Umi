import type { SqliteStore } from './store.js';
import { uid } from '../../../agent/src/identity.js';
import { messageGroups } from '../../../agent/src/context/projection.js';
import { currentSequence } from '../../../protocol/src/conversation-view.js';
import { UmiError } from '../../../protocol/src/model.js';

export type RevisionInput = { targetMessageId: string; expectedLastMessageId: string };
export class MessageRevisions {
  constructor(private readonly store: SqliteStore) {}
  // alias 是源码中的固定 SQL 别名，不接收模型或 IPC 输入。
  visibleSql(alias = 'm') {
    if (!/^[a-z]+$/.test(alias)) throw new UmiError('PROTOCOL_INVALID', '消息查询别名无效');
    return `NOT EXISTS(SELECT 1 FROM message_revisions revision WHERE revision.conversation_id=${alias}.conversation_id
      AND (SELECT sequence FROM events WHERE event_id=${alias}.commit_event_id)>=
        CASE WHEN ${alias}.role='user' THEN revision.user_cutoff ELSE revision.context_cutoff END
      AND (SELECT sequence FROM events WHERE event_id=${alias}.commit_event_id)<revision.end_sequence)`;
  }
  target(conversationId: string, input: RevisionInput) {
    const users = this.store.userMessages(conversationId), target = users.find(m => m.id === input.targetMessageId);
    if (!target || users.at(-1)?.id !== input.expectedLastMessageId)
      throw new UmiError('COMMAND_CONFLICT', '对话已变化，请读取最新消息后再编辑');
    return target;
  }
  prepare(conversationId: string, input: RevisionInput, text: string) {
    const target = this.target(conversationId, input), c = this.store.conversation(conversationId);
    if (target.payload.content === text) throw new UmiError('PROTOCOL_INVALID', '消息内容尚未修改');
    const environmentId = String(c.environment_id), environment = this.store.environment(environmentId);
    if (environment.active_run_id || this.store.pendingEnvironment(environmentId).length ||
        this.store.get("SELECT id FROM file_changes WHERE environment_id=? AND state='intent' LIMIT 1", environmentId))
      throw new UmiError('RUN_STATE', '任务仍在运行或有未结算效果，请先停止并核验，再编辑消息');
    const rows = this.store.messages(conversationId), source = rows.find(m => m.id === target.id)!;
    let contextCutoff = source.projectionSequence;
    // 排队输入可能在工具组中途被接收；修订不能留下半个 assistant/tool 消息组。
    for (const group of messageGroups(rows)) {
      if (!group[0]?.payload.tool_calls?.length) continue;
      if (group.some(m => BigInt(m.projectionSequence) < BigInt(contextCutoff)) &&
          group.some(m => BigInt(m.projectionSequence) >= BigInt(contextCutoff)))
        contextCutoff = group[0].projectionSequence;
    }
    const attachmentIds = this.store.messageAttachments(conversationId, target.id).map(attachment => {
      const original = this.store.attachment(conversationId, attachment.id), id = uid();
      // 复制不可变附件的身份/元数据，复用相同正文资料；原消息的归属与字节不变。
      this.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)', id, conversationId, original.name!,
        original.mime!, original.byte_length!, original.artifact_ref!);
      return id;
    });
    return { targetMessageId: target.id, userCutoff: target.projectionSequence, contextCutoff, attachmentIds };
  }
  record(conversationId: string, runId: string, userTurnId: string, messageId: string,
    prepared: ReturnType<MessageRevisions['prepare']>) {
    const replacement = this.store.get(`SELECT CAST(e.sequence AS TEXT) sequence FROM messages m
      JOIN events e ON e.event_id=m.commit_event_id WHERE m.id=?`, messageId)!;
    const payload = { targetMessageId: prepared.targetMessageId, messageId, userCutoff: prepared.userCutoff,
      contextCutoff: prepared.contextCutoff, replacementSequence: String(replacement.sequence) };
    const event = this.store.append({ conversationId, runId, userTurnId }, { type: 'input.revised', payload });
    this.store.run('INSERT INTO message_revisions VALUES(?,?,?,?,?,?,?)', event.eventId, conversationId,
      prepared.targetMessageId, messageId, prepared.userCutoff, prepared.contextCutoff, payload.replacementSequence);
  }
  executions(conversationId: string, offset = 0, limit = 16) {
    const state = this.store.snapshot(conversationId);
    const rows = Object.values(state.tools).filter(t => !currentSequence(state, t.sequence))
      .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1)
      .map(t => ({ executionId: t.executionId, runId: t.runId, name: t.name, status: t.status, resultRef: t.resultRef ?? null }));
    return { entries: rows.slice(offset, offset + limit), total: rows.length, offset,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
      authority: '这些是修订前的执行事实，不是当前要求或新批准。文件和命令效果没有撤销；使用 inspect_tool_execution 核验原执行，勿盲目重跑。' };
  }
}
