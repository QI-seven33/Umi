import { ExecutionProviders } from '../packages/agent/src/tools/execution-provider.js';
import type { ExecutionContext } from '../packages/protocol/src/model.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { UmiApplication } from '../apps/headless/src/application.js';
import { hash, uid } from '../packages/agent/src/identity.js';
import type {
  ExecutionProvider,
  ProviderToolModule,
} from '../packages/agent/src/tools/execution-provider.js';
import { ExecutionRepository } from '../packages/adapters/src/sqlite/executions.js';
import {
  observe,
  bytesHash,
  fileIdentity,
} from '../packages/adapters/src/host-files/paths.js';
import { executionObservationSchema } from '../packages/protocol/src/execution.js';
import type {
  ExecutionPlan,
  ExecutionObservation,
  ExecutionCapabilities,
} from '../packages/protocol/src/execution.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';

type Mode =
  | 'ok'
  | 'lost'
  | 'no-locator'
  | 'cleanup-unknown'
  | 'wrong-receipt'
  | 'large-output'
  | 'wrong-locator';
function setup(mode: Mode = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'umi-neutral-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'a.txt'), '原始来源\r\n');
  const program = join(root, 'inert.txt');
  writeFileSync(program, 'fixture-only-not-executable');
  let app!: UmiApplication,
    mountId = '',
    calls = 0,
    reconciles = 0,
    verify = false;
  const caps: ExecutionCapabilities = {
    tier: 'fixture',
    filesystemMapping: 'enforced',
    networkDeny: 'enforced',
    uiDeny: 'enforced',
    gatedStart: 'unknown',
    recovery: 'supported',
  };
  const identity = {
    id: 'fixture.provider',
    version: '1.0.0',
    implementationHash: hash('fixture-implementation'),
  };
  let lastPlan!: ExecutionPlan;
  function receipt(plan: ExecutionPlan, unknown = false): ExecutionObservation {
    return {
      schemaVersion: 2,
      executionId: plan.executionId,
      planHash: hash(plan),
      provider: plan.provider,
      reason: 'exited',
      exitCode: 0,
      started: true,
      cleanup: {
        processTree: unknown ? 'unknown' : 'confirmed',
        containment: 'confirmed',
      },
      effects: 'not-verified',
      observedAt: new Date().toISOString(),
      stdout: '退出\r\n',
      stderr: '',
      truncated: false,
    };
  }
  const provider: ExecutionProvider = {
    identity,
    capabilities: caps,
    async start(plan, located, signal) {
      signal.throwIfAborted();
      calls++;
      lastPlan = plan;
      assert(
        app.store.events(c.conversationId).some((e) => e.type === 'execution.planned'),
      );
      assert.equal(app.store.tool(plan.executionId).state, 'dispatched');
      app.store.assertApprovedExecution(
        plan.executionId,
        app.store.readArtifact(app.store.tool(plan.executionId).context_ref!),
      );
      if (mode !== 'no-locator')
        located({
          schemaVersion: 2,
          executionId: mode === 'wrong-locator' ? 'wrong' : plan.executionId,
          planHash: hash(plan),
          provider: identity,
          kind: 'fixture-token',
          token: 'opaque-owned-run',
        });
      writeFileSync(join(plan.workload.cwd.path, 'effect.txt'), String(calls));
      if (mode === 'lost' || mode === 'no-locator')
        throw new Error('模拟创建/效果后回执丢失');
      const r = receipt(plan, mode === 'cleanup-unknown');
      if (mode === 'wrong-receipt') r.planHash = hash('wrong');
      if (mode === 'large-output') r.stdout = '中'.repeat(1000);
      return r;
    },
    async reconcile(plan, locator) {
      reconciles++;
      assert.equal(locator.token, 'opaque-owned-run');
      assert.equal(locator.executionId, plan.executionId);
      assert.equal(hash(plan), hash(lastPlan));
      return verify ? receipt(plan) : undefined;
    },
  };
  const config: ProviderToolModule = {
    id: 'fixture.execution',
    version: '1.0.0',
    name: 'fixture_exec',
    description: '有界临时执行替身',
    schema: z.object({ tag: z.string() }).strict(),
    providers: [provider],
    preparation: {
      prepare(_args, env, id) {
        const m = app.files.repo.mount(mountId, env.id),
          loc = app.files.mountContext({}, env, m.id, 'a.txt', undefined, true);
        const cwdHash = hash(observe(m.root, 'a.txt', m.rootIdentity));
        return {
          ...loc,
          runtimeId: 'provider-v2',
          execution: {
            schemaVersion: 2,
            executionId: id,
            leaseGeneration: app.store.getRun(app.store.tool(id).run_id).generation,
            provider: { ...identity },
            capabilities: { ...caps },
            workload: {
              program: {
                path: program,
                identity: fileIdentity(program),
                hash: bytesHash(readFileSync(program)),
              },
              argv: [],
              cwd: { path: m.root, identity: m.rootIdentity, hash: cwdHash },
              dependencies: [],
              environment: { CI: '1' },
              stdin: '',
            },
            policy: {
              filesystem: [{ root: m.root, identity: m.rootIdentity, access: 'write' }],
              network: 'deny',
              ui: 'deny',
              startMode: 'immediate',
              inheritEnvironment: false,
            },
            timeoutMs: 3000,
            maxOutputBytes: 1024,
          },
        };
      },
    },
  };
  const reopen = (providers: readonly ExecutionProvider[] = [provider]) => {
    app = new UmiApplication(join(root, 'data'), new ScriptModel([text('核验后完成')]), {
      providerModules: [{ ...config, providers }],
    });
  };
  app = new UmiApplication(
    join(root, 'data'),
    new ScriptModel([call('fixture_exec', { tag: 'first' }), text('完成')]),
    { providerModules: [config] },
  );
  const c = app.createConversation(source, { executionPolicy: 'auto' });
  mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
  return {
    root,
    source,
    program,
    c,
    caps,
    provider,
    config,
    reopen,
    get app() {
      return app;
    },
    get calls() {
      return calls;
    },
    get reconciles() {
      return reconciles;
    },
    set verify(value: boolean) {
      verify = value;
    },
    send: () => app.send(c.conversationId, uid(), '执行临时替身'),
    async approve() {
      const id = await eventually(
        () =>
          Object.entries(app.store.snapshot(c.conversationId).approvals).find(
            ([, a]) => a.status === 'pending',
          )?.[0],
      );
      app.approve(c.conversationId, id, 'allow');
      return id;
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}
test('中立执行：具体批准/计划在启动前，退出/文件效果分开，来源不变', async () => {
  const f = setup();
  try {
    const run = f.send();
    await eventually(() =>
      Object.values(f.app.store.snapshot(f.c.conversationId).approvals).some(
        (a) => a.status === 'pending',
      )
        ? true
        : undefined,
    );
    assert.equal(f.calls, 0);
    await f.approve();
    assert.equal((await f.app.wait(run.runId)).status, 'completed');
    assert.equal(f.calls, 1);
    const tool = f.app.store.tools(run.runId)[0]!;
    assert.equal(tool.state, 'succeeded');
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.equal(state.providerExecutions[tool.id]!.status, 'completed');
    assert.deepEqual(state.commandExecutions, {});
    const result = f.app.store.readArtifact<{ data: ExecutionObservation }>(
      tool.result_ref!,
    );
    assert.equal(result.data.effects, 'not-verified');
    assert.equal(result.data.exitCode, 0);
    assert.equal(readFileSync(join(f.source, 'a.txt'), 'utf8'), '原始来源\r\n');
    const types = f.app.store.events(f.c.conversationId).map((e) => e.type);
    assert(types.indexOf('tool.dispatch_intent') < types.indexOf('execution.planned'));
    assert(types.indexOf('execution.planned') < types.indexOf('execution.located'));
  } finally {
    await f.close();
  }
});
test('中立执行：批准后依赖漂移使批准失效且零启动', async () => {
  const f = setup();
  try {
    const run = f.send();
    const id = await eventually(
      () =>
        Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(
          ([, a]) => a.status === 'pending',
        )?.[0],
    );
    writeFileSync(f.program, 'changed');
    f.app.approve(f.c.conversationId, id, 'allow');
    await eventually(() => (f.app.store.approval(id).valid === 0 ? true : undefined));
    assert.equal(f.calls, 0);
    await f.app.stop(f.c.conversationId, run.runId);
    await f.app.wait(run.runId);
  } finally {
    await f.close();
  }
});
test('中立执行：能力未知拒绝强制策略，没有批准或启动', async () => {
  const f = setup();
  try {
    f.caps.networkDeny = 'unknown';
    const run = f.send();
    await f.app.wait(run.runId);
    assert.equal(f.calls, 0);
    assert.equal(f.app.store.tools(run.runId)[0]!.state, 'failed');
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId).approvals, {});
  } finally {
    await f.close();
  }
});
for (const mode of ['lost', 'cleanup-unknown'] as const)
  test(`中立执行：${mode} 重启只核验原定位，不再次 start`, async () => {
    const f = setup(mode);
    try {
      const run = f.send();
      await f.approve();
      await f.app.wait(run.runId);
      const tool = f.app.store.tools(run.runId)[0]!;
      assert.equal(tool.state, 'unknown');
      assert.equal(f.calls, 1);
      await f.app.close();
      f.verify = true;
      f.reopen();
      f.app.resume(f.c.conversationId, run.runId);
      assert.equal((await f.app.wait(run.runId)).status, 'completed');
      assert.equal(f.calls, 1);
      assert.equal(f.app.store.tool(tool.id).state, 'succeeded');
      const events = f.app.store
        .events(f.c.conversationId)
        .filter(
          (e) => e.type === 'execution.completed' || e.type === 'execution.reconciled',
        );
      assert.equal(events.length, mode === 'cleanup-unknown' ? 2 : 1);
    } finally {
      await f.close();
    }
  });
