import { ApprovalCard } from '../apps/desktop/renderer/src/ApprovalCard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DesktopService } from '../apps/desktop/service.js';
import { desktopCommandSchema } from '../packages/protocol/src/desktop.js';
import { initialState } from '../packages/protocol/src/reducer.js';
import { applyBatch } from '../apps/desktop/renderer/src/transport.js';
import type { Snapshot } from '../apps/desktop/renderer/src/transport.js';
import { Timeline, timelineWindow } from '../apps/desktop/renderer/src/Timeline.js';
import { ScriptModel, text, call, removeTestRoot, eventually } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
function fixture(steps: ConstructorParameters<typeof ScriptModel>[0] = []) {
  const root = mkdtempSync(join(tmpdir(), 'umi-desktop-test-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'config.txt'), 'source');
  const model = new ScriptModel(steps),
    app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace);
  return {
    root,
    workspace,
    model,
    app,
    c,
    service: new DesktopService(app),
    async close() {
      await app.close();
      removeTestRoot(root);
    },
  };
}

test('S5-04：旧阶段 4 库升级至 5，原消息、迁移指纹和游标保持', async () => {
  const f = fixture([text('阶段'), text('最终')]);
  const r = f.app.send(f.c.conversationId, uid(), '原要求');
  await f.app.wait(r.runId);
  const before = f.app.store.snapshot(f.c.conversationId),
    m = f.app.store.messages(f.c.conversationId),
    checksums = f.app.store.all(
      'SELECT version,checksum FROM schema_migrations WHERE version<=4',
    );
  f.app.store.db.exec(
    'DROP TABLE message_attachments; DROP TABLE attachments; DROP TABLE conversation_views; DELETE FROM schema_migrations WHERE version=5',
  );
  await f.app.close();
  const next = new UmiApplication(join(f.root, 'data'), new ScriptModel([]));
  try {
    assert.deepEqual(next.store.snapshot(f.c.conversationId), before);
    assert.deepEqual(next.store.messages(f.c.conversationId), m);
    assert.deepEqual(
      next.store.all('SELECT version,checksum FROM schema_migrations WHERE version<=4'),
      checksums,
    );
    assert.equal(next.store.get('SELECT max(version) v FROM schema_migrations')!.v, 6);
  } finally {
    await next.close();
    removeTestRoot(f.root);
  }
});
test('S5-05：有界 IPC 批次、重复消费和缺口使用唯一归约', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 180; i++)
      f.app.store.updateSettings(
        f.c.conversationId,
        f.app.store.settings(f.c.conversationId),
      );
    const full = f.service.snapshot(f.c.conversationId);
    let live: Snapshot = {
      ...full,
      state: initialState(f.c.conversationId, full.state.cursor.logEpoch),
      messages: [],
    };
    const first = (await f.service.handle(
      desktopCommandSchema.parse({
        type: 'events',
        conversationId: f.c.conversationId,
        cursor: live.state.cursor,
      }),
    )) as any;
    assert(first.events.length <= 128);
    assert(first.events.length > 0);
    assert.throws(
      () => applyBatch(live, { ...first, events: first.events.slice(1) }),
      /缺口/,
    );
    live = applyBatch(live, first);
    assert.deepEqual(applyBatch(live, first), live);
    while (live.state.cursor.sequence !== full.state.cursor.sequence) {
      const batch = (await f.service.handle(
        desktopCommandSchema.parse({
          type: 'events',
          conversationId: f.c.conversationId,
          cursor: live.state.cursor,
        }),
      )) as any;
      live = applyBatch(live, batch);
    }
    assert.deepEqual(live.state, full.state);
  } finally {
    await f.close();
  }
});
test('S5-06：持久配置、新会话沿既有工作区证据，工作副本环境身份各自独立', async () => {
  const f = fixture([text('收到')]);
  try {
    const settings = {
      ...f.app.store.settings(f.c.conversationId),
      thinking: 'high' as const,
      executionPolicy: 'auto' as const,
      contextWindow: 256000,
    };
    await f.service.handle({
      type: 'settings',
      conversationId: f.c.conversationId,
      settings,
    });
    const draft = (await f.service.handle({
      type: 'new_conversation',
      conversationId: f.c.conversationId,
    })) as { conversationId: string };
    assert.equal(draft.conversationId, f.c.conversationId);
    assert.equal(f.app.store.listConversations()[0]!.hasMessages, false);
    const sent = f.app.send(f.c.conversationId, uid(), '开始正式对话');
    await f.app.wait(sent.runId);
    assert.equal(f.app.store.listConversations()[0]!.hasMessages, true);
    const c = (await f.service.handle({
      type: 'new_conversation',
      conversationId: f.c.conversationId,
    })) as { conversationId: string; environmentId: string; workspaceId: string };
    assert.equal(c.workspaceId, f.c.workspaceId);
    assert.notEqual(c.environmentId, f.c.environmentId);
    assert.deepEqual(f.app.store.settings(c.conversationId), settings);
    assert.equal(f.app.store.listConversations().length, 2);
    const repeated = await Promise.all(
      Array.from({ length: 20 }, () =>
        f.service.handle({
          type: 'new_conversation',
          conversationId: f.c.conversationId,
        }),
      ),
    );
    assert(
      repeated.every(
        (row) => (row as { conversationId: string }).conversationId === c.conversationId,
      ),
    );
    assert.equal(f.app.store.listConversations().length, 2);
    f.app.store.uploadAttachment(
      c.conversationId,
      '草稿.txt',
      'text/plain',
      '未发送内容',
    );
    f.app.store.updateSettings(c.conversationId, settings);
    assert.equal(
      f.app.store.listConversations().find((row) => row.id === c.conversationId)!
        .hasMessages,
      false,
    );
    await assert.rejects(
      () => f.service.handle({ type: 'create', selectionId: '伪造证据' }),
      /主进程/,
    );
  } finally {
    await f.close();
  }
});
test('S5-07：文本附件原文独立持久化，用户消息不扩写、跨会话不可读、重发幂等', async () => {
  const f = fixture([call('read_attachment', {}, '准备读取'), text('结束')]);
  try {
    const attachment = f.app.store.uploadAttachment(
      f.c.conversationId,
      'ref.txt',
      'text/plain',
      '完整资料：不修改公开接口',
    );
    const command = uid(),
      r = f.app.store.acceptInput(f.c.conversationId, command, '请读取附件', [
        attachment.id,
      ]);
    assert.deepEqual(
      f.app.store.acceptInput(f.c.conversationId, command, '请读取附件', [attachment.id]),
      r,
    );
    assert.throws(
      () => f.app.store.acceptInput(f.c.conversationId, command, '请读取附件', []),
      /不同输入/,
    );
    const snapshot = f.service.snapshot(f.c.conversationId);
    assert.equal(snapshot.messages[0]!.payload.content, '请读取附件');
    assert.equal(snapshot.messages[0]!.attachments[0]!.id, attachment.id);
    assert.equal(
      f.app.store.readAttachment(f.c.conversationId, attachment.id).text,
      '完整资料：不修改公开接口',
    );
    const other = f.app.createConversation(f.workspace);
    assert.throws(
      () => f.app.store.readAttachment(other.conversationId, attachment.id),
      /不属于/,
    );
    const html = renderToStaticMarkup(
      createElement(Timeline, { snapshot, onPreview: () => {}, onError: () => {} }),
    );
    assert(html.includes('ref.txt'));
    assert(!html.includes('完整资料：不修改公开接口'));
  } finally {
    await f.close();
  }
});
test('S5-08：草稿附件不会被模型读到；发送后同一有界工具入口可读取', async () => {
  const f = fixture();
  try {
    const a = f.app.store.uploadAttachment(
        f.c.conversationId,
        'a.md',
        'text/markdown',
        '原文',
      ),
      def = f.app.registry.get('read_attachment'),
      env = f.app.store.environment(f.c.environmentId),
      ctx = def.prepare({}, env),
      args = { attachmentId: a.id, startByte: 0, byteLength: 8192 };
    await assert.rejects(
      () => def.execute(args, ctx, f.c.conversationId, new AbortController().signal),
      /尚未/,
    );
    const r = f.app.store.acceptInput(f.c.conversationId, uid(), '读取', [a.id]);
    f.app.store.applyInputs(r.runId);
    assert.equal(
      (await def.execute(args, ctx, f.c.conversationId, new AbortController().signal))
        .outcome,
      'succeeded',
    );
  } finally {
    await f.close();
  }
});
test('S5-09：renderer 不能注入 SQL、绝对路径、命令或路径穿越', () => {
  for (const command of [
    { type: 'create', workspace: 'C:/Windows' },
    { type: 'shell', script: 'anything' },
    { type: 'sql', sql: 'SELECT *' },
    { type: 'open_file', conversationId: 'c', mountId: 'm', path: '../secret' },
    { type: 'open_file', conversationId: 'c', mountId: 'm', path: 'C:/Windows/a' },
  ])
    assert.equal(desktopCommandSchema.safeParse(command).success, false);
});
test('S5-10：没有 reasoning 不显示正在思考；完成后的折叠不隐藏最终正文', async () => {
  const f = fixture([
    call('search_history', { query: '执行' }, '公开阶段说明'),
    text('最终正文'),
  ]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '执行');
    await f.app.wait(r.runId);
    const snapshot = f.service.snapshot(f.c.conversationId),
      html = renderToStaticMarkup(
        createElement(Timeline, { snapshot, onPreview: () => {}, onError: () => {} }),
      );
    assert(!html.includes('正在思考'));
    assert(html.includes('aria-expanded="false"'));
    assert(html.includes('最终正文'));
    assert(!html.includes('公开阶段说明'));
  } finally {
    await f.close();
  }
});
test('S5-11：批准等待展示原描述，工具异常/拒绝不是成功，最终正文不提前出现', async () => {
  const f = fixture([
    call('write_scratch', { relativePath: 'a.txt', content: 'x' }),
    text('拒绝后结论'),
    text('没有写入'),
  ]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '写入');
    const approval = await eventually(() =>
      Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(
        ([, a]) => a.status === 'pending',
      ),
    );
    let html = renderToStaticMarkup(
      createElement(Timeline, {
        snapshot: f.service.snapshot(f.c.conversationId),
        onPreview: () => {},
        onError: () => {},
      }),
    );
    assert(html.includes('等待你的批准'));
    const card = renderToStaticMarkup(
      createElement(ApprovalCard, {
        id: approval[0],
        state: f.app.store.snapshot(f.c.conversationId),
        conversationId: f.c.conversationId,
        onPreview: () => {},
        onError: () => {},
      }),
    );
    assert(card.includes('确认本次操作'));
    assert(card.includes('a.txt'));
    assert(!html.includes('umi-approval'));
    assert(!html.includes('没有写入'));
    assert(
      !f.app.store
        .snapshot(f.c.conversationId)
        .blocks.some((b) => b.displayRole === 'final'),
    );
    f.app.approve(f.c.conversationId, approval[0], 'deny');
    await f.app.wait(r.runId);
    assert(
      Object.values(f.app.store.snapshot(f.c.conversationId).tools).some(
        (t) => t.status === 'denied',
      ),
    );
    const detail = (await f.service.handle({
      type: 'tool_detail',
      conversationId: f.c.conversationId,
      callId: Object.keys(f.app.store.snapshot(f.c.conversationId).tools)[0]!,
    })) as any;
    assert.equal(detail.result.outcome, 'denied');
  } finally {
    await f.close();
  }
});
test('S5-12：活动会话不能归档；结束后只隐藏列表，事件与工作副本不删除', async () => {
  const f = fixture([text('阶段'), text('最终')]);
  try {
    const r = f.app.store.acceptInput(f.c.conversationId, uid(), '测试');
    assert.throws(
      () => f.app.store.editConversation(f.c.conversationId, null, true),
      /活动任务/,
    );
    f.app.send(f.c.conversationId, uid(), '继续');
    await f.app.wait(r.runId);
    const state = f.app.store.snapshot(f.c.conversationId);
    f.app.store.editConversation(f.c.conversationId, null, true);
    assert.equal(f.app.store.listConversations().length, 0);
    assert.deepEqual(f.app.store.snapshot(f.c.conversationId), state);
    assert.throws(() => f.app.send(f.c.conversationId, uid(), '再发送'), /归档/);
  } finally {
    await f.close();
  }
});

