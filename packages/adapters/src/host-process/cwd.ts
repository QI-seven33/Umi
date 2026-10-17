import { join } from 'node:path';
import type { Environment } from '../../../agent/src/persistence.js';
import type { DirectCommand } from '../../../protocol/src/process.js';
import { ResourceFiles } from '../host-files/resources.js';
import { hostContext } from '../host-files/scratch.js';
import { safeRoot } from '../host-files/paths.js';

// 只解析既有逻辑 cwd，不创建目录，也不把 cwd 当成命令的磁盘沙箱。
export function commandCwd(
  files: ResourceFiles,
  env: Environment,
  cwd: DirectCommand['cwd'],
  edit = false,
) {
  hostContext({}, env);
  let root: string;
  if (cwd.kind === 'mount') {
    const mount = files.repo.mount(cwd.mountId, env.id);
    files.mountContext({}, env, mount.id, undefined, undefined, edit);
    root = mount.root;
  } else root = join(env.root, 'task', cwd.area);
  safeRoot(root);
  return safeRoot(cwd.path ? join(root, ...cwd.path.split('/')) : root);
}
