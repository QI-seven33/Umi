import { deliveredTarget } from './delivered-open.js';
import { hash } from '../../../agent/src/identity.js';
import type { OutputFiles } from './outputs.js';
import type { CurrentTaskEvidence } from '../sqlite/tasks.js';
import type { ResourceFiles } from './resources.js';
import { observe, sameEntry, safeRoot } from './paths.js';
import {
  processReceiptSchema,
  processSnapshotSchema,
} from '../../../protocol/src/process.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { DeliveryReceipt } from '../../../protocol/src/resources.js';

// 只观察现状，不重跑命令、不重新交付。路径仍走原资源范围和对象身份检查。
export function currentTaskEvidence(
  files: ResourceFiles,
  outputs?: OutputFiles,
): CurrentTaskEvidence {
  return (check, tool, result) => {
    const repo = files.repo;
    if (check.kind === 'file_hash') {
      files.mountContext(
        {},
        repo.store.environment(tool.environment_id),
        check.mountId,
        check.path,
      );
      const mount = repo.mount(check.mountId, tool.environment_id);
      files.assertPath(mount.scope, check.path);
      const entry = observe(mount.root, check.path, mount.rootIdentity);
      return (entry?.hash ?? null) === check.expectedHash;
    }
    if (check.kind === 'document_open') {
      const data = result.data as { changeSetId: string; path: string; hash: string; systemAccepted: boolean };
      const cs = repo.changeSet(data.changeSetId, tool.environment_id);
      if (cs.mountId !== check.mountId || data.path !== check.path || data.systemAccepted !== true) return false;
      const target = deliveredTarget(files, repo.store.getRun(tool.run_id).conversation_id, cs.id, check.path);
      return target.hash === data.hash; // 只证明系统接收指定当前交付版本，不证明显示/排版。
    }
    if (check.kind === 'command_exit') {
      const receipt = processReceiptSchema.parse(result.data);
      const context = repo.store.readArtifact<ExecutionContext>(tool.context_ref!);
      const snapshot = processSnapshotSchema.parse(context.process);
      safeRoot(snapshot.cwd, snapshot.cwdIdentity);
      return (
        receipt.executionId === tool.id &&
        receipt.reason === 'exited' &&
        receipt.exitCode === 0 &&
        receipt.jobInactive &&
        receipt.gateReleased
      );
    }
    if (check.kind === 'export_receipt') {
      if (!outputs) return false;
      const cid = repo.store.getRun(tool.run_id).conversation_id;
      const data = outputs.inspectExport(
        cid,
        (result.data as { exportExecutionId: string }).exportExecutionId,
      ).data as {
        receipts: { target: string; hash: string; status: string }[];
      };
      return (
        data.receipts.length === check.items.length &&
        data.receipts.every((receipt) => receipt.status === 'verified') &&
        hash(data.receipts.map((i) => [i.target, i.hash]).sort()) ===
          hash(check.items.map((i) => [i.target, i.expectedHash]).sort())
      );
    }
    if (check.kind === 'delivery') {
      const changeset = repo.changeSet(check.changeSetId, tool.environment_id);
      const mount = repo.mount(changeset.mountId, tool.environment_id);
      const receipts = (result.data as { receipts: DeliveryReceipt[] }).receipts;
      if (!Array.isArray(receipts) || receipts.length !== changeset.changes.length)
        return false;
      return changeset.changes.every((change) => {
        const receipt = receipts.find((item) => item.path === change.path);
        return (
          receipt?.changeSetId === changeset.id &&
          ['applied', 'satisfied'].includes(receipt.outcome) &&
          sameEntry(
            observe(mount.sourceRoot, change.path, mount.sourceIdentity),
            change.after,
            false,
          )
        );
      });
    }
    return false;
  };
}
