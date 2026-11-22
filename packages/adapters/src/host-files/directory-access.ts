import { lstatSync } from 'node:fs';
import { UmiError } from '../../../protocol/src/model.js';
import type { DirectoryAccessObserver, DirectoryAccessStatus } from '../../../protocol/src/resources.js';
import { safeFile, safeRoot } from './paths.js';

// A short, bounded metadata cache for presentation. Actual file tools still perform
// their uncached authorization, scope, identity and version checks before access.
export function createDirectoryAccessObserver(now = () => performance.now()): DirectoryAccessObserver {
  const cache = new Map<string, { until: number; status: DirectoryAccessStatus }>();
  return (probe, refresh = false) => {
    const key = JSON.stringify(probe), at = now(), prior = cache.get(key);
    if (!refresh && prior && prior.until > at) return prior.status;
    let status: DirectoryAccessStatus;
    try {
      safeRoot(probe.root, probe.rootIdentity);
      if (probe.scope.kind === 'file') {
        const target = safeFile(probe.root, probe.scope.path, probe.rootIdentity);
        const stat = lstatSync(target);
        status = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? 'available' : 'changed';
      } else status = 'available';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      status = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing'
        : error instanceof UmiError && error.code === 'RESOURCE_CHANGED' ? 'changed' : 'unavailable';
    }
    cache.delete(key);
    cache.set(key, { until: at + 1000, status });
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
    return status;
  };
}