for (const change of ['missing', 'version', 'implementation'] as const)
  test(`中立执行：重启 provider ${change} 保持 unknown`, async () => {
    const f = setup('lost');
    try {
      const run = f.send();
      await f.approve();
      await f.app.wait(run.runId);
      await f.app.close();
      f.verify = true;
      const other = {
        ...f.provider,
        identity: {
          ...f.provider.identity,
          ...(change === 'version'
            ? { version: '2.0.0' }
            : { implementationHash: hash('other') }),
        },
      };
      f.reopen(change === 'missing' ? [] : [other]);
      f.app.resume(f.c.conversationId, run.runId);
      await f.app.wait(run.runId);
      assert.equal(f.app.store.tools(run.runId)[0]!.state, 'unknown');
      assert.equal(f.calls, 1);
    } finally {
      await f.close();
    }
  });
for (const mode of [
  'no-locator',
  'wrong-receipt',
  'large-output',
  'wrong-locator',
] as const)
  test(`中立执行：${mode} 不接受无效证据且不重跑`, async () => {
    const f = setup(mode);
    try {
      const run = f.send();
      await f.approve();
      await f.app.wait(run.runId);
      const tool = f.app.store.tools(run.runId)[0]!;
      assert.equal(tool.state, 'unknown');
      assert.equal(f.calls, 1);
      const ctx = f.app.store.readArtifact<ExecutionContext>(tool.context_ref!);
      const saved = new ExecutionRepository(f.app.store).forContext(ctx).read();
      assert(saved?.plan);
      assert.equal(saved.receipt, undefined);
      if (mode === 'no-locator' || mode === 'wrong-locator') {
        assert.equal(saved.locator, undefined);
        assert.equal(f.reconciles, 0);
      }
    } finally {
      await f.close();
    }
  });
