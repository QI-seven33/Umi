import {filePath} from '../../../protocol/src/file-path.js';
import {hash} from '../../../agent/src/identity.js';
import {DirectFileAccess} from './direct-access.js';
import {lstatSync,readFileSync,statSync} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { metadataInventory, metadataPage, discoveryRoots } from './metadata.js';
import type { MetadataCoverage, MetadataEntry } from './metadata.js';
import { homedir } from 'node:os';
import { TextDecoder } from 'node:util';

import { hostContext } from './scratch.js';
import {bytesHash,fileIdentity,observe,rootIdentity,safeFile,safeRoot} from './paths.js';
import { ResourceRepository } from '../sqlite/resources.js';
import type { Environment } from '../../../agent/src/persistence.js';
import type {Candidate,Mount} from '../../../protocol/src/resources.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import { UmiError } from '../../../protocol/src/model.js';

import type {ResourceScope} from '../../../protocol/src/resource-scope.js';

export class ResourceFiles {
  readonly direct: DirectFileAccess;
  constructor(readonly repo: ResourceRepository,protectedRoots:readonly string[]=[]) { this.direct=new DirectFileAccess(repo,protectedRoots); }
  initialize(environmentId: string): void {
    if (!this.repo.direct.enabled(environmentId))
      throw new UmiError('LEGACY_WORKFLOW_RETIRED', '旧副本会话已停止支持，请选择目录创建新会话；不会自动升级旧权限或写回文件');
    this.direct.initialize(environmentId);
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
          : '只观察已声明范围内的元数据；空结果不代表文件不存在。cursor 只翻页本次覆盖结果，达到遍历预算请缩小 root/depth。query 只筛选结果，不缩小遍历范围。正文读取仍需 request_directory_access。',
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
        ...(m.direct?{allowPath:(path:string)=>{try{this.direct.protect(path);return true;}catch{return false;}}}:{}),
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
  resourceContext(input: unknown, env: Environment, candidateId: string, access: 'read' | 'edit'): ExecutionContext {
    const candidate = this.repo.getCandidate(candidateId, env.id);
    if (this.repo.denied(candidate, access))
      throw new UmiError('RESOURCE_DENIED', '这个来源的等价权限已被拒绝，请使用获准目录');
    this.checkCandidate(candidate);
    this.direct.protect(candidate.path);
    return {
      ...hostContext(input, env),
      ...(candidate.scope.kind === 'file' ? { resourceScope: candidate.scope } : {}),
      locations: [{
        schemaVersion: 1, environmentId: env.id,
        rootRef: { kind: 'source', resourceId: candidate.id, bindingVersion: 1 },
        relativePath: candidate.scope.kind === 'file' ? candidate.scope.path : 'resource',
        beforeHash: null, desiredHash: null,
        physicalRoot: this.sourceRoot(candidate),
        physicalRootIdentity: this.sourceIdentity(candidate),
        ...(candidate.scope.kind === 'file' ? { beforeIdentity: candidate.scope.identity } : {}),
      }],
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
      throw new UmiError('PERMISSION_DENIED', '当前工作区没有该目录所需权限');
    safeRoot(m.root, m.rootIdentity);
    this.direct.check(m,edit,path);
    const ctx = {
      ...hostContext(input, env),
      ...(m.direct?{directoryGrant:{id:m.direct.grantId,revision:m.direct.revision}}:{}),
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
  read(m: Mount, path: string, startByte = 0, byteLength = 8192, expectedHash?: string, lines?: { startLine: number; lineCount: number }) {
    this.assertPath(m.scope, path);
    this.direct.check(m,false,path);
    const entry = observe(m.root, path, m.rootIdentity);
    if (!entry) throw new UmiError('NOT_FOUND', '文件不存在');
    if (expectedHash && entry.hash !== expectedHash) throw new UmiError('RESOURCE_CHANGED', '文件版本已改变，请从头读取预览');
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
