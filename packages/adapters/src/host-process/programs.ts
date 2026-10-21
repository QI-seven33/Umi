import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { UmiError } from '../../../protocol/src/model.js';

// 观察与实际直接执行共用选择规则。Electron 不是独立 Node；不能用它执行用户脚本。
export type ProgramRuntime = { execPath: string; electron: boolean; path: string };
const currentRuntime = (): ProgramRuntime => ({
  execPath: process.execPath,
  electron: Boolean(process.versions.electron),
  path: process.env.PATH ?? '',
});
type Location = {
  path: string;
  source: 'umi-node' | 'absolute' | 'host-path' | 'node-sibling';
};

function pathEntry(name: string, runtime: ProgramRuntime, check: () => void) {
  for (const directory of runtime.path.split(';')) {
    check();
    // 不从 Umi 自己的 cwd 解释相对 PATH；那不是本次任务工作副本。
    // 这里只观察明确的绝对 PATH 项，不模拟 Shell 的别名、PATHEXT 或 App Paths。
    if (!isAbsolute(directory) || /^[/\\](?![/\\])/.test(directory)) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function executableLocation(
  program: string,
  runtime: ProgramRuntime,
  check: () => void,
): Location {
  if (program === 'node' && !runtime.electron)
    return { path: runtime.execPath, source: 'umi-node' };
  if (isAbsolute(program)) {
    if (!/\.exe$/i.test(program))
      throw new UmiError(
        'PROGRAM_UNSUPPORTED',
        '直接执行仅接受 .exe；批处理请使用明确的 CMD 脚本',
      );
    return { path: program, source: 'absolute' };
  }
  if (/[\\/]/.test(program) || !/^[-\w.]+$/.test(program))
    throw new UmiError('PROGRAM_UNSUPPORTED', '程序使用明确名称或绝对 .exe 路径');
  const path = pathEntry(/\.exe$/i.test(program) ? program : `${program}.exe`, runtime, check);
  if (path) return { path, source: 'host-path' };
  throw new UmiError(
    'PROGRAM_NOT_FOUND',
    '当前 Umi 进程的绝对 PATH 项未找到指定 .exe；不代表整机未安装。可提供明确绝对路径；npm 等 .cmd 入口应使用 CMD 模式',
  );
}

export function resolveProgram(program: string) {
  return executableLocation(program, currentRuntime(), () => {}).path;
}

// 只定位、不运行；npm.cmd 的存在也不证明它能找到 Node 或所有依赖。
export function observeProgram(
  program: string,
  runtime = currentRuntime(),
  check: () => void = () => {},
) {
  let location: Location;
  if (program === 'npm') {
    let sibling: string | undefined;
    try {
      sibling = join(dirname(executableLocation('node', runtime, check).path), 'npm.cmd');
    } catch (error) {
      if (!(error instanceof UmiError) || error.code !== 'PROGRAM_NOT_FOUND') throw error;
    }
    check();
    if (sibling && existsSync(sibling)) location = { path: sibling, source: 'node-sibling' };
    else {
      const path = pathEntry('npm.cmd', runtime, check);
      if (!path)
        throw new UmiError('PROGRAM_NOT_FOUND', '当前 Node 同目录和 Umi 进程绝对 PATH 项未找到 npm.cmd；不代表整机未安装');
      location = { path, source: 'host-path' };
    }
  } else location = executableLocation(program, runtime, check);
  const lookup = pathEntry(basename(location.path), runtime, check);
  return {
    ...location,
    invocation: program === 'npm'
      ? { tool: 'run_shell' as const, shell: 'cmd' as const, entry: location.path }
      : /(?:^|[\\/])(?:powershell|pwsh|cmd)\.exe$/i.test(location.path)
        ? { tool: null, reason: 'USE_FIXED_SHELL', instruction: '此 Shell 入口不能通过 run_command 执行；run_shell 使用固定 CMD/Windows PowerShell，不能选择此路径或切换到 pwsh。' }
        : { tool: 'run_command' as const, program: location.path },
    pathLookup: {
      scope: 'current-process-absolute-PATH-files' as const,
      status: lookup ? 'located' as const : 'not-found' as const,
      path: lookup,
    },
  };
}
