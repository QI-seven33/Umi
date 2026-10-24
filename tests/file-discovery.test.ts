import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import {
  metadataInventory,
  discoveryRoots,
} from '../packages/adapters/src/host-files/metadata.js';
import { ScriptModel, call, text, eventually, removeTestRoot } from './fixtures.js';
import { uid, canonical } from '../packages/agent/src/identity.js';
import { toolResultViews } from '../packages/agent/src/context/bounded.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'umi-file-discovery-'));
  const source = join(root, 'source'),
    external = join(root, '资料 空间');
  mkdirSync(source);
  mkdirSync(external);
  const app = new UmiApplication(join(root, 'data'), new ScriptModel([]));
  const c = app.createConversation(source),
    m = app.files.repo.mounts(c.environmentId)[0]!;
  const env = app.store.environment(c.environmentId);
  return {
    root,
    source,
    external,
    app,
    c,
    m,
    env,
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}
const budget = { maxEntries: 5000, maxDepth: 8, maxMs: 1500 };

test('元数据：观察期间目录变动不发布稳定版本；prefix 仅列指定子树', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.m.root, 'sub'));
    writeFileSync(join(f.m.root, 'sub', 'a.txt'), 'a');
    writeFileSync(join(f.m.root, 'outside.txt'), 'outside');
    assert.deepEqual(
      f.app.files.listMetadata(f.m, 'sub').files.map((e) => e.path),
      ['sub/a.txt'],
    );
    let calls = 0;
    assert.throws(
      () =>
        metadataInventory(f.m.root, budget, {
          now: () => {
            if (++calls === 4) writeFileSync(join(f.m.root, 'changed.txt'), 'change');
            return 0;
          },
        }),
      /目录在列举期间发生变化/,
    );
  } finally {
    await f.close();
  }
});

test('默认根计划：使用实际 OneDrive 变量目录，不需要扫描用户目录验证根规划', () => {
  const roots = discoveryRoots('E:/fixture/source', 'C:/fixture/home', [
    'E:/企业盘',
    'D:/个人盘',
  ]);
  assert(roots.includes(join('E:/企业盘', 'Documents')));
  assert(roots.includes(join('D:/个人盘', 'Desktop')));
  assert(!roots.includes('E:/'));
});

test('发现到物化：文件名命中经明确批准仅复制该文件，邻居不能读取', async () => {
  const f = fixture();
  let app: UmiApplication | undefined;
  try {
    writeFileSync(join(f.external, '目标.md'), 'target');
    writeFileSync(join(f.external, '邻居.md'), 'neighbor');
    const model = new ScriptModel([
      call('discover_resource', { root: f.external, kind: 'file', query: '目标.md' }),
      (r) => {
        const messages = r.body.messages as { role: string; content: string }[];
        const data = JSON.parse(
          messages.filter((m) => m.role === 'tool').at(-1)!.content,
        ).data;
        return call('request_resource', {
          candidateId: data.candidates[0].id,
          access: 'read',
          purpose: '阅读单个发现结果',
        });
      },
      (r) => {
        const messages = r.body.messages as { role: string; content: string }[];
        const mountId = JSON.parse(
          messages.filter((m) => m.role === 'tool').at(-1)!.content,
        ).data.mountId;
        // 在授权所属 run 内验证单文件范围；运行结束后原资源能力会失效。
        assert.throws(
          () =>
            app!.registry
              .get('read_file')
              .prepare({ mountId, path: '邻居.md' }, app!.store.environment(f.env.id)),
          /单文件授权/,
        );
        return call('read_file', { mountId, path: '目标.md' });
      },
      text('已物化单文件'),
    ]);
    await f.app.close();
    app = new UmiApplication(join(f.root, 'data'), model);
    const run = app.send(f.c.conversationId, uid(), '找到并读取目标');
    const approvalId = await eventually(
      () =>
        Object.entries(app!.store.snapshot(f.c.conversationId).approvals).find(
          ([, a]) => a.status === 'pending',
        )?.[0],
    );
    app.approve(f.c.conversationId, approvalId, 'allow');
    await app.wait(run.runId);
    const mount = app.files.repo.mounts(f.env.id).find((m) => m.scope.kind === 'file')!;
    assert(mount);
    assert.deepEqual(
      app.files.listMetadata(mount).files.map((e) => e.path),
      ['目标.md'],
    );
    assert.equal(
      app.store.tools(run.runId).find((t) => t.name === 'read_file')!.state,
      'succeeded',
    );
  } finally {
    await app?.close();
    await f.close();
  }
});

