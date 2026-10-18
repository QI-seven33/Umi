import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import { eventSchema } from '../packages/protocol/src/events.js';

const approval = (app: UmiApplication, c: string) =>
  Object.entries(app.store.snapshot(c).approvals).find(
    ([, a]) => a.status === 'pending',
  )?.[0];
function setup(
  code: string,
  options: {
    policy?: 'ask' | 'auto';
    timeout?: number;
    argv?: string[];
    maxOutputBytes?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'umi-process-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'a.txt'), '原文');
  let mountId = '';
  const model = new ScriptModel([
    () =>
      call('run_command', {
        program: 'node',
        argv: options.argv ?? ['-e', code],
        cwd: { kind: 'mount', mountId },
        timeoutMs: options.timeout ?? 10000,
        maxOutputBytes: options.maxOutputBytes ?? 65536,
      }),
    text('核验阶段'),
    text('最终总结'),
  ]);
  const app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace, { executionPolicy: options.policy ?? 'ask' });
  mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
  return {
    root,
    workspace,
    app,
    c,
    model,
    mountId,
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test(
  'A29：真实程序+argv，批准前无副作用；输出分片、退出回执和历史重放一致',
  { timeout: 40000 },
  async () => {
    const f = setup(
      "require('fs').writeFileSync('a.txt','副本');process.stdout.write('中文输出😀');process.stderr.write('错误通道');",
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '运行代码'),
        a = await eventually(() => approval(f.app, f.c.conversationId));
      assert.equal(f.model.requests.length, 1);
      assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '原文');
      f.app.approve(f.c.conversationId, a, 'allow');
      assert.equal((await f.app.wait(r.runId)).status, 'completed');
      const t = f.app.store.tools(r.runId)[0]!;
      assert.equal(
        t.state,
        'succeeded',
        JSON.stringify(f.app.store.readArtifact(t.result_ref!)),
      );
      assert.equal(
        readFileSync(
          join(f.app.files.repo.mount(f.mountId, f.c.environmentId).root, 'a.txt'),
          'utf8',
        ),
        '副本',
      );
      assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '原文');
      const out = f.app.previewProcess(f.c.conversationId, t.id, 'stdout');
      assert.equal(out.text, '中文输出😀');
      assert.equal(out.receipt!.exitCode, 0);
      assert(out.receipt!.jobInactive);
      assert.equal(
        f.app.previewProcess(f.c.conversationId, t.id, 'stderr').text,
        '错误通道',
      );
      const state = f.app.store.snapshot(f.c.conversationId);
      assert.deepEqual(
        f.app.store
          .events(f.c.conversationId)
          .reduce(
            reduceConversation,
            initialState(f.c.conversationId, state.cursor.logEpoch),
          ),
        state,
      );
      assert.equal(state.commandExecutions[t.id]!.status, 'exited');
      const ctx = executionContextSchema.parse(f.app.store.readArtifact(t.context_ref!));
      assert(ctx.process!.programHash);
      assert(!('DEEPSEEK_API_KEY' in ctx.process!.env));
      assert(
        f.app.store.environment(f.c.environmentId).revision > ctx.environmentRevision,
      );
    } finally {
      await f.close();
    }
  },
);

