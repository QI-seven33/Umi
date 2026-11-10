import {uid} from '../../../agent/src/identity.js';
import { DirectFileRepository } from './direct-files.js';

import type { SqliteStore } from './store.js';
import { UmiError } from '../../../protocol/src/model.js';
import {candidateSchema} from '../../../protocol/src/resources.js';
import type {Candidate,Mount} from '../../../protocol/src/resources.js';
import type { EventScope } from '../../../protocol/src/events.js';

import { resourceScopeSchema } from '../../../protocol/src/resource-scope.js';
import type { ResourceScope } from '../../../protocol/src/resource-scope.js';

// 与核心共用连接、写入锁和事务；资源记录不会另起日志或执行循环。
export class ResourceRepository {
  readonly direct: DirectFileRepository;
  constructor(readonly store: SqliteStore) { this.direct = new DirectFileRepository(store); }
  scope(environmentId: string): EventScope {
    const env = this.store.environment(environmentId),
      c = this.store.get(
        'SELECT id FROM conversations WHERE environment_id=?',
        environmentId,
      )!;
    const t = env.active_run_id
      ? this.store
          .tools(env.active_run_id)
          .find((t) => ['dispatched', 'unknown'].includes(t.state))
      : undefined;
    return t
      ? this.store.preparedToolScope(t)
      : {
          conversationId: c.id as string,
          ...(env.active_run_id ? { runId: env.active_run_id } : {}),
        };
  }
  candidate(
    environmentId: string,
    path: string,
    identity: string,
    initial = false,
    scope: ResourceScope = { kind: 'directory' },
  ): Candidate {
    const old = this.store.get(
      `SELECT id FROM resource_candidates WHERE environment_id=? AND path=? ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''} AND identity=?`,
      environmentId,
      path,
      identity,
    );
    if (old) return this.getCandidate(old.id as string, environmentId);
    const c = {
      id: uid(),
      environmentId,
      path,
      identity,
      initial,
      scope,
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO resource_candidates VALUES(?,?,?,?,?,?)',
        c.id,
        environmentId,
        path,
        identity,
        initial ? 1 : 0,
        c.createdAt,
      );
      if (scope.kind === 'file')
        this.store.run(
          'INSERT INTO resource_scopes VALUES(?,?)',
          c.id,
          JSON.stringify(scope),
        );
      this.store.append(this.scope(environmentId), {
        type: 'resource.discovered',
        payload: {
          candidateId: c.id,
          path,
          identity,
          ...(scope.kind === 'file' ? { resourceScope: scope } : {}),
        },
      });
    });
    return c;
  }
  getCandidate(id: string, environmentId: string): Candidate {
    const r = this.store.get(
      'SELECT * FROM resource_candidates WHERE id=? AND environment_id=?',
      id,
      environmentId,
    );
    if (!r) throw new UmiError('PERMISSION_DENIED', '候选不属于当前环境');
    return candidateSchema.parse({
      id: r.id,
      environmentId: r.environment_id,
      path: r.path,
      identity: r.identity,
      initial: r.initial === 1,
      scope: this.resourceScope(id),
      createdAt: r.created_at,
    });
  }
  resourceScope(resourceId: string): ResourceScope {
    const r = this.store.get(
      'SELECT scope FROM resource_scopes WHERE resource_id=?',
      resourceId,
    );
    return r
      ? resourceScopeSchema.parse(JSON.parse(r.scope as string))
      : { kind: 'directory' };
  }
  denied(c: Candidate, access: string): boolean {
    return Boolean(
      this.store.get(
        "SELECT 1 FROM resource_denials WHERE environment_id=? AND path=? AND identity=? AND (access=? OR access='read')",
        c.environmentId,
        c.path,
        c.scope.kind === 'file' ? c.scope.identity : c.identity,
        access,
      ),
    );
  }
  recordDenial(c: Candidate, access: string) {
    this.store.run(
      'INSERT OR IGNORE INTO resource_denials VALUES(?,?,?,?)',
      c.environmentId,
      c.path,
      c.scope.kind === 'file' ? c.scope.identity : c.identity,
      access,
    );
  }
  authorized(resourceId: string, environmentId: string, edit = false) {
    return this.direct.authorized(resourceId, environmentId, edit);
  }
  mounts(environmentId: string): Mount[] {
    return this.direct.mounts(environmentId);
  }
  mount(id:string,environmentId:string):Mount {
    const mount=this.direct.mount(id,environmentId);
    if(!mount)throw new UmiError('PERMISSION_DENIED','目录绑定不属于当前会话；旧副本不再提供访问');
    return mount;
  }
}