test('分页反馈：长文件页在有界上下文投影尾部仍能观察完整续页游标', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 205; i++)
      writeFileSync(join(f.m.root, `文件 ${String(i).padStart(3, '0')}.txt`), 'text');
    const data = f.app.files.listMetadata(f.m, '', 200);
    assert(data.nextCursor);
    const content = canonical({
      outcome: 'succeeded',
      content: '已列举元数据，nextCursor 续页',
      data,
    });
    const projected = toolResultViews(
      [
        {
          id: 'tool-page',
          applied: true,
          projectionSequence: '1',
          payload: { role: 'tool', content, tool_call_id: 'call-page' },
        },
      ],
      16000,
    );
    assert.equal(projected.views.length, 0);
    const view = JSON.parse(projected.messages[0]!.content);
    assert.equal(view.data.nextCursor, data.nextCursor);
    assert.deepEqual(view.data.files, data.files);
  } finally {
    await f.close();
  }
});

test('发现：指定根支持中文/空格、同名文件、扩展名与字面相对路径，仅生成单文件候选', async () => {
  const f = fixture();
  try {
    for (const directory of ['甲', '乙']) {
      mkdirSync(join(f.external, directory));
      writeFileSync(
        join(f.external, directory, '学习 记录.TXT'),
        '不能出现在元数据里的秘密正文',
      );
    }
    writeFileSync(join(f.external, 'other.md'), 'markdown');
    const result = f.app.files.discover(f.env, '.txt', undefined, {
      root: f.external,
      kind: 'file',
      match: 'extension',
    });
    assert.equal(result.candidates.length, 2);
    assert(result.candidates.every((c) => c.scope.kind === 'file'));
    assert.notEqual(result.candidates[0]!.id, result.candidates[1]!.id);
    assert.deepEqual(result.searchedKinds, ['file']);
    assert.equal(result.contentRead, false);
    assert(!JSON.stringify(result).includes('秘密正文'));
    assert.equal(f.app.files.repo.mounts(f.env.id).length, 1);
    assert.equal(f.app.store.all('SELECT * FROM capabilities').length, 1);
    const relative = f.app.files.discover(f.env, '乙/学习', undefined, {
      root: f.external,
      kind: 'file',
      match: 'relative_path',
    });
    assert.equal(relative.candidates.length, 1);
    assert(relative.candidates[0]!.path.includes('乙'));
    const literal = f.app.files.discover(f.env, '*.txt', undefined, {
      root: f.external,
      kind: 'file',
    });
    assert.equal(literal.candidates.length, 0);
  } finally {
    await f.close();
  }
});

test('发现：覆盖结果可分页，目录变化要求重启，环境/查询/无效游标拒绝', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 45; i++)
      writeFileSync(join(f.external, `note-${String(i).padStart(3, '0')}.txt`), '正文');
    const options = { root: f.external, kind: 'file' as const, limit: 20 };
    const first = f.app.files.discover(f.env, 'note-', undefined, options);
    assert.equal(first.total, 45);
    assert(first.nextCursor!);
    assert(first.totalExact);
    const second = f.app.files.discover(f.env, 'note-', undefined, {
      ...options,
      cursor: first.nextCursor!,
    });
    const third = f.app.files.discover(f.env, 'note-', undefined, {
      ...options,
      cursor: second.nextCursor!,
    });
    assert.equal(
      new Set(
        [...first.candidates, ...second.candidates, ...third.candidates].map((c) => c.id),
      ).size,
      45,
    );
    assert.equal(third.nextCursor, null);
    assert.throws(
      () =>
        f.app.files.discover(f.env, 'other', undefined, {
          ...options,
          cursor: first.nextCursor!,
        }),
      /当前对象和查询/,
    );
    assert.throws(
      () => f.app.files.discover(f.env, '', undefined, { ...options, cursor: 'bad' }),
      /无效/,
    );
    const other = f.app.createConversation(f.source);
    assert.throws(
      () =>
        f.app.files.discover(
          f.app.store.environment(other.environmentId),
          'note-',
          undefined,
          { ...options, cursor: first.nextCursor! },
        ),
      /当前对象和查询/,
    );
    writeFileSync(join(f.external, 'note-new.txt'), 'new');
    const changed = f.app.files.discover(f.env, 'note-', undefined, {
      ...options,
      cursor: first.nextCursor!,
    });
    assert.equal(changed.status, 'restart_required');
    assert.deepEqual(changed.candidates, []);
  } finally {
    await f.close();
  }
});

