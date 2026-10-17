import { build } from 'electron-builder';
import { path7za } from '7zip-bin';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, lstatSync, readdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceFingerprint, verifyBuild } from './build-info.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (resolve(process.cwd()) !== root) throw Error('请在 Umi 源码根目录构建');
const portable = join(root, 'release/Umi-win32-x64');
if (!existsSync(portable) || lstatSync(portable).isSymbolicLink()) throw Error('请先生成本地便携版');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const info = JSON.parse(readFileSync(join(root, 'dist/umi-build.json'), 'utf8'));
const release = JSON.parse(readFileSync(join(portable, 'umi-release.json'), 'utf8'));
if (sourceFingerprint(root) !== info.sourceFingerprint || release.sourceFingerprint !== info.sourceFingerprint) throw Error('便携版与当前源码不一致');
verifyBuild(root, info); verifyBuild(join(portable, 'resources/app'), info);
if (JSON.parse(readFileSync(join(portable, 'resources/app/package.json'), 'utf8')).version !== pkg.version) throw Error('包内版本与源码不一致');
const output = join(root, 'release/installers');
const setup = join(output, `Umi-Setup-${pkg.version}-x64.exe`);
const zip = join(output, `Umi-${pkg.version}-win-x64-portable.zip`);
if (existsSync(zip)) throw Error('同版本便携压缩包已存在；请先保存旧产物或使用新版本号');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const archive = (args, cwd) => {
  const result = spawnSync(path7za, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error('压缩资料检查失败：' + result.stderr);
};
let payloadVerification;
// 在构建器清理临时载荷前核验真正嵌入安装器的压缩资料，无需安装或改注册表。
const verifyPayload = async event => {
  if (resolve(event.file).toLowerCase() !== setup.toLowerCase()) return;
  const candidates = readdirSync(output).filter(name => name.toLowerCase() === `umi-${pkg.version}-x64.nsis.7z`);
  if (candidates.length !== 1) throw Error('无法定位安装器实际载荷');
  const inspection = mkdtempSync(join(output, `verification-${pkg.version}-`));
  const payload = join(inspection, 'payload.7z');
  copyFileSync(join(output, candidates[0]), payload);
  archive(['t', payload], root);
  const unpacked = join(inspection, 'unpacked');
  archive(['x', payload, '-o' + unpacked, '-y'], root);
  const runtimeFiles = verifyBuild(join(unpacked, 'resources/app'), info);
  const exeSha256 = digest(join(unpacked, 'Umi.exe'));
  if (exeSha256 !== digest(join(portable, 'Umi.exe'))) throw Error('安装器载荷exe与便携版不一致');
  const embedded = JSON.parse(readFileSync(join(unpacked, 'resources/app/package.json'), 'utf8'));
  if (embedded.version !== pkg.version) throw Error('安装器载荷版本不一致');
  payloadVerification = { verified: true, runtimeFiles, exeSha256, archiveSha256: digest(payload) };
  writeFileSync(join(inspection, 'verification.json'), JSON.stringify(payloadVerification, null, 2));
};
// 此阶段只生成本地文件；发布为独立操作。未配置签名证书和自动更新。
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const artifacts = await build({ win: ['nsis'], x64: true, prepackaged: portable, config: { extends: join(root, 'electron-builder.yml'), artifactBuildCompleted: verifyPayload }, publish: 'never' });
if (!artifacts.some(path => resolve(path).toLowerCase() === setup.toLowerCase()) || !existsSync(setup) || !payloadVerification) throw Error('安装器或载荷检查未完成');
archive(['a', '-tzip', '-mx=5', zip, '.'], portable);
verifyBuild(join(portable, 'resources/app'), info);
const files = [setup, zip].map(path => ({ name: basename(path), bytes: readFileSync(path).length, sha256: digest(path) }));
writeFileSync(join(output, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
writeFileSync(join(output, 'umi-windows-release.json'), JSON.stringify({ version: pkg.version, createdAt: new Date().toISOString(), sourceFingerprint: info.sourceFingerprint, runtimeFiles: info.files.length, signed: false, payloadVerification, files }, null, 2));
console.log(JSON.stringify({ version: pkg.version, artifacts: files.map(file => file.name), output, payloadVerification }));