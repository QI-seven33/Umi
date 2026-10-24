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
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { DesktopService } from '../apps/desktop/service.js';
import { desktopCommandSchema } from '../packages/protocol/src/desktop.js';
import { executionContextSchema } from '../packages/protocol/src/model.js';
import type { OutputBoundary } from '../packages/adapters/src/host-files/outputs.js';
import { fileIdentity, bytesHash } from '../packages/adapters/src/host-files/paths.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';

function setup(
  boundary?: (point: OutputBoundary, index: number) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'umi-output-')),
    workspace = join(root, 'workspace'),
    destination = join(root, 'destination');
  mkdirSync(workspace);
  mkdirSync(destination);
  const steps: Step[] = [],
    model = new ScriptModel(steps),
    app = new UmiApplication(
      join(root, 'data'),
      model,
      boundary ? { outputBoundary: boundary } : {},
    );
  const c = app.createConversation(workspace),
    env = () => app.store.environment(c.environmentId);
  return {
    root,
    workspace,
    destination,
    steps,
    model,
    app,
    c,
    env,
    async run() {
      const r = app.send(c.conversationId, uid(), '成果交付');
      await app.wait(r.runId);
      return r;
    },
    async output(content = '完整正文', name = '报告.md') {
      steps.push(call('create_output', { name, content }), text('成果尚未导出'));
      const r = await this.run(),
        tool = app.store.tools(r.runId).find((t) => t.name === 'create_output')!;
      assert.equal(tool.state, 'succeeded');
      return {
        id: tool.id,
        data: app.store.readArtifact<{ data: any }>(tool.result_ref!).data,
      };
    },
    startExport(items: { outputId: string; target: string }[]) {
      steps.push(call('export_outputs', { items }), text('处理导出回执'));
      return app.send(c.conversationId, uid(), '导出成果');
    },
    async pending() {
      return eventually(
        () =>
          Object.entries(app.store.snapshot(c.conversationId).approvals).find(
            ([, a]) => a.status === 'pending',
          )?.[0],
      );
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('成果：创建无源目录批准，正文/BOM/CRLF/中文按字节保存，生成不等于导出', async () => {
  const f = setup();
  try {
    const { id, data } = await f.output('\ufeff中文\r\n学习注释\r\n');
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      0,
    );
    assert.equal(data.hash, bytesHash(Buffer.from('\ufeff中文\r\n学习注释\r\n')));
    const preview = f.app.outputs.read(f.c.conversationId, { outputId: id });
    assert.equal(preview.kind, 'text');
    assert.equal('text' in preview ? preview.text : '', '\ufeff中文\r\n学习注释\r\n');
    assert.equal(existsSync(join(f.workspace, '报告.md')), false);
    assert.equal(existsSync(join(f.destination, '报告.md')), false);
  } finally {
    await f.close();
  }
});

test('成果：重启可预览，长文本分页，UTF-8 中间字节拒绝', async () => {
  const f = setup();
  try {
    const { id } = await f.output('中'.repeat(30000));
    await f.app.close();
    const next = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    try {
      let startByte = 0,
        total = '';
      for (;;) {
        const page = next.outputs.read(f.c.conversationId, {
          outputId: id,
          startByte,
          byteLength: 64000,
        });
        assert.equal(page.kind, 'text');
        total += 'text' in page ? page.text : '';
        if (!page.truncated) break;
        startByte = page.endByte;
      }
      assert.equal(total, '中'.repeat(30000));
      assert.throws(
        () => next.outputs.read(f.c.conversationId, { outputId: id, startByte: 1 }),
        /UTF-8/,
      );
    } finally {
      await next.close();
    }
  } finally {
    await f.close();
  }
});

test('成果：二进制仅从 task/artifacts 收录，原文件变化不改变冻结副本', async () => {
  const f = setup();
  try {
    const raw = Buffer.from([0, 255, 1, 3]),
      source = join(f.env().root, 'task', 'artifacts', 'document.bin');
    writeFileSync(source, raw);
    f.steps.push(
      call('capture_output', { name: '文档.bin', path: 'document.bin' }),
      text('已收录'),
    );
    const r = await f.run(),
      tool = f.app.store.tools(r.runId)[0]!;
    assert.equal(tool.state, 'succeeded');
    writeFileSync(source, '后来变化');
    const preview = f.app.outputs.read(f.c.conversationId, { outputId: tool.id });
    assert.equal(preview.kind, 'binary');
    assert(!('text' in preview));
    assert(!('base64' in preview));
    const page = f.app.outputs.read(f.c.conversationId, {
      outputId: tool.id,
      representation: 'base64',
      byteLength: 2,
    });
    assert.equal(
      'base64' in page ? page.base64 : '',
      raw.subarray(0, 2).toString('base64'),
    );
    assert(page.truncated);
  } finally {
    await f.close();
  }
});

for (const bad of ['../source.txt', 'C:/source.txt', 'link.bin', 'large.bin'])
  test(`收录：${bad} 拒绝`, async () => {
    const f = setup();
    try {
      const dir = join(f.env().root, 'task', 'artifacts');
      writeFileSync(join(f.root, 'outside.bin'), '私有');
      linkSync(join(f.root, 'outside.bin'), join(dir, 'link.bin'));
      writeFileSync(join(dir, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
      f.steps.push(call('capture_output', { name: '成果', path: bad }), text('拒绝'));
      const r = await f.run();
      assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
    } finally {
      await f.close();
    }
  });

test('成果：跨会话、伪造成果身份及落盘漂移不能读取或导出', async () => {
  const f = setup();
  try {
    const { id, data } = await f.output();
    const other = f.app.createConversation(f.workspace);
    assert.throws(() => f.app.outputs.read(other.conversationId, { outputId: id }));
    assert.throws(() => f.app.outputs.read(f.c.conversationId, { outputId: uid() }));
    writeFileSync(join(f.env().root, data.relativePath), '漂移');
    assert.throws(() => f.app.outputs.read(f.c.conversationId, { outputId: id }), /变化/);
    assert.throws(() =>
      f.app.outputs.prepareExport(
        { items: [{ outputId: id, target: join(f.destination, 'x') }] },
        f.env(),
        uid(),
      ),
    );
  } finally {
    await f.close();
  }
});

test('导出：具体目标批准前无效果、无整目录授权，允许后回执与固定桌面入口核验', async () => {
  const f = setup();
  try {
    const { id, data } = await f.output(),
      target = join(f.destination, '交付.md'),
      r = f.startExport([{ outputId: id, target }]),
      approval = await f.pending();
    assert(!existsSync(target));
    assert(
      f.app.store
        .snapshot(f.c.conversationId)
        .approvals[approval]!.description.includes(target),
    );
    f.app.approve(f.c.conversationId, approval, 'allow');
    await f.app.wait(r.runId);
    const tool = f.app.store.tools(r.runId)[0]!;
    assert.equal(tool.state, 'succeeded');
    assert.equal(readFileSync(target, 'utf8'), '完整正文');
    const service = new DesktopService(f.app);
    const preview = (await service.handle(
      desktopCommandSchema.parse({
        type: 'preview_output',
        conversationId: f.c.conversationId,
        outputId: id,
      }),
    )) as any;
    assert.equal(preview.hash, data.hash);
    const inspected = (await service.handle(
      desktopCommandSchema.parse({
        type: 'inspect_export',
        conversationId: f.c.conversationId,
        executionId: tool.id,
      }),
    )) as any;
    assert.equal(inspected.data.receipts[0].status, 'verified');
    const opened = (await service.handle(
      desktopCommandSchema.parse({
        type: 'open_export',
        conversationId: f.c.conversationId,
        executionId: tool.id,
        index: 0,
      }),
    )) as any;
    assert.equal(opened.path, target);
    writeFileSync(target, '用户修改');
    await assert.rejects(() =>
      service.handle(
        desktopCommandSchema.parse({
          type: 'open_export',
          conversationId: f.c.conversationId,
          executionId: tool.id,
          index: 0,
        }),
      ),
    );
  } finally {
    await f.close();
  }
});

for (const mode of [
  'exists',
  'duplicate',
  'internal',
  'relative',
  'missing-parent',
  'junction',
])
  test(`导出准备：${mode} 拒绝`, async () => {
    const f = setup();
    try {
      const { id } = await f.output();
      let target = join(f.destination, 'x.md');
      if (mode === 'exists') writeFileSync(target, '用户原文件');
      if (mode === 'internal') target = join(f.env().root, 'task', 'scratch', 'x.md');
      if (mode === 'relative') target = 'x.md';
      if (mode === 'missing-parent') target = join(f.destination, 'missing', 'x.md');
      if (mode === 'junction') {
        symlinkSync(f.destination, join(f.root, 'redirect'), 'junction');
        target = join(f.root, 'redirect', 'x.md');
      }
      const items = [{ outputId: id, target }];
      if (mode === 'duplicate')
        items.push({ outputId: id, target: target.toUpperCase() });
      assert.throws(() => f.app.outputs.prepareExport({ items }, f.env(), uid()));
      if (mode === 'exists') assert.equal(readFileSync(target, 'utf8'), '用户原文件');
    } finally {
      await f.close();
    }
  });

test('导出：等待批准后目标出现使原批准失效，不覆盖也不再询问', async () => {
  const f = setup();
  try {
    const { id } = await f.output(),
      target = join(f.destination, 'late.md'),
      r = f.startExport([{ outputId: id, target }]),
      approval = await f.pending();
    writeFileSync(target, '用户晚到');
    f.app.approve(f.c.conversationId, approval, 'allow');
    await f.app.wait(r.runId);
    assert.equal(readFileSync(target, 'utf8'), '用户晚到');
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'failed');
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('导出：拒绝后同成果/同目标不能重复申请', async () => {
  const f = setup();
  try {
    const { id } = await f.output(),
      target = join(f.destination, 'deny.md');
    f.steps.push(
      call('export_outputs', { items: [{ outputId: id, target }] }),
      call('export_outputs', { items: [{ outputId: id, target }] }),
      text('结束'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '导出'),
      approval = await f.pending();
    f.app.approve(f.c.conversationId, approval, 'deny');
    await f.app.wait(r.runId);
    assert.deepEqual(
      f.app.store.tools(r.runId).map((t) => t.state),
      ['denied', 'denied'],
    );
    assert(!existsSync(target));
  } finally {
    await f.close();
  }
});

test('导出：多成果派发后第二目标冲突，保留第一份与逐项失败反馈', async () => {
  let target2 = '';
  const f = setup((point, index) => {
    if (point === 'after-receipt' && index === 0) writeFileSync(target2, '第三方');
  });
  try {
    const first = await f.output('甲', '甲.md'),
      second = await f.output('乙', '乙.md'),
      target1 = join(f.destination, '甲.md');
    target2 = join(f.destination, '乙.md');
    const r = f.startExport([
        { outputId: first.id, target: target1 },
        { outputId: second.id, target: target2 },
      ]),
      approval = await f.pending();
    f.app.approve(f.c.conversationId, approval, 'allow');
    await f.app.wait(r.runId);
    const tool = f.app.store.tools(r.runId)[0]!;
    assert.equal(tool.state, 'failed');
    const result = f.app.store.readArtifact<{ data: any }>(tool.result_ref!);
    assert.deepEqual(
      result.data.receipts.map((i: any) => i.status),
      ['written', 'conflict'],
    );
    assert.equal(readFileSync(target1, 'utf8'), '甲');
    assert.equal(readFileSync(target2, 'utf8'), '第三方');
    const observed = f.app.outputs.inspectExport(f.c.conversationId, tool.id).data as any;
    assert.deepEqual(
      observed.receipts.map((i: any) => i.status),
      ['verified', 'conflict'],
    );
  } finally {
    await f.close();
  }
});

for (const point of ['after-intent', 'after-effect', 'after-receipt'] as const)
  test(`导出恢复：${point} 中断，重启仅观察且保留身份`, async () => {
    let once = true;
    const f = setup((p) => {
      if (p === point && once) {
        once = false;
        throw new Error('故障');
      }
    });
    try {
      const { id } = await f.output(),
        target = join(f.destination, 'recover.md'),
        r = f.startExport([{ outputId: id, target }]),
        approval = await f.pending();
      f.app.approve(f.c.conversationId, approval, 'allow');
      await f.app.wait(r.runId);
      const tool = f.app.store.tools(r.runId)[0]!;
      assert.equal(tool.state, 'unknown');
      const partial = f.app.store.readArtifact<{ data: any }>(tool.result_ref!);
      assert.equal(partial.data.receipts.length, 1);
      const identity = existsSync(target) ? fileIdentity(target) : null;
      await f.app.close();
      const next = new UmiApplication(
        join(f.root, 'data'),
        new ScriptModel([text('已核验')]),
      );
      try {
        next.resume(f.c.conversationId, r.runId);
        await next.wait(r.runId);
        assert.equal(
          next.store.tool(tool.id).state,
          point === 'after-intent' ? 'failed' : 'succeeded',
        );
        assert.equal(existsSync(target) ? fileIdentity(target) : null, identity);
        assert.equal(
          next.store
            .events(f.c.conversationId)
            .filter((e) => e.type === 'tool.dispatch_intent' && e.executionId === tool.id)
            .length,
          1,
        );
      } finally {
        await next.close();
      }
    } finally {
      await f.close();
    }
  });

test('成果恢复：tool.settled 保存失败后只核验原文件，不重建', async () => {
  const f = setup();
  try {
    f.app.store.db.exec(
      "CREATE TRIGGER output_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.settled' BEGIN SELECT RAISE(ABORT,'故障'); END;",
    );
    f.steps.push(
      call('create_output', { name: '恢复.md', content: '成果字节' }),
      text('结束'),
    );
    const r = await f.run(),
      tool = f.app.store.tools(r.runId)[0]!;
    const ctx = executionContextSchema.parse(f.app.store.readArtifact(tool.context_ref!));
    assert.equal(ctx.output?.kind, 'create');
    const file = join(
      f.env().root,
      ctx.output!.kind === 'create' ? ctx.output!.descriptor.relativePath : '',
    );
    const identity = fileIdentity(file);
    f.app.store.db.exec('DROP TRIGGER output_failure');
    await f.app.close();
    const next = new UmiApplication(
      join(f.root, 'data'),
      new ScriptModel([text('恢复')]),
    );
    try {
      next.resume(f.c.conversationId, r.runId);
      await next.wait(r.runId);
      assert.equal(next.store.tool(tool.id).state, 'succeeded');
      assert.equal(fileIdentity(file), identity);
    } finally {
      await next.close();
    }
  } finally {
    await f.close();
  }
});

test('派发层：export_outputs 必须具有具体批准，不能改工具 effect 绕过', async () => {
  const f = setup();
  try {
    const { id } = await f.output(),
      target = join(f.destination, 'blocked.md'),
      tool = f.app.registry.get('export_outputs');
    tool.effect = 'copy-write';
    tool.approvalRequired = () => false;
    const r = f.startExport([{ outputId: id, target }]);
    await f.app.wait(r.runId);
    assert(!existsSync(target));
    assert.equal(f.app.store.tools(r.runId)[0]!.state, 'prepared');
  } finally {
    await f.close();
  }
});

test('成果列表：跨运行分页定位，元数据不冒充当前正文核验', async () => {
  const f = setup();
  try {
    const a = await f.output('甲', 'a.md'),
      b = await f.output('乙', 'b.md');
    const first = f.app.outputs.list(f.c.conversationId, { limit: 1 });
    assert.equal(first.entries[0]!.outputId, a.id);
    assert.equal(first.nextOffset, 1);
    const second = f.app.outputs.list(f.c.conversationId, { limit: 1, offset: 1 });
    assert.equal(second.entries[0]!.outputId, b.id);
    assert.equal(second.nextOffset, null);
    writeFileSync(join(f.env().root, a.data.relativePath), '变化');
    assert.equal(f.app.outputs.list(f.c.conversationId, {}).total, 2);
    assert.throws(() => f.app.outputs.read(f.c.conversationId, { outputId: a.id }));
    const other = f.app.createConversation(f.workspace);
    assert.equal(f.app.outputs.list(other.conversationId, {}).total, 0);
  } finally {
    await f.close();
  }
});

test('导出取消：首项回执保留，其余不开始，恢复不补导出', async () => {
  const controller = new AbortController();
  const f = setup((point, index) => {
    if (point === 'after-receipt' && index === 0) controller.abort();
  });
  try {
    const a = await f.output('甲'),
      b = await f.output('乙'),
      one = join(f.destination, 'one.md'),
      two = join(f.destination, 'two.md');
    const tool = f.app.registry.get('export_outputs'),
      execute = tool.execute.bind(tool);
    tool.execute = (args, ctx, cid, _signal) =>
      execute(args, ctx, cid, controller.signal);
    const r = f.startExport([
        { outputId: a.id, target: one },
        { outputId: b.id, target: two },
      ]),
      approval = await f.pending();
    f.app.approve(f.c.conversationId, approval, 'allow');
    await f.app.wait(r.runId);
    const execution = f.app.store.tools(r.runId)[0]!;
    assert.equal(execution.state, 'cancelled');
    assert.equal(readFileSync(one, 'utf8'), '甲');
    assert(!existsSync(two));
    const result = f.app.outputs.inspectExport(f.c.conversationId, execution.id)
      .data as any;
    assert.deepEqual(
      result.receipts.map((i: any) => i.status),
      ['verified', 'not_started'],
    );
    assert(!existsSync(two));
  } finally {
    await f.close();
  }
});

for (const fault of ['receipt-save', 'target-drift', 'target-identity'])
  test('导出回执：' + fault + ' 保持可核验且不重导', async () => {
    let target = '';
    const f = setup((point) => {
      if (point === 'after-effect' && fault === 'target-drift')
        writeFileSync(target, '用户编辑');
      if (point === 'after-receipt' && fault === 'target-identity') {
        const bytes = readFileSync(target);
        unlinkSync(target);
        writeFileSync(target, bytes);
      }
    });
    try {
      const a = await f.output();
      target = join(f.destination, 'final.md');
      if (fault === 'receipt-save')
        f.app.store.db.exec(
          "CREATE TRIGGER receipt_fault BEFORE INSERT ON artifacts WHEN NEW.id LIKE 'output-receipt-%' BEGIN SELECT RAISE(ABORT,'回执故障'); END;",
        );
      const r = f.startExport([{ outputId: a.id, target }]),
        approval = await f.pending();
      f.app.approve(f.c.conversationId, approval, 'allow');
      await f.app.wait(r.runId);
      const t = f.app.store.tools(r.runId)[0]!;
      if (fault === 'receipt-save') f.app.store.db.exec('DROP TRIGGER receipt_fault');
      const identity = fileIdentity(target),
        observed = f.app.outputs.inspectExport(f.c.conversationId, t.id);
      assert.equal(observed.outcome, fault === 'receipt-save' ? 'succeeded' : 'unknown');
      assert.equal(fileIdentity(target), identity);
      if (fault === 'target-drift')
        assert.equal(readFileSync(target, 'utf8'), '用户编辑');
    } finally {
      await f.close();
    }
  });

for (const complete of [false, true])
  test(
    '任务导出验收：' + (complete ? '真实回执通过并追踪漂移' : '仅生成成果不能通过'),
    async () => {
      const f = setup();
      try {
        const a = await f.output('验收正文'),
          target = join(f.destination, '验收.md');
        if (complete)
          f.steps.push(call('export_outputs', { items: [{ outputId: a.id, target }] }));
        f.steps.push(() => {
          const user = f.app.store
            .messages(f.c.conversationId)
            .filter((m) => m.role === 'user' && m.applied)
            .at(-1)!;
          const execution = Object.values(
            f.app.store.snapshot(f.c.conversationId).tools,
          ).findLast((t) => t.name === 'export_outputs')?.executionId;
          return call('record_task_checkpoint', {
            goal: '核验交付成果',
            source: { messageId: user.id, quote: '核验交付成果' },
            acknowledgedInputId: user.id,
            criteria: [
              {
                id: 'export',
                description: '实际目标具有固定成果正文',
                check: {
                  kind: 'export_receipt',
                  items: [{ target, expectedHash: a.data.hash }],
                },
              },
            ],
            progress: [
              {
                criterionId: 'export',
                status: 'verified',
                evidenceExecutionId: complete ? execution : a.id,
              },
            ],
          });
        }, text('核验结果'));
        const r = f.app.send(f.c.conversationId, uid(), '核验交付成果');
        if (complete) {
          const approval = await f.pending();
          f.app.approve(f.c.conversationId, approval, 'allow');
        }
        await f.app.wait(r.runId);
        const checkpoint = f.app.store
          .tools(r.runId)
          .find((t) => t.name === 'record_task_checkpoint')!;
        assert.equal(checkpoint.state, complete ? 'succeeded' : 'failed');
        if (complete) {
          assert.equal(
            f.app.tasks.assess(f.c.conversationId).status,
            'criteria_verified',
          );
          writeFileSync(target, '后来修改');
          assert.notEqual(
            f.app.tasks.assess(f.c.conversationId).status,
            'criteria_verified',
          );
        }
      } finally {
        await f.close();
      }
    },
  );

test('任务续作：新输入后 inspect_export 提供当前导出证据，零重复写入', async () => {
  const f = setup();
  try {
    const a = await f.output(),
      target = join(f.destination, '继续验收.md'),
      r = f.startExport([{ outputId: a.id, target }]),
      approval = await f.pending();
    f.app.approve(f.c.conversationId, approval, 'allow');
    await f.app.wait(r.runId);
    const original = f.app.store.tools(r.runId)[0]!;
    const identity = fileIdentity(target);
    f.steps.push(
      call('inspect_export', { executionId: original.id }),
      () => {
        const user = f.app.store
          .messages(f.c.conversationId)
          .filter((m) => m.role === 'user' && m.applied)
          .at(-1)!;
        const evidence = Object.values(
          f.app.store.snapshot(f.c.conversationId).tools,
        ).findLast((t) => t.name === 'inspect_export')!;
        return call('record_task_checkpoint', {
          goal: '确认原交付',
          source: { messageId: user.id, quote: '确认原交付' },
          acknowledgedInputId: user.id,
          criteria: [
            {
              id: 'export',
              description: '当前目标仍符合冻结成果',
              check: {
                kind: 'export_receipt',
                items: [{ target, expectedHash: a.data.hash }],
              },
            },
          ],
          progress: [
            {
              criterionId: 'export',
              status: 'verified',
              evidenceExecutionId: evidence.executionId,
            },
          ],
        });
      },
      text('已只读核验'),
    );
    const next = f.app.send(f.c.conversationId, uid(), '确认原交付');
    await f.app.wait(next.runId);
    assert.equal(f.app.store.tools(next.runId)[0]!.state, 'succeeded');
    assert.equal(f.app.store.tools(next.runId)[1]!.state, 'succeeded');
    assert.equal(f.app.tasks.assess(f.c.conversationId).status, 'criteria_verified');
    assert.equal(fileIdentity(target), identity);
    assert.equal(
      f.app.store.tools(next.runId).filter((t) => t.name === 'export_outputs').length,
      0,
    );
  } finally {
    await f.close();
  }
});

test('导出：拒绝后重建同字节成果并重排批次不能重复申请', async () => {
  const f = setup();
  try {
    const a = await f.output('甲', '甲.md'),
      b = await f.output('乙', '乙.md');
    const targetA = join(f.destination, '甲.md'),
      targetB = join(f.destination, '乙.md');
    f.steps.push(
      call('export_outputs', {
        items: [
          { outputId: a.id, target: targetA },
          { outputId: b.id, target: targetB },
        ],
      }),
      call('create_output', { name: '重建甲.md', content: '甲' }),
      call('create_output', { name: '重建乙.md', content: '乙' }),
      () => {
        const generated = f.app.store
          .tools(r.runId)
          .filter((t) => t.name === 'create_output');
        return call('export_outputs', {
          items: [
            { outputId: generated[1]!.id, target: targetB },
            { outputId: generated[0]!.id, target: targetA },
          ],
        });
      },
      text('结束'),
    );
    const r = f.app.send(f.c.conversationId, uid(), '导出两份成果'),
      approval = await f.pending();
    f.app.approve(f.c.conversationId, approval, 'deny');
    await f.app.wait(r.runId);
    assert.deepEqual(
      f.app.store.tools(r.runId).map((t) => t.state),
      ['denied', 'succeeded', 'succeeded', 'failed'],
    );
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      1,
    );
    assert(!existsSync(targetA));
    assert(!existsSync(targetB));
  } finally {
    await f.close();
  }
});
