import { runConclusion } from '../../../agent/src/loop/run-conclusion.js';
import { attachmentTextProblem } from '../../../protocol/src/attachments.js';
import { AttachmentRepository } from './attachments.js';
import type { AttachmentReadOptions } from '../../../protocol/src/attachments.js';
import { loadImageObservations } from './image-observations.js';
import { WriterLock } from './writer-lock.js';
import { DATABASE_VERSION } from '../../../protocol/src/database.js';
import { CONVERSATION_DELETION_SQL } from './conversation-deletion-schema.js';
import { ConversationDeletion } from './conversation-deletion.js';
import { singleResultBody } from '../../../agent/src/tools/result.js';
import { decodeImage } from './images.js';
import { DESKTOP_SCHEMA_SQL } from './desktop-schema.js';
import { RESOURCE_SCHEMA_SQL } from './schema.js';
import { RESOURCE_SCOPE_SCHEMA_SQL } from './resource-scope-schema.js';
import { PROCESS_SCHEMA_SQL } from './process-schema.js';
import { MEMORY_SCHEMA_SQL } from './memory-schema.js';
import { MemoryRepository } from './memory.js';
import type {
  MemorySource,
  MemoryValue,
  MaintenancePlan,
  Summary,
} from '../../../protocol/src/memory.js';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonical, hash, uid } from '../../../agent/src/identity.js';
import type {
  ContextCarry,
  MessageRow,
  RunRow,
  Environment,
  ToolRow,
  ApprovalRow,
  ToolResult,
} from '../../../agent/src/persistence.js';
import type { PreparedRequest } from '../../../agent/src/ports.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { eventSchema } from '../../../protocol/src/events.js';
import type { EventBody, EventScope, WorkEvent } from '../../../protocol/src/events.js';
import {
  settingsSchema,
  messageSchema,
  cursorSchema,
  executionContextSchema,
  UmiError,
} from '../../../protocol/src/model.js';
import type { Settings, WireMessage, Cursor } from '../../../protocol/src/model.js';
import { initialState, reduceConversation } from '../../../protocol/src/reducer.js';
import type { ConversationState } from '../../../protocol/src/reducer.js';

type Row = Record<string, string | number | null>;

