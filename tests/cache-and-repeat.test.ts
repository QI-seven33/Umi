import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { UmiApplication } from '../apps/headless/src/application.js';
import { hostContext } from '../packages/adapters/src/host-files/scratch.js';
import { inspectRequestCache } from '../packages/adapters/src/sqlite/request-cache.js';
import { requestCacheShape, compareRequestCache, requestContentDelta, cacheUsage } from '../packages/agent/src/loop/request-cache.js';
import { changedCommandInputs } from '../packages/agent/src/tools/repeat-observation.js';
import { hash, uid } from '../packages/agent/src/identity.js';
import { processSnapshotSchema } from '../packages/protocol/src/process.js';
import { UmiError, settingsSchema, validatePairs } from '../packages/protocol/src/model.js';
import type { ExecutionContext } from '../packages/protocol/src/model.js';
import type { PreparedRequest, ModelFrame } from '../packages/agent/src/ports.js';
import { ScriptModel, call, text, removeTestRoot } from './fixtures.js';
import type { Step } from './fixtures.js';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(path = '') {
  const root = mkdtempSync(join(tmpdir(), 'umi-cache-repeat-')), steps: Step[] = [];
  const model = new ScriptModel(steps), app = new UmiApplication(join(root, 'data'), model);
  const c = app.createConversation(root), env = app.store.environment(c.environmentId);
  mkdirSync(join(env.root, 'task', 'scratch', path), { recursive: true });
  let executions = 0;
  app.registry.register({ name: 'check_fixture', description: '隔离命令，不创建真实子进程', schema: z.object({}).strict(), effect: 'host-code',
    prepare(input, current, id) { return { ...hostContext(input, current), process: processSnapshotSchema.parse({
      schemaVersion: 1, executionId: id!, leaseGeneration: app.store.getRun(app.store.tool(id!).run_id).generation,
      mode: 'direct', program: process.execPath, programIdentity: 'fixture-only', programHash: hash('fixture'), argv: [], commandLine: 'fixture',
      cwd: join(current.root, 'task', 'scratch', path), cwdIdentity: 'fixture-cwd', cwdObservation: 'root-identity',
      cwdRef: { kind: 'task', area: 'scratch', path }, env: {}, stdin: '', bridgeHash: hash('fixture'), timeoutMs: 1000, maxOutputBytes: 1024, scope: 'host-code-execution',
    }) }; },
    async execute() { executions++; return { outcome: 'succeeded', content: 'fixture check completed', data: null, mutated: false }; },
  });
  return { root, steps, model, app, c, get executions() { return executions; },
    async send(decision: 'allow' | 'deny' = 'allow') {
      const run = app.send(c.conversationId, uid(), '隔离的修改与复测');
      const controller = new AbortController();
      const approve = (async () => { while (!controller.signal.aborted) {
        for (const [id, a] of Object.entries(app.store.snapshot(c.conversationId).approvals)) if (a.status === 'pending') app.approve(c.conversationId, id, decision);
        await delay(5);
      } })();
      try { return { ...run, ...(await app.wait(run.runId)) }; } finally { controller.abort(); await approve; }
    }, async close() { await app.close(); removeTestRoot(root); } };
}
const check = () => call('check_fixture', {});
const write = (content: string, relativePath = 'source.txt') => call('write_scratch', { relativePath, content });

// 旧executor在第四次check前触发TASK_STALLED；新逻辑只豁免真实变更后的新一组计数。
test('重复边界：同目录文件多次修改后，同参数命令可复测且每次仍单独批准', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 4; i++) f.steps.push(write(`版本${i}`), check());
    f.steps.push(text('已复测'));
    const run = await f.send(); assert.equal(run.status, 'completed'); assert.equal(f.executions, 4);
    assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length, 8);
    validatePairs(f.app.store.messages(f.c.conversationId).map(m => m.payload));
  } finally { await f.close(); }
});

test('重复边界：命令退出和环境修订不算内容变化，第四次相同命令仍停止', async () => {
  const f = fixture(); try {
    f.steps.push(check(), check(), check(), check(), text('没有新输入，已受阻'));
    const run = await f.send(); assert.equal(run.status, 'failed'); assert.equal(f.executions, 3);
    assert.equal(f.app.store.tools(run.runId).at(-1)!.state, 'failed');
    assert.equal(f.app.store.snapshot(f.c.conversationId).runs[run.runId]!.code, 'TASK_STALLED');
  } finally { await f.close(); }
});

