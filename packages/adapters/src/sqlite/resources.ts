import { DirectFileRepository } from './direct-files.js';
import { dirname as rootSource } from 'node:path';
import { uid } from '../../../agent/src/identity.js';
import type { SqliteStore } from './store.js';
import { UmiError } from '../../../protocol/src/model.js';
import {
  candidateSchema,
  mountSchema,
  changeSetSchema,
  manifestSchema,
} from '../../../protocol/src/resources.js';
import type {
  Candidate,
  Mount,
  Manifest,
  ChangeSet,
  DeliveryReceipt,
} from '../../../protocol/src/resources.js';
import type { EventScope } from '../../../protocol/src/events.js';
import { createHash } from 'node:crypto';
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
  authorized(resourceId: string, environmentId: string, edit = false): boolean {
    if (this.direct.mounts(environmentId).some(m=>m.resourceId===resourceId)) return this.direct.authorized(resourceId,environmentId,edit);
    const env = this.store.environment(environmentId);
    return Boolean(
      this.store.get(
        `SELECT 1 FROM capabilities WHERE resource_id=? AND environment_id=? AND (run_id IS NULL OR run_id=?) ${edit ? "AND access='edit'" : ''}`,
        resourceId,
        environmentId,
        env.active_run_id,
      ),
    );
  }
  grant(c: Candidate, access: 'read' | 'edit') {
    const env = this.store.environment(c.environmentId),
      scope = this.scope(env.id),
      tool = scope.executionId ? this.store.tool(scope.executionId) : undefined;
    if (
      !c.initial &&
      (!tool?.approval_id || this.store.approval(tool.approval_id).decision !== 'allow')
    )
      throw new UmiError('PERMISSION_DENIED', '外部资源没有有效批准');
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO resources VALUES(?,?)', c.id, env.id);
      this.store.run(
        'INSERT INTO capabilities VALUES(?,?,?,?,?,?)',
        uid(),
        c.id,
        env.id,
        c.initial ? null : env.active_run_id,
        access,
        tool?.approval_id ?? null,
      );
      this.store.append(scope, {
        type: 'resource.authorized',
        payload: { resourceId: c.id, access, scope: c.initial ? 'conversation' : 'run' },
      });
    });
  }
  mounts(environmentId: string): Mount[] {
    return this.store
      .all('SELECT id FROM mounts WHERE environment_id=? ORDER BY rowid', environmentId)
      .map((r) => this.mount(r.id as string, environmentId)).concat(this.direct.mounts(environmentId));
  }
  mount(id: string, environmentId: string): Mount {
    const direct=this.direct.mount(id,environmentId); if(direct) return direct;
    const r = this.store.get(
      'SELECT * FROM mounts WHERE id=? AND environment_id=?',
      id,
      environmentId,
    );
    if (!r) throw new UmiError('PERMISSION_DENIED', '挂载不属于当前环境');
    return mountSchema.parse({
      id: r.id,
      environmentId: r.environment_id,
      resourceId: r.resource_id,
      root: r.root,
      rootIdentity: r.root_identity,
      bindingVersion: r.binding_version,
      baselineRef: r.baseline_ref,
      scope: this.resourceScope(r.resource_id as string),
      sourceRoot: r.source_root,
      sourceIdentity: r.source_identity,
    });
  }
  addMount(m: Omit<Mount, 'baselineRef'>, manifest: Manifest, excluded: string[]) {
    this.store.transaction(() => {
      const ref = this.store.artifact(manifest, 'resource-baseline');
      this.store.run(
        'INSERT INTO mounts VALUES(?,?,?,?,?,?,?,?,?)',
        m.id,
        m.environmentId,
        m.resourceId,
        m.root,
        m.rootIdentity,
        m.bindingVersion,
        ref,
        m.sourceRoot,
        m.sourceIdentity,
      );
      this.store.append(this.scope(m.environmentId), {
        type: 'resource.materialized',
        payload: { mountId: m.id, resourceId: m.resourceId, baselineRef: ref, excluded },
      });
    });
  }
  baseline(m: Mount): Manifest {
    return manifestSchema.parse(this.store.readArtifact(m.baselineRef));
  }
  beginMaterialization(
    c: Candidate,
    mountId: string,
    root: string,
    manifest: Manifest,
    excluded: string[],
  ) {
    this.store.transaction(() => {
      const planRef = this.store.artifact(
        {
          sourceRoot: c.scope.kind === 'file' ? rootSource(c.path) : c.path,
          sourceIdentity: c.scope.kind === 'file' ? c.scope.rootIdentity : c.identity,
          root,
          manifest,
          excluded,
          ...(c.scope.kind === 'file' ? { resourceScope: c.scope } : {}),
        },
        'materialization-plan',
      );
      this.store.run(
        'INSERT INTO materializations VALUES(?,?,?,?,NULL)',
        mountId,
        c.environmentId,
        c.id,
        planRef,
      );
      this.store.append(this.scope(c.environmentId), {
        type: 'resource.materialization_started',
        payload: { resourceId: c.id, mountId, planRef },
      });
    });
  }
  materialization(id: string, environmentId: string) {
    const r = this.store.get(
      'SELECT * FROM materializations WHERE id=? AND environment_id=?',
      id,
      environmentId,
    );
    if (!r) return undefined;
    return {
      id: r.id as string,
      resourceId: r.resource_id as string,
      rootIdentity: r.root_identity as string | null,
      plan: this.store.readArtifact<{
        sourceRoot: string;
        sourceIdentity: string;
        root: string;
        manifest: Manifest;
        excluded: string[];
        resourceScope?: ResourceScope;
      }>(r.plan_ref as string),
    };
  }
  bindMaterializationRoot(id: string, environmentId: string, identity: string) {
    const record = this.materialization(id, environmentId);
    if (!record || (record.rootIdentity && record.rootIdentity !== identity))
      throw new UmiError('RESOURCE_CHANGED', '物化根不能替换');
    this.store.transaction(() => {
      this.store.run(
        'UPDATE materializations SET root_identity=? WHERE id=? AND root_identity IS NULL',
        identity,
        id,
      );
      this.store.append(this.scope(environmentId), {
        type: 'resource.materialization_root_bound',
        payload: { mountId: id, rootIdentity: identity },
      });
    });
  }
  saveChangeSet(cs: ChangeSet) {
    const scope = this.scope(cs.environmentId);
    if (!scope.executionId)
      throw new UmiError('PROTOCOL_INVALID', '变更集必须由已派发工具构建');
    this.store.transaction(() => {
      const ref = this.store.artifact(cs, 'changeset');
      this.store.run(
        'INSERT INTO changesets VALUES(?,?,?,?,?)',
        cs.id,
        cs.environmentId,
        cs.mountId,
        ref,
        scope.executionId!,
      );
      this.store.append(scope, {
        type: 'changeset.created',
        payload: { changeSetId: cs.id, mountId: cs.mountId, artifactRef: ref },
      });
    });
  }
  changeSet(id: string, environmentId: string): ChangeSet {
    const r = this.store.get(
      'SELECT artifact_ref FROM changesets WHERE id=? AND environment_id=?',
      id,
      environmentId,
    );
    if (!r) throw new UmiError('PERMISSION_DENIED', '变更集不属于当前环境');
    return changeSetSchema.parse(this.store.readArtifact(r.artifact_ref as string));
  }
  items(id: string) {
    return this.store.all(
      'SELECT * FROM delivery_items WHERE changeset_id=? ORDER BY rowid',
      id,
    );
  }
  temporaryPath(cs: ChangeSet, path: string): string | null {
    if (!cs.changes.find((c) => c.path === path)?.after) return null;
    const slash = path.lastIndexOf('/'),
      prefix = slash < 0 ? '' : path.slice(0, slash + 1);
    return `${prefix}.umi-${cs.id}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}.tmp`;
  }
  intent(cs: ChangeSet, path: string) {
    const scope = this.scope(cs.environmentId);
    if (!scope.executionId) throw new UmiError('PROTOCOL_INVALID', '交付缺少执行身份');
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO delivery_items VALUES(?,?,?,'intent',NULL,?)",
        cs.id,
        path,
        scope.executionId!,
        this.temporaryPath(cs, path),
      );
      this.store.append(scope, {
        type: 'delivery.item_intent',
        payload: { changeSetId: cs.id, path },
      });
    });
  }
  receipt(cs: ChangeSet, m: Mount, r: DeliveryReceipt) {
    const scope = this.scope(cs.environmentId);
    this.store.transaction(() => {
      const ref = this.store.artifact(r, 'delivery-receipt');
      this.store.run(
        "UPDATE delivery_items SET state='settled',receipt_ref=? WHERE changeset_id=? AND path=?",
        ref,
        cs.id,
        r.path,
      );
      if (r.outcome === 'applied' || r.outcome === 'satisfied') {
        const latest = this.mount(m.id, m.environmentId),
          base = this.baseline(latest);
        if (r.observed) base[r.path] = r.observed;
        else delete base[r.path];
        const baselineRef = this.store.artifact(base, 'resource-baseline');
        this.store.run('UPDATE mounts SET baseline_ref=? WHERE id=?', baselineRef, m.id);
        this.store.run(
          'UPDATE environments SET revision=revision+1 WHERE id=?',
          m.environmentId,
        );
        this.store.append(
          { conversationId: scope.conversationId, runId: scope.runId! },
          {
            type: 'environment.revised',
            payload: {
              environmentId: m.environmentId,
              revision: this.store.environment(m.environmentId).revision,
            },
          },
        );
      }
      this.store.append(scope, {
        type: 'delivery.item_settled',
        payload: {
          changeSetId: cs.id,
          path: r.path,
          outcome: r.outcome,
          receiptRef: ref,
        },
      });
    });
  }
}
