import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UmiApplication } from '../apps/headless/src/application.js';
import { DeepSeekAdapter } from '../packages/adapters/src/deepseek/adapter.js';
import { readSse } from '../packages/adapters/src/deepseek/sse.js';
import { expandProviderRaw, ProviderChunkArchive } from '../packages/adapters/src/deepseek/chunk-archive.js';
import { settingsSchema } from '../packages/protocol/src/model.js';
import { writeFileSchema } from '../packages/protocol/src/file-write.js';
import { uid } from '../packages/agent/src/identity.js';
import { removeTestRoot } from './fixtures.js';

const encoder = new TextEncoder(), signal = () => new AbortController().signal;
function bytesStream(bytes: Uint8Array, size = bytes.length) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(c) {
    if (offset >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.subarray(offset, offset + size)); offset += size;
  } });
}
async function collect(stream: AsyncIterable<string>) { const out = []; for await (const x of stream) out.push(x); return out; }
const sse = (delta: unknown, finish = 'stop') => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n';

test('SSE：同一网络块可包含总量超过事件容量的许多合法事件，结果不依赖分块', async () => {
  const events = Array.from({ length: 50 }, (_, i) => '中文🌱-' + i);
  const bytes = encoder.encode(events.map(e => 'data: ' + e + '\r\n\r\n').join(''));
  for (const size of [1, 11, bytes.length])
    assert.deepEqual(await collect(readSse(bytesStream(bytes, size), signal(), 16)), events);
});
test('SSE：UTF-8/CRLF边界与多行事件按实际事件容量判断，恶意长行仍拒绝', async () => {
  const exact = encoder.encode('data: 中文🌱\r\n\r\n');
  for (const size of [1, exact.length]) assert.deepEqual(await collect(readSse(bytesStream(exact, size), signal(), 10)), ['中文🌱']);
  assert.deepEqual(await collect(readSse(bytesStream(encoder.encode('data: ab\ndata: cd\n\n')), signal(), 5)), ['ab\ncd']);
  await assert.rejects(collect(readSse(bytesStream(encoder.encode('data: ab\ndata: cd\n\n')), signal(), 4)), /事件超过/);
  for (const text of ['data: ' + 'x'.repeat(100), ':' + 'x'.repeat(100) + '\n'])
    await assert.rejects(collect(readSse(bytesStream(encoder.encode(text), 3), signal(), 16)), /流式行超过/);
});
test('原始分片归档：完整字段/顺序无损，兼容旧格式与length草稿；超大展开不伪装截断', () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({ id: 'same-envelope', choices: [{ index: 0, delta: { content: '🌱' + i } }], custom: { i, nullValue: null } }));
  const collector = new ProviderChunkArchive(); for (const r of records) collector.append(r);
  const archive = collector.finish();
  assert(archive.blocks.length > 1);
  assert.deepEqual(expandProviderRaw({ kind: 'umi-provider-stream', archive }), records);
  const draft = { content: '保留正文', toolCalls: [] };
  assert.deepEqual(expandProviderRaw({ kind: 'output-limit', draft, providerChunks: archive }), { kind: 'output-limit', draft, providerChunks: records });
  assert.equal(expandProviderRaw(records), records);
  assert.throws(() => expandProviderRaw({ kind: 'umi-provider-stream', archive: { ...archive, eventCount: 1 } }), /计数不一致/);
  assert.throws(() => expandProviderRaw({ kind: 'umi-provider-stream', archive: { ...archive, decodedBytes: 129 * 1024 * 1024 } }), /整体展开/);
});

