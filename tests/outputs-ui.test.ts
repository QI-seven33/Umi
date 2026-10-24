import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegacyFileApplication as UmiApplication } from './legacy-file-fixture.js';
import { DesktopService } from '../apps/desktop/service.js';
import {
  InspectionSummary,
  OutputsPanel,
  exportRequest,
} from '../apps/desktop/renderer/src/OutputsPanel.js';
import { fileTargetKey } from '../apps/desktop/renderer/src/Timeline.js';
import { ScriptModel, call, text, removeTestRoot } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';

test('成果 UI：未选择会话时说明入口，不误报已有交付', () => {
  const html = renderToStaticMarkup(
    createElement(OutputsPanel, { conversationId: '', state: null, onDraft: () => {} }),
  );
  assert(html.includes('选择工作区'));
  assert(!html.includes('已导出'));
  assert(!html.includes('请求导出'));
});

test('准备 UI：观察与就绪分开，问题文本安全转义', () => {
  const html = renderToStaticMarkup(
    createElement(InspectionSummary, {
      report: {
        status: 'needs_attention',
        root: 'E:\\项目',
        issues: [{ code: 'DEPENDENCIES_MISSING', message: '<script>依赖缺失</script>' }],
        instruction: '不是运行就绪或隔离证明',
      },
    }),
  );
  assert(html.includes('准备条件需要处理'));
  assert(html.includes('&lt;script&gt;'));
  assert(!html.includes('<script>'));
  assert(html.includes('不是运行就绪或隔离证明'));
  const clean = renderToStaticMarkup(
    createElement(InspectionSummary, {
      report: { status: 'observed', root: '', issues: [], instruction: '只读观察' },
    }),
  );
  assert(clean.includes('已完成只读观察'));
  assert(!clean.includes('运行就绪'));
});

test('导出请求：路径和成果 ID 保留为明确对象，不引入命令或默认覆盖', () => {
  const request = exportRequest('output-a', 'E:\\报告\\a "中文".md');
  const body = JSON.parse(
    request.slice(request.indexOf('{'), request.lastIndexOf('}') + 1),
  );
  assert.deepEqual(body, {
    items: [{ outputId: 'output-a', target: 'E:\\报告\\a "中文".md' }],
  });
  assert(request.includes('原批准流程'));
  assert(request.includes('不覆盖'));
  assert(!request.includes('run_shell'));
});

test('准备 UI 查询：真实检查投影、会话归属、普通工具不暴露任意 data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-output-ui-')),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const model = new ScriptModel([
    call('inspect_execution', {
      cwd: { kind: 'task', area: 'artifacts' },
      programs: ['umi-not-a-program'],
    }),
    text('准备未就绪'),
    call('create_output', { name: '报告.md', content: '正文' }),
    text('尚未交付'),
  ]);
  const app = new UmiApplication(join(root, 'data'), model),
    c = app.createConversation(workspace),
    service = new DesktopService(app);
  try {
    const run = app.send(c.conversationId, uid(), '检查执行准备');
    await app.wait(run.runId);
    const tool = app.store.tools(run.runId).find((t) => t.name === 'inspect_execution')!;
    const detail = (await service.handle({
      type: 'tool_detail',
      conversationId: c.conversationId,
      callId: tool.call_id,
    })) as any;
    assert.equal(detail.inspection.status, 'needs_attention');
    assert(
      detail.inspection.issues.some((i: any) => i.message.includes('umi-not-a-program')),
    );
    assert.deepEqual(
      Object.keys(detail.inspection).sort(),
      ['status', 'root', 'issues', 'instruction'].sort(),
    );
    assert(!('data' in detail.result));
    const other = app.createConversation(workspace);
    await assert.rejects(
      service.handle({
        type: 'tool_detail',
        conversationId: other.conversationId,
        callId: tool.call_id,
      }),
      /不属于当前会话/,
    );
    const next = app.send(c.conversationId, uid(), '生成成果');
    await app.wait(next.runId);
    const created = app.store.tools(next.runId).find((t) => t.name === 'create_output')!;
    const normal = (await service.handle({
      type: 'tool_detail',
      conversationId: c.conversationId,
      callId: created.call_id,
    })) as any;
    assert.equal(normal.inspection, null);
    assert(!('data' in normal.result));
    const page = (await service.handle({
      type: 'list_outputs',
      conversationId: c.conversationId,
      offset: 0,
      limit: 10,
    })) as any;
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].outputId, created.id);
  } finally {
    await app.close();
    removeTestRoot(root);
  }
});

test('原文件预览身份保持，成果页面不会改变附件/变更集定位', () => {
  assert.notEqual(
    fileTargetKey({ mountId: 'x', path: 'a.md', attachmentId: 'a' }),
    fileTargetKey({ mountId: 'x', path: 'a.md', attachmentId: 'b' }),
  );
});
