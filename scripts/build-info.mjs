import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function filesUnder(root, relative, accept) {
  const files = [];
  const walk = path => {
    if (!existsSync(join(root, path))) return;
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error(`构建资料含链接：${path}/${entry.name}`);
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && accept(child)) files.push(child);
    }
  };
  walk(relative); return files.sort();
}
export function sourceFingerprint(root) {
  const files = ['apps', 'packages', 'assets/brand'].flatMap(dir => filesUnder(root, dir, path => /\.(?:ts|tsx|css|png|ico|svg|ttf|txt)$/.test(path)));
  files.push('package.json', 'package-lock.json', 'scripts/build-desktop.mjs', 'scripts/build-info.mjs', 'scripts/package-desktop.mjs', 'scripts/build-icons.cjs', 'scripts/build-windows.mjs', 'electron-builder.yml');
  return digest(files.sort().map(path => `${path}\0${digest(readFileSync(join(root, path)))}`).join('\n'));
}
export function writeBuildInfo(root) {
  const files = ['dist/apps', 'dist/packages'].flatMap(dir => filesUnder(root, dir, path => /\.(?:js|cjs|css|html|png|ico|svg|ttf|txt)$/.test(path))).map(path => ({ path, sha256: digest(readFileSync(join(root, path))) }));
  const info = { schemaVersion: 1, builtAt: new Date().toISOString(), sourceFingerprint: sourceFingerprint(root), files };
  writeFileSync(join(root, 'dist/umi-build.json'), JSON.stringify(info, null, 2)); return info;
}
export function verifyBuild(root, info) {
  if (info.schemaVersion !== 1 || !Array.isArray(info.files) || !info.files.length) throw Error('构建清单缺失或不兼容，请先构建桌面版');
  const paths = new Set();
  for (const entry of info.files) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith('dist/') || /[\\:]/.test(entry.path) || entry.path.split('/').includes('..') || paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('构建清单路径或hash无效');
    paths.add(entry.path); const file = join(root, entry.path);
    if (!existsSync(file) || !statSync(file).isFile() || digest(readFileSync(file)) !== entry.sha256) throw Error(`构建文件不匹配：${entry.path}`);
  }
  return info.files.length;
}