test('列举：205 项稳定分页，重启后续页，无 hash 且大文件不触发内容限额', async () => {
  const f = fixture();
  let app: UmiApplication | undefined;
  try {
    for (let i = 0; i < 205; i++)
      writeFileSync(join(f.m.root, `文件 ${String(i).padStart(3, '0')}.txt`), 'text');
    writeFileSync(join(f.m.root, '大文件.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const first = f.app.files.listMetadata(f.m, '', 200);
    assert.equal(first.total, 206);
    assert.equal(first.files.length, 200);
    assert(first.nextCursor!);
    assert.equal(first.contentRead, false);
    assert(!JSON.stringify(first.files).includes('"hash"'));
    assert.throws(() => f.app.files.scanMount(f.m), /4 MiB/);
    await f.app.close();
    app = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
    const second = app.files.listMetadata(
      app.files.repo.mount(f.m.id, f.env.id),
      '',
      200,
      first.nextCursor!,
    );
    assert.equal(second.files.length, 6);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.files, ...second.files].map((e) => e.path)).size, 206);
  } finally {
    await app?.close();
    await f.close();
  }
});

for (const change of ['add', 'rename', 'replace', 'content'] as const)
  test(`列举：${change} 变化不能沿旧游标静默翻页`, async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.m.root, 'a.txt'), 'a');
      writeFileSync(join(f.m.root, 'b.txt'), 'b');
      const first = f.app.files.listMetadata(f.m, '', 1);
      assert(first.nextCursor!);
      if (change === 'add') writeFileSync(join(f.m.root, 'c.txt'), 'c');
      if (change === 'rename')
        renameSync(join(f.m.root, 'b.txt'), join(f.m.root, 'c.txt'));
      if (change === 'replace') {
        renameSync(join(f.m.root, 'b.txt'), join(f.m.root, 'old'));
        writeFileSync(join(f.m.root, 'b.txt'), 'b');
      }
      if (change === 'content') writeFileSync(join(f.m.root, 'b.txt'), 'different');
      const next = f.app.files.listMetadata(f.m, '', 1, first.nextCursor!);
      assert.equal(next.status, 'restart_required');
      assert.deepEqual(next.files, []);
      assert.equal(next.total, null);
    } finally {
      await f.close();
    }
  });

test('列举：单文件范围不列旁支，prefix 不扩大范围，不接受跨挂载/跨查询游标', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.m.root, 'a.txt'), 'a');
    writeFileSync(join(f.m.root, 'b.txt'), 'b');
    const first = f.app.files.listMetadata(f.m, '', 1);
    assert(first.nextCursor!);
    const single = {
      ...f.m,
      scope: {
        kind: 'file' as const,
        path: 'a.txt',
        rootIdentity: f.m.rootIdentity,
        identity: 'unused',
        size: 1,
        modifiedNs: '0',
        changedNs: '0',
      },
    };
    assert.deepEqual(
      f.app.files.listMetadata(single).files.map((e) => e.path),
      ['a.txt'],
    );
    assert.deepEqual(f.app.files.listMetadata(single, 'b.txt').files, []);
    assert.throws(
      () => f.app.files.listMetadata(single, '', 1, first.nextCursor!),
      /当前对象和查询/,
    );
    assert.throws(
      () => f.app.files.listMetadata(f.m, 'a.txt', 1, first.nextCursor!),
      /当前对象和查询/,
    );
  } finally {
    await f.close();
  }
});

test('元数据：隐藏普通文件可见，忽略项/联接/硬链接有原因，prefix 不沿联接出界', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.m.root, '.notes'), 'hidden');
    mkdirSync(join(f.m.root, 'node_modules'));
    writeFileSync(join(f.m.root, 'node_modules', 'secret.txt'), 'ignore');
    writeFileSync(join(f.external, 'secret.txt'), 'outside');
    symlinkSync(f.external, join(f.m.root, 'linked'), 'junction');
    linkSync(join(f.external, 'secret.txt'), join(f.m.root, 'hard.txt'));
    const result = f.app.files.listMetadata(f.m);
    assert.deepEqual(
      result.files.map((e) => e.path),
      ['.notes'],
    );
    assert.equal(result.coverage.skipped.ignored, 1);
    assert.equal(result.coverage.skipped.link, 1);
    assert.equal(result.coverage.skipped['special-or-hardlink'], 1);
    assert.equal(result.totalExact, false);
    assert.throws(() => f.app.files.listMetadata(f.m, 'linked/secret.txt'), /链接|联接/);
    assert.throws(() => f.app.files.scanMount(f.m), /链接|硬链接/);
  } finally {
    await f.close();
  }
});