export class SqliteStore {
  readonly db!: DatabaseSync;
  readonly dataRoot: string;
  private readonly writerLock: WriterLock;
  readonly instanceId = uid();
  private closed = false;
  private readonly states = new Map<string, ConversationState>();
  constructor(
    directory: string,
    private readonly now = () => new Date().toISOString(),
  ) {
    mkdirSync(directory, { recursive: true });
    this.dataRoot = realpathSync(directory);
    this.writerLock = new WriterLock(this.dataRoot, this.instanceId);
    try {
      this.db = new DatabaseSync(join(this.dataRoot, 'umi.sqlite'));
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
      );
      if (
        this.get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
      ) {
        const versions = this.all('SELECT version,checksum FROM schema_migrations');
        if (
          versions.some(
            (v) =>
              ![1, 2, 3, 4, 5, 6, 7].includes(Number(v.version)) ||
              v.checksum !==
                hash(
                  Number(v.version) === 1
                    ? 'umi-stage2-schema-1'
                    : Number(v.version) === 2
                      ? RESOURCE_SCHEMA_SQL
                      : Number(v.version) === 3
                        ? PROCESS_SCHEMA_SQL
                        : Number(v.version) === 4
                          ? MEMORY_SCHEMA_SQL
                          : Number(v.version) === 5
                            ? DESKTOP_SCHEMA_SQL
                            : Number(v.version) === 6
                              ? RESOURCE_SCOPE_SCHEMA_SQL
                              : CONVERSATION_DELETION_SQL,
                ),
          )
        )
          throw new UmiError(
            'SCHEMA_UNSUPPORTED',
            '数据库版本或迁移指纹不兼容，未修改已有数据',
          );
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, source_root TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS environments(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, root_identity TEXT NOT NULL, binding_version INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), active_run_id TEXT);
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), environment_id TEXT NOT NULL UNIQUE REFERENCES environments(id),
          log_epoch TEXT NOT NULL, next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence>0), settings TEXT NOT NULL, settings_version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), environment_id TEXT NOT NULL REFERENCES environments(id),
          status TEXT NOT NULL CHECK(status IN('queued','running','waiting_permission','stopping','stopped','interrupted','recovering','recovery_required','completed','failed')),
          phase TEXT NOT NULL DEFAULT 'execute' CHECK(phase IN('execute','waiting','finalize')), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
          model_turns INTEGER NOT NULL DEFAULT 0 CHECK(model_turns>=0), stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN(0,1)));
        CREATE TABLE IF NOT EXISTS events(conversation_id TEXT NOT NULL REFERENCES conversations(id),log_epoch TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),
          event_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(conversation_id,log_epoch,sequence), UNIQUE(conversation_id,idempotency_key));
        -- 原话应用事实建立局部索引，避免每条历史消息重扫所有 model.delta 的 JSON。
        CREATE INDEX IF NOT EXISTS events_applied_input ON events(conversation_id,json_extract(payload,'$.payload.messageId'),sequence)
          WHERE json_extract(payload,'$.type')='input.applied';
        CREATE TABLE IF NOT EXISTS commands(conversation_id TEXT NOT NULL REFERENCES conversations(id),id TEXT NOT NULL, hash TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(conversation_id,id));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES runs(id),
          user_turn_id TEXT,turn_id TEXT,attempt_id TEXT,role TEXT NOT NULL CHECK(role IN('system','user','assistant','tool')),payload TEXT NOT NULL,hash TEXT NOT NULL,
          created_at TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 1 CHECK(applied IN(0,1)),commit_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id));
        CREATE TABLE IF NOT EXISTS context_snapshots(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),version INTEGER NOT NULL DEFAULT 1,artifact_id TEXT NOT NULL REFERENCES artifacts(id));
        CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),turn_id TEXT NOT NULL UNIQUE,context_id TEXT NOT NULL REFERENCES context_snapshots(id),
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tool_executions(id TEXT PRIMARY KEY,call_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES runs(id),turn_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
          provider_call_id TEXT NOT NULL,name TEXT NOT NULL,args TEXT NOT NULL,request_hash TEXT NOT NULL,environment_id TEXT NOT NULL REFERENCES environments(id),revision INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN('prepared','dispatched','succeeded','failed','denied','cancelled','unknown')),
          context_ref TEXT REFERENCES artifacts(id),result_ref TEXT REFERENCES artifacts(id),approval_id TEXT);
        CREATE TABLE IF NOT EXISTS approval_requests(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES tool_executions(id),run_id TEXT NOT NULL REFERENCES runs(id),
          request_hash TEXT NOT NULL,description TEXT NOT NULL,decision TEXT CHECK(decision IN('allow','deny')),valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN(0,1)));
        CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
        CREATE TRIGGER IF NOT EXISTS immutable_message BEFORE UPDATE OF payload,hash,created_at,role ON messages BEGIN SELECT RAISE(ABORT,'原始消息不可修改'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_event BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'历史事件不可修改'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_artifact BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'资料不可修改'); END;
      `);
        this.db
          .prepare('INSERT OR IGNORE INTO schema_migrations VALUES(1,?,?)')
          .run(hash('umi-stage2-schema-1'), this.now());
        this.db.exec(RESOURCE_SCHEMA_SQL);
        this.db
          .prepare('INSERT OR IGNORE INTO schema_migrations VALUES(2,?,?)')
          .run(hash(RESOURCE_SCHEMA_SQL), this.now());
        if (!this.get('SELECT version FROM schema_migrations WHERE version=3')) {
          this.db.exec(PROCESS_SCHEMA_SQL);
          this.db
            .prepare('INSERT INTO schema_migrations VALUES(3,?,?)')
            .run(hash(PROCESS_SCHEMA_SQL), this.now());
        }
        if (!this.get('SELECT version FROM schema_migrations WHERE version=4')) {
          this.db.exec(MEMORY_SCHEMA_SQL);
          this.db
            .prepare('INSERT INTO schema_migrations VALUES(4,?,?)')
            .run(hash(MEMORY_SCHEMA_SQL), this.now());
        }
        if (!this.get('SELECT version FROM schema_migrations WHERE version=5')) {
          this.db.exec(DESKTOP_SCHEMA_SQL);
          this.db
            .prepare('INSERT INTO schema_migrations VALUES(5,?,?)')
            .run(hash(DESKTOP_SCHEMA_SQL), this.now());
        }
        if (!this.get('SELECT version FROM schema_migrations WHERE version=6')) {
          this.db.exec(RESOURCE_SCOPE_SCHEMA_SQL);
          this.db
            .prepare('INSERT INTO schema_migrations VALUES(6,?,?)')
            .run(hash(RESOURCE_SCOPE_SCHEMA_SQL), this.now());
        }
        if (!this.get('SELECT version FROM schema_migrations WHERE version=7')) {
          this.db.exec(CONVERSATION_DELETION_SQL);
          this.run('INSERT INTO schema_migrations VALUES(7,?,?)',hash(CONVERSATION_DELETION_SQL),this.now());
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      // 可重建的辅助索引，不改变逻辑表/版本或旧迁移指纹。首次构建有一次扫描，后续启动只读少量生命周期事件。
      this.db.exec("CREATE INDEX IF NOT EXISTS events_attempt_lifecycle ON events(conversation_id,log_epoch,sequence) WHERE json_extract(payload,'$.type') IN('model.attempt_started','model.attempt_completed','model.attempt_failed')");
      for (const row of this.all(
        "SELECT * FROM context_maintenance WHERE state='started'",
      )) {
        this.transaction(() => {
          this.run("UPDATE context_maintenance SET state='failed' WHERE id=?", row.id!);
          this.append(
            {
              conversationId: row.conversation_id as string,
              runId: row.run_id as string,
            },
            {
              type: 'context.maintenance_failed',
              payload: {
                maintenanceId: row.id as string,
                code: 'MAINTENANCE_INTERRUPTED',
              },
            },
          );
        });
      }
      // 只有持有唯一写入锁的实例执行恢复检查；等待批准不依赖旧进程的 Promise。
      for (const r of this.all(
        "SELECT * FROM runs WHERE status IN ('running','stopping','recovering')",
      ) as unknown as RunRow[]) {
        this.commit(
          { conversationId: r.conversation_id, runId: r.id },
          {
            type: r.stop_requested ? 'run.stopped' : 'run.interrupted',
            payload: {
              reason: r.stop_requested
                ? '已恢复用户停止记录，未自动续跑'
                : '执行进程退出，等待核验恢复',
            },
          },
        );
        if (r.stop_requested)
          for (const t of this.tools(r.id).filter((t) => t.state === 'prepared')) {
            if (t.approval_id) this.invalidateApproval(t.id, '用户已停止任务');
            this.settle(
              t.id,
              {
                outcome: 'cancelled',
                content: '停止已持久化，原工具尚未派发。',
                data: null,
              },
              r.generation,
            );
          }
      }
      for (const t of this.all(
        "SELECT * FROM tool_executions WHERE state='dispatched'",
      ) as unknown as ToolRow[])
        this.settle(
          t.id,
          {
            outcome: 'unknown',
            content: '原执行进程已退出，副作用结果尚未核验。',
            data: null,
            verification: 'unknown',
          },
          this.getRun(t.run_id).generation,
          true,
        );
      // 进程硬退出没有机会结算 attempt；启动时补充中断事实，不等待用户点击恢复才结束 loading。
      const lifecycleByConversation = new Map<string, WorkEvent[]>();
      for (const r of this.all(
        "SELECT * FROM runs WHERE status IN('interrupted','stopped','waiting_permission','recovery_required')",
      ) as unknown as RunRow[]) {
        const open = new Map<string, WorkEvent>();
        let lifecycle = lifecycleByConversation.get(r.conversation_id);
        if (!lifecycle) {
          lifecycle = this.all("SELECT payload FROM events WHERE conversation_id=? AND log_epoch=? AND json_extract(payload,'$.type') IN('model.attempt_started','model.attempt_completed','model.attempt_failed') ORDER BY sequence", r.conversation_id, this.conversation(r.conversation_id).log_epoch as string)
            .map(row => eventSchema.parse(JSON.parse(row.payload as string)));
          lifecycleByConversation.set(r.conversation_id, lifecycle);
        }
        for (const e of lifecycle.filter((e) => e.runId === r.id)) {
          if (e.type === 'model.attempt_started') open.set(e.modelAttemptId!, e);
          if (e.type === 'model.attempt_completed' || e.type === 'model.attempt_failed')
            open.delete(e.modelAttemptId!);
        }
        for (const e of open.values())
          this.commit(
            {
              conversationId: r.conversation_id,
              runId: r.id,
              modelTurnId: e.modelTurnId!,
              modelAttemptId: e.modelAttemptId!,
            },
            {
              type: 'model.attempt_failed',
              payload: {
                code: 'PROVIDER_INTERRUPTED',
                reason: '原进程退出，未提交完整响应；保留已显示分片',
              },
            },
          );
      }
      new ConversationDeletion(this).cleanupPending();
    } catch (e) {
      try {
        this.db!.close();
      } catch {}
      this.writerLock.release();
      throw e;
    }
  }
  get(sql: string, ...args: (string | number | bigint | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: (string | number | bigint | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: (string | number | bigint | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const x = fn();
      this.db.exec('COMMIT');
      return x;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.states.clear();
      throw e;
    }
  }
  conversation(id: string) {
    const r = this.get(
      'SELECT id,workspace_id,environment_id,log_epoch,CAST(next_sequence AS TEXT) AS next_sequence,settings,settings_version FROM conversations WHERE id=?',
      id,
    );
    if (!r) throw new UmiError('NOT_FOUND', '会话不存在');
    return r;
  }
  settings(id: string): Settings {
    return settingsSchema.parse(JSON.parse(this.conversation(id).settings as string));
  }
  getRun(id: string): RunRow {
    const r = this.get('SELECT * FROM runs WHERE id=?', id);
    if (!r) throw new UmiError('NOT_FOUND', '运行不存在');
    return r as unknown as RunRow;
  }
  environment(id: string): Environment {
    const r = this.get('SELECT * FROM environments WHERE id=?', id);
    if (!r) throw new UmiError('NOT_FOUND', '环境不存在');
    return r as unknown as Environment;
  }
  artifact(value: unknown, kind = 'json'): string {
    const content = canonical(value),
      id = uid();
    this.run('INSERT INTO artifacts VALUES(?,?,?,?)', id, hash(content), kind, content);
    return id;
  }
  readArtifact<T>(id: string): T {
    const r = this.get('SELECT * FROM artifacts WHERE id=?', id);
    if (!r) throw new UmiError('NOT_FOUND', '资料不存在');
    if (hash(r.content as string) !== r.hash)
      throw new UmiError('PROTOCOL_INVALID', '资料指纹不一致');
    return JSON.parse(r.content as string) as T;
  }
  createConversation(sourceRoot: string, settings: Partial<Settings> = {}) {
    const root = realpathSync(sourceRoot);
    if (!statSync(root).isDirectory())
      throw new UmiError('PROTOCOL_INVALID', '工作区必须为目录');
    const workspaceId =
      (this.get('SELECT id FROM workspaces WHERE source_root=?', root)?.id as
        | string
        | undefined) ?? uid();
    const conversationId = uid(),
      environmentId = uid(),
      environmentRoot = join(this.dataRoot, 'environments', environmentId);
    for (const area of ['scratch', 'artifacts', 'research', 'logs'])
      mkdirSync(join(environmentRoot, 'task', area), { recursive: true });
    const st = statSync(environmentRoot, { bigint: true });
    const identity = `${st.dev}:${st.ino}`;
    this.transaction(() => {
      this.run('INSERT OR IGNORE INTO workspaces VALUES(?,?)', workspaceId, root);
      this.run(
        'INSERT INTO environments(id,root,root_identity) VALUES(?,?,?)',
        environmentId,
        environmentRoot,
        identity,
      );
      this.run(
        'INSERT INTO conversations(id,workspace_id,environment_id,log_epoch,settings) VALUES(?,?,?,?,?)',
        conversationId,
        workspaceId,
        environmentId,
        uid(),
        canonical(settingsSchema.parse(settings)),
      );
    });
    return { workspaceId, conversationId, environmentId };
  }
  listConversations(
    archived = false,
  ): Array<Record<string, unknown> & { hasMessages: boolean }> {
    return this.all(
      `SELECT c.id,c.workspace_id workspaceId,w.source_root workspace,c.environment_id environmentId,
      EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='user') hasMessages,
      COALESCE(v.title,(SELECT substr(json_extract(m.payload,'$.content'),1,60) FROM messages m WHERE m.conversation_id=c.id AND m.role='user' ORDER BY m.rowid LIMIT 1),'新对话') title,
      (SELECT json_extract(e.payload,'$.occurredAt') FROM events e WHERE e.conversation_id=c.id AND e.log_epoch=c.log_epoch ORDER BY e.sequence DESC LIMIT 1) updatedAt
      FROM conversations c JOIN workspaces w ON w.id=c.workspace_id LEFT JOIN conversation_views v ON v.conversation_id=c.id WHERE COALESCE(v.archived,0)=? ORDER BY updatedAt DESC,c.rowid DESC`,
      archived ? 1 : 0,
    ).map((row) => ({ ...row, hasMessages: Boolean(row.hasMessages) }));
  }
  // 未发送的会话是工作区的草稿入口；不因重复点击新对话而分配新环境。
  emptyConversation(workspaceId: string) {
    return this.get(
      `SELECT c.id,c.workspace_id workspaceId,c.environment_id environmentId FROM conversations c
    LEFT JOIN conversation_views v ON v.conversation_id=c.id WHERE c.workspace_id=? AND COALESCE(v.archived,0)=0
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id=c.id) ORDER BY c.rowid DESC LIMIT 1`,
      workspaceId,
    );
  }
  editConversation(id: string, title: string | null, archive = false) {
    this.conversation(id);
    const state = this.snapshot(id);
    if (
      archive &&
      Object.values(state.runs).some((r) =>
        [
          'queued',
          'running',
          'waiting_permission',
          'stopping',
          'recovering',
          'recovery_required',
        ].includes(r.status),
      )
    )
      throw new UmiError('RUN_STATE', '请先停止或核验活动任务');
    if (
      archive &&
      this.unresolvedEnvironment(this.conversation(id).environment_id as string).length
    )
      throw new UmiError('TOOL_OUTCOME_UNKNOWN', '会话仍有未知副作用，不能隐藏恢复入口');
    this.transaction(() => {
      this.run(
        'INSERT INTO conversation_views VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET title=COALESCE(excluded.title,conversation_views.title),archived=excluded.archived',
        id,
        title,
        archive ? 1 : 0,
      );
    });
  }
  get databaseVersion() { return DATABASE_VERSION; }
  deleteArchivedConversation(id: string) {
    const result = new ConversationDeletion(this).deleteArchived(id);
    this.states.delete(id);
    return result;
  }
  attachment(conversationId: string, id: string) {
    const a = this.get(
      'SELECT * FROM attachments WHERE id=? AND conversation_id=?',
      id,
      conversationId,
    );
    if (!a) throw new UmiError('PERMISSION_DENIED', '附件不属于当前会话');
    return a;
  }
  messageAttachments(conversationId: string, messageId: string) {
    return this.all(
      'SELECT a.id,a.name,a.mime,a.byte_length byteLength FROM attachments a JOIN message_attachments m ON m.attachment_id=a.id WHERE m.message_id=? AND a.conversation_id=?',
      messageId,
      conversationId,
    ).map((a) => ({
      id: String(a.id),
      name: String(a.name),
      mime: String(a.mime),
      byteLength: Number(a.byteLength),
    }));
  }
  uploadAttachment(conversationId: string, name: string, mime: string, text: string) {
    this.conversation(conversationId);
    const problem = attachmentTextProblem(text);
    if (problem) throw new UmiError('PROTOCOL_INVALID', problem);
    const id = uid(),
      bytes = Buffer.byteLength(text);
    if (
      !name ||
      name.length > 180 ||
      /[\\/\x00-\x1f]/.test(name) ||
      !['text/plain', 'text/markdown', 'application/json', 'text/csv'].includes(mime) ||
      bytes > 1_000_000 ||
      Buffer.from(text,'utf8').toString('utf8') !== text ||
      /[\x00-\x08\x0e-\x1f]/.test(text)
    )
      throw new UmiError('PROTOCOL_INVALID', '附件名称、类型或大小不支持');
    return this.transaction(() => {
      // 同会话重复内容复用资料；每次上传仍有独立附件身份/显示名，不混淆同名版本。
      const old = this.get("SELECT a.artifact_ref FROM attachments a JOIN artifacts r ON r.id=a.artifact_ref WHERE a.conversation_id=? AND r.kind='attachment' AND r.hash=? LIMIT 1", conversationId, hash({ text }));
      const ref = old ? String(old.artifact_ref) : this.artifact({ text }, 'attachment');
      this.run(
        'INSERT INTO attachments VALUES(?,?,?,?,?,?)',
        id,
        conversationId,
        name,
        mime,
        bytes,
        ref,
      );
      return { id, name, mime, byteLength: bytes };
    });
  }
  uploadDocument(conversationId:string,input:unknown){return new AttachmentRepository(this).uploadDocument(conversationId,input);}
  uploadImage(conversationId: string, name: string, base64: string) {
    this.conversation(conversationId);
    if (!name || name.length > 180 || /[\\/\x00-\x1f]/.test(name))
      throw new UmiError('PROTOCOL_INVALID', '图片名称无效');
    const { bytes, mime } = decodeImage(base64),
      id = uid();
    return this.transaction(() => {
      const ref = this.artifact({ base64 }, 'attachment');
      this.run(
        'INSERT INTO attachments VALUES(?,?,?,?,?,?)',
        id,
        conversationId,
        name,
        mime,
        bytes.length,
        ref,
      );
      return { id, name, mime, byteLength: bytes.length };
    });
  }
  previewAttachment(conversationId: string, id: string, startByte = 0, byteLength = 8192) {
    const a = this.attachment(conversationId, id);
    if (String(a.mime).startsWith('image/'))
      return {
        id,
        name: String(a.name),
        totalBytes: Number(a.byte_length),
        mime: String(a.mime),
        dataUrl: `data:${a.mime};base64,${this.readArtifact<{ base64: string }>(a.artifact_ref as string).base64}`,
      };
    return this.readAttachment(conversationId, id, startByte, byteLength);
  }
  imageObservations(conversationId: string, messageIds: string[]) {
    return loadImageObservations(this, conversationId, messageIds);
  }
  messageImages(conversationId: string, messageId: string) {
    return this.messageAttachments(conversationId, messageId)
      .filter((a) => a.mime.startsWith('image/'))
      .map((a) => ({
        mime: a.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        dataUrl: (this.previewAttachment(conversationId, a.id) as { dataUrl: string })
          .dataUrl,
      }));
  }
  sentAttachment(conversationId: string, id: string) { return new AttachmentRepository(this).sent(conversationId,id); }
  listAttachments(conversationId: string, input: unknown) { return new AttachmentRepository(this).list(conversationId,input); }
  searchAttachment(conversationId: string, input: unknown) { return new AttachmentRepository(this).search(conversationId,input); }
  readAttachment(conversationId: string, id: string, startByte = 0, byteLength = 8192, options: AttachmentReadOptions = {}) {
    return new AttachmentRepository(this).read(conversationId,id,startByte,byteLength,options);
  }
  // append 仅允许在事务内调用；快照校验在提交前执行，错误不会留下半条事实。
  append(scope: EventScope, body: EventBody, key: string = uid()): WorkEvent {
    const c = this.conversation(scope.conversationId);
    const duplicate = this.get(
      'SELECT payload FROM events WHERE conversation_id=? AND idempotency_key=?',
      scope.conversationId,
      key,
    );
    if (duplicate) {
      const e = eventSchema.parse(JSON.parse(duplicate.payload as string));
      const original = {
        conversationId: e.conversationId,
        runId: e.runId,
        userTurnId: e.userTurnId,
        modelTurnId: e.modelTurnId,
        modelAttemptId: e.modelAttemptId,
        callId: e.callId,
        executionId: e.executionId,
      };
      if (
        canonical({ type: e.type, payload: e.payload }) !== canonical(body) ||
        canonical(original) !== canonical(scope)
      )
        throw new UmiError('COMMAND_CONFLICT', '事件幂等键对应不同内容或归属');
      return e;
    }
    const seq = this.get(
      'SELECT CAST(next_sequence AS TEXT) AS seq FROM conversations WHERE id=?',
      scope.conversationId,
    )!.seq as string;
    if (BigInt(seq) >= 9223372036854775807n)
      throw new UmiError('PROTOCOL_INVALID', '事件序号已达数据库上限');
    if (scope.runId && this.getRun(scope.runId).conversation_id !== scope.conversationId)
      throw new UmiError('PROTOCOL_INVALID', '运行与会话不匹配');
    const e = eventSchema.parse({
      ...scope,
      ...body,
      schemaVersion: 1,
      eventId: uid(),
      streamId: scope.conversationId,
      workspaceId: c.workspace_id,
      logEpoch: c.log_epoch,
      sequence: seq,
      occurredAt: this.now(),
      producer:
        body.type === 'input.accepted' || body.type === 'approval.decided' || body.type === 'question.answered'
          ? 'user'
          : body.type === 'model.delta' || body.type === 'usage.recorded'
            ? 'provider'
            : 'system',
      idempotencyKey: key,
    });
    const projected = reduceConversation(this.projectionState(scope.conversationId), e);
    this.run(
      'INSERT INTO events VALUES(?,?,?,?,?,?)',
      scope.conversationId,
      e.logEpoch,
      BigInt(seq),
      e.eventId,
      key,
      canonical(e),
    );
    this.run(
      'UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=?',
      scope.conversationId,
    );
    this.states.set(scope.conversationId, projected);
    if (scope.runId) {
      const map: Record<string, string> = {
        'run.started': 'running',
        'run.resumed': 'running',
        'run.waiting': 'waiting_permission',
        'run.stop_requested': 'stopping',
        'run.stopped': 'stopped',
        'run.interrupted': 'interrupted',
        'run.recovery_started': 'recovering',
        'run.recovery_required': 'recovery_required',
        'run.completed': 'completed',
        'run.failed': 'failed',
      };
      const next = map[e.type];
      if (next) this.run('UPDATE runs SET status=? WHERE id=?', next, scope.runId);
      if (e.type === 'run.phase_changed')
        this.run('UPDATE runs SET phase=? WHERE id=?', e.payload.phase, scope.runId);
      if (e.type === 'run.waiting')
        this.run("UPDATE runs SET phase='waiting' WHERE id=?", scope.runId);
      if (e.type === 'run.stop_requested')
        this.run('UPDATE runs SET stop_requested=1 WHERE id=?', scope.runId);
      if (['run.completed', 'run.failed', 'run.stopped'].includes(e.type))
        this.run(
          'UPDATE environments SET active_run_id=NULL WHERE active_run_id=?',
          scope.runId,
        );
    }
    if (scope.runId && ['run.interrupted', 'run.stopped', 'run.recovery_required', 'run.failed', 'tool.settled', 'tool.reconciled'].includes(e.type)) this.recordTerminalNotice(scope.runId);
    return e;
  }
  commit(scope: EventScope, body: EventBody, update?: () => void): WorkEvent {
    try {
      return this.transaction(() => {
        update?.();
        return this.append(scope, body);
      });
    } catch (error) {
      // 执行说明写入失败时，回滚整份说明，仍尝试保存诚实的中断/停止事实。
      // 若连这个事实也不能落库，原错误继续向上传递，不能宣称保存成功。
      if (!scope.runId || !['run.interrupted', 'run.stopped', 'run.recovery_required', 'run.failed'].includes(body.type) ||
          !String((error as { code?: string }).code ?? '').includes('SQLITE')) throw error;
      this.recordingFailureSummary = true;
      try {
        return this.transaction(() => this.append(scope, body.type === 'run.stopped'
          ? { type: 'run.stopped', payload: { reason: '用户停止已记录；执行说明未能完整保存。' } }
          : { type: 'run.interrupted', payload: { code: 'PERSISTENCE_FAILED', reason: '执行说明未能完整保存；已有记录保留，需恢复核验。' } }));
      } finally { this.recordingFailureSummary = false; }
    }
  }
  commitModelDeltas(scope: EventScope, generation: number, deltas: Extract<EventBody, { type: 'model.delta' }>[]): void {
    if (!deltas.length || deltas.length > 64 || deltas.some(d => d.type !== 'model.delta'))
      throw new UmiError('PROTOCOL_INVALID', '模型片段批次无效');
    this.transaction(() => {
      const run = this.getRun(scope.runId!), env = this.environment(run.environment_id);
      // 允许停止请求后刷新已观察片段，但不得给新租约或终态追加文字。
      if (run.generation !== generation || env.active_run_id !== run.id ||
          !['running', 'stopping'].includes(run.status))
        throw new UmiError('LEASE_LOST', '模型片段所属执行权已失效');
      for (const delta of deltas) this.append(scope, delta);
    });
  }
  events(conversationId: string, after?: Cursor, limit?: number): WorkEvent[] {
    const c = this.conversation(conversationId);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 128))
      throw new UmiError('PROTOCOL_INVALID', '事件批次上限无效');
    if (after) {
      cursorSchema.parse(after);
      if (
        after.streamId !== conversationId ||
        after.logEpoch !== c.log_epoch ||
        BigInt(after.sequence) >= BigInt(String(c.next_sequence))
      )
        throw new UmiError('CURSOR_INVALID', '重连游标与持久会话不一致');
    }
    return this.all(
      'SELECT payload FROM events WHERE conversation_id=? AND log_epoch=? AND sequence>? ORDER BY sequence' +
        (limit === undefined ? '' : ' LIMIT ?'),
      conversationId,
      c.log_epoch as string,
      BigInt(after?.sequence ?? '0'),
      ...(limit === undefined ? [] : [limit]),
    ).map((r) => eventSchema.parse(JSON.parse(r.payload as string)));
  }
  private projectionState(conversationId: string): ConversationState {
    let state = this.states.get(conversationId);
    if (!state) {
      const c = this.conversation(conversationId);
      state = initialState(conversationId, c.log_epoch as string);
      // 冷重放逐条校验并消费，避免同时保留所有数据库行和解析后的巨大事件数组。
      // 运行态与历史仍使用同一个纯归约器，原始片段不合并、不删除。
      for (const row of this.db.prepare('SELECT payload FROM events WHERE conversation_id=? AND log_epoch=? ORDER BY sequence').iterate(conversationId, c.log_epoch as string))
        state = reduceConversation(state, eventSchema.parse(JSON.parse(row.payload as string)));
      this.states.set(conversationId, state);
    }
    return state;
  }
  snapshot(conversationId: string): ConversationState {
    return structuredClone(this.projectionState(conversationId));
  }
  // 桌面只读取用户消息的接收序号；不解码全部模型原文，也不逐条重查。
  userMessages(conversationId: string): MessageRow[] {
    this.conversation(conversationId);
    return this.all(
      "SELECT m.*,CAST(e.sequence AS TEXT) AS projection_sequence FROM messages m JOIN events e ON e.event_id=m.commit_event_id WHERE m.conversation_id=? AND m.role='user' ORDER BY e.sequence",
      conversationId,
    ).map((r) => this.historyRow(r));
  }
  messages(conversationId: string): MessageRow[] {
    this.conversation(conversationId);
    return this.all(
      `SELECT m.*,CAST(COALESCE((SELECT a.sequence FROM events a WHERE a.conversation_id=m.conversation_id AND
      json_extract(a.payload,'$.type')='input.applied' AND json_extract(a.payload,'$.payload.messageId')=m.id LIMIT 1),e.sequence) AS TEXT) AS projection_sequence
      FROM messages m JOIN events e ON e.event_id=m.commit_event_id WHERE m.conversation_id=? ORDER BY e.sequence`,
      conversationId,
    ).map((r) => {
      const payload = messageSchema.parse(JSON.parse(r.payload as string));
      if (hash(payload) !== r.hash || payload.role !== r.role)
        throw new UmiError('PROTOCOL_INVALID', '原始消息内容、角色或指纹不一致');
      return {
        id: r.id as string,
        conversationId: r.conversation_id as string,
        runId: r.run_id as string,
        userTurnId: r.user_turn_id as string | null,
        modelTurnId: r.turn_id as string | null,
        modelAttemptId: r.attempt_id as string | null,
        role: r.role as string,
        createdAt: r.created_at as string,
        applied: r.applied === 1,
        projectionSequence: r.projection_sequence as string,
        payload,
      };
    });
  }
  // 历史检索不重建上下文顺序，也不解析未匹配消息的思考与工具载荷。
  searchMessages(
    conversationId: string,
    q: { query: string; role: string; from?: string; to?: string; limit: number },
  ): { rows: MessageRow[]; total: number } {
    this.conversation(conversationId);
    const where = ['conversation_id=?', "instr(json_extract(payload,'$.content'),?)>0"],
      args: (string | number)[] = [conversationId, q.query];
    if (q.role !== 'all') {
      where.push('role=?');
      args.push(q.role);
    }
    if (q.from) {
      where.push('created_at>=?');
      args.push(q.from);
    }
    if (q.to) {
      where.push('created_at<=?');
      args.push(q.to);
    }
    const total = Number(
      this.get(`SELECT count(*) n FROM messages WHERE ${where.join(' AND ')}`, ...args)!
        .n,
    );
    const rows = this.all(
      `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY rowid LIMIT ?`,
      ...args,
      q.limit,
    ).map((r) => this.historyRow(r));
    return { rows, total };
  }
  private historyRow(r: Row): MessageRow {
    const payload = messageSchema.parse(JSON.parse(r.payload as string));
    if (hash(payload) !== r.hash || payload.role !== r.role)
      throw new UmiError('PROTOCOL_INVALID', '历史原文指纹不一致');
    return {
      id: r.id as string,
      conversationId: r.conversation_id as string,
      runId: r.run_id as string,
      userTurnId: r.user_turn_id as string | null,
      modelTurnId: r.turn_id as string | null,
      modelAttemptId: r.attempt_id as string | null,
      role: r.role as string,
      createdAt: r.created_at as string,
      applied: r.applied === 1,
      projectionSequence:
        (r.projection_sequence as string | undefined) ??
        (this.get(
          'SELECT CAST(sequence AS TEXT) seq FROM events WHERE event_id=?',
          r.commit_event_id as string,
        )?.seq as string | undefined) ??
        '0',
      payload,
    };
  }
  messageById(conversationId: string, messageId: string): MessageRow | undefined {
    this.conversation(conversationId);
    const r = this.get(
      'SELECT * FROM messages WHERE conversation_id=? AND id=?',
      conversationId,
      messageId,
    );
    return r ? this.historyRow(r) : undefined;
  }
  runtimeFacts(environmentId: string, projection?: ConversationState): unknown {
    const env = this.environment(environmentId);
    const conversationId = this.get(
      'SELECT id FROM conversations WHERE environment_id=?',
      environmentId,
    )!.id as string;
    const state = projection ?? this.snapshot(conversationId);
    return {
      initialResources: this.all(
        'SELECT id candidateId,path FROM resource_candidates WHERE environment_id=? AND initial=1',
        environmentId,
      ).map((r) => ({
        ...r,
        materializationError:
          state.resources[r.candidateId as string]?.materializationError ?? null,
      })),
      resourceFailures: Object.entries(state.resources)
        .filter(([, r]) => r.materializationError)
        .map(([resourceId, r]) => ({
          resourceId,
          path: state.candidates[resourceId]?.path,
          ...r.materializationError,
        })),
      incompleteMaterializations: Object.entries(state.materializations)
        .filter(([, m]) => m.status !== 'ready')
        .map(([mountId, m]) => ({ mountId, ...m })),
      mounts: this.all(
        `SELECT m.id mountId,m.resource_id resourceId,m.source_root sourceRoot,m.baseline_ref baselineRef,rs.scope resourceScope,
      EXISTS(SELECT 1 FROM capabilities c WHERE c.resource_id=m.resource_id AND c.environment_id=m.environment_id AND (c.run_id IS NULL OR c.run_id=?) AND c.access='edit') canEdit
      FROM mounts m LEFT JOIN resource_scopes rs ON rs.resource_id=m.resource_id WHERE m.environment_id=? AND EXISTS(SELECT 1 FROM capabilities c WHERE c.resource_id=m.resource_id AND c.environment_id=m.environment_id AND (c.run_id IS NULL OR c.run_id=?))`,
        env.active_run_id,
        env.id,
        env.active_run_id,
      ).map((r) => ({
        ...r,
        resourceScope: r.resourceScope
          ? JSON.parse(r.resourceScope as string)
          : { kind: 'directory' },
        canEdit: r.canEdit === 1,
        excluded: state.resources[r.resourceId as string]?.excluded ?? [],
      })),
    };
  }
  contextMemory(conversationId: string) {
    return new MemoryRepository(this).load(conversationId);
  }
  contextSourceFingerprint(runId: string) {
    return new MemoryRepository(this).fingerprint(runId);
  }
  resolveMemorySource(conversationId: string, source: MemorySource) {
    return new MemoryRepository(this).source(conversationId, source);
  }
  saveMemory(executionId: string, value: MemoryValue) {
    return new MemoryRepository(this).save(executionId, value);
  }
  accessibleArtifact(conversationId: string, artifactId: string) {
    return new MemoryRepository(this).accessible(conversationId, artifactId);
  }
  startMaintenance(plan: MaintenancePlan, generation: number) {
    return new MemoryRepository(this).start(plan, generation);
  }
  finishMaintenance(
    plan: MaintenancePlan,
    summary: Summary | null,
    raw: unknown,
    usage: unknown,
    generation: number,
  ) {
    new MemoryRepository(this).finish(plan, summary, raw, usage, generation);
  }
  failMaintenance(
    plan: MaintenancePlan,
    code: string,
    generation: number,
    raw?: unknown,
    usage?: unknown,
  ) {
    new MemoryRepository(this).fail(plan, code, generation, raw, usage);
  }
  interruptedMaintenance(runId: string, baseVersion: number) {
    // 适配器内只读维护投影，不向领域暴露可变状态，也不复制完整会话历史。
    const maintenance = this.projectionState(this.getRun(runId).conversation_id).memory.maintenance;
    return Object.values(maintenance).some(m =>
      m.runId === runId && m.status === 'failed' && m.code === 'MAINTENANCE_INTERRUPTED' &&
      this.readArtifact<MaintenancePlan>(m.planRef).baseVersion === baseVersion);
  }
  maintenanceCount(runId: string, modelOnly = false) {
    if (modelOnly)
      return this.all(
        'SELECT plan_ref FROM context_maintenance WHERE run_id=?',
        runId,
      ).filter(
        (row) =>
          this.readArtifact<MaintenancePlan>(row.plan_ref as string).request !== null,
      ).length;
    return Number(
      this.get('SELECT count(*) n FROM context_maintenance WHERE run_id=?', runId)!.n,
    );
  }
  message(
    scope: EventScope,
    payload: WireMessage,
    applied = true,
    messageId = uid(),
  ): string {
    const parsed = messageSchema.parse(payload),
      digest = hash(parsed);
    const e = this.append(scope, {
      type: payload.role === 'user' ? 'input.accepted' : 'message.committed',
      payload: { messageId, hash: digest },
    });
    this.run(
      'INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      messageId,
      scope.conversationId,
      scope.runId!,
      scope.userTurnId ?? null,
      scope.modelTurnId ?? null,
      scope.modelAttemptId ?? null,
      payload.role,
      canonical(parsed),
      digest,
      e.occurredAt,
      applied ? 1 : 0,
      e.eventId,
    );
    return messageId;
  }
  acceptInput(
    conversationId: string,
    commandId: string,
    text: string,
    attachmentIds: string[] = [],
  ) {
    if (!text.trim() || text.length > 2_000_000)
      throw new UmiError('PROTOCOL_INVALID', '输入为空或过长');
    const requestHash = hash(attachmentIds.length ? { text, attachmentIds } : { text });
    return this.transaction(() => {
      const existing = this.get(
        'SELECT * FROM commands WHERE conversation_id=? AND id=?',
        conversationId,
        commandId,
      );
      if (existing) {
        if (existing.hash !== requestHash)
          throw new UmiError('COMMAND_CONFLICT', '相同命令 ID 对应不同输入');
        return JSON.parse(existing.receipt as string) as {
          runId: string;
          messageId: string;
          userTurnId: string;
        };
      }
      const c = this.conversation(conversationId),
        env = this.environment(c.environment_id as string);
      if (
        this.get(
          'SELECT archived FROM conversation_views WHERE conversation_id=?',
          conversationId,
        )?.archived === 1
      )
        throw new UmiError('RUN_STATE', '会话已归档');
      if (
        new Set(attachmentIds).size !== attachmentIds.length ||
        attachmentIds.length > 8
      )
        throw new UmiError('PROTOCOL_INVALID', '附件身份重复或数量超限');
      for (const id of attachmentIds) {
        const attachment = this.attachment(conversationId, id);
        if (
          String(attachment.mime).startsWith('image/') &&
          this.settings(conversationId).model !== 'deepseek-flash'
        )
          throw new UmiError(
            'PROTOCOL_INVALID',
            '当前模型不支持图片，请切换至 DeepSeek Flash',
          );
        if (
          this.get('SELECT message_id FROM message_attachments WHERE attachment_id=?', id)
        )
          throw new UmiError('COMMAND_CONFLICT', '附件已属于另一条消息');
      }
      let runId = env.active_run_id;
      if (!runId) {
        runId = uid();
        this.run(
          "INSERT INTO runs(id,conversation_id,environment_id,status) VALUES(?,?,?,'queued')",
          runId,
          conversationId,
          env.id,
        );
        this.run('UPDATE environments SET active_run_id=? WHERE id=?', runId, env.id);
        this.append(
          { conversationId, runId },
          { type: 'run.created', payload: { environmentId: env.id } },
        );
      }
      const userTurnId = uid(),
        messageId = this.message(
          { conversationId, runId, userTurnId },
          { role: 'user', content: text },
          false,
        );
      for (const id of attachmentIds)
        this.run('INSERT INTO message_attachments VALUES(?,?)', messageId, id);
      const receipt = { runId, messageId, userTurnId };
      this.run(
        'INSERT INTO commands VALUES(?,?,?,?)',
        conversationId,
        commandId,
        requestHash,
        canonical(receipt),
      );
      return receipt;
    });
  }
  applyInputs(runId: string) {
    const r = this.getRun(runId);
    this.transaction(() => {
      for (const m of this.messages(r.conversation_id).filter(
        (m) => m.runId === runId && !m.applied,
      )) {
        this.run('UPDATE messages SET applied=1 WHERE id=?', m.id);
        this.append(
          { conversationId: r.conversation_id, runId, userTurnId: m.userTurnId! },
          { type: 'input.applied', payload: { messageId: m.id } },
        );
      }
    });
  }
  updateSettings(conversationId: string, settings: Settings) {
    const value = settingsSchema.parse(settings);
    this.transaction(() => {
      this.run(
        'UPDATE conversations SET settings=?,settings_version=settings_version+1 WHERE id=?',
        canonical(value),
        conversationId,
      );
      this.append(
        { conversationId },
        {
          type: 'settings.changed',
          payload: {
            version: this.conversation(conversationId).settings_version as number,
          },
        },
      );
    });
  }
  tool(id: string): ToolRow {
    const r = this.get('SELECT * FROM tool_executions WHERE id=?', id);
    if (!r) throw new UmiError('NOT_FOUND', '工具执行不存在');
    return r as unknown as ToolRow;
  }
  tools(runId: string): ToolRow[] {
    return this.all(
      'SELECT * FROM tool_executions WHERE run_id=? ORDER BY rowid',
      runId,
    ) as unknown as ToolRow[];
  }
  approval(id: string): ApprovalRow {
    const r = this.get('SELECT * FROM approval_requests WHERE id=?', id);
    if (!r) throw new UmiError('NOT_FOUND', '批准请求不存在');
    return r as unknown as ApprovalRow;
  }
  private recordingFailureSummary = false;
  // 终态事务保存可见说明；未闭合的工具组先结算，避免插断历史配对。
  private recordTerminalNotice(runId: string) {
    if (this.recordingFailureSummary) return;
    const run = this.getRun(runId);
    if (!['interrupted', 'stopped', 'recovery_required', 'failed'].includes(run.status)) return;
    const messages = this.messages(run.conversation_id);
    if (run.status !== 'stopped' && messages.some(m => m.runId === runId && !m.applied)) return;
    const input = messages.findLast(m => m.runId === runId && m.role === 'user' && (m.applied || run.status === 'stopped'));
    if (!input) return;
    const state = this.snapshot(run.conversation_id).runs[runId]!;
    // 新输入和存储故障不能被旧收尾覆盖；存储失败时只保留可确认的错误状态。
    if (['CONTEXT_SOURCE_CHANGED', 'PERSISTENCE_FAILED'].includes(state.code ?? '')) return;
    if (state.finalMessageId && messages.some(m => m.id === state.finalMessageId && m.payload.content.trim())) return;
    const code = run.status === 'stopped' ? 'STOPPED' : run.status === 'recovery_required' ? 'TOOL_OUTCOME_UNKNOWN' : state.code ?? 'PROVIDER_INTERRUPTED';
    if (state.failureSummary?.inputId === input.id && state.failureSummary.code === code && BigInt(state.failureSummary.sequence) > BigInt(state.activationSequence ?? '0')) return;
    const tools = this.tools(runId);
    if (tools.some(t => ['prepared', 'dispatched', 'unknown'].includes(t.state) && !t.result_ref)) return;
    const reason = state.reason ?? (run.status === 'stopped' ? '用户已停止执行。' : '执行进程退出，等待核验恢复。');
    const scope = { conversationId: run.conversation_id, runId };
    const text = runConclusion(run, reason, code, tools);
    if (state.failureSummary?.inputId === input.id && state.failureSummary.text === text) return;
    this.recordingFailureSummary = true;
    try {
      const messageId = this.message(scope, { role: 'assistant', content: text });
      this.append(scope, { type: 'run.failure_summary', payload: { messageId, inputId: input.id, text } });
    } finally { this.recordingFailureSummary = false; }
  }
  checkLease(runId: string, generation: number) {
    const r = this.getRun(runId),
      e = this.environment(r.environment_id);
    if (r.generation !== generation || e.active_run_id !== runId || r.stop_requested)
      throw new UmiError('LEASE_LOST', '执行权失效或任务已停止');
  }
  claim(runId: string, recovery = false): number {
    return this.transaction(() => {
      const r = this.getRun(runId),
        e = this.environment(r.environment_id);
      if (e.active_run_id && e.active_run_id !== runId) {
        const owner = this.getRun(e.active_run_id);
        if (
          !recovery ||
          owner.generation !== 0 ||
          !['queued', 'recovery_required'].includes(owner.status)
        )
          throw new UmiError('ENVIRONMENT_BUSY', '环境正在运行其他任务');
      }
      // claim 允许模型先处理新原话；未决副作用在派发层继续阻止新修改。
      if (['completed', 'failed'].includes(r.status))
        throw new UmiError('RUN_TERMINAL', '运行已结束');
      if (!recovery && r.status === 'stopped')
        throw new UmiError('STOPPED', '明确停止后必须主动恢复');
      this.run(
        'UPDATE runs SET generation=generation+1,stop_requested=0 WHERE id=?',
        runId,
      );
      this.run('UPDATE environments SET active_run_id=? WHERE id=?', runId, e.id);
      const generation = r.generation + 1;
      this.append(
        { conversationId: r.conversation_id, runId },
        {
          type: recovery ? 'run.recovery_started' : 'run.started',
          payload: { generation },
        },
      );
      return generation;
    });
  }
  pendingEnvironment(environmentId: string): ToolRow[] {
    return this.all(
      "SELECT * FROM tool_executions WHERE environment_id=? AND state IN('prepared','dispatched','unknown') ORDER BY rowid",
      environmentId,
    ) as unknown as ToolRow[];
  }
  unresolvedEnvironment(environmentId: string): ToolRow[] {
    return this.all(
      "SELECT * FROM tool_executions WHERE environment_id=? AND state IN('dispatched','unknown')",
      environmentId,
    ) as unknown as ToolRow[];
  }
  questionRequest(conversationId: string, executionId: string) {
    const question = this.projectionState(conversationId).questions?.[executionId];
    return question ? structuredClone(question) : undefined;
  }
  preparedToolScope(t: ToolRow): EventScope {
    const r = this.getRun(t.run_id);
    return {
      conversationId: r.conversation_id,
      runId: r.id,
      modelTurnId: t.turn_id,
      modelAttemptId: t.attempt_id,
      callId: t.call_id,
      executionId: t.id,
    };
  }
  contextCarry(conversationId: string): ContextCarry | null {
    const row = this.get(
      'SELECT c.artifact_id FROM context_snapshots c JOIN model_requests q ON q.context_id=c.id WHERE c.conversation_id=? ORDER BY q.rowid DESC LIMIT 1',
      conversationId,
    );
    if (!row) return null;
    const value = this.readArtifact<ContextCarry>(row.artifact_id as string);
    // 旧快照保持只读；迁移前缺少来源或窗口身份时建立新视图。
    return Array.isArray(value.messages) && Array.isArray(value.sources) && value.projection
      ? value : null;
  }
  fileEvidenceExecutions(environmentId: string, mountId: string, path: string): string[] {
    // 只查询当前环境、同一文件成功的既有执行，不重放整段对话或读取其它文件正文。
    return this.all(`SELECT id FROM tool_executions WHERE environment_id=? AND state='succeeded'
      AND name IN('read_file','write_file','edit_file')
      AND CASE WHEN json_valid(args) THEN json_extract(args,'$.mountId') END=?
      AND CASE WHEN json_valid(args) THEN json_extract(args,'$.path') END=? ORDER BY rowid DESC`,
      environmentId,mountId,path).map(row=>String(row.id));
  }
  modelReceivedToolResult(executionId: string): boolean {
    const tool = this.tool(executionId);
    if (!tool.result_ref) return false;
    const expected = this.readArtifact<ToolResult>(tool.result_ref).data;
    if (expected == null) return false;
    const conversationId = this.getRun(tool.run_id).conversation_id;
    const requests = this.all(
      "SELECT q.artifact_id FROM model_requests q JOIN runs r ON r.id=q.run_id WHERE r.conversation_id=? AND EXISTS(SELECT 1 FROM messages m WHERE m.turn_id=q.turn_id AND m.role='assistant' AND m.applied=1) ORDER BY q.rowid DESC",
      conversationId,
    );
    for (const row of requests) {
      const request = this.readArtifact<PreparedRequest>(row.artifact_id as string);
      const messages = request.body.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message.role !== 'tool' || message.tool_call_id !== tool.provider_call_id) continue;
        try {
          const result = JSON.parse(message.content);
          if (result.outcome === 'succeeded' && hash(result.data) === hash(expected)) return true;
        } catch { /* 摘录或未知格式不能作为完整可见证据。 */ }
      }
    }
    return false;
  }
  persistRequest(
    scope: EventScope,
    requestId: string,
    contextId: string,
    request: PreparedRequest,
    context: unknown,
    generation: number,
  ) {
    this.transaction(() => {
      this.checkLease(scope.runId!, generation);
      const c = context as {
        estimatedInputTokens: number;
        inputCeiling: number;
        estimator: string;
        contextVersion?: number;
        metrics?: import('../../../protocol/src/memory.js').ContextMetrics;
        sourceFingerprint?: string;
      };
      if (
        c.sourceFingerprint &&
        c.sourceFingerprint !== this.contextSourceFingerprint(scope.runId!)
      )
        throw new UmiError(
          'CONTEXT_SOURCE_CHANGED',
          '实际请求冻结前来源改变，未派发模型',
        );
      const contextRef = this.artifact(context, 'context'),
        requestRef = this.artifact(request, 'model-request');
      this.run(
        'INSERT INTO context_snapshots VALUES(?,?,?,?)',
        contextId,
        scope.conversationId,
        c.contextVersion ?? 1,
        contextRef,
      );
      this.run(
        'INSERT INTO model_requests VALUES(?,?,?,?,?,?)',
        requestId,
        scope.runId!,
        scope.modelTurnId!,
        contextId,
        requestRef,
        hash(request),
      );
      this.run('UPDATE runs SET model_turns=model_turns+1 WHERE id=?', scope.runId!);
      this.append(scope, {
        type: 'context.snapshot_created',
        payload: {
          contextId,
          requestId,
          estimatedInputTokens: c.estimatedInputTokens,
          inputCeiling: c.inputCeiling,
          estimator: c.estimator,
          ...(c.metrics ? { metrics: c.metrics } : {}),
        },
      });
      this.append(scope, {
        type: 'model.request_prepared',
        payload: { requestId, contextId },
      });
    });
  }
  persistResponse(
    scope: EventScope,
    message: WireMessage,
    raw: unknown,
    usage: unknown,
    requestId: string,
    generation: number,
    finishReason: string,
  ): string {
    return this.transaction(() => {
      this.checkLease(scope.runId!, generation);
      const blocks = this.snapshot(scope.conversationId).blocks.filter(
        (b) => b.attemptId === scope.modelAttemptId,
      );
      if (
        blocks
          .filter((b) => b.kind === 'text')
          .map((b) => b.text)
          .join('') !== message.content ||
        blocks
          .filter((b) => b.kind === 'reasoning')
          .map((b) => b.text)
          .join('') !== (message.reasoning_content ?? '')
      )
        throw new UmiError('PROTOCOL_INVALID', '已提交分片与完整模型消息不一致');
      const responseRef = this.artifact(raw, 'provider-response');
      if (usage !== null) {
        const usageRef = this.artifact(usage, 'usage');
        this.append(scope, { type: 'usage.recorded', payload: { requestId, usageRef } });
      }
      this.append(scope, {
        type: 'model.attempt_completed',
        payload: { finishReason, responseRef },
      });
      const messageId = this.message(scope, message);
      const env = this.environment(this.getRun(scope.runId!).environment_id);
      for (const call of message.tool_calls ?? []) {
        const executionId = uid(),
          callId = uid();
        const requestHash = hash({
          name: call.function.name,
          args: call.function.arguments,
          environmentId: env.id,
          revision: env.revision,
        });
        this.run(
          "INSERT INTO tool_executions(id,call_id,run_id,turn_id,attempt_id,provider_call_id,name,args,request_hash,environment_id,revision,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared')",
          executionId,
          callId,
          scope.runId!,
          scope.modelTurnId!,
          scope.modelAttemptId!,
          call.id,
          call.function.name,
          call.function.arguments,
          requestHash,
          env.id,
          env.revision,
        );
        this.append(
          { ...scope, callId, executionId },
          {
            type: 'tool.prepared',
            payload: { name: call.function.name, providerCallId: call.id },
          },
        );
      }
      return messageId;
    });
  }
  // 本地受阻正文有真实消息和事件，不冒充模型响应或增加计费 usage。
  persistFailureSummary(runId: string, text: string, generation: number, code?: string): string {
    return this.transaction(() => {
      this.checkLease(runId, generation);
      const run = this.getRun(runId), scope = { conversationId: run.conversation_id, runId };
      if (this.messages(run.conversation_id).some(m => m.runId === runId && !m.applied))
        throw new UmiError('CONTEXT_SOURCE_CHANGED', '新要求阻止提交旧收尾');
      const inputId = this.messages(run.conversation_id).filter(m => m.runId === runId && m.role === 'user' && m.applied).at(-1)?.id;
      if (!inputId) throw new UmiError('PROTOCOL_INVALID', '受阻说明缺少用户原话');
      const existing = this.snapshot(run.conversation_id).runs[runId]?.failureSummary;
      if (existing?.inputId === inputId && existing.text === text && (!code || existing.code === code)) return existing.messageId;
      // 与正文同事务保存可恢复的终止原因；不新增事件类型或计费请求。
      if (code) {
        this.recordingFailureSummary = true;
        try { this.append(scope, { type: 'run.interrupted', payload: { code, reason: '正在保存本轮执行说明。' } }); }
        finally { this.recordingFailureSummary = false; }
      }
      const messageId = this.message(scope, { role: 'assistant', content: text });
      this.append(scope, { type: 'run.failure_summary', payload: { messageId, inputId, text } });
      return messageId;
    });
  }
  requestApproval(
    toolId: string,
    context: ExecutionContext,
    description: string,
    generation: number,
  ): string {
    executionContextSchema.parse(context);
    return this.transaction(() => {
      const t = this.tool(toolId);
      this.checkLease(t.run_id, generation);
      const scope = this.preparedToolScope(t);
      this.checkExecutionContext(t, context);
      const approvalId = uid(),
        contextRef = this.artifact(context, 'execution-context'),
        requestHash = hash({ name: t.name, args: t.args, context });
      this.run(
        'UPDATE tool_executions SET approval_id=?,context_ref=?,request_hash=?,revision=? WHERE id=?',
        approvalId,
        contextRef,
        requestHash,
        context.environmentRevision,
        toolId,
      );
      this.run(
        'INSERT INTO approval_requests VALUES(?,?,?,?,?,NULL,1)',
        approvalId,
        toolId,
        t.run_id,
        requestHash,
        description,
      );
      this.append(scope, {
        type: 'approval.requested',
        payload: { approvalId, requestHash, name: t.name, description },
      });
      this.append(
        { conversationId: scope.conversationId, runId: t.run_id },
        { type: 'run.waiting', payload: { approvalId } },
      );
      return approvalId;
    });
  }
  invalidateApproval(toolId: string, reason: string) {
    this.transaction(() => {
      const t = this.tool(toolId);
      if (!t.approval_id) return;
      this.run('UPDATE approval_requests SET valid=0 WHERE id=?', t.approval_id);
      this.append(this.preparedToolScope(t), {
        type: 'approval.invalidated',
        payload: { approvalId: t.approval_id, reason },
      });
      this.run('UPDATE tool_executions SET approval_id=NULL WHERE id=?', toolId);
    });
  }
  decideApproval(conversationId: string, approvalId: string, decision: 'allow' | 'deny') {
    this.transaction(() => {
      const a = this.approval(approvalId),
        t = this.tool(a.execution_id),
        r = this.getRun(a.run_id);
      if (r.conversation_id !== conversationId)
        throw new UmiError('PROTOCOL_INVALID', '批准不属于当前会话');
      if (!a.valid || t.approval_id !== approvalId || r.stop_requested)
        throw new UmiError('APPROVAL_STALE', '批准对象已失效');
      if (a.decision) {
        if (a.decision !== decision)
          throw new UmiError('COMMAND_CONFLICT', '批准决定已提交');
        return;
      }
      this.run(
        'UPDATE approval_requests SET decision=? WHERE id=?',
        decision,
        approvalId,
      );
      this.append(this.preparedToolScope(t), {
        type: 'approval.decided',
        payload: { approvalId, decision },
      });
    });
  }
  dispatch(toolId: string, context: ExecutionContext, generation: number, effect = 'unknown') {
    executionContextSchema.parse(context);
    this.transaction(() => {
      const t = this.tool(toolId);
      this.checkLease(t.run_id, generation);
      this.checkExecutionContext(t, context);
      if (!['read', 'memory'].includes(effect) &&
          this.unresolvedEnvironment(t.environment_id).some((prior) => prior.id !== t.id))
        throw new UmiError('TOOL_OUTCOME_UNKNOWN', '环境仍有未决执行，未派发新的副作用');
      if (
        context.execution &&
        (context.execution.executionId !== t.id ||
          context.execution.leaseGeneration !== generation ||
          context.process)
      )
        throw new UmiError('PROTOCOL_INVALID', '中立执行身份/租约错误或混用 V1');
      if (t.state !== 'prepared')
        throw new UmiError('TOOL_OUTCOME_UNKNOWN', '工具已派发，必须核验后处理');
      if (this.environment(t.environment_id).revision !== context.environmentRevision)
        throw new UmiError('APPROVAL_STALE', '环境修订已改变');
      const requestHash = hash({ name: t.name, args: t.args, context });
      if (
        (context.process ||
          context.execution ||
          ['run_command', 'run_shell', 'export_outputs'].includes(t.name) ||
          context.output?.kind === 'export') &&
        !t.approval_id
      )
        throw new UmiError(
          'APPROVAL_REQUIRED',
          '宿主执行或成果导出在派发层必须有具体批准',
        );
      if (t.approval_id) {
        const a = this.approval(t.approval_id);
        if (
          a.execution_id !== t.id ||
          a.run_id !== t.run_id ||
          !a.valid ||
          a.decision !== 'allow' ||
          a.request_hash !== requestHash
        )
          throw new UmiError('APPROVAL_STALE', '执行内容与批准不一致');
      }
      const contextRef =
        t.approval_id && t.context_ref
          ? t.context_ref
          : this.artifact(context, 'execution-context');
      this.run(
        "UPDATE tool_executions SET state='dispatched',context_ref=?,request_hash=?,revision=? WHERE id=?",
        contextRef,
        requestHash,
        context.environmentRevision,
        toolId,
      );
      this.append(this.preparedToolScope(t), {
        type: 'tool.dispatch_intent',
        payload: { contextRef },
      });
    });
  }
  private checkExecutionContext(t: ToolRow, context: ExecutionContext) {
    const env = this.environment(t.environment_id);
    if (
      context.environmentId !== env.id ||
      context.environmentRevision !== env.revision ||
      context.bindingRoot !== env.root ||
      context.rootIdentity !== env.root_identity ||
      context.locations.some((l) => l.environmentId !== env.id)
    )
      throw new UmiError('APPROVAL_STALE', '执行定位与持久环境绑定不一致');
  }
  assertApprovedExecution(executionId: string, context: ExecutionContext) {
    const t = this.tool(executionId), run = this.getRun(t.run_id);
    if (this.messages(run.conversation_id).some(m => m.runId === run.id && !m.applied)) {
      this.invalidateApproval(t.id, '释放前收到新用户消息，旧授权须重新判断');
      throw new UmiError('APPROVAL_STALE', '新用户要求尚未交给模型，原程序不会释放');
    }
    this.checkExecutionContext(t, context);
    if (t.state !== 'dispatched' || !t.approval_id)
      throw new UmiError('APPROVAL_REQUIRED', '原宿主执行未获批准并派发');
    const a = this.approval(t.approval_id),
      digest = hash({ name: t.name, args: t.args, context });
    if (
      a.execution_id !== t.id ||
      a.run_id !== t.run_id ||
      !a.valid ||
      a.decision !== 'allow' ||
      a.request_hash !== digest ||
      t.request_hash !== digest
    )
      throw new UmiError('APPROVAL_STALE', '宿主释放前批准核验失败');
  }
  settle(
    toolId: string,
    result: ToolResult,
    generation: number,
    reconciled = false,
    mutated = false,
    inspectionExecutionId?: string,
  ) {
    result = singleResultBody(result);
    this.transaction(() => {
      const t = this.tool(toolId),
        r = this.getRun(t.run_id);
      if (r.generation !== generation)
        throw new UmiError('LEASE_LOST', '结果来自旧执行者');
      if (!['prepared', 'dispatched', 'unknown'].includes(t.state)) {
        if (t.result_ref && hash(singleResultBody(this.readArtifact<ToolResult>(t.result_ref))) === hash(result))
          return;
        throw new UmiError(
          'TOOL_ALREADY_SETTLED',
          '工具已有确定结果，不能再次改写或累计修订',
        );
      }
      const scope = this.preparedToolScope(t),
        resultRef = this.artifact(result, 'tool-result');
      const existed = this.messages(r.conversation_id).some(
        (m) =>
          m.payload.role === 'tool' &&
          m.payload.tool_call_id === t.provider_call_id &&
          m.modelAttemptId === t.attempt_id,
      );
      if (inspectionExecutionId) {
        const inspection = this.tool(inspectionExecutionId), current = this.getRun(inspection.run_id);
        if (!reconciled || inspection.name !== 'inspect_tool_execution' || inspection.state !== 'dispatched' ||
            current.conversation_id !== r.conversation_id || inspection.environment_id !== t.environment_id)
          throw new UmiError('PROTOCOL_INVALID', '核验反馈必须属于当前已派发检查工具');
        this.checkLease(current.id, current.generation);
      }
      const content = canonical(result);
      // 检查工具的配对结果承载新事实；不把 system 插入尚未闭合的工具组。
      const messageId = existed && inspectionExecutionId
        ? this.messages(r.conversation_id).find(m => m.payload.tool_call_id === t.provider_call_id && m.modelAttemptId === t.attempt_id)!.id
        : this.message(
        scope,
        existed
          ? { role: 'system', content: `中断执行核验更新：${content}` }
          : { role: 'tool', tool_call_id: t.provider_call_id, content },
      );
      this.run(
        'UPDATE tool_executions SET state=?,result_ref=? WHERE id=?',
        result.outcome,
        resultRef,
        toolId,
      );
      this.append(
        scope,
        reconciled
          ? {
              type: 'tool.reconciled',
              payload: {
                outcome: result.outcome,
                verification: result.verification ?? 'unknown',
                ...(inspectionExecutionId ? { inspectionExecutionId } : {}),
                resultRef,
                messageId,
              },
            }
          : {
              type: 'tool.settled',
              payload: { outcome: result.outcome, resultRef, messageId },
            },
      );
      if (mutated) {
        this.run(
          'UPDATE environments SET revision=revision+1 WHERE id=?',
          t.environment_id,
        );
        this.append(
          { conversationId: r.conversation_id, runId: r.id },
          {
            type: 'environment.revised',
            payload: {
              environmentId: t.environment_id,
              revision: this.environment(t.environment_id).revision,
            },
          },
        );
      }
    });
  }
  close() {
    if (this.closed) return;
    this.db.close();
    this.writerLock.release();
    this.closed = true;
  }
}
