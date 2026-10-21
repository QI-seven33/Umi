import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeProgram } from '../packages/adapters/src/host-process/programs.js';
import type { ProgramRuntime } from '../packages/adapters/src/host-process/programs.js';
import { UmiError } from '../packages/protocol/src/model.js';
import { removeTestRoot } from './fixtures.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'umi-program-observation-'));
  const bin = join(root, 'bin'), node = join(root, 'node');
  mkdirSync(bin); mkdirSync(node);
  const runtime: ProgramRuntime = { execPath: join(node, 'node.exe'), electron: false, path: bin };
  // 这些入口只有无效文本；观察测试若意外运行它们就不可能成功。
  const entry = (dir: string, name: string) => {
    const path = join(dir, name); writeFileSync(path, 'inert observation fixture'); return path;
  };
  return { root, bin, node, runtime, entry, close: () => removeTestRoot(root) };
}

test('入口观察：Electron 缺少 Node 时仍定位 PATH 中的 npm.cmd，但不宣称能运行', () => {
  const f = fixture();
  try {
    const path = f.entry(f.bin, 'npm.cmd');
    const report = observeProgram('npm', { ...f.runtime, electron: true });
    assert.equal(report.path, path);
    assert.equal(report.source, 'host-path');
    assert.deepEqual(report.invocation, { tool: 'run_shell', shell: 'cmd', entry: path });
    assert.deepEqual(report.pathLookup, { scope: 'current-process-absolute-PATH-files', status: 'located', path });
    assert(!Object.hasOwn(report, 'version'));
  } finally { f.close(); }
});

test('入口观察：独立 Node 的直接入口与 PATH 同名入口可以不同，也可以缺失', () => {
  const f = fixture();
  try {
    const first = observeProgram('node', f.runtime);
    assert.equal(first.source, 'umi-node');
    assert.deepEqual(first.invocation, { tool: 'run_command', program: f.runtime.execPath });
    assert.equal(first.pathLookup.status, 'not-found');
    const different = f.entry(f.bin, 'node.exe');
    const second = observeProgram('node', f.runtime);
    assert.equal(second.path, f.runtime.execPath);
    assert.equal(second.pathLookup.path, different);
  } finally { f.close(); }
});

test('入口观察：Electron 绝不作为独立 Node 回退，PATH 有 Node 才定位', () => {
  const f = fixture();
  try {
    const runtime = { ...f.runtime, electron: true, execPath: join(f.root, 'electron.exe') };
    assert.throws(() => observeProgram('node', runtime), { code: 'PROGRAM_NOT_FOUND' });
    const path = f.entry(f.bin, 'node.exe');
    assert.equal(observeProgram('node', runtime).path, path);
    assert.equal(observeProgram('node', runtime).source, 'host-path');
  } finally { f.close(); }
});

test('入口观察：保持 Node 同目录 npm 优先，缺少同目录入口才回退 PATH', () => {
  const f = fixture();
  try {
    const onPath = f.entry(f.bin, 'npm.cmd');
    assert.equal(observeProgram('npm', f.runtime).path, onPath);
    const sibling = f.entry(f.node, 'npm.cmd');
    const report = observeProgram('npm', f.runtime);
    assert.equal(report.source, 'node-sibling');
    assert.equal(report.path, sibling);
    assert.equal(report.pathLookup.path, onPath);
  } finally { f.close(); }
});

test('入口观察：绝对路径与 PATH 查找分开，不把 .cmd 或脚本升级为直接执行', () => {
  const f = fixture();
  try {
    const exe = f.entry(f.node, 'custom.exe');
    const other = f.entry(f.bin, 'custom.exe');
    const report = observeProgram(exe, f.runtime);
    assert.equal(report.source, 'absolute');
    assert.equal(report.path, exe);
    assert.equal(report.pathLookup.path, other);
    for (const input of [join(f.node, 'npm.cmd'), './custom.exe', 'node && echo unsafe'])
      assert.throws(() => observeProgram(input, f.runtime), { code: 'PROGRAM_UNSUPPORTED' });
  } finally { f.close(); }
});

test('入口观察：跳过相对、空和当前盘根相对 PATH，保留绝对项先后顺序', () => {
  const f = fixture();
  try {
    const path = f.entry(f.bin, 'custom.exe');
    const later = f.entry(f.node, 'custom.exe');
    const runtime = { ...f.runtime, path: `.;relative-bin;\\;\rooted;;${f.bin};${f.node}` };
    assert.equal(observeProgram('custom', runtime).path, path);
    assert.notEqual(observeProgram('custom', runtime).path, later);
  } finally { f.close(); }
});

test('入口观察：PATH 扫描保留取消与预算异常，npm 回退不吞掉它们', () => {
  const f = fixture();
  try {
    const limit = new UmiError('PREFLIGHT_LIMIT', 'limited');
    assert.throws(() => observeProgram('npm', { ...f.runtime, electron: true }, () => { throw limit; }), e => e === limit);
    const abort = new DOMException('stopped', 'AbortError');
    assert.throws(() => observeProgram('custom', f.runtime, () => { throw abort; }), e => e === abort);
  } finally { f.close(); }
});

test('入口观察：Shell 文件存在也不能建议用 run_command 绕过固定 Shell 入口', () => {
  const f = fixture();
  try {
    for (const name of ['cmd.exe', 'powershell.exe', 'pwsh.exe']) {
      const path = f.entry(f.bin, name);
      const report = observeProgram(path, f.runtime);
      assert.equal(report.invocation.tool, null);
      assert.equal(report.invocation.reason, 'USE_FIXED_SHELL');
    }
  } finally { f.close(); }
});