test('元数据：条目/时间/深度预算说明不完整，取消传播，空结果保留范围', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.external, 'a.txt'), 'a');
    writeFileSync(join(f.external, 'b.txt'), 'b');
    mkdirSync(join(f.external, 'deep'));
    writeFileSync(join(f.external, 'deep', 'target.txt'), 'target');
    const count = metadataInventory(f.external, { ...budget, maxEntries: 1 });
    assert.equal(count.coverage.visited, 1);
    assert(count.coverage.reasons.includes('entries'));
    assert(!count.coverage.complete);
    let time = 0;
    const timed = metadataInventory(
      f.external,
      { ...budget, maxMs: 2 },
      { now: () => time++ },
    );
    assert(timed.coverage.reasons.includes('time'));
    assert(!timed.coverage.complete);
    const depth = metadataInventory(f.external, { ...budget, maxDepth: 0 });
    assert(depth.coverage.reasons.includes('depth'));
    assert(!depth.entries.some((e) => e.path === 'deep/target.txt'));
    const cancelled = new AbortController();
    cancelled.abort();
    assert.throws(
      () => metadataInventory(f.external, budget, { signal: cancelled.signal }),
      /abort/i,
    );
    const empty = f.app.files.discover(f.env, '不存在', undefined, {
      root: f.external,
      kind: 'file',
    });
    assert.equal(empty.status, 'no_candidates');
    assert.equal(empty.coverage.length, 1);
    assert.match(empty.notice!, /不代表文件不存在/);
    const missing = f.app.files.discover(f.env, '', undefined, {
      root: join(f.external, 'missing'),
      kind: 'file',
    });
    assert.equal(missing.totalExact, false);
    assert.equal(missing.coverage[0]!.skipped.unavailable, 1);
  } finally {
    await f.close();
  }
});

test('元数据：长普通路径与指定 OneDrive 实际目录只查元数据', async () => {
  const f = fixture();
  try {
    const directory = join(
      f.external,
      '企业 OneDrive 实际根',
      'Documents',
      '中文'.repeat(45),
      'long'.repeat(25),
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '记录.md'), '秘密正文');
    const result = f.app.files.discover(f.env, 'md', undefined, {
      root: join(f.external, '企业 OneDrive 实际根'),
      kind: 'file',
      match: 'extension',
      depth: 4,
    });
    assert.equal(result.candidates.length, 1);
    assert(result.candidates[0]!.path.length > 260);
    assert.equal(result.contentRead, false);
    assert(!JSON.stringify(result).includes('秘密正文'));
  } finally {
    await f.close();
  }
});

test('工具调用：模型通过结果游标列完整页，派发和只读恢复沿用现有链路', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.m.root, 'a.txt'), 'a');
    writeFileSync(join(f.m.root, 'b.txt'), 'b');
    let nextCursor = '';
    const model = new ScriptModel([
      call('list_files', { mountId: f.m.id, limit: 1 }),
      (r) => {
        const messages = r.body.messages as { role: string; content: string }[];
        nextCursor = JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content)
          .data.nextCursor;
        return call('list_files', { mountId: f.m.id, limit: 1, cursor: nextCursor });
      },
      text('两页已列举'),
    ]);
    await f.app.close();
    const app = new UmiApplication(join(f.root, 'data'), model);
    try {
      const run = app.send(f.c.conversationId, uid(), '列出文件');
      await app.wait(run.runId);
      const tools = app.store.tools(run.runId);
      assert.equal(tools.length, 2);
      assert(tools.every((t) => t.state === 'succeeded'));
      assert(nextCursor);
      const data = tools.map(
        (t) =>
          app.store.readArtifact<{ data: { files: { path: string }[] } }>(t.result_ref!)
            .data,
      );
      assert.deepEqual(
        data.flatMap((d) => d.files.map((e) => e.path)),
        ['a.txt', 'b.txt'],
      );
      const tool = app.registry.get('list_files'),
        env = app.store.environment(f.env.id);
      const input = { mountId: f.m.id, limit: 1, cursor: nextCursor };
      const reconciled = await tool.reconcile!(
        input,
        tool.prepare(input, env),
        f.c.conversationId,
        new AbortController().signal,
      );
      assert.equal((reconciled.data as { status: string }).status, 'ok');
      assert.throws(
        () =>
          app.registry.parse(
            'discover_resource',
            JSON.stringify({ path: f.external, root: f.external }),
          ),
        /path 精确定位不能同时使用 root\/cursor/,
      );
      assert.throws(
        () =>
          app.registry.parse(
            'discover_resource',
            JSON.stringify({ query: 'txt', match: 'extension' }),
          ),
        /扩展名匹配需 kind=file 和非空字面扩展名/,
      );
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});