test('S5-13：同一运行中的后续用户指令位于先前阶段正文之后，批准卡片只显示一次', async () => {
  const f = fixture([
    call('write_scratch', { relativePath: 'a.txt', content: 'x' }, '先前阶段说明'),
  ]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '第一条指令');
    await eventually(() =>
      Object.values(f.app.store.snapshot(f.c.conversationId).approvals).find(
        (a) => a.status === 'pending',
      ),
    );
    f.app.send(f.c.conversationId, uid(), '随后补充的指令');
    const html = renderToStaticMarkup(
      createElement(Timeline, {
        snapshot: f.service.snapshot(f.c.conversationId),
        onPreview: () => {},
        onError: () => {},
      }),
    );
    assert(html.indexOf('先前阶段说明') < html.indexOf('随后补充的指令'));
    const state = f.app.store.snapshot(f.c.conversationId),
      cards = Object.entries(state.approvals)
        .filter(([, a]) => a.status === 'pending')
        .map(([id]) =>
          renderToStaticMarkup(
            createElement(ApprovalCard, {
              id,
              state,
              conversationId: f.c.conversationId,
              onPreview: () => {},
              onError: () => {},
            }),
          ),
        )
        .join('');
    assert.equal(cards.split('class="umi-approval"').length - 1, 1);
    assert(!html.includes('umi-approval'));
    assert.equal(f.app.store.getRun(r.runId).status, 'waiting_permission');
  } finally {
    await f.close();
  }
});