for (const boundary of [
  'tool.dispatch_intent',
  'process.ready',
  'process.output',
  'process.exited',
  'tool.settled',
]) {
  test(
    `A31/A36：${boundary} 提交故障，核验原执行且不重复文件效果`,
    { timeout: 60000 },
    async () => {
      const f = setup(
        "const fs=require('fs');const n=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8')):0;fs.writeFileSync('count.txt',String(n+1));process.stdout.write('效果已发生');",
      );
      try {
        f.app.store.db.exec(
          `CREATE TRIGGER command_commit_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='${boundary}' BEGIN SELECT RAISE(ABORT,'命令提交故障'); END;`,
        );
        const r = f.app.send(f.c.conversationId, uid(), '提交故障'),
          a = await eventually(() => approval(f.app, f.c.conversationId));
        f.app.approve(f.c.conversationId, a, 'allow');
        const status = (await f.app.wait(r.runId)).status,
          m = f.app.files.repo.mount(f.mountId, f.c.environmentId),
          file = join(m.root, 'count.txt');
        f.app.store.db.exec('DROP TRIGGER command_commit_failure');
        if (boundary === 'tool.dispatch_intent') {
          assert.equal(status, 'failed');
          assert(!existsSync(file));
          assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
          return;
        }
        assert.equal(status, 'recovery_required');
        if (boundary === 'process.ready') assert(!existsSync(file));
        else assert.equal(readFileSync(file, 'utf8'), '1');
        f.app.resume(f.c.conversationId, r.runId);
        assert.equal((await f.app.wait(r.runId)).status, 'completed');
        const t = f.app.store.tools(r.runId)[0]!;
        assert.equal(t.state, boundary === 'tool.settled' ? 'succeeded' : 'failed');
        if (existsSync(file)) assert.equal(readFileSync(file, 'utf8'), '1');
        assert.equal(
          f.app.store
            .events(f.c.conversationId)
            .filter((e) => e.type === 'tool.dispatch_intent').length,
          1,
        );
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'A31：挂起就绪后、释放前目录根替换，禁止启动原命令',
  { timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'umi-process-drift-')),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'a.txt'), '原');
    let mountId = '';
    const app = new UmiApplication(
        join(root, 'data'),
        new ScriptModel([
          () =>
            call('run_command', {
              program: 'node',
              argv: ['-e', "require('fs').writeFileSync('effect.txt','不得执行')"],
              cwd: { kind: 'mount', mountId },
            }),
          text('位置变化'),
          text('结束'),
        ]),
        {
          processBoundary(point, id) {
            if (point === 'ready') {
              const ctx = executionContextSchema.parse(
                app.store.readArtifact(app.store.tool(id).context_ref!),
              );
              renameSync(ctx.process!.cwd, ctx.process!.cwd + '-old');
              mkdirSync(ctx.process!.cwd);
            }
          },
        },
      ),
      c = app.createConversation(workspace);
    mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
    try {
      const r = app.send(c.conversationId, uid(), '释放检查'),
        a = await eventually(() => approval(app, c.conversationId));
      app.approve(c.conversationId, a, 'allow');
      assert.equal((await app.wait(r.runId)).status, 'recovery_required');
      assert(
        !existsSync(
          join(app.files.repo.mount(mountId, c.environmentId).root, 'effect.txt'),
        ),
      );
      app.resume(c.conversationId, r.runId);
      await app.wait(r.runId);
      assert.equal(app.store.tools(r.runId)[0]!.state, 'failed');
      assert.equal(
        app.commands.repo.receipt(app.store.tools(r.runId)[0]!.id)!.reason,
        'not_started',
      );
    } finally {
      await app.close();
      removeTestRoot(root);
    }
  },
);

test('A31：PID 复用身份不符时不终止该 PID', { timeout: 30000 }, async () => {
  const f = setup('');
  try {
    assert.equal(
      await f.app.commands.runner.probe({ pid: process.pid, birth: '1' }, true),
      'different',
    );
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    await f.close();
  }
});