test('重复边界：同内容重写和工作目录外修改不能清零命令计数', async () => {
  for (const unrelated of [false, true]) {
    const f = fixture(unrelated ? 'project' : ''); try {
      f.steps.push(write('相同内容'), check(), check(), check(), write('相同内容', unrelated ? 'other.txt' : 'source.txt'), check(), text('受阻'));
      const run = await f.send(); assert.equal(run.status, 'failed'); assert.equal(f.executions, 3);
    } finally { await f.close(); }
  }
});

test('重复边界：修改只重置此前计数，之后三次无变化仍会停止', async () => {
  const f = fixture(); try {
    f.steps.push(check(), check(), check(), write('新内容'), check(), check(), check(), check(), text('受阻'));
    const run = await f.send(); assert.equal(run.status, 'failed'); assert.equal(f.executions, 6);
  } finally { await f.close(); }
});

test('重复边界：已经拒绝的相同命令不会因文件修改再次请求批准', async () => {
  const f = fixture(); try {
    f.steps.push(check(), text('已拒绝')); const first = await f.send('deny'); assert.equal(first.status, 'completed');
    // 同一个run的后续输入仍保持拒绝事实：直接用脚本阶段使拒绝和修改在一次run内发生。
    f.steps.push(check(), write('新内容'), check(), text('保留拒绝决定'));
    let firstCheck = true;
    const approve = f.app.approve.bind(f.app);
    f.app.approve = (...args) => { const approval = f.app.store.approval(args[1]); const tool = f.app.store.tool(approval.execution_id);
      return approve(args[0], args[1], tool.name === 'check_fixture' && firstCheck ? (firstCheck = false, 'deny') : args[2]); };
    const run = await f.send(); const tools = f.app.store.tools(run.runId);
    assert.equal(f.executions, 0); assert.deepEqual(tools.filter(t => t.name === 'check_fixture').map(t => t.state), ['denied', 'denied']);
    assert.equal(tools.filter(t => t.approval_id).length, 2);
  } finally { await f.close(); }
});

test('重复边界：未决宿主效果优先阻挡，新命令不能借内容变化自动重放', async () => {
  const f = fixture(); try {
    f.app.registry.register({ name: 'unknown_fixture', description: '丢失回执', schema: z.object({}).strict(), effect: 'host-code', prepare: hostContext,
      async execute() { throw new Error('lost receipt'); } });
    f.steps.push(write('变化'), call('unknown_fixture', {}));
    const first = await f.send(); assert.equal(first.status, 'recovery_required');
    f.steps.push(check(), text('仍待核验')); const next = await f.send();
    assert.equal(f.executions, 0); assert.equal(f.app.store.unresolvedEnvironment(f.c.environmentId).length, 1);
    const blocked = f.app.store.tools(next.runId).find(t => t.name === 'check_fixture')!;
    assert.equal(f.app.store.readArtifact<any>(blocked.result_ref!).data.code, 'TOOL_OUTCOME_UNKNOWN');
  } finally { await f.close(); }
});

test('变更观察：挂载working/子目录匹配，baseline、其它环境与无变化均不计', async () => {
  const f = fixture('project'); try {
    const env = f.app.store.environment(f.c.environmentId), base = hostContext({}, env);
    const command = { ...base, process: { cwdRef: { kind: 'mount', mountId: 'mount', path: 'project' } } } as ExecutionContext;
    const writeContext: ExecutionContext = { ...base, locations: [{ schemaVersion: 1, environmentId: env.id,
      rootRef: { kind: 'mount', mountId: 'mount', area: 'working', bindingVersion: 1 }, relativePath: 'project/a.txt', beforeHash: null, desiredHash: hash('new') }] };
    assert(changedCommandInputs(writeContext, command));
    assert(!changedCommandInputs({ ...writeContext, environmentId: 'other' }, command));
    assert(!changedCommandInputs({ ...writeContext, locations: [{ ...writeContext.locations[0]!, relativePath: 'project2/a.txt' }] }, command));
    assert(!changedCommandInputs({ ...writeContext, locations: [{ ...writeContext.locations[0]!, rootRef: { kind: 'mount', mountId: 'mount', area: 'baseline', bindingVersion: 1 } }] }, command));
    assert(!changedCommandInputs({ ...writeContext, locations: [{ ...writeContext.locations[0]!, beforeHash: hash('new') }] }, command));
  } finally { await f.close(); }
});

function prepared(): PreparedRequest {
  return { adapterId: 'fixture', adapterVersion: '1', protocol: 'chat', endpointProfileId: 'local', model: 'deepseek-flash', settings: settingsSchema.parse({}), maxOutputTokens: 100,
    body: { model: 'deepseek-flash', messages: [{ role: 'system', content: '稳定' }, { role: 'user', content: '输入' }], tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }] } };
}

