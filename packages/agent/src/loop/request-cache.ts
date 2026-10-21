import { hash } from '../identity.js';
import type { PreparedRequest } from '../ports.js';

type MessageParts = { role: string; contentBytes: number; reasoningBytes: number; toolArgumentBytes: number; envelopeBytes: number };
type MessageShape = { chainHash: string; encodedChainHash: string; bytes: number; parts: MessageParts };
const encodedBytes = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
export type RequestCacheShape = {
  routeHash: string; configHash: string; toolsHash: string; leadingSystemHash: string;
  encodedConfigHash: string; encodedToolsHash: string; encodedLeadingSystemHash: string;
  messages: MessageShape[]; messageBytes: number; toolBytes: number;
};

// 只在诊断投影中忽略JSON对象键顺序，同时保留编码指纹；原请求、消息和字符串不变。
// 数组顺序、reasoning、图片和工具参数字符串仍精确比较，不猜供应商token或缓存命中。
export function requestCacheShape(request: PreparedRequest): RequestCacheShape | null {
  if (!Array.isArray(request.body.messages)) return null;
  const { messages, tools, ...config } = request.body;
  let chain = '', encodedChain = '', messageBytes = 0, leading = true;
  const system: unknown[] = [];
  const shapes = messages.map(message => {
    const encoded = JSON.stringify(message), bytes = Buffer.byteLength(encoded);
    messageBytes += bytes;
    chain = hash([chain, message]);
    encodedChain = hash(`${encodedChain}\n${encoded}`);
    if (leading && message?.role === 'system') system.push(message); else leading = false;
    const role = ['system', 'developer', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role as string : 'other';
    const contentBytes = encodedBytes(message?.content), reasoningBytes = encodedBytes(message?.reasoning_content);
    const toolArgumentBytes = Array.isArray(message?.tool_calls)
      ? message.tool_calls.reduce((n: number, call: any) => n + encodedBytes(call?.function?.arguments), 0) : 0;
    return { chainHash: chain, encodedChainHash: encodedChain, bytes, parts: { role, contentBytes, reasoningBytes, toolArgumentBytes,
      envelopeBytes: bytes - contentBytes - reasoningBytes - toolArgumentBytes } };
  });
  const encodedTools = JSON.stringify(tools ?? null);
  return {
    routeHash: hash(JSON.stringify([request.adapterId, request.adapterVersion, request.protocol, request.endpointProfileId, request.model])),
    configHash: hash(config), toolsHash: hash(tools ?? null), leadingSystemHash: hash(system),
    encodedConfigHash: hash(JSON.stringify(config)), encodedToolsHash: hash(encodedTools),
    encodedLeadingSystemHash: hash(JSON.stringify(system)), messages: shapes, messageBytes,
    toolBytes: Buffer.byteLength(encodedTools),
  };
}

export function compareRequestCache(current: RequestCacheShape | null, previous: RequestCacheShape | null) {
  if (!current) return { baseline: 'unavailable' as const, reasons: ['unsupported-encoded-messages'], leadingMessages: null, leadingBytes: null, firstChangedMessage: null, appendedBytes: null };
  if (!previous) return { baseline: 'none' as const, reasons: ['no-comparable-prior-request'], leadingMessages: null, leadingBytes: null, firstChangedMessage: null, appendedBytes: null };
  const reasons: string[] = [], encodingOnlyFields: string[] = [];
  // 规范化对象键可能来自持久层。单列这种变化，不把它叫历史内容改写。
  for (const [field, semantic, encoded] of [
    ['request-config', 'configHash', 'encodedConfigHash'],
    ['tools', 'toolsHash', 'encodedToolsHash'],
    ['leading-system', 'leadingSystemHash', 'encodedLeadingSystemHash'],
  ] as const) {
    if (current[semantic] === previous[semantic] && current[encoded] !== previous[encoded]) encodingOnlyFields.push(field);
  }
  if (current.routeHash !== previous.routeHash) reasons.push('route');
  if (current.configHash !== previous.configHash) reasons.push('request-config');
  if (current.toolsHash !== previous.toolsHash) reasons.push('tools');
  if (current.leadingSystemHash !== previous.leadingSystemHash) reasons.push('leading-system');
  let leadingMessages = 0, leadingBytes = 0;
  while (leadingMessages < Math.min(current.messages.length, previous.messages.length) &&
    current.messages[leadingMessages]!.chainHash === previous.messages[leadingMessages]!.chainHash) {
    leadingBytes += current.messages[leadingMessages]!.bytes; leadingMessages++;
  }
  let encodedLeadingMessages = 0;
  while (encodedLeadingMessages < Math.min(current.messages.length, previous.messages.length) &&
    current.messages[encodedLeadingMessages]!.encodedChainHash === previous.messages[encodedLeadingMessages]!.encodedChainHash) encodedLeadingMessages++;
  if (encodedLeadingMessages < leadingMessages) encodingOnlyFields.push('carried-messages');
  const rewritten = leadingMessages < Math.min(current.messages.length, previous.messages.length);
  if (rewritten) reasons.push('carried-message-rewritten');
  if (current.messages.length < previous.messages.length) reasons.push('messages-shortened');
  return { baseline: 'compared' as const, reasons, encodingOnlyFields, encodedLeadingMessages, leadingMessages, leadingBytes,
    firstChangedMessage: rewritten ? leadingMessages + 1 : null,
    appendedBytes: leadingMessages === previous.messages.length
      ? current.messages.slice(previous.messages.length).reduce((bytes, message) => bytes + message.bytes, 0) : null };
}

export function cacheUsage(value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const token = (key: string) => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : null;
  const hit = token('prompt_cache_hit_tokens'), miss = token('prompt_cache_miss_tokens');
  return { input: token('prompt_tokens'), output: token('completion_tokens'), hit, miss,
    hitRate: hit !== null && miss !== null && Number.isSafeInteger(hit + miss) && hit + miss > 0 ? hit / (hit + miss) : null };
}
// 用字段值相同的前缀定位新增/改写尾部；各项均为当前JSON编码字节，不冒充计费token或“无效工作”。
// 同样的43KB可能是必要编辑来源；内容类别与任务价值是不同的判断。
export function requestContentDelta(current: RequestCacheShape | null, comparison: ReturnType<typeof compareRequestCache>) {
  if (!current) return null;
  const start = comparison.leadingMessages ?? 0;
  const byRole: Record<string, { messages: number; bytes: number; contentBytes: number; reasoningBytes: number; toolArgumentBytes: number; envelopeBytes: number }> = {};
  for (const message of current.messages.slice(start)) {
    const row = byRole[message.parts.role] ??= { messages: 0, bytes: 0, contentBytes: 0, reasoningBytes: 0, toolArgumentBytes: 0, envelopeBytes: 0 };
    row.messages++; row.bytes += message.bytes;
    row.contentBytes += message.parts.contentBytes; row.reasoningBytes += message.parts.reasoningBytes;
    row.toolArgumentBytes += message.parts.toolArgumentBytes; row.envelopeBytes += message.parts.envelopeBytes;
  }
  return { basis: 'json-encoded-message-bytes',
    range: comparison.baseline !== 'compared' ? 'whole-request-without-baseline'
      : comparison.appendedBytes !== null ? 'appended-messages' : 'changed-tail',
    firstMessage: start < current.messages.length ? start + 1 : null,
    messages: current.messages.length - start,
    bytes: Object.values(byRole).reduce((n, row) => n + row.bytes, 0), byRole };
}