// 相同合法写入，一个字符/分片时协议外壳总量超过旧16MB。经真正适配器、循环、
// SQLite和文件工具落盘；不以模拟模型“说完成”代替文件字节与执行次数核对。
test('真实循环：细分片HTML超过旧传输总量仍只写一次；大网络块、原始资料与重启读取均可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-stream-capacity-')), source = join(root, 'source'); mkdirSync(source);
  const html = '<!doctype html><meta charset="utf-8"><title>island</title><canvas></canvas><!--' + 'scene-data-'.repeat(4500) + '-->';
  let mountId = '', requests = 0, transportBytes = 0, eventCount = 0;
  const transport: typeof fetch = async () => {
    if (++requests > 1) return new Response(sse({ content: '新版HTML已保存在工作副本，尚未交付或进行浏览器验收。' }));
    const args = JSON.stringify({ mountId, path: 'island.html', content: html });
    assert(writeFileSchema.safeParse(JSON.parse(args)).success);
    const events: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const raw = { id: 'chatcmpl-fragmentation-regression-20261022', object: 'chat.completion.chunk', created: 1792627200,
        model: 'deepseek-flash', system_fingerprint: 'repeat-envelope-is-not-task-output',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(i ? {} : { id: 'html-write', type: 'function' }), function: { ...(i ? {} : { name: 'write_file' }), arguments: args[i] } }] }, finish_reason: null }],
        provider_extension: { preserved: 'unknown-provider-field' } };
      events.push('data: ' + JSON.stringify(raw) + '\n\n'); eventCount++;
    }
    events.push('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 20000 } }) + '\n\ndata: [DONE]\n\n'); eventCount++;
    const bytes = encoder.encode(events.join('')); transportBytes = bytes.length;
    assert(transportBytes > 16_000_000);
    return new Response(bytesStream(bytes, 3_000_000));
  };
  const app = new UmiApplication(join(root, 'data'), new DeepSeekAdapter(() => 'offline-only', 'http://127.0.0.1:1', transport));
  let ref = '', stored = '';
  try {
    const c = app.createConversation(source, { thinking: 'normal' });
    const mount = app.files.repo.mounts(c.environmentId)[0]!; mountId = mount.id;
    const run = app.send(c.conversationId, uid(), '创建离线验收HTML，不向来源目录交付。');
    assert.equal((await app.wait(run.runId)).status, 'completed');
    assert.equal(requests, 2); assert.equal(app.store.tools(run.runId).length, 1);
    assert.equal(app.store.tools(run.runId)[0]!.state, 'succeeded');
    assert.equal(readFileSync(join(mount.root, 'island.html'), 'utf8'), html);
    assert(!existsSync(join(source, 'island.html')));
    const complete = app.store.events(c.conversationId).find(e => e.type === 'model.attempt_completed')!;
    assert.equal(complete.type, 'model.attempt_completed'); if (complete.type !== 'model.attempt_completed') return;
    ref = complete.payload.responseRef;
    const raw = app.store.readArtifact<any[]>(ref);
    assert.equal(raw.length, eventCount);
    assert.equal(raw[0].provider_extension.preserved, 'unknown-provider-field');
    assert.equal(raw.at(-1).usage.completion_tokens, 20000);
    assert.deepEqual(JSON.parse(raw.flatMap(r => r.choices[0]?.delta?.tool_calls?.map((t: any) => t.function.arguments) ?? []).join('')), { mountId, path: 'island.html', content: html });
    stored = app.store.get('SELECT content FROM artifacts WHERE id=?', ref)!.content as string;
    assert(Buffer.byteLength(stored) < transportBytes / 10);
    assert.equal(app.store.get('SELECT hash FROM artifacts WHERE id=?', ref) != null, true);
    console.log(JSON.stringify({ fileBytes: Buffer.byteLength(html), transportBytes, storedRawBytes: Buffer.byteLength(stored), eventCount, writes: 1 }));
    await app.close();
    const next = new UmiApplication(join(root, 'data'), new DeepSeekAdapter(() => 'unused', 'http://127.0.0.1:1', async () => { throw Error('禁止联网'); }));
    try { assert.equal(next.store.readArtifact<any[]>(ref).length, eventCount); assert.equal(readFileSync(join(mount.root, 'island.html'), 'utf8'), html); }
    finally { await next.close(); }
  } finally { await app.close(); removeTestRoot(root); }
});

test('响应原始归档不把缺DONE或身份漂移变成可执行工具', async () => {
  for (const body of [sse({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{}' } }] }, 'tool_calls').replace('data: [DONE]\n\n', ''),
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a"}]}}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"b"}]}}]}\n\n']) {
    const adapter = new DeepSeekAdapter(() => 'offline', 'http://127.0.0.1:1', async () => new Response(body));
    let completed = false;
    await assert.rejects(async () => { for await (const frame of adapter.stream(adapter.prepare([], [], settingsSchema.parse({}), 8192), signal())) if (frame.kind === 'response') completed = true; });
    assert.equal(completed, false);
  }
});