test('中立执行：完整身份必需，回执不能声称未启动却正常退出', () => {
  assert.equal(executionObservationSchema.safeParse({ schemaVersion: 2 }).success, false);
  const f = {
    schemaVersion: 2,
    executionId: 'id',
    planHash: hash('plan'),
    provider: { id: 'p', version: '1', implementationHash: hash('p') },
    reason: 'exited',
    exitCode: 0,
    started: false,
    cleanup: { processTree: 'confirmed', containment: 'confirmed' },
    effects: 'not-verified',
    observedAt: new Date().toISOString(),
    stdout: '',
    stderr: '',
    truncated: false,
  };
  assert.equal(executionObservationSchema.safeParse(f).success, false);
});

test('中立执行：派发层阻止工具定义绕过批准', async () => {
  const f = setup();
  try {
    f.app.registry.get('fixture_exec').approvalRequired = () => false;
    const run = f.send();
    await f.app.wait(run.runId);
    assert.equal(f.calls, 0);
    assert.equal(f.app.store.tools(run.runId)[0]!.state, 'prepared');
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId).providerExecutions, {});
  } finally {
    await f.close();
  }
});
test('中立执行：批准等待期间取消，provider 没有启动', async () => {
  const f = setup();
  try {
    const run = f.send();
    await eventually(() =>
      Object.values(f.app.store.snapshot(f.c.conversationId).approvals).some(
        (a) => a.status === 'pending',
      )
        ? true
        : undefined,
    );
    await f.app.stop(f.c.conversationId, run.runId);
    await f.app.wait(run.runId);
    assert.equal(f.calls, 0);
    assert.equal(f.app.store.tools(run.runId)[0]!.state, 'cancelled');
  } finally {
    await f.close();
  }
});

test('中立执行：未实现可信 release 契约时，provider 声称 gate 可用仍拒绝', async () => {
  const f = setup();
  try {
    f.send();
    await eventually(
      () =>
        f.app.store.tools(f.app.store.environment(f.c.environmentId).active_run_id!)[0]
          ?.context_ref ?? undefined,
    );
    const id = f.app.store.environment(f.c.environmentId).active_run_id!;
    const ctx = f.app.store.readArtifact<ExecutionContext>(
      f.app.store.tools(id)[0]!.context_ref!,
    );
    f.caps.gatedStart = 'enforced';
    const plan = {
      ...ctx.execution!,
      capabilities: { ...f.caps },
      policy: { ...ctx.execution!.policy, startMode: 'gated' as const },
    };
    assert.throws(
      () => new ExecutionProviders([f.provider]).require(plan),
      /强制执行策略/,
    );
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