test('A31：原回执清理不明可再次核验，保留旧回执事实', { timeout: 60000 }, async () => {
  const f = setup("process.stdout.write('已退出')"),
    run = f.app.commands.runner.run.bind(f.app.commands.runner);
  f.app.commands.runner.run = async (...a) => ({
    ...(await run(...a)),
    jobInactive: false,
  });
  try {
    const r = f.app.send(f.c.conversationId, uid(), '清理核验'),
      a = await eventually(() => approval(f.app, f.c.conversationId));
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
    const t = f.app.store.tools(r.runId)[0]!,
      oldRef = f.app.commands.repo.row(t.id)!.receipt_ref as string;
    assert.equal(
      f.app.store.readArtifact<{ jobInactive: boolean }>(oldRef).jobInactive,
      false,
    );
    f.app.resume(f.c.conversationId, r.runId);
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(f.app.store.tool(t.id).state, 'succeeded');
    assert(f.app.commands.repo.receipt(t.id)!.jobInactive);
    assert.equal(
      f.app.store.readArtifact<{ jobInactive: boolean }>(oldRef).jobInactive,
      false,
    );
    const state = f.app.store.snapshot(f.c.conversationId);
    assert.deepEqual(
      f.app.store
        .events(f.c.conversationId)
        .reduce(
          reduceConversation,
          initialState(f.c.conversationId, state.cursor.logEpoch),
        ),
      state,
    );
  } finally {
    await f.close();
  }
});

test(
  'A30：Git 初始化及状态均单独批准，不继承凭据和 hooks 配置',
  { timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'umi-process-git-')),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    let mountId = '';
    const app = new UmiApplication(
        join(root, 'data'),
        new ScriptModel([
          () =>
            call('run_command', {
              program: 'git',
              argv: ['init'],
              cwd: { kind: 'mount', mountId },
            }),
          () =>
            call('run_command', {
              program: 'git',
              argv: ['status', '--porcelain'],
              cwd: { kind: 'mount', mountId },
            }),
          text('阶段'),
          text('最终'),
        ]),
      ),
      c = app.createConversation(workspace);
    mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
    try {
      const r = app.send(c.conversationId, uid(), 'Git 验证');
      for (let i = 0; i < 2; i++) {
        const a = await eventually(() => approval(app, c.conversationId), 20000);
        const t = app.store.tool(app.store.approval(a).execution_id),
          ctx = executionContextSchema.parse(app.store.readArtifact(t.context_ref!));
        assert.equal(ctx.process!.env.GIT_CONFIG_NOSYSTEM, '1');
        assert.equal(ctx.process!.env.GIT_CONFIG_GLOBAL, 'NUL');
        assert(ctx.process!.argv.includes('credential.helper='));
        assert(ctx.process!.argv.includes('core.hooksPath=NUL'));
        assert.equal(ctx.process!.scope, i === 0 ? 'git-write' : 'git-inspect');
        app.approve(c.conversationId, a, 'allow');
      }
      await app.wait(r.runId);
      assert(app.store.tools(r.runId).every((t) => t.state === 'succeeded'));
      assert(
        existsSync(join(app.files.repo.mount(mountId, c.environmentId).root, '.git')),
      );
      assert(!existsSync(join(workspace, '.git')));
    } finally {
      await app.close();
      removeTestRoot(root);
    }
  },
);

test('C11：版本 2 数据库升级至 3 保留挂载、原文及原会话游标', async () => {
  const f = setup('');
  try {
    const events = f.app.store.events(f.c.conversationId),
      mounts = f.app.files.repo.mounts(f.c.environmentId),
      cursor = f.app.store.snapshot(f.c.conversationId).cursor;
    f.app.store.db.exec(
      'DROP TABLE conversation_deletions; DELETE FROM schema_migrations WHERE version=7; DROP TABLE context_maintenance; DROP TABLE memory_entries; DROP TABLE process_outputs; DROP TABLE process_executions; DROP TABLE process_fingerprints; DELETE FROM schema_migrations WHERE version IN(3,4);',
    );
    await f.app.close();
    const next = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try {
      assert.equal(next.store.all('SELECT * FROM schema_migrations').length, 7);
      assert.deepEqual(next.store.events(f.c.conversationId), events);
      assert.deepEqual(next.store.snapshot(f.c.conversationId).cursor, cursor);
      assert.deepEqual(next.files.repo.mounts(f.c.environmentId), mounts);
    } finally {
      await next.close();
    }
  } finally {
    await f.close();
  }
});

