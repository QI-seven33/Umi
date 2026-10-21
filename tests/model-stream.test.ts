import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import type { ModelFrame, PreparedRequest } from '../packages/agent/src/ports.js';
import { UmiError } from '../packages/protocol/src/model.js';
import { ScriptModel, removeTestRoot, eventually } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import { streamWithIdleTimeout } from '../packages/agent/src/model-stream.js';
import { settingsSchema } from '../packages/protocol/src/model.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopService } from '../apps/desktop/service.js';
import { Timeline } from '../apps/desktop/renderer/src/Timeline.js';
import { initialState, reduceConversation } from '../packages/protocol/src/reducer.js';

async function fixture(model: ScriptModel | DeepSeekAdapter, action: (app: UmiApplication, id: string) => Promise<void>, retries = 0) {
  const root = mkdtempSync(join(tmpdir(), 'umi-stream-'));
  const app = new UmiApplication(join(root, 'data'), model, { limits: { maxTurns: 4, maxRetries: retries, modelTimeoutMs: 120, retryDelayMs: 1 } });
  try { await action(app, app.createConversation(root).conversationId); }
  finally { await app.close(); removeTestRoot(root); }
}

test('持续思考、正文和长工具参数超过单次空闲期限仍完整执行一次', async () => {
  class ActiveModel extends ScriptModel {
    override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      if (this.requests.length) { yield* super.stream(request, signal); return; }
      this.requests.push(structuredClone(request));
      const args = JSON.stringify({ relativePath: 'scene.html', content: '<html>scene</html>' });
      for (let i = 0; i < 8; i++) {
        await delay(30, undefined, { signal });
        yield { kind: 'delta', channel: 'reasoning', key: 'reasoning', text: '进展' };
      }
      yield { kind: 'delta', channel: 'text', key: 'text', text: '正在写入。' };
      for (let i = 0; i < args.length; i += 8) {
        await delay(30, undefined, { signal });
        yield { kind: 'delta', channel: 'tool', key: 'call', text: args.slice(i, i + 8) };
      }
      yield { kind: 'response', message: { role: 'assistant', content: '正在写入。', reasoning_content: '进展'.repeat(8), tool_calls: [{ id: 'long-write', type: 'function', function: { name: 'write_scratch', arguments: args } }] }, finishReason: 'tool_calls', usage: null, raw: {} };
    }
  }
  const model = new ActiveModel([{ role: 'assistant', content: '文件已写入托管副本。' }]);
  await fixture(model, async (app, id) => {
    const r = app.send(id, uid(), '创建场景');
    const approval = await eventually(() => Object.entries(app.store.snapshot(id).approvals).find(([, a]) => a.status === 'pending')?.[0]);
    app.approve(id, approval, 'allow');
    assert.equal((await app.wait(r.runId)).status, 'completed');
    assert.equal(model.requests.length, 2);
    assert.equal(app.store.tools(r.runId).length, 1);
    assert(existsSync(join(app.store.environment(app.store.getRun(r.runId).environment_id).root, 'task/scratch/scene.html')));
  });
});

for (const channel of ['reasoning', 'text', 'tool'] as const) {
  test(`已有${channel}分片后断流不自动重试、不派发残缺工具`, async () => {
    class PartialModel extends ScriptModel {
      override async *stream(request: PreparedRequest): AsyncGenerator<ModelFrame> {
        this.requests.push(structuredClone(request));
        yield { kind: 'delta', channel, key: 'partial', text: channel === 'tool' ? '{"relativePath":"scene.html","content":"' : '已收到的部分内容' };
        throw new UmiError('PROVIDER_INTERRUPTED', '测试断流', true);
      }
    }
    const model = new PartialModel([]);
    await fixture(model, async (app, id) => {
      const r = app.send(id, uid(), '创建场景');
      assert.equal((await app.wait(r.runId)).status, 'interrupted');
      assert.equal(model.requests.length, 1);
      assert.equal(app.store.tools(r.runId).length, 0);
      assert.equal(app.store.messages(id).filter(m => m.role === 'assistant' && m.modelAttemptId).length, 0);
      assert.equal(app.store.snapshot(id).blocks[0]?.status, 'interrupted');
    }, 2);
  });
}

