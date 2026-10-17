import type { SqliteStore } from './store.js';
import { canonical, hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';

// 窄的不可变意图/回执账本：复用 artifacts 主键，不改变历史 SQL 或新增全局服务。
export class OutputRepository {
  constructor(readonly store: SqliteStore) {}
  read<T>(ref: string): T | undefined {
    if (!this.store.get('SELECT id FROM artifacts WHERE id=?', ref)) return undefined;
    return this.store.readArtifact<T>(ref);
  }
  save(ref: string, value: unknown) {
    this.store.transaction(() => {
      const existing = this.read(ref);
      if (existing !== undefined) {
        if (hash(existing) !== hash(value))
          throw new UmiError('PROTOCOL_INVALID', '不可改写原导出事实');
        return;
      }
      const content = canonical(value);
      this.store.run(
        'INSERT INTO artifacts VALUES(?,?,?,?)',
        ref,
        hash(content),
        'output-export',
        content,
      );
    });
  }
  intentRef(executionId: string, index: number) {
    return `output-intent-${executionId}-${index}`;
  }
  receiptRef(executionId: string, index: number) {
    return `output-receipt-${executionId}-${index}`;
  }
}
