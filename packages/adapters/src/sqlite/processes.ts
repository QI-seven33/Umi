import { SqliteStore } from './store.js';
import {
  processSnapshotSchema,
  processReceiptSchema,
} from '../../../protocol/src/process.js';
import type {
  ProcessSnapshot,
  ProcessReceipt,
  ProcessIdentity,
} from '../../../protocol/src/process.js';
import { UmiError } from '../../../protocol/src/model.js';
import { hash } from '../../../agent/src/identity.js';

export class ProcessRepository {
  constructor(readonly store: SqliteStore) {}
  row(executionId: string) {
    return this.store.get(
      'SELECT * FROM process_executions WHERE execution_id=?',
      executionId,
    );
  }
  private scope(id: string) {
    return this.store.preparedToolScope(this.store.tool(id));
  }
  plan(snapshot: ProcessSnapshot) {
    processSnapshotSchema.parse(snapshot);
    const t = this.store.tool(snapshot.executionId);
    if (t.state !== 'dispatched')
      throw new UmiError('PROTOCOL_INVALID', '启动计划必须在工具派发持久化之后');
    this.store.transaction(() => {
      const ref = this.store.artifact(snapshot, 'process-snapshot');
      this.store.run(
        "INSERT INTO process_executions(execution_id,snapshot_ref,state) VALUES(?,?,'planned')",
        t.id,
        ref,
      );
      this.store.append(this.scope(t.id), {
        type: 'process.planned',
        payload: { snapshotRef: ref },
      });
    });
  }
  owner(id: string, bridge: ProcessIdentity) {
    this.store.transaction(() => {
      const p = this.row(id);
      if (!p || p.state !== 'planned' || p.bridge_pid)
        throw new UmiError('PROTOCOL_INVALID', '桥接身份无法绑定');
      this.store.run(
        'UPDATE process_executions SET bridge_pid=?,bridge_birth=? WHERE execution_id=?',
        bridge.pid,
        bridge.birth,
        id,
      );
      this.store.append(this.scope(id), {
        type: 'process.owner_bound',
        payload: { bridgePid: bridge.pid, bridgeBirth: bridge.birth },
      });
    });
  }
  ready(id: string, bridge: ProcessIdentity, child: ProcessIdentity) {
    this.store.transaction(() => {
      const p = this.row(id);
      if (
        !p ||
        p.state !== 'planned' ||
        p.bridge_pid !== bridge.pid ||
        p.bridge_birth !== bridge.birth
      )
        throw new UmiError('PROTOCOL_INVALID', '原进程计划或桥接身份不存在');
      this.store.run(
        "UPDATE process_executions SET state='ready',child_pid=?,child_birth=? WHERE execution_id=?",
        child.pid,
        child.birth,
        id,
      );
      this.store.append(this.scope(id), {
        type: 'process.ready',
        payload: {
          bridgePid: bridge.pid,
          bridgeBirth: bridge.birth,
          childPid: child.pid,
          childBirth: child.birth,
        },
      });
    });
  }
  release(id: string) {
    this.store.transaction(() => {
      if (this.row(id)?.state !== 'ready')
        throw new UmiError('PROTOCOL_INVALID', '进程没有挂起就绪');
      this.store.run(
        "UPDATE process_executions SET state='running',released=1 WHERE execution_id=?",
        id,
      );
      this.store.append(this.scope(id), { type: 'process.release_intent', payload: {} });
    });
  }
  started(id: string) {
    this.store.commit(this.scope(id), { type: 'process.started', payload: {} });
  }
  output(id: string, channel: 'stdout' | 'stderr', text: string) {
    if (!text) return;
    this.store.transaction(() => {
      const index = Number(
          this.store.get(
            'SELECT COUNT(*) n FROM process_outputs WHERE execution_id=?',
            id,
          )!.n,
        ),
        ref = this.store.artifact({ encoding: 'utf-8', text }, 'process-output'),
        bytes = Buffer.byteLength(text);
      this.store.run(
        'INSERT INTO process_outputs VALUES(?,?,?,?,?)',
        id,
        index,
        channel,
        ref,
        bytes,
      );
      this.store.append(this.scope(id), {
        type: 'process.output',
        payload: { outputIndex: index, channel, artifactRef: ref, byteLength: bytes },
      });
    });
  }
  readOutput(id: string, channel: 'stdout' | 'stderr') {
    return this.store
      .all(
        'SELECT artifact_ref FROM process_outputs WHERE execution_id=? AND channel=? ORDER BY output_index',
        id,
        channel,
      )
      .map(
        (r) => this.store.readArtifact<{ text: string }>(r.artifact_ref as string).text,
      )
      .join('');
  }
  receipt(id: string): ProcessReceipt | undefined {
    const ref = this.row(id)?.receipt_ref;
    return ref
      ? processReceiptSchema.parse(this.store.readArtifact(ref as string))
      : undefined;
  }
  confirmCleanup(id: string): ProcessReceipt {
    return this.store.transaction(() => {
      const old = this.receipt(id);
      if (!old) throw new UmiError('PROTOCOL_INVALID', '原退出回执不存在');
      if (old.jobInactive) return old;
      const receipt = processReceiptSchema.parse({
          ...old,
          jobInactive: true,
          observedAt: new Date().toISOString(),
        }),
        ref = this.store.artifact(receipt, 'process-receipt');
      this.store.run(
        'UPDATE process_executions SET receipt_ref=? WHERE execution_id=?',
        ref,
        id,
      );
      this.store.append(this.scope(id), {
        type: 'process.reconciled',
        payload: { receiptRef: ref, jobInactive: true },
      });
      return receipt;
    });
  }
  finish(receipt: Omit<ProcessReceipt, 'stdoutRef' | 'stderrRef'>): ProcessReceipt {
    return this.store.transaction(() => {
      const id = receipt.executionId,
        existing = this.receipt(id);
      if (existing) {
        if (
          hash({ ...existing, stdoutRef: undefined, stderrRef: undefined }) !==
          hash(receipt)
        )
          throw new UmiError('PROTOCOL_INVALID', '进程已有不同回执');
        return existing;
      }
      const result = processReceiptSchema.parse({
        ...receipt,
        stdoutRef: this.store.artifact(
          { encoding: 'utf-8', text: this.readOutput(id, 'stdout') },
          'process-output-complete',
        ),
        stderrRef: this.store.artifact(
          { encoding: 'utf-8', text: this.readOutput(id, 'stderr') },
          'process-output-complete',
        ),
      });
      const ref = this.store.artifact(result, 'process-receipt');
      this.store.run(
        "UPDATE process_executions SET state='exited',receipt_ref=? WHERE execution_id=?",
        ref,
        id,
      );
      this.store.append(this.scope(id), {
        type: 'process.exited',
        payload: {
          receiptRef: ref,
          exitCode: result.exitCode,
          reason: result.reason,
          jobInactive: result.jobInactive,
        },
      });
      return result;
    });
  }
}
