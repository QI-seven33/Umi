import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ExecutionInspection } from '../packages/adapters/src/host-process/preflight.js';
import {
  inspectionSchema,
  directCommandSchema,
} from '../packages/protocol/src/process.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';
import { uid } from '../packages/agent/src/identity.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';

function setup(
  files: Record<string, string> = {},
  options: ConstructorParameters<typeof UmiApplication>[2] = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'umi-preflight-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(workspace, name), body);
  const steps: Step[] = [],
    app = new UmiApplication(join(root, 'data'), new ScriptModel(steps), options),
    c = app.createConversation(workspace),
    mount = app.files.repo.mounts(c.environmentId)[0]!;
  const cwd = { kind: 'mount' as const, mountId: mount.id };
  const inspector = new ExecutionInspection(app.files);
  return {
    root,
    workspace,
    steps,
    app,
    c,
    mount,
    cwd,
    inspector,
    env: () => app.store.environment(c.environmentId),
    inspect: (input: Record<string, unknown> = {}) =>
      inspector.inspect({ cwd, ...input }, app.store.environment(c.environmentId)),
    async run() {
      const r = app.send(c.conversationId, uid(), '准备并执行');
      await app.wait(r.runId);
      return r;
    },
    async observation() {
      steps.push(call('inspect_execution', { cwd }), text('检查完成'));
      const r = await this.run();
      return app.store.tools(r.runId)[0]!;
    },
    preparation(id: string) {
      return {
        inspectionExecutionId: id,
        changes: '仅准备临时任务文件',
        network: 'not-requested',
        installScripts: false,
      };
    },
    pending: () =>
      eventually(
        () =>
          Object.entries(app.store.snapshot(c.conversationId).approvals).find(
            ([, a]) => a.status === 'pending',
          )?.[0],
      ),
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('准备观察：真实循环保存回执，不启动程序、安装依赖或请求批准', async () => {
  const f = setup({
    'package.json': JSON.stringify({
      dependencies: { demo: '1' },
      scripts: { postinstall: 'echo bad' },
    }),
  });
  try {
    const t = await f.observation();
    assert.equal(t.state, 'succeeded');
    const report = f.app.store.readArtifact<any>(t.result_ref!).data;
    assert(report.issues.some((i: any) => i.code === 'DEPENDENCIES_MISSING'));
    assert(report.issues.some((i: any) => i.code === 'LOCK_MISSING'));
    assert.equal(report.programs[0].version, process.versions.node);
    assert.equal(report.programs[0].versionBasis, 'umi-process');
    assert.equal(report.project.dependencyCount, 1);
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      0,
    );
    assert(!existsSync(join(f.mount.root, 'node_modules')));
    assert(!existsSync(join(f.env().root, 'task', 'cache')));
  } finally {
    await f.close();
  }
});

test('准备观察：不假设外部工具版本，缺失工具与副本文件有明确反馈', async () => {
  const f = setup();
  try {
    const report = f.inspect({
      programs: [
        'umi-missing-executable-20261011',
        join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
      ],
      requiredFiles: ['输入.txt'],
    });
    assert.equal(report.programs[0]!.status, 'unavailable');
    assert.equal(report.programs[1]!.version, null);
    assert(report.issues.some((i) => i.code === 'REQUIRED_FILE_MISSING'));
    assert.equal(report.status, 'needs_attention');
  } finally {
    await f.close();
  }
});

for (const mode of ['invalid', 'mismatch', 'manager', 'workspaces', 'python', 'large'])
  test('准备观察：' + mode + ' 不冒充就绪', async () => {
    const data =
      mode === 'invalid'
        ? { 'package.json': '[' }
        : mode === 'large'
          ? { 'package.json': ' '.repeat(256 * 1024 + 1) }
          : mode === 'python'
            ? { 'requirements.txt': 'example==1' }
            : {
                'package.json': JSON.stringify({
                  dependencies: { demo: '1' },
                  ...(mode === 'manager' ? { packageManager: 'pnpm@9' } : {}),
                  ...(mode === 'workspaces' ? { workspaces: ['packages/*'] } : {}),
                }),
                'package-lock.json': JSON.stringify({
                  lockfileVersion: 3,
                  packages: {
                    '': { dependencies: { demo: mode === 'mismatch' ? '2' : '1' } },
                  },
                }),
              };
    const f = setup(data);
    try {
      const report = f.inspect();
      const code = {
        invalid: 'MANIFEST_INVALID',
        mismatch: 'LOCK_MISMATCH',
        manager: 'PACKAGE_MANAGER_REVIEW',
        workspaces: 'WORKSPACES_REVIEW',
        python: 'PYTHON_REVIEW',
        large: 'INPUT_UNOBSERVED',
      }[mode];
      assert(
        report.issues.some((i) => i.code === code),
        JSON.stringify(report),
      );
    } finally {
      await f.close();
    }
  });

test('准备观察：node_modules 仅存在不保证依赖完整，也不遍历来源依赖', async () => {
  const f = setup({
    'package.json': JSON.stringify({ dependencies: { demo: '1' } }),
    'package-lock.json': '{}',
  });
  try {
    mkdirSync(join(f.mount.root, 'node_modules'));
    writeFileSync(join(f.mount.root, 'node_modules', 'partial.txt'), '部分');
    const report = f.inspect();
    assert.equal(report.directories[0]!.status, 'present');
    assert(report.instruction.includes('不验证依赖完整'));
    assert.equal(
      report.observations.some((o) => o.path.includes('node_modules/')),
      false,
    );
  } finally {
    await f.close();
  }
});

for (const kind of ['junction', 'hardlink'])
  test('准备观察：' + kind + ' 不跟随', async () => {
    const f = setup({ 'package.json': '{}' });
    try {
      if (kind === 'junction')
        symlinkSync(f.workspace, join(f.mount.root, 'node_modules'), 'junction');
      else {
        unlinkSync(join(f.mount.root, 'package.json'));
        linkSync(join(f.workspace, 'package.json'), join(f.mount.root, 'package.json'));
      }
      const report = f.inspect();
      assert(
        report.issues.some(
          (i) =>
            i.code ===
            (kind === 'junction' ? 'DEPENDENCY_LOCATION_UNSAFE' : 'INPUT_UNOBSERVED'),
        ),
      );
    } finally {
      await f.close();
    }
  });

test('准备观察：参数、跨环境与提前取消，不扩大读取范围', async () => {
  const f = setup();
  try {
    assert(
      !inspectionSchema.safeParse({ cwd: { ...f.cwd, path: '../outside' } }).success,
    );
    assert(
      !inspectionSchema.safeParse({ cwd: f.cwd, requiredFiles: ['../outside'] }).success,
    );
    assert(
      !inspectionSchema.safeParse({ cwd: f.cwd, programs: Array(9).fill('node') })
        .success,
    );
    const second = f.app.createConversation(f.workspace);
    assert.throws(() =>
      f.inspector.inspect({ cwd: f.cwd }, f.app.store.environment(second.environmentId)),
    );
    assert.throws(() =>
      f.inspector.inspect({ cwd: f.cwd }, f.env(), AbortSignal.abort()),
    );
  } finally {
    await f.close();
  }
});

test('准备命令：批准前无缓存/进程，拒绝不执行，说明不伪装强制网络隔离', async () => {
  const f = setup();
  try {
    const observed = await f.observation();
    f.steps.push(
      call('run_command', {
        program: 'node',
        argv: ['-e', ''],
        cwd: f.cwd,
        preparation: f.preparation(observed.id),
      }),
      text('拒绝'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '拒绝准备'),
      approval = await f.pending();
    const description = f.app.store.snapshot(f.c.conversationId).approvals[approval]!
      .description;
    assert(description.includes('准备目的'));
    assert(description.includes('未强制阻断'));
    assert(description.includes('建议缓存'));
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
    assert(!existsSync(join(f.env().root, 'task', 'cache')));
    f.app.approve(f.c.conversationId, approval, 'deny');
    await f.app.wait(r.runId);
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'denied');
  } finally {
    await f.close();
  }
});

for (const mode of ['before', 'waiting', 'identity', 'cross', 'wrong-tool', 'wrong-cwd'])
  test('准备绑定：' + mode + ' 不启动原命令', async () => {
    const f = setup({ 'package.json': '{}' });
    try {
      const observed = await f.observation();
      let reference = observed.id,
        cwd = f.cwd;
      if (mode === 'before')
        writeFileSync(join(f.mount.root, 'package.json'), '{"changed":true}');
      if (mode === 'identity') {
        unlinkSync(join(f.mount.root, 'package.json'));
        writeFileSync(join(f.mount.root, 'package.json'), '{}');
      }
      if (mode === 'cross') {
        const second = f.app.createConversation(f.workspace);
        f.steps.push(
          call('inspect_execution', {
            cwd: {
              kind: 'mount',
              mountId: f.app.files.repo.mounts(second.environmentId)[0]!.id,
            },
          }),
          text('检查'),
        );
        const r = f.app.send(second.conversationId, uid(), '其他会话');
        await f.app.wait(r.runId);
        reference = f.app.store.tools(r.runId)[0]!.id;
      }
      if (mode === 'wrong-tool') {
        f.steps.push(
          call('create_output', { name: '结果', content: '正文' }),
          text('创建'),
        );
        const r = await f.run();
        reference = f.app.store.tools(r.runId)[0]!.id;
      }
      const args = {
        program: 'node',
        argv: ['-e', "require('fs').writeFileSync('effect.txt','不应写入')"],
        cwd: mode === 'wrong-cwd' ? { kind: 'task', area: 'scratch' } : cwd,
        preparation: f.preparation(reference),
      };
      f.steps.push(call('run_command', args), text('结果'));
      const r = f.app.send(f.c.conversationId, uid(), '准备');
      if (mode === 'waiting') {
        const a = await f.pending();
        writeFileSync(join(f.mount.root, 'package.json'), '{"drift":true}');
        f.app.approve(f.c.conversationId, a, 'allow');
      }
      await f.app.wait(r.runId);
      assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
      assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
      assert(!existsSync(join(f.mount.root, 'effect.txt')));
    } finally {
      await f.close();
    }
  });

test(
  '准备到执行：真实本地 Node 离线准备，任务缓存，重新观察后继续任务',
  { timeout: 60000 },
  async () => {
    const f = setup();
    try {
      const observation = await f.observation();
      f.steps.push(
        call('run_command', {
          program: 'node',
          cwd: f.cwd,
          preparation: f.preparation(observation.id),
          argv: [
            '-e',
            "const fs=require('fs');fs.mkdirSync(process.env.NPM_CONFIG_CACHE,{recursive:true});fs.writeFileSync('prepared.txt','就绪');process.stdout.write(process.env.NPM_CONFIG_CACHE)",
          ],
        }),
        call('inspect_execution', { cwd: f.cwd, requiredFiles: ['prepared.txt'] }),
        call('run_command', {
          program: 'node',
          cwd: f.cwd,
          argv: [
            '-e',
            "process.stdout.write(require('fs').readFileSync('prepared.txt','utf8'))",
          ],
        }),
        text('完成'),
      );
      const r = f.app.send(f.c.conversationId, uid(), '准备再运行'),
        first = await f.pending();
      f.app.approve(f.c.conversationId, first, 'allow');
      const second = await f.pending();
      assert.notEqual(first, second);
      f.app.approve(f.c.conversationId, second, 'allow');
      await f.app.wait(r.runId);
      const tools = f.app.store.tools(r.runId);
      assert.deepEqual(
        tools.map((t) => t.state),
        ['succeeded', 'succeeded', 'succeeded'],
      );
      const snapshot = executionContextSchema.parse(
        f.app.store.readArtifact(tools[0]!.context_ref!),
      ).process!;
      assert(snapshot.preparation);
      assert.equal(snapshot.preparation.cacheRoot, join(f.env().root, 'task', 'cache'));
      assert(
        snapshot.env.NPM_CONFIG_CACHE!.startsWith(join(f.env().root, 'task', 'cache')),
      );
      assert(!('NODE_OPTIONS' in snapshot.env));
      assert.equal(readFileSync(join(f.mount.root, 'prepared.txt'), 'utf8'), '就绪');
      assert(!existsSync(join(f.workspace, 'prepared.txt')));
      assert.equal(f.app.commands.repo.readOutput(tools[2]!.id, 'stdout'), '就绪');
    } finally {
      await f.close();
    }
  },
);

test(
  '准备回执：重启后仍可绑定，恢复不重跑已产生的准备效果',
  { timeout: 60000 },
  async () => {
    const f = setup();
    let next: UmiApplication | undefined;
    try {
      const observed = await f.observation();
      await f.app.close();
      const steps: Step[] = [];
      next = new UmiApplication(join(f.root, 'data'), new ScriptModel(steps));
      next.store.db.exec(
        "CREATE TRIGGER prep_fault BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.settled' BEGIN SELECT RAISE(ABORT,'fault'); END;",
      );
      steps.push(
        call('run_command', {
          program: 'node',
          cwd: f.cwd,
          preparation: f.preparation(observed.id),
          argv: ['-e', "require('fs').appendFileSync('once.txt','1')"],
        }),
        text('核验'),
      );
      const r = next.send(f.c.conversationId, uid(), '准备'),
        a = await eventually(
          () =>
            Object.entries(next!.store.snapshot(f.c.conversationId).approvals).find(
              ([, a]) => a.status === 'pending',
            )?.[0],
        );
      next.approve(f.c.conversationId, a, 'allow');
      await next.wait(r.runId);
      assert.equal(readFileSync(join(f.mount.root, 'once.txt'), 'utf8'), '1');
      next.store.db.exec('DROP TRIGGER prep_fault');
      next.resume(f.c.conversationId, r.runId);
      await next.wait(r.runId);
      assert.equal(readFileSync(join(f.mount.root, 'once.txt'), 'utf8'), '1');
      assert.equal(next.store.all('SELECT * FROM process_executions').length, 1);
    } finally {
      await next?.close();
      removeTestRoot(f.root);
    }
  },
);

test(
  '日常成果：artifacts cwd 沿具体批准生成二进制，再收录冻结',
  { timeout: 60000 },
  async () => {
    const f = setup();
    try {
      f.steps.push(
        call('run_command', {
          program: 'node',
          cwd: { kind: 'task', area: 'artifacts' },
          argv: [
            '-e',
            "require('fs').writeFileSync('report.bin',Buffer.from([0,255,1]))",
          ],
        }),
        call('capture_output', { name: '成果.bin', path: 'report.bin' }),
        text('生成尚未导出'),
      );
      const r = f.app.send(f.c.conversationId, uid(), '生成文件'),
        a = await f.pending();
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const tools = f.app.store.tools(r.runId);
      assert.deepEqual(
        tools.map((t) => t.state),
        ['succeeded', 'succeeded'],
      );
      assert.equal(
        f.app.outputs.read(f.c.conversationId, { outputId: tools[1]!.id }).kind,
        'binary',
      );
    } finally {
      await f.close();
    }
  },
);

test('准备观察：空锁与根缺失不能冒充可安装', async () => {
  const f = setup({
    'package.json': '{"dependencies":{"demo":"1"}}',
    'package-lock.json': '{}',
  });
  try {
    assert(f.inspect().issues.some((i) => i.code === 'LOCK_INVALID'));
    writeFileSync(
      join(f.mount.root, 'package-lock.json'),
      ' {"lockfileVersion":3,"packages":{"":{}}} ',
    );
    assert(f.inspect().issues.some((i) => i.code === 'LOCK_MISMATCH'));
  } finally {
    await f.close();
  }
});

test('准备绑定：外部工具入口漂移不启动，与版本未知分开报告', async () => {
  const f = setup();
  try {
    const program = join(f.root, 'custom.exe');
    writeFileSync(program, '只观察不执行');
    f.steps.push(
      call('inspect_execution', { cwd: f.cwd, programs: [program] }),
      text('观察'),
    );
    const observed = f.app.store.tools((await f.run()).runId)[0]!;
    assert.equal(
      f.app.store.readArtifact<any>(observed.result_ref!).data.programs[0].version,
      null,
    );
    unlinkSync(program);
    writeFileSync(program, '更换工具');
    assert.throws(
      () => f.inspector.assertCurrent(observed.id, { ...f.cwd, path: '' }, f.env()),
      /已变化/,
    );
  } finally {
    await f.close();
  }
});

for (const dangling of [false, true])
  test(
    '准备缓存：' + (dangling ? '悬空' : '现有') + '祖先联接被拒绝，不创建外部目录',
    async () => {
      const f = setup();
      try {
        const observed = await f.observation();
        symlinkSync(
          dangling ? join(f.root, 'missing-target') : f.workspace,
          join(f.env().root, 'task', 'cache'),
          'junction',
        );
        f.steps.push(
          call('run_command', {
            program: 'node',
            argv: ['-e', ''],
            cwd: f.cwd,
            preparation: f.preparation(observed.id),
          }),
          text('拒绝'),
        );
        const r = await f.run();
        assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
        assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
        assert.equal(
          Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );

test('准备观察：单文件权限不能扩展到相邻项目清单', async () => {
  const f = setup();
  try {
    const external = join(f.root, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'one.txt'), '仅此文件');
    writeFileSync(join(external, 'package.json'), '{"secret":"不应观察"}');
    const data = (r: any) =>
      JSON.parse(r.body.messages.filter((m: any) => m.role === 'tool').at(-1).content)
        .data;
    f.steps.push(
      call('discover_resource', { path: join(external, 'one.txt'), query: 'one' }),
      (r) =>
        call('request_resource', {
          candidateId: data(r).candidates[0].id,
          access: 'read',
          purpose: '只读单文件',
        }),
      (r) =>
        call('inspect_execution', { cwd: { kind: 'mount', mountId: data(r).mountId } }),
      text('范围明确'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '检查单文件'),
      a = await f.pending();
    f.app.approve(f.c.conversationId, a, 'allow');
    await f.app.wait(r.runId);
    const tool = f.app.store.tools(r.runId).at(-1)!;
    assert.equal(tool.state, 'failed');
    assert(
      f.app.store.readArtifact<any>(tool.result_ref!).content.includes('单文件资源'),
    );
  } finally {
    await f.close();
  }
});

test('执行能力：依赖目录有大文件时仍可执行，不做全目录指纹扫描', async () => {
  const f = setup();
  try {
    mkdirSync(join(f.mount.root, 'node_modules'));
    writeFileSync(
      join(f.mount.root, 'node_modules', 'large.bin'),
      Buffer.alloc(32 * 1024 * 1024 + 1),
    );
    const report = f.inspect();
    assert.equal(report.directories[0]!.status, 'present');
    assert.deepEqual(report.commandObservation, {
      kind: 'root-identity',
      recursive: false,
    });
    const observed = await f.observation();
    f.steps.push(
      call('run_command', {
        program: 'node',
        argv: ['-e', ''],
        cwd: f.cwd,
        preparation: f.preparation(observed.id),
      }),
      text('运行完成'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '执行大依赖目录命令');
    f.app.approve(f.c.conversationId, await f.pending(), 'allow');
    await f.app.wait(r.runId);
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'succeeded');
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 1);
  } finally {
    await f.close();
  }
});

test('准备绑定：未观察输入不能作为已冻结版本依据', async () => {
  const f = setup({ 'package.json': ' '.repeat(256 * 1024 + 1) });
  try {
    const observed = await f.observation();
    f.steps.push(
      call('run_command', {
        program: 'node',
        argv: ['-e', ''],
        cwd: f.cwd,
        preparation: f.preparation(observed.id),
      }),
      text('检查不完整'),
    );
    const r = await f.run();
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('准备拒绝：换检查回执和描述不能在同 run 重复申请', async () => {
  const f = setup();
  try {
    const prior = await f.observation();
    const command = (id: string) => ({
      program: 'node',
      argv: ['-e', ''],
      cwd: f.cwd,
      preparation: { ...f.preparation(id), changes: id },
    });
    f.steps.push(
      call('run_command', command(prior.id)),
      call('inspect_execution', { cwd: f.cwd }),
      () =>
        call(
          'run_command',
          command(
            f.app.store.tools(r.runId).find((t) => t.name === 'inspect_execution')!.id,
          ),
        ),
      text('停止准备'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '准备'),
      a = await f.pending();
    f.app.approve(f.c.conversationId, a, 'deny');
    await f.app.wait(r.runId);
    assert.deepEqual(
      f.app.store.tools(r.runId).map((t) => t.state),
      ['denied', 'succeeded', 'failed'],
    );
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test(
  '模型可用链路：从实际工具消息取检查 ID，完成具体批准准备',
  { timeout: 30000 },
  async () => {
    const f = setup();
    try {
      f.steps.push(
        call('inspect_execution', { cwd: f.cwd }),
        (r) => {
          const messages = (r.body as any).messages,
            report = JSON.parse(
              messages.filter((m: any) => m.role === 'tool').at(-1).content,
            ).data;
          assert.equal(typeof report.inspectionExecutionId, 'string');
          return call('run_command', {
            program: 'node',
            cwd: f.cwd,
            preparation: f.preparation(report.inspectionExecutionId),
            argv: ['-e', "require('fs').writeFileSync('model-prepared.txt','已准备')"],
          });
        },
        text('准备完成'),
      );
      const r = f.app.send(f.c.conversationId, uid(), '准备任务'),
        a = await f.pending();
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      assert.deepEqual(
        f.app.store.tools(r.runId).map((t) => t.state),
        ['succeeded', 'succeeded'],
      );
      assert.equal(
        readFileSync(join(f.mount.root, 'model-prepared.txt'), 'utf8'),
        '已准备',
      );
    } finally {
      await f.close();
    }
  },
);
