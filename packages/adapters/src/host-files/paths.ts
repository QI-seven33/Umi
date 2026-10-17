import { createHash } from 'node:crypto';
import {
  lstatSync,
  statSync,
  realpathSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep, parse } from 'node:path';
import { UmiError } from '../../../protocol/src/model.js';
import { filePath } from '../../../protocol/src/resources.js';
import type { Manifest } from '../../../protocol/src/resources.js';
import { uid } from '../../../agent/src/identity.js';

export const bytesHash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function rootIdentity(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}`;
}
export function fileIdentity(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export function safeRoot(path: string, expected?: string): string {
  const absolute = resolve(path);
  if (absolute.startsWith('\\\\'))
    throw new UmiError('PERMISSION_DENIED', '当前结构化资源不接受网络共享或设备路径');
  let part = parse(absolute).root;
  for (const name of absolute.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, name);
    if (lstatSync(part).isSymbolicLink())
      throw new UmiError('PERMISSION_DENIED', '根路径包含符号链接或目录联接');
  }
  const canonical = realpathSync(absolute),
    samePath =
      process.platform === 'win32'
        ? canonical.toLowerCase() === absolute.toLowerCase()
        : canonical === absolute;
  if (
    !statSync(absolute).isDirectory() ||
    !samePath ||
    (expected && rootIdentity(absolute) !== expected)
  )
    throw new UmiError('RESOURCE_CHANGED', '目录身份或规范位置已变化');
  return canonical;
}
export function safeFile(root: string, path: string, expectedRoot?: string): string {
  filePath.parse(path);
  safeRoot(root, expectedRoot);
  const target = resolve(root, ...path.split('/')),
    rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new UmiError('PERMISSION_DENIED', '路径越过资源根');
  let part = root;
  for (const segment of path.split('/')) {
    part = join(part, segment);
    let s;
    try {
      s = lstatSync(part);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if (
      s.isSymbolicLink() ||
      (part !== target && !s.isDirectory()) ||
      (part === target && (!s.isFile() || s.nlink > 1))
    )
      throw new UmiError('PERMISSION_DENIED', '路径包含链接、硬链接、目录目标或特殊对象');
  }
  return existsSync(target) ? realpathSync(target) : target;
}
export function observe(
  root: string,
  path: string,
  expectedRoot?: string,
): Manifest[string] | null {
  const target = safeFile(root, path, expectedRoot);
  if (!existsSync(target)) return null;
  const s = statSync(target);
  if (s.size > 4 * 1024 * 1024)
    throw new UmiError('RESOURCE_LIMIT', '单文件超过结构化操作的 4 MiB 上限');
  const identity = fileIdentity(target),
    data = readFileSync(target);
  if (fileIdentity(target) !== identity || statSync(target).size !== data.length)
    throw new UmiError('RESOURCE_CHANGED', '读取期间文件被替换');
  return { hash: bytesHash(data), identity, size: data.length };
}
export function sameEntry(
  a: Manifest[string] | null,
  b: Manifest[string] | null,
  identity = true,
): boolean {
  return a === null || b === null
    ? a === b
    : a.hash === b.hash && a.size === b.size && (!identity || a.identity === b.identity);
}
// 枚举必须完整覆盖配置范围；达到上限即失败，不能把不完整清单交给交付器。
export function scan(
  root: string,
  excluded: string[] = [],
): { manifest: Manifest; excluded: string[] } {
  safeRoot(root);
  const manifest: Manifest = {},
    skipped: string[] = [];
  let count = 0,
    total = 0;
  const start = Date.now();
  const ignore = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
  function walk(dir: string, base: string, depth: number) {
    if (depth > 16 || Date.now() - start > 10000)
      throw new UmiError('RESOURCE_LIMIT', '资源清单超过深度或时间上限');
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++count > 5000)
        throw new UmiError('RESOURCE_LIMIT', '资源清单超过 5000 个目录项');
      const p = join(dir, e.name),
        rel = base ? `${base}/${e.name}` : e.name;
      if (ignore.has(e.name) || excluded.some((x) => resolve(p) === resolve(x))) {
        skipped.push(rel);
        continue;
      }
      if (e.isSymbolicLink())
        throw new UmiError('PERMISSION_DENIED', `资源含链接，未物化：${rel}`);
      if (e.isDirectory()) walk(p, rel, depth + 1);
      else {
        const entry = observe(root, rel);
        if (!entry) throw new UmiError('RESOURCE_CHANGED', '枚举时目标消失');
        total += entry.size;
        if (total > 32 * 1024 * 1024)
          throw new UmiError('RESOURCE_LIMIT', '资源内容超过 32 MiB 物化上限');
        manifest[rel] = entry;
      }
    }
  }
  walk(root, '', 0);
  return { manifest, excluded: skipped };
}
//原子写
export function atomicWrite(
  root: string,
  path: string,
  data: Uint8Array,
  expectedRoot?: string,
  temporaryPath?: string,
  expectedBefore?: Manifest[string] | null,
) {
  let file = safeFile(root, path, expectedRoot);
  mkdirSync(dirname(file), { recursive: true });
  file = safeFile(root, path, expectedRoot);
  const temp = temporaryPath
    ? safeFile(root, temporaryPath, expectedRoot)
    : join(dirname(file), `.umi-${uid()}.tmp`);
  if (dirname(temp) !== dirname(file))
    throw new UmiError('PROTOCOL_INVALID', '交付暂存文件必须位于目标同目录');
  try {
    const fd = openSync(temp, 'wx');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    safeFile(root, path, expectedRoot);
    // 局部编辑在暂存字节完成后再次检查原对象；这不是操作系统级 CAS/沙箱。
    if (
      expectedBefore !== undefined &&
      !sameEntry(observe(root, path, expectedRoot), expectedBefore)
    )
      throw new UmiError('RESOURCE_CHANGED', '落盘前目标字节或对象身份已变化');
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

// wx 原子占用不存在的名称，不覆盖晚到目标；写入中断可留下部分文件，恢复只核验。
export function createExclusive(
  root: string,
  path: string,
  data: Uint8Array,
  expectedRoot?: string,
) {
  let file = safeFile(root, path, expectedRoot);
  mkdirSync(dirname(file), { recursive: true });
  file = safeFile(root, path, expectedRoot);
  const fd = openSync(file, 'wx');
  try {
    safeFile(root, path, expectedRoot);
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
