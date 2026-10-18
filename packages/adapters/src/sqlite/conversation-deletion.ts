import { lstatSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { SqliteStore } from './store.js';
import { safeRoot } from '../host-files/paths.js';
import { UmiError } from '../../../protocol/src/model.js';

const active = ['queued','running','waiting_permission','stopping','recovering','recovery_required'];
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
type Selection = { table: string; where: string; args: string[] };

// 用户管理入口，不注册为模型工具。只删除会话事实与自有目录，不回滚源交付/导出。
export class ConversationDeletion {
  constructor(private readonly store: SqliteStore,
    private readonly removeDirectory = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })) {}

  private managedRoot(environmentId: string, root: string) {
    if (!/^[a-f0-9-]{36}$/i.test(environmentId))
      throw new UmiError('PERMISSION_DENIED', '托管环境身份不合法');
    const expected = join(this.store.dataRoot, 'environments', environmentId);
    if (!samePath(resolve(root), expected))
      throw new UmiError('PERMISSION_DENIED', '删除位置不属于会话的托管环境');
    safeRoot(this.store.dataRoot);
    safeRoot(join(this.store.dataRoot, 'environments'));
    for (const row of this.store.all('SELECT source_root FROM workspaces')) {
      const part = relative(expected, resolve(String(row.source_root)));
      if (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
        throw new UmiError('PERMISSION_DENIED', '仍有工作区引用此托管目录，未删除其来源文件');
    }
    return expected;
  }
  cleanupPending() {
    for (const row of this.store.all('SELECT * FROM conversation_deletions')) {
      try {
        if (this.store.get('SELECT id FROM environments WHERE id=?', row.environment_id!))
          throw new UmiError('RUN_STATE', '环境仍在使用，不能清理');
        const root = this.managedRoot(String(row.environment_id), String(row.root));
        try { lstatSync(root); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          this.store.run('DELETE FROM conversation_deletions WHERE environment_id=?', row.environment_id!);
          continue;
        }
        // 根身份/祖先链接核验在递归删除前进行；内部链接由rm移除链接本身，不跟随目标。
        safeRoot(root, String(row.root_identity));
        this.removeDirectory(root);
        this.store.run('DELETE FROM conversation_deletions WHERE environment_id=?', row.environment_id!);
      } catch (error) {
        const code = error instanceof UmiError ? error.code : (error as NodeJS.ErrnoException).code ?? 'CLEANUP_FAILED';
        this.store.run('UPDATE conversation_deletions SET last_error=? WHERE environment_id=?', code, row.environment_id!);
      }
    }
  }

  // JSON里有明确资料引用，也有嵌套成字符串的工具回执/模型历史；只在worker核验。
  private references(values: Iterable<unknown>, ids: Set<string>) {
    const refs = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        if (ids.has(value)) refs.add(value);
        for (const match of value.matchAll(/(?:output-(?:intent|receipt)-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-\d+)?/gi))
          if (ids.has(match[0])) refs.add(match[0]);
        if (/^\s*[\[{]/.test(value)) {
          let parsed: unknown;
          try { parsed = JSON.parse(value); } catch { return; }
          visit(parsed);
        }
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === 'object') {
        for (const [key,item] of Object.entries(value)) {
          if (ids.has(key)) refs.add(key); // 来源索引也可能将资料ID用作对象键。
          visit(item);
        }
      }
    };
    for (const value of values) visit(value);
    return refs;
  }
  private closure(roots: Set<string>, ids: Set<string>) {
    const pending = [...roots];
    for (let i = 0; i < pending.length; i++) {
      const refs = this.references([this.store.readArtifact(pending[i]!)], ids);
      for (const ref of refs) if (!roots.has(ref)) { roots.add(ref); pending.push(ref); }
    }
    return roots;
  }
  private exportRoots(toolIds: Set<string>, ids: Set<string>, roots: Set<string>) {
    // 导出意图/回执通过执行ID计算位置，不一定在JSON里出现其artifact主键。
    for (const id of ids) {
      const match = /^output-(?:intent|receipt)-(.+)-\d+$/.exec(id);
      if (match && toolIds.has(match[1]!)) roots.add(id);
    }
  }

  deleteArchived(conversationId: string) {
    const s = this.store;
    const result = s.transaction(() => {
      const c = s.conversation(conversationId), environmentId = String(c.environment_id), env = s.environment(environmentId);
      if (s.get('SELECT archived FROM conversation_views WHERE conversation_id=?', conversationId)?.archived !== 1)
        throw new UmiError('RUN_STATE', '请先归档会话，再永久删除');
      if (s.all('SELECT status FROM runs WHERE conversation_id=?', conversationId).some(r => active.includes(String(r.status))))
        throw new UmiError('RUN_STATE', '请先停止或核验活动任务');
      if (s.unresolvedEnvironment(environmentId).length)
        throw new UmiError('TOOL_OUTCOME_UNKNOWN', '会话仍有未知副作用，不能删除恢复证据');
      const root = this.managedRoot(environmentId, env.root);
      try { safeRoot(root, env.root_identity); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const runWhere = 'run_id IN(SELECT id FROM runs WHERE conversation_id=?)';
      const executionWhere = 'execution_id IN(SELECT id FROM tool_executions WHERE ' + runWhere + ')';
      const byConversation = (table: string): Selection => ({table,where:'conversation_id=?',args:[conversationId]});
      const byEnvironment = (table: string): Selection => ({table,where:'environment_id=?',args:[environmentId]});
      const selections: Selection[] = [
        {table:'message_attachments',where:'message_id IN(SELECT id FROM messages WHERE conversation_id=?) OR attachment_id IN(SELECT id FROM attachments WHERE conversation_id=?)',args:[conversationId,conversationId]},
        byConversation('attachments'), {table:'process_outputs',where:executionWhere,args:[conversationId]},
        {table:'process_executions',where:executionWhere,args:[conversationId]},
        {table:'delivery_items',where:'changeset_id IN(SELECT id FROM changesets WHERE environment_id=?)',args:[environmentId]},
        byEnvironment('changesets'), byEnvironment('capabilities'), byEnvironment('mounts'), byEnvironment('materializations'),
        {table:'resource_scopes',where:'resource_id IN(SELECT id FROM resource_candidates WHERE environment_id=?)',args:[environmentId]},
        byEnvironment('resources'), byEnvironment('resource_denials'), byEnvironment('resource_candidates'),
        byEnvironment('process_fingerprints'), byConversation('memory_entries'), byConversation('context_maintenance'),
        {table:'model_requests',where:runWhere,args:[conversationId]}, byConversation('context_snapshots'),
        {table:'approval_requests',where:runWhere,args:[conversationId]},
        {table:'tool_executions',where:runWhere,args:[conversationId]},
        byConversation('messages'), byConversation('commands'), byConversation('events'), byConversation('runs'),
        byConversation('conversation_views'), {table:'conversations',where:'id=?',args:[conversationId]},
        {table:'environments',where:'id=?',args:[environmentId]},
      ];
      const ids = new Set(s.all('SELECT id FROM artifacts').map(row => String(row.id)));
      const roots = new Set<string>(), toolIds = new Set(s.all('SELECT id FROM tool_executions WHERE ' + runWhere,conversationId).map(row => String(row.id)));
      for (const selection of selections) {
        const rows = s.db.prepare('SELECT * FROM ' + selection.table + ' WHERE ' + selection.where).iterate(...selection.args);
        for (const ref of this.references(rows, ids)) roots.add(ref);
      }
      this.exportRoots(toolIds,ids,roots);
      const candidates = this.closure(roots,ids);
      // 事务保存目录清理意图，也只在这里允许resource_scopes随所属环境删除。
      s.run('INSERT INTO conversation_deletions VALUES(?,?,?,?,NULL)',environmentId,root,env.root_identity,new Date().toISOString());
      for (const selection of selections)
        s.run('DELETE FROM ' + selection.table + ' WHERE ' + selection.where,...selection.args);
      s.run('DELETE FROM workspaces WHERE id=? AND NOT EXISTS(SELECT 1 FROM conversations WHERE workspace_id=?)',String(c.workspace_id),String(c.workspace_id));
      const liveRoots = new Set<string>();
      for (const table of s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
        const name = String(table.name);
        if (['artifacts','schema_migrations','conversation_deletions'].includes(name)) continue;
        const rows = s.db.prepare('SELECT * FROM "' + name.replaceAll('"','""') + '"').iterate();
        for (const ref of this.references(rows,ids)) liveRoots.add(ref);
      }
      this.exportRoots(new Set(s.all('SELECT id FROM tool_executions').map(row => String(row.id))),ids,liveRoots);
      const retained = this.closure(liveRoots,ids);
      // 最后一条会话删除时才回收无归属旧资料；否则只回收本次候选，避开其他在途资料。
      const garbage = s.get('SELECT id FROM conversations LIMIT 1') ? candidates : ids;
      let deletedArtifacts = 0;
      for (const id of garbage) if (!retained.has(id))
        deletedArtifacts += Number(s.run('DELETE FROM artifacts WHERE id=?',id).changes);
      if (s.all('PRAGMA foreign_key_check').length)
        throw new UmiError('PROTOCOL_INVALID', '删除关联核验失败，事务已回滚');
      return {deleted:true as const,deletedArtifacts,environmentId};
    });
    // 数据库提交后才移除目录。失败不冒充清理完成，重启重试，不恢复已删除会话。
    this.cleanupPending();
    return {...result,cleanupPending:Boolean(s.get('SELECT environment_id FROM conversation_deletions WHERE environment_id=?',result.environmentId))};
  }
}