test('S5-14：总结轮的 reasoning 仍归思考展示，不作为最终正文', async () => {
  const f = fixture([
    call('search_history', { query: '执行' }),
    { role: 'assistant', content: '总结', reasoning_content: '总结轮原始思考' },
  ]);
  try {
    const r = f.app.send(f.c.conversationId, uid(), '执行');
    await f.app.wait(r.runId);
    const snapshot = f.service.snapshot(f.c.conversationId);
    const html = renderToStaticMarkup(
      createElement(Timeline, { snapshot, onPreview: () => {}, onError: () => {} }),
    );
    assert(!html.includes('总结轮原始思考'));
    assert(html.includes('总结'));
  } finally {
    await f.close();
  }
});

test('S5-15：实时用户消息投影与完成后的历史投影保持相同排序和应用状态', async () => {
  const f = fixture([
    call('write_scratch', { relativePath: 'a.txt', content: 'x' }),
    text('阶段'),
    text('最终'),
  ]);
  try {
    const initial = f.service.snapshot(f.c.conversationId),
      r = f.app.send(f.c.conversationId, uid(), '原始要求');
    const approval = await eventually(() =>
      Object.entries(f.app.store.snapshot(f.c.conversationId).approvals).find(
        ([, a]) => a.status === 'pending',
      ),
    )!;
    f.app.send(f.c.conversationId, uid(), '补充要求');
    f.app.approve(f.c.conversationId, approval[0], 'allow');
    await f.app.wait(r.runId);
    const full = f.service.snapshot(f.c.conversationId);
    let live: Snapshot = { ...initial };
    while (live.state.cursor.sequence !== full.state.cursor.sequence) {
      const batch = (await f.service.handle(
        desktopCommandSchema.parse({
          type: 'events',
          conversationId: f.c.conversationId,
          cursor: live.state.cursor,
        }),
      )) as any;
      live = applyBatch(live, batch);
    }
    assert.deepEqual(live.messages, full.messages);
    assert.deepEqual(live.state, full.state);
  } finally {
    await f.close();
  }
});

