import { hash } from '../../../agent/src/identity.js';
import type { OutputFiles } from './outputs.js';
import type { CurrentTaskEvidence } from '../sqlite/tasks.js';
import type { ResourceFiles } from './resources.js';
import {observe,safeRoot} from './paths.js';
import {
  processReceiptSchema,
  processSnapshotSchema,
} from '../../../protocol/src/process.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';

// 只观察现状，不重跑命令或重新导出。路径仍走原资源范围和对象身份检查。
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
    if(check.kind==='document_open') {
      const data=result.data as {mountId:string;path:string;hash:string;systemAccepted:boolean};
      if(data.mountId!==check.mountId||data.path!==check.path||data.systemAccepted!==true)return false;
      const context=repo.store.readArtifact<ExecutionContext>(tool.context_ref!);
      files.mountContext({},repo.store.environment(tool.environment_id),check.mountId,check.path);
      const mount=repo.mount(check.mountId,tool.environment_id),entry=observe(mount.root,check.path,mount.rootIdentity);
      return entry?.hash===data.hash&&entry.identity===context.locations[0]?.beforeIdentity;
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
    return false;
  };
}