test(
  'A03/A31：进程事件缺少执行归属或输出顺序错误不能推进会话游标',
  { timeout: 40000 },
  async () => {
    const f = setup("process.stdout.write('原输出')");
    try {
      const r = f.app.send(f.c.conversationId, uid(), '事件校验'),
        a = await eventually(() => approval(f.app, f.c.conversationId));
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const events = f.app.store.events(f.c.conversationId),
        output = events.find((e) => e.type === 'process.output')!;
      const malformed = { ...output, executionId: undefined };
      assert(!eventSchema.safeParse(malformed).success);
      const prefix = events
        .filter((e) => BigInt(e.sequence) < BigInt(output.sequence))
        .reduce(reduceConversation, initialState(f.c.conversationId, output.logEpoch));
      const invalid = eventSchema.parse({
        ...output,
        payload: { ...output.payload, outputIndex: 99 },
      });
      assert.throws(() => reduceConversation(prefix, invalid));
      assert.equal(prefix.cursor.sequence, (BigInt(output.sequence) - 1n).toString());
    } finally {
      await f.close();
    }
  },
);

test(
  'A31：批准等待期间普通文件变化不重新批准，命令读取当前内容',
  { timeout: 40000 },
  async () => {
    const f = setup(
      "const fs=require('fs');fs.writeFileSync('effect.txt',fs.readFileSync('a.txt','utf8'))",
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '检查依赖'),
        a = await eventually(() => approval(f.app, f.c.conversationId)),
        m = f.app.files.repo.mount(f.mountId, f.c.environmentId);
      writeFileSync(join(m.root, 'a.txt'), '外部修改依赖');
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      assert.equal(f.app.store.tools(r.runId)[0]!.state, 'succeeded');
      assert.equal(readFileSync(join(m.root, 'effect.txt'), 'utf8'), '外部修改依赖');
      assert.equal(
        Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
        1,
      );
      const ctx = executionContextSchema.parse(
        f.app.store.readArtifact(f.app.store.tools(r.runId)[0]!.context_ref!),
      );
      assert.equal(ctx.process!.cwdFingerprint, undefined);
      assert.equal(ctx.process!.cwdObservation, 'root-identity');
      assert.equal(f.app.store.all('SELECT * FROM process_fingerprints').length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'A29：argv 空格、引号、反斜线及 Unicode 保持，不经 Shell 拼接',
  { timeout: 40000 },
  async () => {
    const values = ['', '中文😀', 'a b', 'quoted"value', 'tail\\', 'both \\"end'],
      f = setup('', {
        argv: [
          '-e',
          'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
          '--',
          ...values,
        ],
      });
    try {
      const r = f.app.send(f.c.conversationId, uid(), '参数'),
        a = await eventually(() => approval(f.app, f.c.conversationId));
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const t = f.app.store.tools(r.runId)[0]!;
      assert.equal(t.state, 'succeeded');
      assert.deepEqual(
        JSON.parse(f.app.previewProcess(f.c.conversationId, t.id, 'stdout').text),
        values,
      );
    } finally {
      await f.close();
    }
  },
);

for (const action of ['stop', 'timeout'] as const) {
  test(
    `A29/A31：${action} 清理实际子进程树并保留已发生文件效果`,
    { timeout: 40000 },
    async () => {
      const f = setup(
        "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('pid.txt',String(c.pid));process.stdout.write('运行中'+'.'.repeat(1000));setInterval(()=>{},1000)",
        { timeout: action === 'timeout' ? 800 : 10000 },
      );
      try {
        const r = f.app.send(f.c.conversationId, uid(), '停止树'),
          a = await eventually(() => approval(f.app, f.c.conversationId));
        f.app.approve(f.c.conversationId, a, 'allow');
        const m = f.app.files.repo.mount(f.mountId, f.c.environmentId);
        await eventually(() => existsSync(join(m.root, 'pid.txt')) || undefined, 15000);
        const pid = Number(readFileSync(join(m.root, 'pid.txt'), 'utf8'));
        if (action === 'stop') {
          const started = performance.now();
          f.app.requestStop(f.c.conversationId, r.runId);
          const receiptMs = performance.now() - started;
          await f.app.wait(r.runId);
          const cleanupMs = performance.now() - started;
          assert(receiptMs < 500);
          assert(cleanupMs < 5000);
          console.log(JSON.stringify({ sample: 'native-tree-stop', receiptMs, cleanupMs }));
        }
        else await f.app.wait(r.runId);
        const t = f.app.store.tools(r.runId)[0]!,
          out = f.app.previewProcess(f.c.conversationId, t.id, 'stdout');
        assert(out.receipt!.jobInactive);
        assert.equal(out.receipt!.reason, action === 'stop' ? 'stopped' : 'timeout');
        assert.equal(t.state, action === 'stop' ? 'cancelled' : 'failed');
        assert.throws(() => process.kill(pid, 0));
        assert(!existsSync(join(f.workspace, 'pid.txt')));
        assert(out.text.startsWith('运行中'));
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'A29：输出归档和模型摘录有界，截断明确且跨分片密钥脱敏',
  { timeout: 40000 },
  async () => {
    const secret = 'umi-fixture-secret-abcdef-123456789',
      old = process.env.UMI_FIXTURE_API_KEY;
    process.env.UMI_FIXTURE_API_KEY = secret;
    const f = setup(
      `process.stdout.write(${JSON.stringify(secret.slice(0, 15))});setTimeout(()=>{process.stdout.write(${JSON.stringify(secret.slice(15))}+'中文😀'+'.'.repeat(5000));},40)`,
      { maxOutputBytes: 1024 },
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '长输出'),
        a = await eventually(() => approval(f.app, f.c.conversationId));
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const t = f.app.store.tools(r.runId)[0]!,
        out = f.app.previewProcess(f.c.conversationId, t.id, 'stdout');
      assert(!out.text.includes(secret));
      assert(out.text.includes('[已隐藏凭据]'));
      assert(Buffer.byteLength(out.text) <= 8192);
      assert.equal(out.receipt!.truncated,false);
      assert.equal(out.receipt!.archiveComplete,true);
      assert(out.receipt!.stdoutBytes > 1024);
      assert(out.text.includes('中文😀'));
      const c2 = f.app.createConversation(f.workspace);
      assert.throws(() => f.app.previewProcess(c2.conversationId, t.id, 'stdout'));
    } finally {
      if (old === undefined) delete process.env.UMI_FIXTURE_API_KEY;
      else process.env.UMI_FIXTURE_API_KEY = old;
      await f.close();
    }
  },
);

for (const shell of ['powershell', 'cmd'] as const) {
  test(`A29：${shell} 完整脚本真实执行，独立批准`, { timeout: 40000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'umi-process-shell-')),
      workspace = join(root, 'workspace');
    mkdirSync(workspace);
    let mountId = '';
    const script =
      shell === 'powershell'
        ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'result.txt'),'中文');[Console]::Write('中文输出')"
        : 'echo cmd-output>result.txt & echo cmd-output';
    const app = new UmiApplication(
        join(root, 'data'),
        new ScriptModel([
          () =>
            call('run_shell', {
              shell,
              script,
              cwd: { kind: 'mount', mountId },
              timeoutMs: 10000,
            }),
          text('阶段'),
          text('总结'),
        ]),
      ),
      c = app.createConversation(workspace);
    mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
    try {
      const r = app.send(c.conversationId, uid(), '运行脚本'),
        a = await eventually(() => approval(app, c.conversationId));
      assert(
        app.store.snapshot(c.conversationId).approvals[a]!.description.includes(script),
      );
      app.approve(c.conversationId, a, 'allow');
      await app.wait(r.runId);
      const t = app.store.tools(r.runId)[0]!;
      assert.equal(
        t.state,
        'succeeded',
        JSON.stringify(app.store.readArtifact(t.result_ref!)),
      );
      assert(
        existsSync(
          join(app.files.repo.mount(mountId, c.environmentId).root, 'result.txt'),
        ),
      );
      assert(!existsSync(join(workspace, 'result.txt')));
    } finally {
      await app.close();
      removeTestRoot(root);
    }
  });
}