test('缓存形状：尾部追加保留历史，思考、工具参数和图片表示的改写会定位首变消息', () => {
  const prior = prepared(); const next = structuredClone(prior);
  (next.body.messages as any[]).push({ role: 'assistant', content: '', reasoning_content: '原思考', tool_calls: [{ id: 'c', function: { arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: '结果' });
  const comparison = compareRequestCache(requestCacheShape(next), requestCacheShape(prior));
  assert.deepEqual(comparison.reasons, []); assert.equal(comparison.leadingMessages, 2); assert(comparison.appendedBytes! > 0);
  for (const mutate of [(m: any[]) => m[2].reasoning_content = '变更', (m: any[]) => m[2].tool_calls[0].function.arguments = '{"x":1}', (m: any[]) => m[1].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,changed' } }]]) {
    const changed = structuredClone(next); mutate(changed.body.messages as any[]);
    const result = compareRequestCache(requestCacheShape(changed), requestCacheShape(next));
    assert(result.reasons.includes('carried-message-rewritten')); assert.equal(result.appendedBytes, null); assert(result.firstChangedMessage! >= 2);
  }
});

test('缓存形状：工具顺序、路由、配置、system、窗口缩短分别归因，不解释服务端miss', () => {
  const old = prepared(); (old.body.tools as any[]).push({ type: 'function', function: { name: 'y' } });
  for (const [reason, mutate] of [
    ['tools', (r: PreparedRequest) => (r.body.tools as any[]).reverse()],
    ['route', (r: PreparedRequest) => r.endpointProfileId = 'other'],
    ['request-config', (r: PreparedRequest) => r.body.reasoning_effort = 'high'],
    ['leading-system', (r: PreparedRequest) => (r.body.messages as any[])[0].content = '新规则'],
    ['messages-shortened', (r: PreparedRequest) => (r.body.messages as any[]).pop()],
  ] as const) { const changed = structuredClone(old); mutate(changed); assert(compareRequestCache(requestCacheShape(changed), requestCacheShape(old)).reasons.includes(reason)); }
  assert.equal(compareRequestCache(requestCacheShape(old), null).baseline, 'none');
  assert.equal(requestCacheShape({ ...old, body: {} }), null);
  assert.equal(cacheUsage({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 }).hitRate, 0);
  assert.equal(cacheUsage({ prompt_cache_hit_tokens: 98 }).hitRate, null);
  assert.equal(cacheUsage({ prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 2 }).hit, null);
});

test('只读缓存报告：分页有前序比较，usage缺失保持未知，正文不输出，数据库不改', async () => {
  const f = fixture(); try {
    f.steps.push(call('search_history', { query: '私密测试正文' }), text('私密测试正文'));
    const run = await f.send(); assert.equal(run.status, 'completed');
    const other = f.app.createConversation(f.root);
    const database = String(f.app.store.db.prepare('PRAGMA database_list').get()!.file);
    await f.app.close(); const before = hash(readFileSync(database));
    const report = inspectRequestCache(database, f.c.conversationId, 1);
    assert.equal(report.schemaVersion, 3); assert.equal(report.rows.length, 1); assert.equal(report.rows[0]!.comparison.baseline, 'compared');
    assert.equal(report.rows[0]!.contentDelta?.range, 'appended-messages'); assert(report.rows[0]!.contentDelta!.byRole.tool!.bytes > 0);
    assert.deepEqual(report.rows[0]!.comparison.reasons, []); assert.equal(report.rows[0]!.attempts[0]!.hitRate, null);
    assert.equal(report.rows[0]!.attempts[0]!.input, 17); assert(!JSON.stringify(report).includes('私密测试正文'));
    assert(report.nextBefore); const older = inspectRequestCache(database, f.c.conversationId, 1, report.nextBefore);
    assert.equal(older.rows[0]!.comparison.baseline, 'none'); assert.equal(older.nextBefore, null);
    assert.equal(inspectRequestCache(database, other.conversationId).rows.length, 0);
    assert.throws(() => inspectRequestCache(database, 'missing'), /会话不存在/);
    assert.throws(() => inspectRequestCache(database, f.c.conversationId, 101));
    assert.equal(hash(readFileSync(database)), before);
    const missing = join(f.root, 'must-not-create.sqlite'); assert.throws(() => inspectRequestCache(missing, f.c.conversationId)); assert(!existsSync(missing));
  } finally { await f.close(); }
});
test('只读缓存报告：重试按尝试展示，未返回usage不补零，真实hit/miss准确保留', async () => {
  const f = fixture(); try {
    const original = f.model.stream.bind(f.model); let fail = true;
    f.model.stream = async function* (request: PreparedRequest, signal: AbortSignal): AsyncGenerator<ModelFrame> {
      if (fail) { fail = false; throw new UmiError('PROVIDER_HTTP', '隔离重试', true); }
      for await (const frame of original(request, signal)) yield frame.kind === 'response' ? { ...frame, usage: { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 98, prompt_cache_miss_tokens: 2 } } : frame;
    };
    f.steps.push(text('完成')); await f.send();
    const database = String(f.app.store.db.prepare('PRAGMA database_list').get()!.file);
    const report = inspectRequestCache(database, f.c.conversationId);
    assert.equal(report.rows.length, 1); const attempts = report.rows[0]!.attempts;
    assert.equal(attempts.length, 2); assert.equal(attempts[0]!.recorded, false); assert.equal(attempts[0]!.hit, null);
    assert.equal(attempts[1]!.recorded, true); assert.equal(attempts[1]!.hit, 98); assert.equal(attempts[1]!.miss, 2); assert.equal(attempts[1]!.hitRate, 0.98);
  } finally { await f.close(); }
});

test('只读缓存报告：损坏的冻结资料明确拒绝，不输出猜测结果', async () => {
  const f = fixture(); try {
    f.steps.push(text('完成')); await f.send();
    const database = String(f.app.store.db.prepare('PRAGMA database_list').get()!.file);
    await f.app.close();
    const db = new DatabaseSync(database);
    try { db.exec("DROP TRIGGER immutable_artifact; UPDATE artifacts SET content='{}' WHERE id IN(SELECT artifact_id FROM model_requests)"); }
    finally { db.close(); }
    assert.throws(() => inspectRequestCache(database, f.c.conversationId), /指纹不一致/);
  } finally { await f.close(); }
});
test('增量组成：只计新增尾部，JSON字节区分思考、工具参数、回执与信封', () => {
  const old = prepared(), next = structuredClone(old);
  const reasoning = '必要的推理🙂'.repeat(180), args = JSON.stringify({ command: '程序参数🙂'.repeat(80) });
  (next.body.messages as any[]).push({ role: 'assistant', content: '', reasoning_content: reasoning,
    tool_calls: [{ id: 'delta-call', type: 'function', function: { name: 'fixture', arguments: args } }] },
    { role: 'tool', tool_call_id: 'delta-call', content: JSON.stringify({ text: '真实回执🙂'.repeat(600) }) },
    { role: 'system', content: '状态变化' });
  const previous = requestCacheShape(old)!, current = requestCacheShape(next)!;
  const delta = requestContentDelta(current, compareRequestCache(current, previous))!;
  assert.equal(delta.range, 'appended-messages'); assert.equal(delta.firstMessage, 3); assert.equal(delta.messages, 3);
  assert.equal(delta.bytes, current.messageBytes - previous.messageBytes); assert.equal(delta.byRole.user, undefined);
  assert.equal(delta.byRole.assistant!.reasoningBytes, Buffer.byteLength(JSON.stringify(reasoning)));
  assert.equal(delta.byRole.assistant!.toolArgumentBytes, Buffer.byteLength(JSON.stringify(args)));
  assert(delta.byRole.tool!.contentBytes > 5000); assert(delta.byRole.assistant!.envelopeBytes > 0);
  for (const row of Object.values(delta.byRole)) assert.equal(row.bytes, row.contentBytes + row.reasoningBytes + row.toolArgumentBytes + row.envelopeBytes);
  assert(!JSON.stringify(delta).includes('必要的推理')); assert(!JSON.stringify(delta).includes('真实回执'));
});

test('增量组成：历史改写标记changed-tail，图片与未知角色不泄漏原文', () => {
  const old = prepared(), next = structuredClone(old), privateText = '诊断不得泄漏的图片内容';
  (next.body.messages as any[])[1] = { role: 'user', content: [{ type: 'image_url', image_url: { url: privateText } }] };
  (next.body.messages as any[]).push({ role: privateText, content: '不同协议的资料' });
  const current = requestCacheShape(next)!;
  const delta = requestContentDelta(current, compareRequestCache(current, requestCacheShape(old)))!;
  assert.equal(delta.range, 'changed-tail'); assert.equal(delta.firstMessage, 2); assert.equal(delta.messages, 2);
  assert(delta.byRole.user!.contentBytes > privateText.length); assert(delta.byRole.other);
  assert(!JSON.stringify(current).includes(privateText)); assert(!JSON.stringify(delta).includes(privateText));
});

test('增量组成：无基线标明整份请求，没有新消息与不支持编码分别表示', () => {
  const shape = requestCacheShape(prepared())!;
  const first = requestContentDelta(shape, compareRequestCache(shape, null))!;
  assert.equal(first.range, 'whole-request-without-baseline'); assert.equal(first.bytes, shape.messageBytes);
  const repeat = requestContentDelta(shape, compareRequestCache(shape, shape))!;
  assert.equal(repeat.bytes, 0); assert.equal(repeat.messages, 0); assert.equal(repeat.firstMessage, null); assert.deepEqual(repeat.byRole, {});
  assert.equal(requestContentDelta(null, compareRequestCache(null, shape)), null);
});
// 模拟artifact落盘后对象键被规范化：诊断投影可比较字段值，发送正文不能因此被重写。
function reverseObjectKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
  return value;
}
test('缓存诊断：持久化键序变化单列，历史字段相同且增量只含新消息', () => {
  const old = prepared();
  (old.body.messages as any[]).push({ role: 'assistant', content: '', reasoning_content: '保留原思考', tool_calls: [
    { id: 'c', type: 'function', function: { name: 'x', arguments: '{"a":1,"b":2}' } },
  ] });
  const next = reverseObjectKeys(old) as PreparedRequest;
  (next.body.messages as any[]).push({ role: 'tool', tool_call_id: 'c', content: '新增回执' });
  const before = JSON.stringify(next), shape = requestCacheShape(next)!, comparison = compareRequestCache(shape, requestCacheShape(old));
  assert.deepEqual(comparison.reasons, []);
  assert.deepEqual(comparison.encodingOnlyFields, ['tools', 'leading-system', 'carried-messages']);
  assert.equal(comparison.encodedLeadingMessages, 0); assert.equal(comparison.leadingMessages, 3);
  assert.equal(comparison.firstChangedMessage, null);
  const delta = requestContentDelta(shape, comparison)!;
  assert.equal(delta.range, 'appended-messages'); assert.equal(delta.messages, 1);
  assert.deepEqual(Object.keys(delta.byRole), ['tool']); assert.equal(delta.bytes, comparison.appendedBytes);
  assert.equal(JSON.stringify(next), before); // 比较不改变实际发送对象/字节。
});
test('缓存诊断：不解析字符串中的JSON、不忽略文本空白或数组顺序', () => {
  const old = prepared();
  (old.body.messages as any[]).push({ role: 'assistant', content: '', reasoning_content: '原文', tool_calls: [
    { id: 'c', type: 'function', function: { name: 'x', arguments: '{"a":1,"b":2}' } },
  ] });
  for (const mutate of [
    (m: any) => m.tool_calls[0].function.arguments = '{"b":2,"a":1}',
    (m: any) => m.reasoning_content += ' ',
    (m: any) => m.content = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  ]) {
    const changed = reverseObjectKeys(old) as PreparedRequest; mutate((changed.body.messages as any[])[2]);
    const result = compareRequestCache(requestCacheShape(changed), requestCacheShape(old));
    assert(result.reasons.includes('carried-message-rewritten')); assert.equal(result.firstChangedMessage, 3);
    assert.equal(result.leadingMessages, 2); assert.equal(result.appendedBytes, null);
  }
  const withParts = structuredClone(old); (withParts.body.messages as any[])[1].content = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  const changed = structuredClone(withParts); (changed.body.messages as any[])[1].content.reverse();
  assert.equal(compareRequestCache(requestCacheShape(changed), requestCacheShape(withParts)).firstChangedMessage, 2);
});
test('缓存诊断：请求配置仅换键序不误报，更换字段值仍能独立定位', () => {
  const old = prepared(); old.body.thinking = { type: 'enabled', budget: 100 };
  const next = reverseObjectKeys(old) as PreparedRequest;
  const equal = compareRequestCache(requestCacheShape(next), requestCacheShape(old));
  assert.deepEqual(equal.reasons, []); assert(equal.encodingOnlyFields?.includes('request-config'));
  const changed = structuredClone(next); (changed.body.thinking as any).budget = 200;
  const different = compareRequestCache(requestCacheShape(changed), requestCacheShape(old));
  assert(different.reasons.includes('request-config')); assert(!different.encodingOnlyFields?.includes('request-config'));
});
