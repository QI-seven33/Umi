import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { UmiError } from '../../../protocol/src/model.js';

export function resolveProgram(program: string) {
  if (program === 'node' && !process.versions.electron) return process.execPath;
  if (isAbsolute(program)) {
    if (!/\.exe$/i.test(program))
      throw new UmiError(
        'PROGRAM_UNSUPPORTED',
        '直接执行仅接受 .exe；批处理请使用明确的 CMD 脚本',
      );
    return program;
  }
  if (/[\\/]/.test(program) || !/^[-\w.]+$/.test(program))
    throw new UmiError('PROGRAM_UNSUPPORTED', '程序使用明确名称或绝对 .exe 路径');
  for (const path of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    const candidate = join(path, /\.exe$/i.test(program) ? program : `${program}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  throw new UmiError(
    'PROGRAM_NOT_FOUND',
    '没有找到指定程序；npm 等 .cmd 入口应使用 CMD 模式',
  );
}
