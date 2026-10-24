import { lstatSync, opendirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import { filePath } from '../../../protocol/src/resources.js';
import { safeFile, safeRoot } from './paths.js';

export type MetadataEntry = {
  path: string;
  kind: 'file' | 'directory';
  identity: string;
  size: number;
  modifiedNs: string;
  changedNs: string;
};
export type MetadataBudget = {
  maxEntries: number;
  maxDepth: number;
  maxMs: number;
};
export type MetadataCoverage = {
  root: string;
  depth: number;
  visited: number;
  limited: boolean;
  complete: boolean;
  reasons: string[];
  skipped: Record<string, number>;
  examples: { path: string; reason: string }[];
};
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
export function discoveryRoots(source: string, home: string, cloudRoots: string[]) {
  return [
    source,
    dirname(source),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Projects'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'OneDrive', 'Documents'),
    ...cloudRoots.flatMap((root) => [join(root, 'Desktop'), join(root, 'Documents')]),
  ];
}
const stamp = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

// 只观察目录项/属性，不读取文件字节；这份清单不能交给交付器作为内容基线。
export function metadataInventory(
  root: string,
  budget: MetadataBudget,
  options: {
    expectedRoot?: string;
    prefix?: string;
    fileOnly?: string;
    skipEnvironments?: boolean;
    allowPath?: (absolute:string)=>boolean;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
) {
  const entries: MetadataEntry[] = [];
  const coverage: MetadataCoverage = {
    root,
    depth: budget.maxDepth,
    visited: 0,
    limited: false,
    complete: true,
    reasons: [],
    skipped: {},
    examples: [],
  };
  const directories = new Map<string, string>();
  const now = options.now ?? Date.now,
    started = now();
  const skip = (path: string, reason: string, incomplete = false) => {
    coverage.skipped[reason] = (coverage.skipped[reason] ?? 0) + 1;
    if (coverage.examples.length < 8) coverage.examples.push({ path, reason });
    if (incomplete) coverage.complete = false;
  };
  const limit = (reason: string) => {
    coverage.limited = true;
    coverage.complete = false;
    if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  };
  const stopped = () => {
    options.signal?.throwIfAborted();
    if (coverage.visited >= budget.maxEntries) {
      limit('entries');
      return true;
    }
    if (now() - started >= budget.maxMs) {
      limit('time');
      return true;
    }
    return false;
  };
  const add = (absolute: string, path: string) => {
    if(options.allowPath && !options.allowPath(absolute)) {skip(path,'protected-control-data');return false;}
    const s = lstatSync(absolute, { bigint: true });
    if (s.isSymbolicLink()) {
      skip(path, 'link', true);
      return;
    }
    if (!s.isDirectory() && (!s.isFile() || s.nlink > 1n)) {
      skip(path, 'special-or-hardlink', true);
      return;
    }
    if (path && !filePath.safeParse(path).success) {
      skip(path, 'unsupported-path', true);
      return;
    }
    entries.push({
      path,
      kind: s.isDirectory() ? 'directory' : 'file',
      identity: s.isDirectory()
        ? `${s.dev}:${s.ino}`
        : `${s.dev}:${s.ino}:${s.birthtimeNs}`,
      size: Number(s.size),
      modifiedNs: s.mtimeNs.toString(),
      changedNs: s.ctimeNs.toString(),
    });
    return s.isDirectory();
  };
  const walk = (absolute: string, base: string, depth: number) => {
    if (stopped()) return;
    if(options.allowPath && !options.allowPath(absolute)) {skip(base,'protected-control-data');return;}
    safeRoot(absolute);
    directories.set(absolute, stamp(absolute));
    const dir = opendirSync(absolute);
    const names: string[] = [];
    try {
      // opendir 避免在超大单层目录上一次分配全部目录项；先收集预算内名称再排序。
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (stopped()) break;
        coverage.visited++;
        names.push(item.name);
      }
    } finally {
      dir.closeSync();
    }
    names.sort();
    for (const name of names) {
      options.signal?.throwIfAborted();
      if (now() - started >= budget.maxMs) {
        limit('time');
        break;
      }
      const path = base ? `${base}/${name}` : name,
        target = join(absolute, name);
      if (
        ignored.has(name.toLowerCase()) ||
        (options.skipEnvironments && name.toLowerCase() === 'environments')
      ) {
        skip(path, 'ignored');
        continue;
      }
      try {
        const directory = add(target, path);
        if (directory) {
          if (depth >= budget.maxDepth) {
            limit('depth');
            continue;
          }
          walk(target, path, depth + 1);
        }
      } catch (e) {
        options.signal?.throwIfAborted();
        skip(path, e instanceof UmiError ? 'unsafe-path' : 'unavailable', true);
      }
    }
  };
  try {
    safeRoot(root, options.expectedRoot);
    if (options.fileOnly) {
      // 单文件范围只 stat 该对象，不遍历其相邻文件，也不根据 prefix 扩大范围。
      const path = options.fileOnly;
      if (
        !options.prefix ||
        path === options.prefix ||
        path.startsWith(`${options.prefix}/`)
      ) {
        const target = safeFile(root, path, options.expectedRoot);
        coverage.visited++;
        try {
          add(target, path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    } else if (options.prefix) {
      filePath.parse(options.prefix);
      const target = join(root, ...options.prefix.split('/'));
      // 先检查祖先，再 stat 目标，避免 prefix 借目录联接观察根外对象。
      safeRoot(dirname(target));
      let s;
      try {
        s = lstatSync(target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (s?.isDirectory() && !s.isSymbolicLink()) {
        safeRoot(target);
        add(target, options.prefix);
        walk(target, options.prefix, 0);
      } else if (s) {
        safeFile(root, options.prefix, options.expectedRoot);
        add(target, options.prefix);
      }
    } else {
      add(root, '');
      walk(root, '', 0);
    }
    // 目录在观察期间发生增删/替换时，不发布可续用的分页版本。
    for (const [path, before] of directories) {
      if (stamp(path) !== before)
        throw new UmiError('RESOURCE_CHANGED', '目录在列举期间发生变化');
    }
  } catch (e) {
    options.signal?.throwIfAborted();
    if (e instanceof UmiError) throw e;
    skip(options.prefix ?? '', 'unavailable', true);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries,
    coverage,
    version: hash({ entries, directories: [...directories], coverage }),
  };
}

const cursorSchema = z
  .object({
    v: z.literal(1),
    binding: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative().max(50000),
  })
  .strict();
// 游标只表达读位置；权限仍由 mount/environment 和真实路径检查决定，不由游标授予。
export function metadataPage<T>(
  all: T[],
  binding: unknown,
  version: string,
  limit: number,
  cursor?: string,
) {
  const key = hash(binding);
  let offset = 0;
  if (cursor) {
    let parsed;
    try {
      parsed = cursorSchema.parse(
        JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new UmiError('PROTOCOL_INVALID', '无效的元数据分页游标');
    }
    if (parsed.binding !== key)
      throw new UmiError('PERMISSION_DENIED', '分页游标不属于当前对象和查询');
    if (parsed.version !== version)
      return {
        status: 'restart_required' as const,
        items: [] as T[],
        nextCursor: null,
        total: null,
        truncated: false,
      };
    offset = parsed.offset;
    if (offset > all.length)
      throw new UmiError('PROTOCOL_INVALID', '分页位置超出当前清单');
  }
  const end = Math.min(offset + limit, all.length);
  return {
    status: 'ok' as const,
    items: all.slice(offset, end),
    total: all.length,
    truncated: end < all.length,
    nextCursor:
      end < all.length
        ? Buffer.from(
            JSON.stringify({ v: 1, binding: key, version, offset: end }),
          ).toString('base64url')
        : null,
  };
}
