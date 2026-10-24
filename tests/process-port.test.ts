import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { UmiError } from '../packages/protocol/src/model.js';
import { uid } from '../packages/agent/src/identity.js';
import type { LegacyWindowsProcessPort } from '../packages/adapters/src/host-process/port.js';
import type { ProcessIdentity } from '../packages/protocol/src/process.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';

const bridge = { pid: 910001, birth: '1' };
const child = { pid: 910002, birth: '2' };
type Mode = 'success' | 'drift' | 'lost' | 'inaccessible';

function setup(mode: Mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'umi-process-port-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'a.txt'), '学习注释原文');
  let mountId = '';
  let calls = 0;
  const probes: { identity: ProcessIdentity; terminate: boolean }[] = [];
  const runner: LegacyWindowsProcessPort = {
    async run(snapshot, callbacks, signal) {
      signal.throwIfAborted();
      calls++;
      // 替身仍经过真实仓储与唯一 Agent 循环，只模拟原生桥接的边界。
      const row = app.commands.repo.row(snapshot.executionId)!;
      assert.equal(row.state, 'planned');
      assert.equal(app.store.tool(snapshot.executionId).state, 'dispatched');
      assert(
        app.store.events(c.conversationId).some((e) => e.type === 'tool.dispatch_intent'),
      );
      callbacks.owner(bridge);
      await callbacks.ready(bridge, child);
      assert.equal(app.commands.repo.row(snapshot.executionId)!.released, 1);
      callbacks.started();
      writeFileSync(join(snapshot.cwd, 'effect.txt'), String(calls));
      callbacks.output('stdout', '已执行');
      if (mode === 'lost' || mode === 'inaccessible')
        throw new UmiError('PROCESS_OUTCOME_UNKNOWN', '模拟原生回执丢失');
      return {
        kind: 'exit',
        reason: 'exited',
        exitCode: 0,
        jobInactive: true,
        gateReleased: true,
        stdoutBytes: Buffer.byteLength('已执行'),
        stderrBytes: 0,
        truncated: false,
      };
    },
    async probe(identity, terminate = false) {
      probes.push({ identity, terminate });
      return mode === 'inaccessible' ? 'inaccessible' : 'absent';
    },
  };
  const app = new UmiApplication(
    join(root, 'data'),
    new ScriptModel([
      () =>
        call('run_command', {
          program: 'node',
          argv: ['-e', ''],
          cwd: { kind: 'mount', mountId },
        }),
      text('核验阶段'),
      text('最终总结'),
    ]),
    {
      processRunner: runner,
      processBoundary(point, id) {
        if (mode === 'drift' && point === 'ready') {
          const snapshot = app.commands.repo.store.readArtifact<{ cwd: string }>(
            app.commands.repo.row(id)!.snapshot_ref as string,
          );
          // 普通文件修改不再绑定命令批准；这里核验仍保留的目录根身份。
          renameSync(snapshot.cwd, snapshot.cwd + '.before-ready');
          mkdirSync(snapshot.cwd);
          writeFileSync(join(snapshot.cwd, 'a.txt'), '替换后的目录根');
        }
      },
    },
  );
  const c = app.createConversation(workspace);
  mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
  return {
    app,
    c,
    runner,
    probes,
    workspace,
    get calls() {
      return calls;
    },
    get effect() {
      return join(app.files.repo.mount(mountId, c.environmentId).root, 'effect.txt');
    },
    pending() {
      return Object.entries(app.store.snapshot(c.conversationId).approvals).find(
        ([, a]) => a.status === 'pending',
      )?.[0];
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('执行端口：应用注入贯穿真实批准、派发、门控和输出归档', async () => {
  const f = setup();
  try {
    assert.equal(f.app.commands.runner, f.runner);
    const r = f.app.send(f.c.conversationId, uid(), '执行注入验证');
    const approval = await eventually(() => f.pending());
    assert.equal(f.calls, 0);
    assert(!existsSync(f.effect));
    f.app.approve(f.c.conversationId, approval, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.calls, 1);
    const t = f.app.store.tools(r.runId)[0]!;
    assert.equal(t.state, 'succeeded');
    assert.equal(f.app.previewProcess(f.c.conversationId, t.id, 'stdout').text, '已执行');
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '学习注释原文');
  } finally {
    await f.close();
  }
});

test('执行端口：拒绝批准时不会调用注入实现', async () => {
  const f = setup();
  try {
    const r = f.app.send(f.c.conversationId, uid(), '拒绝执行');
    f.app.approve(f.c.conversationId, await eventually(() => f.pending()), 'deny');
    await f.app.wait(r.runId);
    assert.equal(f.calls, 0);
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'denied');
    assert(!existsSync(f.effect));
  } finally {
    await f.close();
  }
});

test('执行端口：ready 后目录根替换阻止释放，恢复仅核验原身份', async () => {
  const f = setup('drift');
  try {
    const r = f.app.send(f.c.conversationId, uid(), '核验释放');
    f.app.approve(f.c.conversationId, await eventually(() => f.pending()), 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
    assert(!existsSync(f.effect));
    f.app.resume(f.c.conversationId, r.runId);
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.calls, 1);
    assert.deepEqual(f.probes, [
      { identity: bridge, terminate: true },
      { identity: child, terminate: false },
    ]);
    const receipt = f.app.commands.repo.receipt(f.app.store.tools(r.runId)[0]!.id)!;
    assert.equal(receipt.reason, 'not_started');
    assert.equal(receipt.gateReleased, false);
  } finally {
    await f.close();
  }
});

for (const mode of ['lost', 'inaccessible'] as const) {
  test(`执行端口：回执丢失 ${mode} 保留效果事实且不重跑`, async () => {
    const f = setup(mode);
    try {
      const r = f.app.send(f.c.conversationId, uid(), '核验未知结果');
      f.app.approve(f.c.conversationId, await eventually(() => f.pending()), 'allow');
      assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
      f.app.resume(f.c.conversationId, r.runId);
      assert.equal(
        (await f.app.wait(r.runId)).status,
        mode === 'lost' ? 'completed' : 'recovery_required',
      );
      assert.equal(f.calls, 1);
      assert.equal(readFileSync(f.effect, 'utf8'), '1');
      const t = f.app.store.tools(r.runId)[0]!;
      if (mode === 'lost') {
        assert.equal(f.app.commands.repo.receipt(t.id)!.reason, 'interrupted');
        assert.equal(t.state, 'failed');
      } else {
        assert.equal(f.app.commands.repo.receipt(t.id), undefined);
        assert.equal(t.state, 'unknown');
        assert.deepEqual(f.probes, [{ identity: bridge, terminate: true }]);
      }
    } finally {
      await f.close();
    }
  });
}
