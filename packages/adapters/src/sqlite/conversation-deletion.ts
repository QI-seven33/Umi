import { EventBlocks } from './event-blocks.js';
import {hash} from '../../../agent/src/identity.js';
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
  private *rows(sql:string,args:string[]=[]):Iterable<unknown>{
    const query=this.store.db.prepare(sql);query.setReturnArrays(true);let first=true;
    for(const row of query.iterate(...args)){
      if(first){yield query.columns().map(c=>c.name);first=false;} // 保留自定义列名作为资料键的兼容语义。
      yield row;
    }
  }
  private references(values: Iterable<unknown>, ids: Set<string>) {
    const refs=new Set<string>();
    const opaqueIds=[...ids].some(id=>!/^(?:output-(?:intent|receipt)-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-\d+)?$/i.test(id));
    const visit=(value:unknown):void=>{
      if(typeof value==='string'){
        if(ids.has(value)){refs.add(value);return;}
        // 事件自身的身份占绝大多数；它们不是资料引用时无须再跑巨大候选前缀正则。
        if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))return;
        for(const match of value.matchAll(/(?:output-(?:intent|receipt)-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-\d+)?/gi))
          if(ids.has(match[0]))refs.add(match[0]);
        if((opaqueIds||value.includes('\\u'))&&/^\s*[\[{]/.test(value)){
          let parsed:unknown;try{parsed=JSON.parse(value);}catch{return;}visit(parsed);
        }
      }else if(Array.isArray(value)){for(const item of value)visit(item);}
      else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(ids.has(key))refs.add(key);visit(item);}
    };
    for(const value of values)visit(value);
    return refs;
  }
  private closure(roots: Set<string>, ids: Set<string>) {
    const pending = [...roots];
    const opaque=[...ids].some(id=>!/^(?:output-(?:intent|receipt)-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:-\d+)?$/i.test(id));
    for (let i = 0; i < pending.length && roots.size < ids.size; i++) {
      const ref=pending[i]!,row=this.store.get('SELECT kind,hash,content,json_valid(content) valid FROM artifacts WHERE id=?',ref);
      if(!row||!row.valid||hash(String(row.content))!==row.hash)throw new UmiError('PROTOCOL_INVALID','资料缺失、编码或指纹不一致，删除未提交');
      // 常规资料的规范JSON已保留所有ASCII引用，避免把巨大请求全文再建成对象树。
      // 压缩协议、转义或兼容ID仍沿原读取解码；不能省略隐藏在压缩块里的引用。
      const value=opaque||String(row.content).includes('\\u')||['provider-response','maintenance-response'].includes(String(row.kind))?this.store.readArtifact(ref):String(row.content);
      const refs = this.references([value], ids);
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
    return this.deleteMany(() => [conversationId], true)[0]!;
  }
  workspaceStatus(workspaceId: string) {
    const row=this.store.get('SELECT * FROM workspace_deletion_receipts WHERE workspace_id=?',workspaceId);
    if(!row)return {deleted:false as const,exists:Boolean(this.store.get('SELECT id FROM workspaces WHERE id=?',workspaceId))};
    const environmentIds=JSON.parse(String(row.environment_ids)) as string[];
    return {deleted:true as const,conversationIds:JSON.parse(String(row.conversation_ids)) as string[],completedAt:String(row.completed_at),
      cleanupPending:environmentIds.some(id=>Boolean(this.store.get('SELECT environment_id FROM conversation_deletions WHERE environment_id=?',id)))};
  }
  deleteWorkspace(workspaceId: string) {
    const prior=this.workspaceStatus(workspaceId);
    if(prior.deleted)return prior;
    this.deleteMany(() => {
      if (!this.store.get('SELECT id FROM workspaces WHERE id=?', workspaceId))
        throw new UmiError('NOT_FOUND', '工作区不存在');
      const ids = this.store.all('SELECT id FROM conversations WHERE workspace_id=? ORDER BY rowid', workspaceId).map(c => String(c.id));
      if (!ids.length) {
        this.store.run('DELETE FROM workspace_file_grants WHERE workspace_id=?', workspaceId);
        this.store.run('DELETE FROM workspaces WHERE id=?', workspaceId);
      }
      return ids;
    }, false, plans=>this.store.run('INSERT INTO workspace_deletion_receipts VALUES(?,?,?,?)',workspaceId,
      JSON.stringify(plans.map(p=>p.conversationId)),JSON.stringify(plans.map(p=>p.environmentId)),new Date().toISOString()));
    return this.workspaceStatus(workspaceId) as {deleted:true;conversationIds:string[];completedAt:string;cleanupPending:boolean};
  }

  // 整个工作区在同一事务中删除，任一活动/未知效果或关联失败都会回滚全部会话。
  private deleteMany(select: () => string[], requireArchived: boolean,
    completed?: (plans:{conversationId:string;environmentId:string}[])=>unknown) {
    const s = this.store;
    // 大批UUID索引删除会使默认小页缓存频繁换入换出。只在删除期间给连接
    // 至少64MiB的建议上限，事务后恢复原值；不降低同步等级或关闭外键。
    const cache=Number(s.get('PRAGMA cache_size')!.cache_size),pageSize=Number(s.get('PRAGMA page_size')!.page_size);
    const cacheKiB=cache<0?-cache:cache*pageSize/1024,raised=cacheKiB<65536;
    if(raised)s.db.exec('PRAGMA cache_size=-65536');
    let results;
    try {results = s.transaction(() => {
      // 先核验整组；任何会话未决都不能先清掉另一会话的恢复证据。
      const plans=select().map(conversationId => {
        const c = s.conversation(conversationId), environmentId = String(c.environment_id), env = s.environment(environmentId);
        if (requireArchived && s.get('SELECT archived FROM conversation_views WHERE conversation_id=?', conversationId)?.archived !== 1)
          throw new UmiError('RUN_STATE', '请先归档会话，再永久删除');
        if (s.all('SELECT status FROM runs WHERE conversation_id=?', conversationId).some(r => active.includes(String(r.status))))
          throw new UmiError('RUN_STATE', '请先停止或核验活动任务');
        if (s.unresolvedEnvironment(environmentId).length || s.get("SELECT id FROM file_changes WHERE environment_id=? AND state='intent' LIMIT 1", environmentId))
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
          byEnvironment('file_changes'), byEnvironment('direct_file_mounts'), byEnvironment('direct_file_environments'),
          byEnvironment('changesets'), byEnvironment('capabilities'), byEnvironment('mounts'), byEnvironment('materializations'),
          {table:'resource_scopes',where:'resource_id IN(SELECT id FROM resource_candidates WHERE environment_id=?)',args:[environmentId]},
          byEnvironment('resources'), byEnvironment('resource_denials'), byEnvironment('resource_candidates'),
          byEnvironment('process_fingerprints'), byConversation('memory_entries'), byConversation('context_maintenance'),
          {table:'model_requests',where:runWhere,args:[conversationId]}, byConversation('context_snapshots'),
          {table:'approval_requests',where:runWhere,args:[conversationId]},
          {table:'tool_executions',where:runWhere,args:[conversationId]},
          byConversation('messages'), byConversation('commands'), byConversation('events'), byConversation('event_blocks'), byConversation('runs'),
          byConversation('conversation_views'), {table:'conversations',where:'id=?',args:[conversationId]},
          {table:'environments',where:'id=?',args:[environmentId]},
        ];
        return {conversationId,environmentId,c,env,root,selections,runWhere};
      });
      const ids=new Set(s.all('SELECT id FROM artifacts').map(row=>String(row.id)));
      const last=Number(s.get('SELECT count(*) n FROM conversations')!.n)===plans.length;
      const roots=new Set<string>(),toolIds=new Set<string>();
      // 全部会话都删除时，候选就是全部资料，无须反复解码即将删除的模型历史。
      if(!last)for(const plan of plans) {
        for(const row of s.all('SELECT id FROM tool_executions WHERE '+plan.runWhere,plan.conversationId))toolIds.add(String(row.id));
        for(const selection of plan.selections) {
          // 显式按事件主键顺序读取，避免SQLite选用随机idempotency_key索引反复换页。
          const rows=selection.table==='event_blocks'?new EventBlocks(s.db).values(plan.conversationId):this.rows('SELECT * FROM '+selection.table+' WHERE '+selection.where+(selection.table==='events'?' ORDER BY log_epoch,sequence':''),selection.args);
          for(const ref of this.references(rows,ids))roots.add(ref);
        }
      }
      this.exportRoots(toolIds,ids,roots);
      const candidates=last?ids:this.closure(roots,ids);
      for(const {environmentId,root,env} of plans)
        s.run('INSERT INTO conversation_deletions VALUES(?,?,?,?,NULL)',environmentId,root,env.root_identity,new Date().toISOString());
      // 同类子记录先整组移除，才删除父记录。最后整组日志可以顺序删除，避免按会话索引反复定位。
      for(let i=0;i<(plans[0]?.selections.length??0);i++) {
        const table=plans[0]!.selections[i]!.table;
        if(table==='events'){
          const selection=JSON.stringify(plans.map(p=>p.conversationId));
          const count=last?0:Number(s.get('SELECT count(*) n FROM events WHERE conversation_id IN(SELECT value FROM json_each(?))',selection)!.n);
          const total=last?0:Number(s.get('SELECT count(*) n FROM events')!.n);
          const bulk=last||count>total/2;
          // 批量删除时避免为每条即将删除的delta再解析两次JSON局部索引。
          // 仅暂拆Umi自有索引，同事务按原SQL重建；失败时DDL与删除一起回滚。
          const indexes=bulk?s.all("SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN('events_applied_input','events_attempt_lifecycle')"):[];
          for(const index of indexes)s.db.exec('DROP INDEX "'+String(index.name).replaceAll('"','""')+'"');
          if(last)s.run('DELETE FROM events');
          else s.run('DELETE FROM events'+(bulk?' NOT INDEXED':'')+' WHERE conversation_id IN(SELECT value FROM json_each(?))',selection);
          for(const index of indexes)s.db.exec(String(index.sql));
          continue;
        }
        for(const plan of plans){const selection=plan.selections[i]!;s.run('DELETE FROM '+selection.table+' WHERE '+selection.where,...selection.args);}
      }
      for(const {c} of plans) {
        s.run('DELETE FROM workspace_file_grants WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM conversations WHERE workspace_id=?)',String(c.workspace_id),String(c.workspace_id));
        s.run('DELETE FROM workspaces WHERE id=? AND NOT EXISTS(SELECT 1 FROM conversations WHERE workspace_id=?)',String(c.workspace_id),String(c.workspace_id));
      }
      const liveRoots = new Set<string>();
      for (const table of s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
        const name = String(table.name);
        if (['artifacts','schema_migrations','conversation_deletions','conversation_projections','workspace_deletion_receipts'].includes(name)) continue;
        const rows = name==='event_blocks'?new EventBlocks(s.db).values():this.rows('SELECT * FROM "' + name.replaceAll('"','""') + '"');
        for (const ref of this.references(rows,ids)) liveRoots.add(ref);
      }
      this.exportRoots(new Set(s.all('SELECT id FROM tool_executions').map(row => String(row.id))),ids,liveRoots);
      const retained = this.closure(liveRoots,ids);
      // 最后一条会话删除时才回收无归属旧资料；否则只回收本次候选，避开其他在途资料。
      const garbage = candidates;
      let deletedArtifacts = 0;
      for (const id of garbage) if (!retained.has(id))
        deletedArtifacts += Number(s.run('DELETE FROM artifacts WHERE id=?',id).changes);
      if (s.all('PRAGMA foreign_key_check').length)
        throw new UmiError('PROTOCOL_INVALID', '删除关联核验失败，事务已回滚');
      completed?.(plans);
      return plans.map(({environmentId,conversationId},index)=>({deleted:true as const,deletedArtifacts:index===0?deletedArtifacts:0,environmentId,conversationId}));
    });} finally {if(raised)s.db.exec('PRAGMA cache_size='+cache);}
    // 数据库提交后才移除目录。失败不冒充清理完成，重启重试，不恢复已删除会话。
    this.cleanupPending();
    return results.map(result => ({...result,cleanupPending:Boolean(s.get('SELECT environment_id FROM conversation_deletions WHERE environment_id=?',result.environmentId))}));
  }
}
