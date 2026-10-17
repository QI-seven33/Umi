import { packager } from '@electron/packager';
import { existsSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint, verifyBuild } from './build-info.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve('release/Umi-win32-x64');
// 覆盖仅限当前源码根下的已知Umi交付目录，拒绝目录链接和其他产品。
if (resolve(process.cwd()).toLowerCase() !== root.toLowerCase() || output.toLowerCase() !== join(root, 'release', 'Umi-win32-x64').toLowerCase()) throw Error('打包目录不属于当前 Umi 项目');
if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !existsSync(join(output, 'resources/app/package.json')) || JSON.parse(readFileSync(join(output, 'resources/app/package.json'), 'utf8')).name !== 'umi')) throw Error('拒绝覆盖不属于 Umi 的既有目录');
const manifestFile = join(root, 'dist/umi-build.json');
if (!existsSync(manifestFile)) throw Error('请先运行 npm run build:desktop，再打包');
const build = JSON.parse(readFileSync(manifestFile, 'utf8'));
if (build.sourceFingerprint !== sourceFingerprint(root)) throw Error('源码已变化，当前dist过期；请运行 npm run package:desktop');
verifyBuild(root, build);
// Electron npm 包随发行版附带官方校验表；复用缓存时仍验证压缩包，无需每次在线取同一版本清单。
const electronPackage = JSON.parse(readFileSync(join(root,'node_modules/electron/package.json'),'utf8'));
const electronChecksums = JSON.parse(readFileSync(join(root,'node_modules/electron/checksums.json'),'utf8'));
if (electronPackage.version !== '44.5.1' || !/^[a-f0-9]{64}$/.test(electronChecksums['electron-v44.5.1-win32-x64.zip'] ?? '')) throw Error('Electron 运行时或官方校验表与固定版本不符');
const paths = await packager({ download: { checksums: electronChecksums }, dir: '.', out: 'release', name: 'Umi', executableName: 'Umi', icon: resolve('apps/desktop/renderer/public/umi.ico'), platform: 'win32', arch: 'x64', electronVersion: '44.5.1', asar: false, prune: true, overwrite: true,
  ignore: [/^\/assets($|\/)/, /^\/\.github($|\/)/, /^\/electron-builder\.yml$/, /^\/AGENTS\.md$/, /^\/tsconfig\.json$/, /^\/release($|\/)/, /^\/apps($|\/)/, /^\/packages($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/docs($|\/)/, /^\/baseline\.json$/, /^\/[^/]+\.log$/, /^\/dist\/(tests|scripts)($|\/)/, /^\/\.env/, /^\/\.umi/, /^\/node_modules\/(?:\.cache|\.bin)/] });
for (const path of paths) {
  const runtimeFiles = verifyBuild(join(path, 'resources/app'), build);
  writeFileSync(join(path, 'umi-release.json'), JSON.stringify({ name: 'Umi', builtAt: build.builtAt, packagedAt: new Date().toISOString(), sourceFingerprint: build.sourceFingerprint, verifiedRuntimeFiles: runtimeFiles }, null, 2));
}
process.stdout.write(JSON.stringify({ name: 'Umi', paths, builtAt: build.builtAt, sourceFingerprint: build.sourceFingerprint, verifiedRuntimeFiles: build.files.length }) + '\n');