test('A29：非法环境变量与目录穿越在准备前拒绝，无进程', { timeout: 15000 }, async () => {
  const f = setup('');
  try {
    f.model.beforeResponse = undefined;
    const a = f.app.send(f.c.conversationId, uid(), '非法参数');
    await eventually(() => approval(f.app, f.c.conversationId));
    await f.app.stop(f.c.conversationId, a.runId);
    const schema = f.app.registry.get('run_command').schema;
    assert(
      !schema.safeParse({
        program: 'node',
        argv: [],
        cwd: { kind: 'mount', mountId: f.mountId, path: '../outside' },
        env: {},
      }).success,
    );
    assert(
      !schema.safeParse({
        program: 'node',
        cwd: { kind: 'mount', mountId: f.mountId },
        env: { NODE_OPTIONS: '--require evil' },
      }).success,
    );
    assert(
      !schema.safeParse({
        program: 'node',
        cwd: { kind: 'mount', mountId: f.mountId },
        env: { DEEPSEEK_API_KEY: 'key' },
      }).success,
    );
    assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
  } finally {
    await f.close();
  }
});

test(
  'A29/A31：自动模式也阻塞宿主代码批准；拒绝不创建进程',
  { timeout: 15000 },
  async () => {
    const f = setup("require('fs').writeFileSync('effect.txt','不得执行')", {
      policy: 'auto',
    });
    try {
      const r = f.app.send(f.c.conversationId, uid(), '拒绝代码'),
        a = await eventually(() => approval(f.app, f.c.conversationId));
      assert.equal(f.app.store.getRun(r.runId).status, 'waiting_permission');
      f.app.approve(f.c.conversationId, a, 'deny');
      await f.app.wait(r.runId);
      assert.equal(f.app.store.tools(r.runId)[0]!.state, 'denied');
      assert.equal(f.app.store.all('SELECT * FROM process_executions').length, 0);
      assert(
        !existsSync(
          join(f.app.files.repo.mount(f.mountId, f.c.environmentId).root, 'effect.txt'),
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'A29：非零退出保留完整输出与已发生修改，不把失败当作未执行',
  { timeout: 40000 },
  async () => {
    const f = setup(
      "require('fs').writeFileSync('a.txt','已修改');process.stderr.write('测试失败');process.exitCode=7",
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '运行失败代码'),
        a = await eventually(() => approval(f.app, f.c.conversationId)),
        before = f.app.store.environment(f.c.environmentId).revision;
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const t = f.app.store.tools(r.runId)[0]!;
      assert.equal(t.state, 'failed');
      assert.equal(
        f.app.previewProcess(f.c.conversationId, t.id, 'stderr').receipt!.exitCode,
        7,
      );
      assert(f.app.store.environment(f.c.environmentId).revision > before);
      assert.equal(
        readFileSync(
          join(f.app.files.repo.mount(f.mountId, f.c.environmentId).root, 'a.txt'),
          'utf8',
        ),
        '已修改',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  '宿主网络：一次具体批准后可访问回环 HTTP，不需要准备检查',
  { timeout: 40000 },
  async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('本地网络可用');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const f = setup(
      `fetch('http://127.0.0.1:${address.port}/').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exitCode=1;})`,
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '访问本地测试 HTTP');
      const a = await eventually(() => approval(f.app, f.c.conversationId));
      assert.equal(requests, 0);
      f.app.approve(f.c.conversationId, a, 'allow');
      await f.app.wait(r.runId);
      const t = f.app.store.tools(r.runId)[0]!;
      assert.equal(t.state, 'succeeded');
      assert.equal(
        f.app.previewProcess(f.c.conversationId, t.id, 'stdout').text,
        '本地网络可用',
      );
      assert.equal(requests, 1);
      assert.equal(f.app.store.tools(r.runId).length, 1);
    } finally {
      await f.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
