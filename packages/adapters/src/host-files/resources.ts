import { existsSync, lstatSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { metadataInventory, metadataPage, discoveryRoots } from './metadata.js';
import type { MetadataCoverage, MetadataEntry } from './metadata.js';
import { homedir } from 'node:os';
import { TextDecoder } from 'node:util';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { hostContext } from './scratch.js';
import {
  atomicWrite,
  bytesHash,
  fileIdentity,
  observe,
  rootIdentity,
  safeFile,
  safeRoot,
  scan,
  sameEntry,
} from './paths.js';
import { ResourceRepository } from '../sqlite/resources.js';
import type { Environment } from '../../../agent/src/persistence.js';
import type { Candidate, Mount, Manifest } from '../../../protocol/src/resources.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';
import { hash } from '../../../agent/src/identity.js';
import { filePath } from '../../../protocol/src/resources.js';
import type { ToolResult } from '../../../agent/src/persistence.js';
import type {
  ResourceScope,
  MaterializationFailure,
} from '../../../protocol/src/resource-scope.js';

export class ResourceFiles {
  constructor(readonly repo: ResourceRepository) {}
  initialize(environmentId: string): void {
    const c = this.repo.store.get(
        'SELECT id FROM conversations WHERE environment_id=?',
        environmentId,
      )!,
      conversationId = c.id as string;
    const candidates = this.repo.store.all(
      'SELECT id FROM resource_candidates WHERE environment_id=? AND initial=1',
      environmentId,
    );
    if (
      candidates.some(
        (r) =>
          this.repo.mounts(environmentId).some((m) => m.resourceId === r.id) ||
          this.repo.store.snapshot(conversationId).resources[r.id as string]
            ?.materializationError,
      )
    )
      return;
    try {
      this.bindInitial(conversationId);
    } catch (e) {
      const resource = this.repo.store.get(
        'SELECT id FROM resource_candidates WHERE environment_id=? AND initial=1',
        environmentId,
      );
      if (!resource) throw e;
      const record = this.repo.store.get(
        'SELECT id FROM materializations WHERE environment_id=? AND resource_id=?',
        environmentId,
        resource.id as string,
      );
      const failure: MaterializationFailure = record
        ? { stage: 'copy', effects: 'partial-or-unknown', mountId: record.id as string }
        : { stage: 'scan', effects: 'not-started' };
      this.repo.store.commit(this.repo.scope(environmentId), {
        type: 'resource.materialization_failed',
        payload: {
          resourceId: resource.id as string,
          code: e instanceof UmiError ? e.code : 'MATERIALIZATION_FAILED',
          reason:
            e instanceof Error
              ? e.message
              : '初始工作区未完成物化；其他已获准工具仍可使用',
          failure,
        },
      });
    }
  }
  bindInitial(conversationId: string): Mount {
    const c = this.repo.store.conversation(conversationId),
      env = this.repo.store.environment(c.environment_id as string);
    const path = this.repo.store.get(
      'SELECT source_root FROM workspaces WHERE id=?',
      c.workspace_id as string,
    )!.source_root as string;
    const candidate = this.repo.candidate(
      env.id,
      safeRoot(path),
      rootIdentity(path),
      true,
    );
    this.repo.grant(candidate, 'edit');
    return this.materialize(candidate);
  }
  discover(
    env: Environment,
    query: string,
    path?: string,
    options: {
      root?: string | undefined;
      kind?: 'file' | 'directory' | 'any';
      match?: 'name' | 'extension' | 'relative_path';
      depth?: number;
      limit?: number;
      cursor?: string | undefined;
      signal?: AbortSignal;
    } = {},
  ) {
    const candidates: Candidate[] = [];
    if (path) {
      const p = resolve(path);
      let status: 'found' | 'not_found' | 'rejected' | 'unavailable' = 'found',
        reason: string | undefined;
      try {
        const st = lstatSync(p, { bigint: true });
        if (st.isFile()) {
          const root = safeRoot(dirname(p)),
            file = safeFile(root, basename(p)),
            relativePath = basename(file);
          filePath.parse(relativePath);
          const scope: ResourceScope = {
            kind: 'file',
            path: relativePath,
            rootIdentity: rootIdentity(root),
            identity: fileIdentity(file),
            size: Number(st.size),
            modifiedNs: st.mtimeNs.toString(),
            changedNs: st.ctimeNs.toString(),
          };
          candidates.push(
            this.repo.candidate(
              env.id,
              file,
              hash(
                process.platform === 'win32'
                  ? { ...scope, path: scope.path.toLowerCase() }
                  : scope,
              ),
              false,
              scope,
            ),
          );
        } else if (st.isDirectory() && !st.isSymbolicLink()) {
          const root = safeRoot(p);
          candidates.push(this.repo.candidate(env.id, root, rootIdentity(root)));
        } else {
          status = 'rejected';
          reason = '目标是链接或非普通文件/目录';
        }
      } catch (e) {
        status =
          (e as NodeJS.ErrnoException).code === 'ENOENT' ||
          (e as NodeJS.ErrnoException).code === 'ENOTDIR'
            ? 'not_found'
            : e instanceof UmiError || (e instanceof Error && e.name === 'ZodError')
              ? 'rejected'
              : 'unavailable';
        reason = e instanceof Error ? e.message : '目标元数据无法读取';
      }
      return {
        candidates,
        coverage: [{ root: p, depth: 0, visited: 1, limited: false }],
        contentRead: false,
        exactPath: true,
        status,
        ...(reason ? { reason } : {}),
        searchedKinds: ['file', 'directory'],
      };
    }
    const c = this.repo.store.get(
      'SELECT w.source_root FROM conversations c JOIN workspaces w ON w.id=c.workspace_id WHERE c.environment_id=?',
      env.id,
    )!;
    const home = homedir();
    const oneDrive = [
      process.env.OneDrive,
      process.env.OneDriveConsumer,
      process.env.OneDriveCommercial,
    ].filter((p): p is string => Boolean(p));
    const roots = options.root
      ? [resolve(options.root)]
      : discoveryRoots(c.source_root as string, home, oneDrive);
    const kind = options.kind ?? 'directory',
      match = options.match ?? 'name';
    const depth = options.depth ?? 2,
      limit = options.limit ?? 20;
    const coverage: MetadataCoverage[] = [];
    const found: { root: string; entry: MetadataEntry }[] = [];
    const seen = new Set<string>(),
      versions: string[] = [];
    const budget = { maxEntries: 5000, maxDepth: depth, maxMs: 1500 };
    const started = Date.now();
    let visited = 0;
    for (const root of [
      ...new Set(roots.map((p) => (process.platform === 'win32' ? p.toLowerCase() : p))),
    ]) {
      options.signal?.throwIfAborted();
      let inventory;
      try {
        inventory = metadataInventory(
          root,
          {
            ...budget,
            maxEntries: Math.max(0, budget.maxEntries - visited),
            maxMs: Math.max(0, budget.maxMs - (Date.now() - started)),
          },
          {
            skipEnvironments: true,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
      } catch (e) {
        options.signal?.throwIfAborted();
        coverage.push({
          root,
          depth,
          visited: 0,
          limited: false,
          complete: false,
          reasons: [],
          skipped: { unavailable: 1 },
          examples: [
            { path: '', reason: e instanceof UmiError ? e.code : 'unavailable' },
          ],
        });
        continue;
      }
      coverage.push(inventory.coverage);
      versions.push(inventory.version);
      visited += inventory.coverage.visited;
      for (const entry of inventory.entries) {
        if (kind !== 'any' && kind !== entry.kind) continue;
        const needle = query.toLocaleLowerCase(),
          relativePath = entry.path.toLocaleLowerCase();
        const name = basename(entry.path || root).toLocaleLowerCase();
        const matches =
          match === 'extension'
            ? entry.kind === 'file' &&
              name.endsWith(needle.startsWith('.') ? needle : '.' + needle)
            : (match === 'relative_path' ? relativePath : name).includes(needle);
        const absolute = resolve(root, ...entry.path.split('/'));
        const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
        if (matches && !seen.has(key)) {
          seen.add(key);
          found.push({ root, entry });
        }
      }
    }
    found.sort((a, b) => {
      const x = resolve(a.root, a.entry.path),
        y = resolve(b.root, b.entry.path);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const version = hash({ versions, coverage });
    const page = metadataPage(
      found,
      { environmentId: env.id, roots, query, kind, match, depth },
      version,
      limit,
      options.cursor,
    );
    for (const item of page.items) {
      const exact = this.discover(env, '', resolve(item.root, item.entry.path));
      const candidate = exact.candidates[0];
      if (
        !candidate ||
        (candidate.scope.kind === 'directory' &&
          candidate.identity !== item.entry.identity) ||
        (candidate.scope.kind === 'file' &&
          (candidate.scope.identity !== item.entry.identity ||
            candidate.scope.changedNs !== item.entry.changedNs))
      )
        throw new UmiError('RESOURCE_CHANGED', '候选在发现期间变化，请重新搜索');
      candidates.push(candidate);
    }
    return {
      candidates,
      coverage,
      budget,
      contentRead: false,
      exactPath: false,
      status:
        page.status === 'restart_required'
          ? 'restart_required'
          : candidates.length
            ? 'found'
            : 'no_candidates',
      searchedKinds: kind === 'any' ? ['file', 'directory'] : [kind],
      total: page.total,
      totalExact: page.status === 'ok' && coverage.every((c) => c.complete),
      truncated: page.truncated,
      version,
      notice:
        page.status === 'restart_required'
          ? '目录元数据已变化，请去掉 cursor 重新搜索'
          : '只观察已声明范围内的元数据；空结果不代表文件不存在。cursor 只翻页本次覆盖结果，达到遍历预算请缩小 root/depth。query 只筛选结果，不缩小遍历范围。正文读取仍需 request_resource。',
      nextCursor: page.nextCursor,
    };
  }
  listMetadata(
    m: Mount,
    prefix = '',
    limit = 100,
    cursor?: string,
    signal?: AbortSignal,
  ) {
    const inventory = metadataInventory(
      m.root,
      { maxEntries: 5000, maxDepth: 16, maxMs: 1500 },
      {
        expectedRoot: m.rootIdentity,
        prefix,
        ...(signal ? { signal } : {}),
        ...(m.scope.kind === 'file' ? { fileOnly: m.scope.path } : {}),
      },
    );
    const all = inventory.entries.filter((e) => e.kind === 'file');
    const page = metadataPage(
      all,
      {
        environmentId: m.environmentId,
        mountId: m.id,
        rootIdentity: m.rootIdentity,
        scope: m.scope,
        prefix,
      },
      inventory.version,
      limit,
      cursor,
    );
    return {
      mountId: m.id,
      files: page.items,
      status: page.status,
      total: page.total,
      totalExact: page.status === 'ok' && inventory.coverage.complete,
      truncated: page.truncated,
      version: inventory.version,
      coverage: inventory.coverage,
      contentRead: false,
      notice:
        page.status === 'restart_required'
          ? '目录元数据已变化，请去掉 cursor 重新列举'
          : '元数据清单不含内容 hash；内容版本请用 read_file/stat_file。预算耗尽时请用 prefix 缩小范围。',
      nextCursor: page.nextCursor,
    };
  }

  resourceContext(
    input: unknown,
    env: Environment,
    candidateId: string,
    access: 'read' | 'edit',
    executionId?: string,
  ): ExecutionContext {
    const c = this.repo.getCandidate(candidateId, env.id);
    if (this.repo.denied(c, access))
      throw new UmiError(
        'RESOURCE_DENIED',
        '这个来源的等价资源权限已被拒绝；请改用获准资源',
      );
    this.checkCandidate(c);
    const sourceRoot = this.sourceRoot(c),
      sourceIdentity = this.sourceIdentity(c),
      ctx = hostContext(input, env);
    const old = this.repo.mounts(env.id).find((m) => m.resourceId === c.id),
      mountId =
        old?.id ??
        `mount-${hash({ environmentId: env.id, resourceId: c.id, executionId: executionId ?? 'initial' }).slice(0, 40)}`;
    const root = join(env.root, 'working', mountId);
    return {
      ...ctx,
      ...(c.scope.kind === 'file' ? { resourceScope: c.scope } : {}),
      locations: [
        {
          schemaVersion: 1,
          environmentId: env.id,
          rootRef: { kind: 'source', resourceId: c.id, bindingVersion: 1 },
          relativePath: c.scope.kind === 'file' ? c.scope.path : 'resource',
          beforeHash: null,
          desiredHash: null,
          physicalRoot: sourceRoot,
          physicalRootIdentity: sourceIdentity,
          ...(c.scope.kind === 'file' ? { beforeIdentity: c.scope.identity } : {}),
        },
        {
          schemaVersion: 1,
          environmentId: env.id,
          rootRef: { kind: 'mount', mountId, area: 'working', bindingVersion: 1 },
          relativePath: c.scope.kind === 'file' ? c.scope.path : 'resource',
          beforeHash: null,
          desiredHash: null,
          physicalRoot: root,
          ...(old ? { physicalRootIdentity: old.rootIdentity } : {}),
        },
      ],
    };
  }
  mountContext(
    input: unknown,
    env: Environment,
    mountId: string,
    path?: string,
    desiredHash?: string | null,
    edit = false,
  ): ExecutionContext {
    const m = this.repo.mount(mountId, env.id);
    if (!this.repo.authorized(m.resourceId, env.id, edit))
      throw new UmiError('PERMISSION_DENIED', '当前任务没有该工作副本所需权限');
    safeRoot(m.root, m.rootIdentity);
    const ctx = {
      ...hostContext(input, env),
      ...(m.scope.kind === 'file' ? { resourceScope: m.scope } : {}),
    };
    if (!path) return ctx;
    this.assertPath(m.scope, path);
    const before = observe(m.root, path, m.rootIdentity);
    return {
      ...ctx,
      locations: [
        {
          schemaVersion: 1,
          environmentId: env.id,
          rootRef: {
            kind: 'mount',
            mountId: m.id,
            area: 'working',
            bindingVersion: m.bindingVersion,
          },
          relativePath: path,
          beforeHash: before?.hash ?? null,
          desiredHash: desiredHash === undefined ? (before?.hash ?? null) : desiredHash,
          physicalRoot: m.root,
          physicalRootIdentity: m.rootIdentity,
          beforeIdentity: before?.identity ?? null,
        },
      ],
    };
  }
  materialize(c: Candidate, plannedMountId?: string): Mount {
    const steps = this.materializationSteps(c, plannedMountId);
    while (true) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }
  async materializeAsync(
    c: Candidate,
    plannedMountId: string,
    signal: AbortSignal,
  ): Promise<Mount> {
    const steps = this.materializationSteps(c, plannedMountId, signal),
      start = Date.now();
    let count = 0;
    while (true) {
      signal.throwIfAborted();
      if (Date.now() - start > 30000)
        throw new UmiError(
          'RESOURCE_LIMIT',
          '物化超过本次时间限额；已保存计划，可核验部分副本',
        );
      const step = steps.next();
      if (step.done) return step.value;
      if (++count % 16 === 0) await yieldIO(undefined, { signal });
    }
  }
  private *materializationSteps(
    c: Candidate,
    plannedMountId?: string,
    signal?: AbortSignal,
  ): Generator<void, Mount> {
    if (!this.repo.authorized(c.id, c.environmentId))
      throw new UmiError('PERMISSION_DENIED', '来源尚未授权，未读取正文');
    const old = this.repo.mounts(c.environmentId).find((m) => m.resourceId === c.id);
    if (old) {
      safeRoot(old.root, old.rootIdentity);
      this.checkCandidate(c);
      return old;
    }
    const env = this.repo.store.environment(c.environmentId);
    hostContext({}, env);
    this.checkCandidate(c);
    // 托管数据不能递归成为自身的来源。运行数据库与环境目录也不作为用户资料物化。
    const excluded = [
      this.repo.store.dataRoot,
      join(this.repo.store.dataRoot, 'environments'),
      join(this.repo.store.dataRoot, 'umi.sqlite'),
      join(this.repo.store.dataRoot, 'umi.sqlite-wal'),
      join(this.repo.store.dataRoot, 'umi.sqlite-shm'),
      join(this.repo.store.dataRoot, 'writer.lock'),
    ];
    const sourceRoot = this.sourceRoot(c),
      sourceIdentity = this.sourceIdentity(c),
      scanned = this.scanSource(c, excluded),
      mountId =
        plannedMountId ??
        `mount-${hash({ environmentId: env.id, resourceId: c.id, executionId: 'initial' }).slice(0, 40)}`,
      root = join(env.root, 'working', mountId);
    if (existsSync(root))
      throw new UmiError(
        'RESOURCE_CHANGED',
        '计划物化位置已经存在，不能覆盖旧副本；请核验原执行',
      );
    this.repo.beginMaterialization(c, mountId, root, scanned.manifest, scanned.excluded);
    mkdirSync(root, { recursive: true });
    this.repo.bindMaterializationRoot(mountId, env.id, rootIdentity(root));
    const manifest: Manifest = {};
    for (const [path, entry] of Object.entries(scanned.manifest)) {
      signal?.throwIfAborted();
      const file = safeFile(sourceRoot, path, sourceIdentity),
        bytes = readFileSync(file);
      if (
        !sameEntry(observe(sourceRoot, path, sourceIdentity), entry) ||
        bytesHash(bytes) !== entry.hash
      )
        throw new UmiError('RESOURCE_CHANGED', '物化时来源文件已变化');
      this.saveBlob(env, bytes);
      atomicWrite(root, path, bytes);
      manifest[path] = entry;
      yield;
    }
    const after = this.scanSource(c, excluded).manifest;
    if (
      Object.keys(after).length !== Object.keys(manifest).length ||
      Object.entries(manifest).some(([p, e]) => !sameEntry(after[p] ?? null, e))
    )
      throw new UmiError('RESOURCE_CHANGED', '物化期间来源目录变化，未发布挂载');
    this.repo.addMount(
      {
        id: mountId,
        environmentId: env.id,
        resourceId: c.id,
        root,
        rootIdentity: rootIdentity(root),
        bindingVersion: 1,
        sourceRoot,
        sourceIdentity,
        scope: c.scope,
      },
      manifest,
      scanned.excluded,
    );
    return this.repo.mount(mountId, env.id);
  }
  reconcileMaterialization(c: Candidate, ctx: ExecutionContext): Mount | undefined {
    const location = ctx.locations.find((l) => l.rootRef.kind === 'mount');
    if (!location || location.rootRef.kind !== 'mount') return undefined;
    const record = this.repo.materialization(location.rootRef.mountId, c.environmentId);
    if (!record?.rootIdentity) return undefined;
    const env = this.repo.store.environment(c.environmentId);
    hostContext({}, env);
    if (
      record.resourceId !== c.id ||
      record.plan.sourceRoot !== this.sourceRoot(c) ||
      record.plan.sourceIdentity !== this.sourceIdentity(c) ||
      hash(record.plan.resourceScope ?? { kind: 'directory' }) !== hash(c.scope) ||
      hash(ctx.resourceScope ?? { kind: 'directory' }) !== hash(c.scope) ||
      record.plan.root !== location.physicalRoot
    )
      return undefined;
    safeRoot(record.plan.root, record.rootIdentity);
    const current = scan(record.plan.root).manifest;
    if (
      Object.keys(current).length !== Object.keys(record.plan.manifest).length ||
      Object.entries(record.plan.manifest).some(
        ([p, e]) => !sameEntry(current[p] ?? null, e, false),
      )
    )
      return undefined;
    for (const e of Object.values(record.plan.manifest)) this.blob(env, e.hash);
    this.repo.addMount(
      {
        id: record.id,
        environmentId: env.id,
        resourceId: c.id,
        root: record.plan.root,
        rootIdentity: record.rootIdentity,
        bindingVersion: 1,
        sourceRoot: this.sourceRoot(c),
        sourceIdentity: this.sourceIdentity(c),
        scope: c.scope,
      },
      record.plan.manifest,
      record.plan.excluded,
    );
    return this.repo.mount(record.id, env.id);
  }
  scanMount(m: Mount): Manifest {
    safeRoot(m.root, m.rootIdentity);
    if (m.scope.kind === 'directory') return scan(m.root).manifest;
    const entry = observe(m.root, m.scope.path, m.rootIdentity);
    return entry ? { [m.scope.path]: entry } : {};
  }
  sourceRoot(c: Candidate): string {
    return c.scope.kind === 'file' ? dirname(c.path) : c.path;
  }
  sourceIdentity(c: Candidate): string {
    return c.scope.kind === 'file' ? c.scope.rootIdentity : c.identity;
  }
  assertPath(scope: ResourceScope, path: string): void {
    if (scope.kind === 'file' && path !== scope.path)
      throw new UmiError('PERMISSION_DENIED', '单文件授权不包含这个相对路径');
  }
  private checkCandidate(c: Candidate): void {
    const root = this.sourceRoot(c);
    safeRoot(root, this.sourceIdentity(c));
    if (c.scope.kind === 'file') {
      const file = safeFile(root, c.scope.path, c.scope.rootIdentity),
        st = statSync(file, { bigint: true });
      if (
        fileIdentity(file) !== c.scope.identity ||
        Number(st.size) !== c.scope.size ||
        st.mtimeNs.toString() !== c.scope.modifiedNs ||
        st.ctimeNs.toString() !== c.scope.changedNs
      )
        throw new UmiError(
          'RESOURCE_CHANGED',
          '所选文件身份、大小、修改时间或元数据变更时间已变化，请重新发现并批准',
        );
    }
  }
  private scanSource(c: Candidate, excluded: string[]) {
    if (c.scope.kind === 'directory') return scan(c.path, excluded);
    this.checkCandidate(c);
    const target = resolve(c.path),
      within = (p: string) => {
        const a = resolve(p),
          t = process.platform === 'win32' ? target.toLowerCase() : target,
          r = process.platform === 'win32' ? a.toLowerCase() : a;
        return t === r || t.startsWith(r + sep);
      };
    if (excluded.some(within))
      throw new UmiError('PERMISSION_DENIED', '托管运行数据不能作为来源物化');
    const entry = observe(this.sourceRoot(c), c.scope.path, c.scope.rootIdentity);
    if (!entry) throw new UmiError('RESOURCE_CHANGED', '所选文件已消失');
    this.checkCandidate(c);
    return { manifest: { [c.scope.path]: entry }, excluded: [] };
  }
  materializationFailure(
    c: Candidate,
    ctx: ExecutionContext,
    error: unknown,
  ): ToolResult {
    const location = ctx.locations.find((l) => l.rootRef.kind === 'mount'),
      mountId = location?.rootRef.kind === 'mount' ? location.rootRef.mountId : undefined;
    const record = mountId
      ? this.repo.materialization(mountId, c.environmentId)
      : undefined;
    const failure: MaterializationFailure = {
      stage: record ? 'copy' : 'scan',
      effects: record ? 'partial-or-unknown' : 'not-started',
      ...(mountId ? { mountId } : {}),
    };
    const code = error instanceof UmiError ? error.code : 'MATERIALIZATION_FAILED',
      reason = error instanceof Error ? error.message : '资源物化失败';
    this.repo.store.commit(this.repo.scope(c.environmentId), {
      type: 'resource.materialization_failed',
      payload: { resourceId: c.id, code, reason, failure },
    });
    return {
      outcome: record ? 'unknown' : 'failed',
      content:
        reason +
        (record
          ? '；已保留原物化计划，恢复将核验副本，不重新复制。'
          : '；尚未开始复制，没有发布挂载。'),
      data: { code, reason, failure },
      verification: record ? 'unknown' : 'not-started',
    };
  }
  saveBlob(env: Environment, bytes: Uint8Array): string {
    hostContext({}, env);
    const digest = bytesHash(bytes),
      root = join(env.root, 'task', 'artifacts', 'content');
    mkdirSync(root, { recursive: true });
    safeRoot(root);
    const path = `${digest}.bin`,
      file = safeFile(root, path);
    if (!existsSync(file)) atomicWrite(root, path, bytes);
    else if (bytesHash(readFileSync(file)) !== digest)
      throw new UmiError('PROTOCOL_INVALID', '内容资料指纹不一致');
    return digest;
  }
  blob(env: Environment, digest: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new UmiError('PROTOCOL_INVALID', '内容资料标识无效');
    hostContext({}, env);
    const data = readFileSync(
      safeFile(join(env.root, 'task', 'artifacts', 'content'), `${digest}.bin`),
    );
    if (bytesHash(data) !== digest)
      throw new UmiError('PROTOCOL_INVALID', '内容资料被修改');
    return data;
  }
  read(m: Mount, path: string, startByte = 0, byteLength = 8192, expectedHash?: string, lines?: { startLine: number; lineCount: number }) {
    this.assertPath(m.scope, path);
    const entry = observe(m.root, path, m.rootIdentity);
    if (!entry) throw new UmiError('NOT_FOUND', '工作副本文件不存在');
    if (expectedHash && entry.hash !== expectedHash) throw new UmiError('RESOURCE_CHANGED', '工作副本版本已改变，请从头读取预览');
    const bytes = readFileSync(safeFile(m.root, path, m.rootIdentity));
    if (
      bytesHash(bytes) !== entry.hash ||
      fileIdentity(safeFile(m.root, path, m.rootIdentity)) !== entry.identity
    )
      throw new UmiError('RESOURCE_CHANGED', '预览期间文件改变');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('binary');
    } catch {
      return {
        mountId: m.id,
        path,
        kind: 'binary',
        size: bytes.length,
        hash: entry.hash,
        identity: entry.identity,
        previewSupported: false,
        text: undefined,
      };
    }
    // 行号是定位入口，返回正文仍为原始字节；长行仅在连续分页边界停止。
    let selectionEnd = bytes.length;
    if (lines) {
      let offset = 0;
      for (let line = 1; line < lines.startLine; line++) {
        const lf = bytes.indexOf(10, offset);
        if (lf < 0 || lf + 1 >= bytes.length) throw new UmiError('NOT_FOUND', '起始行超出文件范围');
        offset = lf + 1;
      }
      startByte = offset;
      for (let count = 0; count < lines.lineCount; count++) {
        const lf = bytes.indexOf(10, offset);
        if (lf < 0) { offset = bytes.length; break; }
        offset = lf + 1;
      }
      selectionEnd = offset;
    }
    const start = Math.min(startByte, bytes.length);
    let end = Math.min(start + byteLength, selectionEnd);
    if (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
      throw new UmiError('PROTOCOL_INVALID', '起点切开 UTF-8 字符');
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return {
      mountId: m.id,
      path,
      kind: 'text',
      encoding: 'utf-8',
      hash: entry.hash,
      identity: entry.identity,
      size: bytes.length,
      startByte: start,
      endByte: end,
      nextStartByte: end < bytes.length ? end : null,
      truncated: end < bytes.length,
      text: bytes.subarray(start, end).toString('utf8'),
      ...(lines ? { lineSelection: { ...lines, rangeComplete: end === selectionEnd } } : {}),
    };
  }
}
