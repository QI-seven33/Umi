import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';

type Owner = { pid: number; instanceId: string };
function owner(path: string): Owner | null {
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error();
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('pid' in value) || !('instanceId' in value) ||
        !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || Number(value.pid) > 2147483647 ||
        typeof value.instanceId !== 'string' || !value.instanceId) throw Error();
    return value as Owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new UmiError('WRITER_LOCKED', '写入锁标记损坏或不可读取，未自动删除；请完整退出 Umi 后核验数据目录。');
  }
}
function assertExited(value: Owner) {
  try { process.kill(value.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  // PID复用、权限不足都保守阻挡，不用年龄或猜测代替退出证据。
  throw new UmiError('WRITER_LOCKED', '另一个写入进程仍可能存活，禁止并发运行。');
}

/** 独立小SQLite文件只持有进程锁，不存业务数据；进程退出后系统释放锁。 */
export class WriterLock {
  private readonly mutex: DatabaseSync;
  private readonly guard: string;
  private readonly ownerPath: string;
  private readonly lockPath: string;
  private released = false;
  constructor(root: string, private readonly instanceId: string) {
    this.guard = join(root, 'writer.starting');
    this.ownerPath = join(this.guard, 'owner.json');
    this.lockPath = join(root, 'writer.lock');
    let mutex: DatabaseSync | undefined;
    try {
      mutex = new DatabaseSync(join(root, 'writer-lease.sqlite'));
      mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      try { mutex?.close(); } catch {}
      throw new UmiError('WRITER_LOCKED', '另一个写入进程仍可能持有锁，或写入锁文件不可用。');
    }
    this.mutex = mutex;
    try {
      try { mkdirSync(this.guard); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = lstatSync(this.guard);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new UmiError('WRITER_LOCKED', '启动标记不是普通目录，未自动修改。');
      const previous = owner(this.ownerPath);
      if (previous) { assertExited(previous); unlinkSync(this.ownerPath); }
      // 空目录也用wx争抢owner。旧版本若刚mkdir但尚未写owner，只有一个写入能成功。
      writeFileSync(this.ownerPath, canonical({ pid: process.pid, instanceId }), { flag: 'wx' });
      const writer = owner(this.lockPath);
      if (writer) { assertExited(writer); unlinkSync(this.lockPath); }
      writeFileSync(this.lockPath, canonical({ pid: process.pid, instanceId }), { flag: 'wx' });
      // guard保留到close，旧版本也不能同时进入其启动/死锁接管分支。
    } catch (error) {
      this.release();
      if (error instanceof UmiError) throw error;
      throw new UmiError('WRITER_LOCKED', '写入权核验未完成，未打开会话库。');
    }
  }
  release() {
    if (this.released) return;
    // 只清理本实例标记；先关业务数据库，再由调用者释放这里的写入权。
    try { if (owner(this.lockPath)?.instanceId === this.instanceId) unlinkSync(this.lockPath); } catch {}
    try {
      if (owner(this.ownerPath)?.instanceId === this.instanceId) {
        unlinkSync(this.ownerPath); rmdirSync(this.guard);
      }
    } catch {}
    try { this.mutex.close(); } finally { this.released = true; }
    // 不删除mutex文件：删除仍被打开的锁文件会破坏不同进程间的锁身份。
  }
}