test('真正无数据的请求以独立超时原因结束', async () => {
  class SilentModel extends ScriptModel {
    override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      this.requests.push(structuredClone(request));
      await delay(1000, undefined, { signal });
      throw new Error('不应到达');
    }
  }
  await fixture(new SilentModel([]), async (app, id) => {
    const r = app.send(id, uid(), '等待响应');
    assert.equal((await app.wait(r.runId)).status, 'interrupted');
    const failed = app.store.events(id).find(e => e.type === 'model.attempt_failed');
    assert.equal(failed?.type === 'model.attempt_failed' ? failed.payload.code : '', 'PROVIDER_TIMEOUT');
  });
});

test('SSE心跳维持活跃但不生成正文、思考或工具事实', async () => {
  let requests = 0;
  const transport: typeof fetch = async () => {
    requests++;
    let cancelled = false, count = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(30);
        if (cancelled) return;
        if (count++ < 8) controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        else { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); }
      }, cancel() { cancelled = true; },
    }));
  };
  await fixture(new DeepSeekAdapter(() => 'fixture-only', 'https://api.deepseek.com', transport), async (app, id) => {
    const r = app.send(id, uid(), '等候心跳');
    assert.equal((await app.wait(r.runId)).status, 'completed');
    assert.equal(requests, 1);
    assert.equal(app.store.snapshot(id).blocks.map(b => b.text).join(''), '完成');
    assert.equal(app.store.tools(r.runId).length, 0);
  });
});

test('部分输出后真正停流仅请求一次，页面显示原因且历史可重放', async () => {
  class StalledModel extends ScriptModel {
    override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      this.requests.push(structuredClone(request));
      yield { kind: 'delta', channel: 'text', key: 'text', text: '准备写入。' };
      await delay(1000, undefined, { signal });
      throw new Error('不应到达');
    }
  }
  const model = new StalledModel([]);
  await fixture(model, async (app, id) => {
    const r = app.send(id, uid(), '创建场景');
    assert.equal((await app.wait(r.runId)).status, 'interrupted');
    assert.equal(model.requests.length, 1);
    const snapshot = app.store.snapshot(id);
    assert.match(snapshot.runs[r.runId]!.reason!, /未收到数据/);
    assert.deepEqual(app.store.events(id).reduce(reduceConversation, initialState(id, snapshot.cursor.logEpoch)), snapshot);
    const html = renderToStaticMarkup(createElement(Timeline, { snapshot: new DesktopService(app).snapshot(id), onPreview: () => {}, onError: () => {} }));
    assert.match(html, /未收到数据/);
    assert.match(html, /准备写入/);
    assert.equal(app.store.tools(r.runId).length, 0);
  }, 2);
});

test('有持续心跳或分片时用户停止仍立即生效、不重试', async () => {
  class ActiveModel extends ScriptModel {
    override async *stream(request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      this.requests.push(structuredClone(request));
      while (true) {
        yield { kind: 'delta', channel: 'reasoning', key: 'reasoning', text: '进展' };
        await delay(30, undefined, { signal });
      }
    }
  }
  const model = new ActiveModel([]);
  await fixture(model, async (app, id) => {
    const r = app.send(id, uid(), '运行');
    await eventually(() => app.store.snapshot(id).blocks.length || undefined);
    await app.stop(id, r.runId);
    assert.equal(app.store.getRun(r.runId).status, 'stopped');
    assert.equal(model.requests.length, 1);
    assert.equal(app.store.snapshot(id).blocks[0]?.status, 'interrupted');
    assert.equal(app.store.tools(r.runId).length, 0);
  }, 2);
});

test('本地消费/落库耗时不算提供商空闲，提前结束会关闭模型迭代器', async () => {
  let closed = false;
  class Model extends ScriptModel {
    override async *stream(_request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      try {
        yield { kind: 'delta', channel: 'text', key: 'text', text: '一' };
        signal.throwIfAborted();
        yield { kind: 'delta', channel: 'text', key: 'text', text: '二' };
      } finally { closed = true; }
    }
  }
  const model = new Model([]), request = model.prepare([], [], settingsSchema.parse({}), 100);
  const stream = streamWithIdleTimeout(model, request, new AbortController().signal, 40);
  assert.equal((await stream.next()).value?.kind, 'delta');
  await delay(100);
  assert.equal((await stream.next()).value?.kind, 'delta');
  await stream.return(undefined);
  assert.equal(closed, true);
});
