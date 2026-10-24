import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { replaceUniqueUtf8 } from '../packages/adapters/src/host-files/text-edit.js';
import { fileIdentity } from '../packages/adapters/src/host-files/paths.js';
import { uid } from '../packages/agent/src/identity.js';
import { ScriptModel, call, text, removeTestRoot, eventually } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import type { EditFileArgs } from '../packages/protocol/src/file-edit.js';
import type { Mount } from '../packages/protocol/src/resources.js';

const lastData = (r: PreparedRequest) =>
  JSON.parse(
    (r.body.messages as { role: string; content: string }[])
      .filter((m) => m.role === 'tool')
      .at(-1)!.content,
  ).data as Record<string, any>;
interface EditFixture {
  root: string;
  workspace: string;
  app: UmiApplication;
  c: ReturnType<UmiApplication['createConversation']>;
  model: ScriptModel;
  m: Mount;
  file: string;
  run(): Promise<ReturnType<UmiApplication['send']>>;
  close(): Promise<void>;
}
function fixture(
  source: string | Buffer = '前缀 唯一目标 后缀',
  mutate?: (args: EditFileArgs, f: EditFixture) => void,
  read: { startByte?: number; byteLength?: number } = {},
  follow?: (f: EditFixture) => Step[],
): EditFixture {
  const root = mkdtempSync(join(tmpdir(), 'umi-text-edit-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'a.txt'), source);
  writeFileSync(join(workspace, 'b.txt'), '另一个文件');
  let mountId = '';
  const steps: Step[] = [
    () => call('read_file', { mountId, path: 'a.txt', ...read }),
    (r) => {
      const d = lastData(r);
      const args: EditFileArgs = {
        mountId,
        path: 'a.txt',
        readExecutionId: d.readExecutionId,
        expectedReadHash: d.hash,
        oldText: '唯一目标',
        newText: '替换内容',
      };
      mutate?.(args, f);
      return call('edit_file', args);
    },
    text('已检查工具结果'),
    text('结束'),
  ];
  const model = new ScriptModel(steps),
    app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace);
  mountId = app.files.repo.mounts(c.environmentId)[0]!.id;
  const m = app.files.repo.mount(mountId, c.environmentId);
  const f: EditFixture = {
    root,
    workspace,
    app,
    c,
    model,
    m,
    file: join(m.root, 'a.txt'),
    async run() {
      const r = app.send(c.conversationId, uid(), '局部修改');
      await app.wait(r.runId);
      return r;
    },
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
  if (follow) steps.splice(2, 2, ...follow(f));
  return f;
}

test('局部编辑：BOM/CRLF/中文和学习注释的无关字节保持', async () => {
  const original = Buffer.from('\uFEFF// 学习：保留\r\n第一行\r\n唯一目标\r\n尾部😀\r\n');
  const f = fixture(original);
  try {
    const r = await f.run(),
      tools = f.app.store.tools(r.runId),
      read = tools[0]!,
      edit = tools[1]!;
    assert.equal(edit.state, 'succeeded');
    assert.equal(
      f.app.store.readArtifact<any>(read.result_ref!).data.readExecutionId,
      read.id,
    );
    assert.deepEqual(
      readFileSync(f.file),
      Buffer.from(original.toString('utf8').replace('唯一目标', '替换内容')),
    );
    assert.deepEqual(readFileSync(join(f.workspace, 'a.txt')), original);
    assert.equal(
      Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,
      0,
    );
  } finally {
    await f.close();
  }
});

for (const [label, source, mutate, message] of [
  ['零命中', '原文无目标', undefined, /没有精确命中/],
  ['多命中', '唯一目标 唯一目标', undefined, /不唯一/],
  [
    '错误哈希',
    '唯一目标',
    (a: EditFileArgs) => {
      a.expectedReadHash = '0'.repeat(64);
    },
    /不匹配/,
  ],
  [
    '缺失读回执',
    '唯一目标',
    (a: EditFileArgs) => {
      a.readExecutionId = 'missing';
    },
    /成功的 read_file/,
  ],
  [
    '错误文件',
    '唯一目标',
    (a: EditFileArgs) => {
      a.path = 'b.txt';
    },
    /不匹配/,
  ],
  [
    '内容过期',
    '唯一目标',
    (_a: EditFileArgs, f: ReturnType<typeof fixture>) => {
      writeFileSync(f.file, '外部内容变化');
    },
    /读后.*变化/,
  ],
  [
    '同字节对象替换',
    '唯一目标',
    (_a: EditFileArgs, f: ReturnType<typeof fixture>) => {
      renameSync(f.file, join(f.m.root, 'old.txt'));
      writeFileSync(f.file, '唯一目标');
    },
    /对象身份.*变化/,
  ],
  ['二进制', Buffer.from([0xff, 0xfe, 0x41, 0]), undefined, /不是可绑定/],
] as const) {
  test(`局部编辑：${label} 明确失败且不覆盖目标`, async () => {
    const f = fixture(source, mutate);
    try {
      const r = await f.run(),
        edit = f.app.store.tools(r.runId)[1]!;
      assert.equal(edit.state, 'failed');
      assert.match(f.app.store.readArtifact<any>(edit.result_ref!).content, message);
      assert(!readFileSync(f.file).includes(Buffer.from('替换内容')));
    } finally {
      await f.close();
    }
  });
}

test('局部编辑：部分读取只允许实际可见范围，不能凭全文件 hash 越过范围', async () => {
  const f = fixture('prefix 唯一目标 suffix', undefined, { startByte: 0, byteLength: 6 });
  try {
    const r = await f.run();
    const t = f.app.store.tools(r.runId)[1]!;
    assert.equal(t.state, 'failed');
    assert.match(
      f.app.store.readArtifact<any>(t.result_ref!).content,
      /不在本次读取范围/,
    );
  } finally {
    await f.close();
  }
});

test('局部编辑：读取的部分范围内唯一片段可修改', async () => {
  const f = fixture('prefix 唯一目标 suffix', undefined, {
    startByte: 7,
    byteLength: 12,
  });
  try {
    const r = await f.run();
    assert.equal(f.app.store.tools(r.runId)[1]!.state, 'succeeded');
    assert.equal(readFileSync(f.file, 'utf8'), 'prefix 替换内容 suffix');
  } finally {
    await f.close();
  }
});

test('局部编辑：no-op 保留对象、mtime 和环境修订', async () => {
  const f = fixture('唯一目标', (a) => {
    a.newText = a.oldText;
  });
  try {
    const identity = fileIdentity(f.file),
      mtime = statSync(f.file, { bigint: true }).mtimeNs,
      revision = f.app.store.environment(f.c.environmentId).revision;
    const r = await f.run(),
      t = f.app.store.tools(r.runId)[1]!;
    assert.equal(t.state, 'succeeded');
    assert.equal(f.app.store.readArtifact<any>(t.result_ref!).mutated, false);
    assert.equal(fileIdentity(f.file), identity);
    assert.equal(statSync(f.file, { bigint: true }).mtimeNs, mtime);
    assert.equal(f.app.store.environment(f.c.environmentId).revision, revision);
  } finally {
    await f.close();
  }
});

test('局部编辑：派发后变化仍拒绝，取消在落盘前无效果', async () => {
  for (const mode of ['drift', 'cancel'] as const) {
    const f = fixture('唯一目标');
    const definition = f.app.registry.get('edit_file'),
      execute = definition.execute;
    definition.execute = async (a, ctx, c, signal) => {
      if (mode === 'drift') writeFileSync(f.file, '派发后第三方变化');
      return execute(a, ctx, c, mode === 'cancel' ? AbortSignal.abort() : signal);
    };
    try {
      const r = await f.run();
      assert.equal(
        f.app.store.tools(r.runId)[1]!.state,
        mode === 'drift' ? 'failed' : 'cancelled',
      );
      assert.equal(
        readFileSync(f.file, 'utf8'),
        mode === 'drift' ? '派发后第三方变化' : '唯一目标',
      );
    } finally {
      await f.close();
    }
  }
});

for (const point of ['tool.started', 'tool.settled']) {
  test(`局部编辑：${point} 提交中断，重启只核验原目标不重复替换`, async () => {
    const f = fixture('唯一目标', (a) => {
      a.newText = '唯一目标 + 新增';
    });
    try {
      f.app.store.db.exec(
        `CREATE TRIGGER edit_commit_failure BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='${point}' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='edit_file' BEGIN SELECT RAISE(ABORT,'局部编辑提交故障'); END;`,
      );
      const r = await f.run();
      assert.equal(f.app.store.getRun(r.runId).status, 'recovery_required');
      assert.equal(
        readFileSync(f.file, 'utf8'),
        point === 'tool.started' ? '唯一目标' : '唯一目标 + 新增',
      );
      f.app.store.db.exec('DROP TRIGGER edit_commit_failure');
      await f.app.close();
      const next = new UmiApplication(
        join(f.root, 'data'),
        new ScriptModel([text('原目标核验'), text('结束')]),
      );
      try {
        next.resume(f.c.conversationId, r.runId);
        assert.equal((await next.wait(r.runId)).status, 'completed');
        const t = next.store.tools(r.runId)[1]!;
        assert.equal(t.state, point === 'tool.started' ? 'failed' : 'succeeded');
        assert.equal(
          readFileSync(f.file, 'utf8'),
          point === 'tool.started' ? '唯一目标' : '唯一目标 + 新增',
        );
        assert.equal(
          next.store
            .events(f.c.conversationId)
            .filter((e) => e.type === 'tool.dispatch_intent' && e.executionId === t.id)
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
}

test('局部编辑：写后再出现第三方字节，恢复保持 unknown', async () => {
  const f = fixture('唯一目标');
  try {
    f.app.store.db.exec(
      "CREATE TRIGGER edit_unknown BEFORE INSERT ON events WHEN json_extract(NEW.payload,'$.type')='tool.settled' AND (SELECT name FROM tool_executions WHERE id=json_extract(NEW.payload,'$.executionId'))='edit_file' BEGIN SELECT RAISE(ABORT,'故障'); END;",
    );
    const r = await f.run();
    f.app.store.db.exec('DROP TRIGGER edit_unknown');
    writeFileSync(f.file, '第三方最终字节');
    f.app.resume(f.c.conversationId, r.runId);
    assert.equal((await f.app.wait(r.runId)).status, 'recovery_required');
    assert.equal(f.app.store.tools(r.runId)[1]!.state, 'unknown');
    assert.equal(readFileSync(f.file, 'utf8'), '第三方最终字节');
  } finally {
    await f.close();
  }
});

test('局部编辑：冻结变更集独立批准后才交付来源', async () => {
  const f = fixture('唯一目标', undefined, {}, (f) => [
    () => call('build_changeset', { mountId: f.m.id }),
    (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
    text('已检查交付'),
    text('结束'),
  ]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '修改后交付');
    const a = await eventually(
      () =>
        Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(
          ([, a]) => a.status === 'pending',
        )?.[0],
    );
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '唯一目标');
    assert.equal(readFileSync(f.file, 'utf8'), '替换内容');
    f.app.approve(f.c.conversationId, a, 'allow');
    assert.equal((await f.app.wait(r.runId)).status, 'completed');
    assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), '替换内容');
  } finally {
    await f.close();
  }
});

test('局部编辑：不同会话的成功读取不能授予本会话编辑', async () => {
  const f = fixture('唯一目标');
  try {
    const first = await f.run(),
      read = f.app.store.tools(first.runId)[0]!;
    const other = f.app.createConversation(f.workspace),
      otherMount = f.app.files.repo.mounts(other.environmentId)[0]!;
    const args = {
      mountId: otherMount.id,
      path: 'a.txt',
      readExecutionId: read.id,
      expectedReadHash: f.app.store.readArtifact<any>(read.result_ref!).data.hash,
      oldText: '唯一目标',
      newText: '不得写入',
    };
    assert.throws(
      () =>
        f.app.registry
          .get('edit_file')
          .prepare(args, f.app.store.environment(other.environmentId), uid()),
      /当前会话成功/,
    );
    assert.equal(readFileSync(join(otherMount.root, 'a.txt'), 'utf8'), '唯一目标');
  } finally {
    await f.close();
  }
});

test('精确字节替换：重叠命中、LF/CRLF、片段字节上限和无效 Unicode 均明确拒绝', () => {
  assert.throws(() => replaceUniqueUtf8(Buffer.from('aaaa'), 'aaa', 'x'), /不唯一/);
  assert.throws(
    () => replaceUniqueUtf8(Buffer.from('a\r\nb'), 'a\nb', 'x'),
    /没有精确命中/,
  );
  assert.throws(
    () => replaceUniqueUtf8(Buffer.from('x'), 'x', '界'.repeat(21334)),
    /64000/,
  );
  assert.throws(() => replaceUniqueUtf8(Buffer.from([0xff]), 'x', 'y'), /UTF-8/);
  assert.throws(() => replaceUniqueUtf8(Buffer.from('x'), 'x', '\ud800'), /Unicode/);
  assert.throws(() => replaceUniqueUtf8(Buffer.from('x'), '', 'x'), /不能为空/);
});
