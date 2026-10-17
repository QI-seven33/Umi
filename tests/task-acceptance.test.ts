import { replaceFileSteps } from './file-write-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UmiApplication } from '../apps/headless/src/application.js';
import { uid } from '../packages/agent/src/identity.js';
import { bytesHash } from '../packages/adapters/src/host-files/paths.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';
import type {
  TaskAcceptance,
  TaskCheckpointInput,
} from '../packages/protocol/src/task.js';
import type { LegacyWindowsProcessPort } from '../packages/adapters/src/host-process/port.js';
import { call, text, ScriptModel, removeTestRoot, eventually } from './fixtures.js';
import type { Step } from './fixtures.js';

function fixture(steps: Step[], runner?: LegacyWindowsProcessPort) {
  const root = mkdtempSync(join(tmpdir(), 'umi-task-acceptance-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'a.txt'), '原始注释');
  const model = new ScriptModel(steps);
  const app = new UmiApplication(
    join(root, 'data'),
    model,
    runner ? { processRunner: runner } : {},
  );
  const c = app.createConversation(workspace);
  const mount = app.files.repo.mounts(c.environmentId)[0]!;
  const args: TaskCheckpointInput = {
    baseVersion: 0,
    goal: '核验文件内容',
    source: { messageId: '', quote: '核验文件' },
    acknowledgedInputId: '',
    criteria: [
      {
        id: 'file',
        description: '副本文件符合预期',
        check: {
          kind: 'file_hash',
          mountId: mount.id,
          path: 'a.txt',
          expectedHash: bytesHash(Buffer.from('原始注释')),
        },
      },
    ],
    progress: [{ criterionId: 'file', status: 'pending', reason: '' }],
    nextAction: '读取文件元数据并核验',
  };
  const latest = () =>
    app.store
      .messages(c.conversationId)
      .filter((row) => row.role === 'user' && row.applied)
      .at(-1)!;
  const checkpoint = (patch: Partial<TaskCheckpointInput> = {}) => {
    if (!args.source.messageId) args.source.messageId = latest().id;
    args.acknowledgedInputId = latest().id;
    return call('record_task_checkpoint', { ...args, ...patch });
  };
  const tool = (name: string) =>
    Object.values(app.store.snapshot(c.conversationId).tools).findLast(
      (item) => item.name === name,
    )!;
  const pending = () =>
    Object.entries(app.store.snapshot(c.conversationId).approvals).find(
      ([, item]) => item.status === 'pending',
    )?.[0];
  return {
    root,
    workspace,
    model,
    app,
    c,
    mount,
    args,
    checkpoint,
    tool,
    pending,
    file: join(mount.root, 'a.txt'),
    async run(input = '核验文件') {
      const receipt = app.send(c.conversationId, uid(), input);
      await app.wait(receipt.runId);
      return receipt;
    },
    report(runId: string) {
      return app.store.readArtifact<TaskAcceptance>(
        app.store.snapshot(c.conversationId).runs[runId]!.acceptance!.artifactRef,
      );
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('任务验收：普通答复不冒充有目标核验，结束报告与事件可回放', async () => {
  const f = fixture([text('你好')]);
  try {
    const r = await f.run('你好');
    assert.equal(f.report(r.runId).status, 'untracked');
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

test('任务验收：模型虚报完成只得到 needs_work，无进展最多提醒一次', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(() => f.checkpoint(), text('全部完成'), text('仍声称全部完成'));
  try {
    const r = await f.run();
    assert.equal(f.report(r.runId).status, 'needs_work');
    assert.equal(f.model.requests.length, 3);
    assert.equal(f.app.tasks.list(f.c.conversationId).length, 1);
    assert.equal(f.app.store.getRun(r.runId).status, 'completed');
  } finally {
    await f.close();
  }
});

test('任务续作：旧待办不强迫新一轮寒暄继续操作', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(() => f.checkpoint(), text('未完成'), text('保留待办'), text('你好'));
  try {
    await f.run();
    const before = f.model.requests.length;
    const r = await f.run('你好');
    assert.equal(f.model.requests.length, before + 1);
    assert.equal(f.app.store.tools(r.runId).length, 0);
    assert.equal(f.app.tasks.list(f.c.conversationId).length, 1);
  } finally {
    await f.close();
  }
});

test('任务续作：检查点已提交但工具结算中断，重启核验幂等而不增加版本', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(() =>
    f.checkpoint({
      progress: [{ criterionId: 'file', status: 'blocked', reason: '等待后续安排' }],
    }),
  );
  let reopened: UmiApplication | undefined;
  const settle = f.app.store.settle.bind(f.app.store);
  let injected = false;
  f.app.store.settle = (...args) => {
    if (!injected && f.app.store.tool(args[0]).name === 'record_task_checkpoint') {
      injected = true;
      throw Object.assign(new Error('test settlement interruption'), {
        code: 'SQLITE_BUSY',
      });
    }
    return settle(...args);
  };
  try {
    const r = await f.run();
    assert.equal(f.app.store.getRun(r.runId).status, 'recovery_required');
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'dispatched');
    const checkpoint = f.app.tasks.list(f.c.conversationId)[0]!;
    await f.app.close();
    reopened = new UmiApplication(
      join(f.root, 'data'),
      new ScriptModel([call('inspect_tool_execution', { executionId: checkpoint.executionId }), text('保留阻塞')]),
    );
    reopened.resume(f.c.conversationId, r.runId);
    await reopened.wait(r.runId);
    assert.equal(reopened.tasks.list(f.c.conversationId)[0]!.taskId, checkpoint.taskId);
    assert.equal(reopened.tasks.list(f.c.conversationId)[0]!.version, 1);
    assert.equal(
      reopened.store
        .events(f.c.conversationId)
        .filter((event) => event.type === 'task.checkpoint_recorded').length,
      1,
    );
    assert.equal(reopened.store.tools(r.runId)[0]!.state, 'succeeded');
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('任务验收：验收报告与 run.completed 同事务，提交中断不留下半份成功事实', async () => {
  const f = fixture([text('结束'), text('恢复后的结束')]);
  const append = f.app.store.append.bind(f.app.store);
  let injected = false;
  f.app.store.append = (...args) => {
    if (!injected && args[1].type === 'run.completed') {
      injected = true;
      throw Object.assign(new Error('test final transaction interruption'), {
        code: 'SQLITE_BUSY',
      });
    }
    return append(...args);
  };
  try {
    const r = await f.run('问答');
    assert.equal(f.app.store.getRun(r.runId).status, 'interrupted');
    assert.equal(
      f.app.store.snapshot(f.c.conversationId).runs[r.runId]!.acceptance,
      undefined,
    );
    assert.equal(
      f.app.store
        .events(f.c.conversationId)
        .filter((event) => event.type === 'run.acceptance_reported').length,
      0,
    );
    f.app.resume(f.c.conversationId, r.runId);
    await f.app.wait(r.runId);
    assert.equal(f.report(r.runId).status, 'untracked');
    assert.equal(
      f.app.store
        .events(f.c.conversationId)
        .filter((event) => event.type === 'run.acceptance_reported').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('任务组合验收：副本测试、文件哈希与源交付可同时核验，交付不误作废测试', async () => {
  const runner: LegacyWindowsProcessPort = {
    async run(_snapshot, callbacks) {
      const owner = { pid: 910011, birth: '1' },
        child = { pid: 910012, birth: '2' };
      callbacks.owner(owner);
      await callbacks.ready(owner, child);
      callbacks.started();
      return {
        kind: 'exit',
        reason: 'exited',
        exitCode: 0,
        jobInactive: true,
        gateReleased: true,
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
      };
    },
    async probe() {
      return 'absent';
    },
  };
  const steps: Step[] = [];
  const f = fixture(steps, runner);
  const commandArgs = {
    program: 'node',
    argv: ['-e', ''],
    cwd: { kind: 'mount', mountId: f.mount.id },
  };
  let changeset = '';
  steps.push(
    ...replaceFileSteps(() => f.mount.id, 'a.txt', '正确内容'),
    () => call('run_command', commandArgs),
    () => call('stat_file', { mountId: f.mount.id, path: 'a.txt' }),
    () => call('build_changeset', { mountId: f.mount.id }),
    () => {
      changeset = Object.keys(f.app.store.snapshot(f.c.conversationId).changesets).at(
        -1,
      )!;
      f.args.criteria = [
        {
          id: 'file',
          description: '副本内容正确',
          check: {
            kind: 'file_hash',
            mountId: f.mount.id,
            path: 'a.txt',
            expectedHash: bytesHash(Buffer.from('正确内容')),
          },
        },
        {
          id: 'test',
          description: '指定测试退出零',
          check: {
            kind: 'command_exit',
            command: {
              name: 'run_command',
              args: f.app.registry.parse(
                'run_command',
                JSON.stringify(commandArgs),
              ) as never,
            },
          },
        },
        {
          id: 'delivery',
          description: '写回源文件',
          check: { kind: 'delivery', changeSetId: changeset },
        },
      ];
      f.args.progress = [
        {
          criterionId: 'file',
          status: 'verified',
          reason: '',
          evidenceExecutionId: f.tool('stat_file').executionId,
        },
        {
          criterionId: 'test',
          status: 'verified',
          reason: '',
          evidenceExecutionId: f.tool('run_command').executionId,
        },
        { criterionId: 'delivery', status: 'blocked', reason: '等待批准' },
      ];
      return f.checkpoint();
    },
    () => call('deliver_changeset', { changeSetId: changeset }),
    () => {
      const checkpoint = f.app.tasks.list(f.c.conversationId)[0]!;
      return f.checkpoint({
        taskId: checkpoint.taskId,
        baseVersion: checkpoint.version,
        progress: f.args.progress.map((item) =>
          item.criterionId === 'delivery'
            ? {
                criterionId: 'delivery',
                status: 'verified',
                reason: '',
                evidenceExecutionId: f.tool('deliver_changeset').executionId,
              }
            : item,
        ),
        nextAction: '',
      });
    },
    text('记录的三项验收通过'),
  );
  try {
    const r = f.app.send(f.c.conversationId, uid(), '核验文件、测试并交付');
    f.app.approve(f.c.conversationId, await eventually(() => f.pending()), 'allow');
    f.app.approve(f.c.conversationId, await eventually(() => f.pending()), 'allow');
    await f.app.wait(r.runId);
    assert.equal(f.report(r.runId).status, 'criteria_verified');
    assert.equal(
      f.report(r.runId).tasks[0]!.progress.filter((item) => item.status === 'verified')
        .length,
      3,
    );
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '正确内容');
  } finally {
    await f.close();
  }
});

test('任务验收：真实 stat_file 回执和实时哈希通过，源文件未写回', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(
    () => call('stat_file', { mountId: f.mount.id, path: 'a.txt' }),
    () =>
      f.checkpoint({
        progress: [
          {
            criterionId: 'file',
            status: 'verified',
            reason: '',
            evidenceExecutionId: f.tool('stat_file').executionId,
          },
        ],
      }),
    text('所记录的文件验收项已通过'),
  );
  try {
    const r = await f.run();
    assert.equal(f.report(r.runId).status, 'criteria_verified');
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '原始注释');
    assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'criteria_verified');
    writeFileSync(f.file, '外部变化');
    assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'needs_review');
  } finally {
    await f.close();
  }
});

test('任务验收：结束前产物变化降级待审，禁止用旧回执宣称当前成功', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(
    () => call('stat_file', { mountId: f.mount.id, path: 'a.txt' }),
    () =>
      f.checkpoint({
        progress: [
          {
            criterionId: 'file',
            status: 'verified',
            reason: '',
            evidenceExecutionId: f.tool('stat_file').executionId,
          },
        ],
      }),
    () => {
      writeFileSync(f.file, '被替换');
      return text('完成');
    },
  );
  try {
    const r = await f.run();
    assert.equal(f.report(r.runId).status, 'needs_review');
  } finally {
    await f.close();
  }
});

for (const mode of ['missing', 'wrong_hash', 'cross_conversation'] as const) {
  test(`任务验收：拒绝 ${mode} 证据，不保存假的 verified`, async () => {
    const steps: Step[] = [];
    const f = fixture(steps);
    let other: Awaited<ReturnType<typeof f.run>> | undefined;
    steps.push(
      () => call('stat_file', { mountId: f.mount.id, path: 'a.txt' }),
      () => {
        if (mode === 'wrong_hash')
          f.args.criteria[0]!.check = {
            kind: 'file_hash',
            mountId: f.mount.id,
            path: 'a.txt',
            expectedHash: '0'.repeat(64),
          };
        const id =
          mode === 'missing'
            ? 'missing'
            : mode === 'cross_conversation'
              ? f.app.store.tools(other!.runId)[0]!.id
              : f.tool('stat_file').executionId;
        return f.checkpoint({
          progress: [
            {
              criterionId: 'file',
              status: 'verified',
              reason: '',
              evidenceExecutionId: id,
            },
          ],
        });
      },
      text('核验失败'),
    );
    try {
      if (mode === 'cross_conversation') {
        const c = f.app.createConversation(f.workspace);
        const mount = f.app.files.repo.mounts(c.environmentId)[0]!;
        // 先执行另一个会话的真实只读工具；不会伪造数据库记录。
        steps.unshift(
          () => call('stat_file', { mountId: mount.id, path: 'a.txt' }),
          text('另一个会话结束'),
        );
        other = f.app.send(c.conversationId, uid(), '读取');
        await f.app.wait(other.runId);
      }
      const r = await f.run();
      const row = f.app.store
        .tools(r.runId)
        .find((item) => item.name === 'record_task_checkpoint')!;
      assert.equal(row.state, 'failed');
      assert.equal(f.app.tasks.list(f.c.conversationId).length, 0);
      assert.equal(f.report(r.runId).status, 'untracked');
    } finally {
      await f.close();
    }
  });
}

for (const mode of ['version', 'drop_criterion', 'foreign_source'] as const) {
  test(`任务验收：${mode} 更新被拒绝，原检查点保留`, async () => {
    const steps: Step[] = [];
    const f = fixture(steps);
    steps.push(
      () => f.checkpoint(),
      () => {
        const old = f.app.tasks.list(f.c.conversationId)[0]!;
        const input = {
          ...old.input,
          taskId: old.taskId,
          baseVersion: mode === 'version' ? 0 : 1,
        };
        if (mode === 'drop_criterion')
          input.criteria = [{ ...input.criteria[0]!, description: '降低要求' }];
        if (mode === 'foreign_source')
          input.source = { messageId: 'foreign', quote: '核验文件' };
        return call('record_task_checkpoint', input);
      },
      text('未完成'),
      text('保留待办'),
    );
    try {
      const r = await f.run();
      assert.equal(
        f.app.store
          .tools(r.runId)
          .filter((item) => item.name === 'record_task_checkpoint')[1]!.state,
        'failed',
      );
      assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.version, 1);
      assert.equal(f.report(r.runId).status, 'needs_work');
    } finally {
      await f.close();
    }
  });
}

test('任务续作：重启后带回原检查点，新 run 先核对新输入再用新证据更新', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(
    () =>
      f.checkpoint({
        progress: [{ criterionId: 'file', status: 'blocked', reason: '等待用户继续' }],
      }),
    text('等待继续'),
  );
  let reopened: UmiApplication | undefined;
  try {
    const first = await f.run();
    const saved = f.app.tasks.list(f.c.conversationId)[0]!;
    assert.equal(f.report(first.runId).status, 'blocked');
    await f.app.close();
    const nextSteps: Step[] = [
      (request) => {
        assert(
          (request.body.messages as { content: string }[])
            .at(-1)!
            .content.includes(saved.taskId),
        );
        assert.equal(reopened!.store.tools(first.runId).length, 1);
        return call('stat_file', { mountId: f.mount.id, path: 'a.txt' });
      },
      () =>
        call('record_task_checkpoint', {
          ...saved.input,
          taskId: saved.taskId,
          baseVersion: saved.version,
          acknowledgedInputId: reopened!.store
            .messages(f.c.conversationId)
            .filter((row) => row.applied && row.role === 'user')
            .at(-1)!.id,
          progress: [
            {
              criterionId: 'file',
              status: 'verified',
              reason: '',
              evidenceExecutionId: Object.values(
                reopened!.store.snapshot(f.c.conversationId).tools,
              ).findLast((item) => item.name === 'stat_file')!.executionId,
            },
          ],
          nextAction: '',
        }),
      text('验收项通过'),
    ];
    reopened = new UmiApplication(join(f.root, 'data'), new ScriptModel(nextSteps));
    assert.equal(reopened.tasks.list(f.c.conversationId)[0]!.taskId, saved.taskId);
    const next = reopened.send(f.c.conversationId, uid(), '继续核验文件');
    await reopened.wait(next.runId);
    assert.notEqual(next.runId, first.runId);
    assert.equal(reopened.tasks.list(f.c.conversationId)[0]!.version, 2);
    assert.equal(reopened.tasks.assess(f.c.conversationId).status, 'criteria_verified');
    const state = reopened.store.snapshot(f.c.conversationId);
    assert.deepEqual(
      reopened.store
        .events(f.c.conversationId)
        .reduce(
          reduceConversation,
          initialState(f.c.conversationId, state.cursor.logEpoch),
        ),
      state,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('任务续作：中途用户更正使旧 verified 失效，不自动撤销原验收项', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(
    () => call('stat_file', { mountId: f.mount.id, path: 'a.txt' }),
    () =>
      f.checkpoint({
        progress: [
          {
            criterionId: 'file',
            status: 'verified',
            reason: '',
            evidenceExecutionId: f.tool('stat_file').executionId,
          },
        ],
      }),
    () => {
      f.app.send(f.c.conversationId, uid(), '还要检查源文件交付');
      return text('收到更正');
    },
    text('需要继续核对'),
  );
  try {
    const r = await f.run();
    assert.equal(f.report(r.runId).status, 'needs_review');
    assert.equal(f.app.tasks.list(f.c.conversationId)[0]!.input.criteria.length, 1);
  } finally {
    await f.close();
  }
});

for (const decision of ['allow', 'deny'] as const) {
  test(`任务交付：副本修改与固定变更集源交付分开，批准 ${decision}`, async () => {
    const steps: Step[] = [];
    const f = fixture(steps);
    let changeSetId = '';
    steps.push(
      ...replaceFileSteps(() => f.mount.id, 'a.txt', '交付内容'),
      () => call('build_changeset', { mountId: f.mount.id }),
      () => {
        const t = f.tool('build_changeset');
        changeSetId = Object.keys(f.app.store.snapshot(f.c.conversationId).changesets).at(
          -1,
        )!;
        assert(t.resultRef);
        f.args.criteria = [
          {
            id: 'delivery',
            description: '固定变更集写回源文件',
            check: { kind: 'delivery', changeSetId },
          },
        ];
        f.args.progress = [
          { criterionId: 'delivery', status: 'blocked', reason: '等待交付批准' },
        ];
        return f.checkpoint();
      },
      () => call('deliver_changeset', { changeSetId }),
      () => {
        const old = f.app.tasks.list(f.c.conversationId)[0]!;
        return decision === 'deny'
          ? text('交付未获批准，副本修改保留')
          : f.checkpoint({
              taskId: old.taskId,
              baseVersion: old.version,
              progress: [
                {
                  criterionId: 'delivery',
                  status: 'verified',
                  reason: '',
                  evidenceExecutionId: f.tool('deliver_changeset').executionId,
                },
              ],
            });
      },
      text('交付核验结束'),
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '核验文件并交付');
      const approval = await eventually(() => f.pending());
      assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '原始注释');
      assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'blocked');
      f.app.approve(f.c.conversationId, approval, decision);
      await f.app.wait(r.runId);
      assert.equal(
        f.report(r.runId).status,
        decision === 'allow' ? 'criteria_verified' : 'blocked',
      );
      assert.equal(
        readFileSync(join(f.workspace, 'a.txt'), 'utf8'),
        decision === 'allow' ? '交付内容' : '原始注释',
      );
      if (decision === 'allow') {
        writeFileSync(join(f.workspace, 'a.txt'), '交付后外部更正');
        assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'needs_review');
      }
    } finally {
      await f.close();
    }
  });
}

for (const exitCode of [0, 1]) {
  test(`任务命令证据：批准后的原生回执退出码 ${exitCode}，不真实执行程序`, async () => {
    let starts = 0;
    const runner: LegacyWindowsProcessPort = {
      async run(_snapshot, callbacks, signal) {
        signal.throwIfAborted();
        starts++;
        const owner = { pid: 910001, birth: '1' },
          child = { pid: 910002, birth: '2' };
        callbacks.owner(owner);
        await callbacks.ready(owner, child);
        callbacks.started();
        return {
          kind: 'exit',
          reason: 'exited',
          exitCode,
          jobInactive: true,
          gateReleased: true,
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
        };
      },
      async probe() {
        return 'absent';
      },
    };
    const steps: Step[] = [];
    const f = fixture(steps, runner);
    const args = {
      program: 'node',
      argv: ['-e', ''],
      cwd: { kind: 'mount', mountId: f.mount.id },
    };
    steps.push(
      () => call('run_command', args),
      () => {
        f.args.criteria = [
          {
            id: 'test',
            description: '指定测试命令退出零',
            check: {
              kind: 'command_exit',
              command: {
                name: 'run_command',
                args: f.app.registry.parse('run_command', JSON.stringify(args)) as never,
              },
            },
          },
        ];
        f.args.progress = [
          {
            criterionId: 'test',
            status: 'verified',
            reason: '',
            evidenceExecutionId: f.tool('run_command').executionId,
          },
        ];
        return f.checkpoint();
      },
      text('命令核验结束'),
    );
    try {
      const r = f.app.send(f.c.conversationId, uid(), '核验文件及指定测试');
      const approval = await eventually(() => f.pending());
      assert.equal(starts, 0);
      f.app.approve(f.c.conversationId, approval, 'allow');
      await f.app.wait(r.runId);
      assert.equal(starts, 1);
      assert.equal(
        f.report(r.runId).status,
        exitCode === 0 ? 'criteria_verified' : 'untracked',
      );
      if (exitCode === 0) {
        writeFileSync(f.file, '测试后文件已变化');
        // command_exit 是已发生的执行事实；当前文件版本由独立 file_hash 条目验收。
        assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'criteria_verified');
        assert.equal(starts, 1);
      } else assert.equal(f.app.store.tools(r.runId).at(-1)!.state, 'failed');
    } finally {
      await f.close();
    }
  });
}

test('任务续作：停止批准等待后检查点保留，重启不会自动启动运行', async () => {
  const steps: Step[] = [];
  const f = fixture(steps);
  steps.push(
    () =>
      f.checkpoint({
        progress: [
          { criterionId: 'file', status: 'blocked', reason: '等待具体写入批准' },
        ],
      }),
    call('write_scratch', { relativePath: 'proof.txt', content: '待批准' }),
  );
  let reopened: UmiApplication | undefined;
  try {
    const r = f.app.send(f.c.conversationId, uid(), '核验文件');
    await eventually(() => f.pending());
    await f.app.stop(f.c.conversationId, r.runId);
    const checkpoint = f.app.tasks.list(f.c.conversationId)[0]!;
    await f.app.close();
    const model = new ScriptModel([text('依原检查点保留阻塞')]);
    reopened = new UmiApplication(join(f.root, 'data'), model);
    assert.equal(model.requests.length, 0);
    assert.equal(reopened.store.getRun(r.runId).status, 'stopped');
    assert.equal(reopened.tasks.list(f.c.conversationId)[0]!.taskId, checkpoint.taskId);
    reopened.resume(f.c.conversationId, r.runId);
    await reopened.wait(r.runId);
    assert.equal(reopened.tasks.assess(f.c.conversationId).status, 'blocked');
    assert.equal(
      reopened.store.tools(r.runId).filter((item) => item.name === 'write_scratch')
        .length,
      1,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});