test('首屏仅渲染近期正文，历史导航可展开且模型历史完整', async () => {
  const f = fixture(Array.from({ length: 12 }, (_, i) => text('回复-' + i)));
  try {
    for (let i = 0; i < 12; i++) {
      const r = f.app.send(f.c.conversationId, uid(), '用户-' + i);
      await f.app.wait(r.runId);
    }
    const snapshot = f.service.snapshot(f.c.conversationId);
    const html = renderToStaticMarkup(
      createElement(Timeline, { snapshot, onPreview: () => {}, onError: () => {} }),
    );
    assert.equal(snapshot.messages.length, 12);
    assert.equal(timelineWindow(snapshot).hiddenCount, 4);
    assert(!html.includes('用户-0'));
    assert(!html.includes('回复-0'));
    assert(html.includes('用户-4'));
    assert(html.includes('回复-11'));
    const target = snapshot.messages[0]!.id;
    assert.equal(timelineWindow(snapshot, 8, target).hiddenCount, 0);
    const expanded = renderToStaticMarkup(
      createElement(Timeline, {
        snapshot,
        navigationTarget: { id: target },
        onPreview: () => {},
        onError: () => {},
      }),
    );
    assert(expanded.includes('用户-0'));
    assert(expanded.includes('回复-0'));
    assert.equal(
      f.app.store.messages(f.c.conversationId).filter((m) => m.role === 'user').length,
      12,
    );
    assert(f.app.store.messages(f.c.conversationId).some((m) => m.role === 'assistant'));
  } finally {
    await f.close();
  }
});
