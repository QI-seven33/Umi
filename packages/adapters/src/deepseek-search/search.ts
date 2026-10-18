import { z } from 'zod';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import type { ToolResult } from '../../../agent/src/persistence.js';
import { searchResponseSchema, searchView, SEARCH_ARCHIVE_BYTES } from '../../../agent/src/tools/web-search.js';
import type { WebSearchArchive, SearchSnapshot } from '../../../agent/src/tools/web-search.js';
import { canonical } from '../../../agent/src/identity.js';
import { hostContext } from '../host-files/scratch.js';
import { publicWebUrl } from './fetch.js';
import { UmiError } from '../../../protocol/src/model.js';

async function searchJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new UmiError('WEB_SEARCH_INVALID', '搜索响应为空');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > SEARCH_ARCHIVE_BYTES) throw new UmiError('WEB_SEARCH_TOO_LARGE', '搜索响应超过 4 MiB，未建立完整快照');
      chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new UmiError('WEB_SEARCH_INVALID', '搜索响应不是合法 UTF-8 JSON'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export function registerWebSearch(registry: ToolRegistry, archive: WebSearchArchive, key: () => string,
  baseUrl = 'https://api.deepseek.com', transport: typeof fetch = fetch) {
  const endpoint = new URL(baseUrl);
  if ((endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new UmiError('PROTOCOL_INVALID', '搜索端点必须为不含凭据的 HTTPS 地址');
  const schema = z.object({
    query: z.string().regex(/^[\s\S]{1,128}$/u, '搜索词限 1～128 个 Unicode 字符')
      .refine(value => Array.from(value).length <= 128 && Boolean(value.trim()), '搜索词须非空且不超过128个Unicode字符').describe('1～128 个 Unicode 字符，保留 site:/引号/日期等搜索语法，不自动截断'),
    count: z.number().int().min(1).max(10).default(5),
  }).strict();
  registry.register({
    // 唯一网页搜索入口，直接取得结构化结果；不再额外调用模型包装。
    name: 'search_web',
    description: '直接调用 DeepSeek Search 查找实时公开网页，query 限128个Unicode字符，count默认5最多10。只回传有界摘要和结构化来源，完整搜索回执另存 snapshotId，可用 read_artifact 分页补读。精确事实/例外请 fetch_webpage 核对页面，评分不是事实证明。空结果是正常无命中；调用计次收费，无自动重试。',
    schema, effect: 'network',
    prepare(input, env, executionId) {
      schema.parse(input);
      if (!executionId) throw new UmiError('PROTOCOL_INVALID', '搜索缺少执行身份');
      return { ...hostContext(input, env), webReadExecutionId: executionId };
    },
    async execute(input, context, _cid, signal): Promise<ToolResult> {
      signal.throwIfAborted();
      const args = schema.parse(input), executionId = context.webReadExecutionId, secret = key();
      if (!executionId) throw new UmiError('PROTOCOL_INVALID', '搜索执行身份缺失');
      if (!secret) throw new UmiError('PROVIDER_CONFIG', '未配置 DeepSeek 搜索凭据');
      const combined = AbortSignal.any([signal, AbortSignal.timeout(30000)]), start = performance.now();
      const failed = (code: string, content: string, httpStatus: number | null = null, retryable = false): ToolResult => ({
        outcome: 'failed', content, data: { provider: 'deepseek-search', query: args.query, code, httpStatus, retryable,
          execution_status: 'failed', evidence_status: 'unavailable', sources: [], networkRequests: 1,
          billingStatus: '以提供商结算为准', latency_ms: Math.round(performance.now() - start) } });
      try {
        const response = await transport(baseUrl.replace(/\/$/, '') + '/v1/tools/search', {
          method: 'POST', signal: combined, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
          body: JSON.stringify({ query: args.query, count: args.count, need_content: false }),
        });
        combined.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel();
          const messages: Record<number, string> = {
            400: '搜索参数被接口拒绝，请检查搜索词长度或语法', 401: 'DeepSeek 搜索凭据无效', 402: 'DeepSeek 余额不足',
            403: '提供商拒绝搜索请求', 404: '搜索接口不存在', 408: '搜索请求超时',
            413: '搜索请求过大', 429: '搜索受到账号限流',
          };
          return failed('WEB_SEARCH_HTTP_' + response.status, messages[response.status] ?? '搜索接口返回 HTTP ' + response.status,
            response.status, [408,429].includes(response.status) || response.status >= 500);
        }
        const parsed = searchResponseSchema.safeParse(await searchJson(response, combined));
        if (!parsed.success) return failed('WEB_SEARCH_INVALID', '搜索响应缺少有效结构化结果，未建立快照', response.status);
        // 不把认证链接或本地地址当成可继续抓取的公开网页。
        for (const result of parsed.data.results) publicWebUrl(result.url);
        const snapshot: SearchSnapshot = { version: 1, provider: 'deepseek-search', query: args.query,
          retrievedAt: new Date().toISOString(), response: parsed.data };
        if (Buffer.byteLength(canonical(snapshot)) > SEARCH_ARCHIVE_BYTES)
          return failed('WEB_SEARCH_TOO_LARGE', '完整搜索回执超过 4 MiB，未建立快照', response.status);
        signal.throwIfAborted();
        const snapshotId = archive.save(executionId, snapshot);
        return { outcome: 'succeeded', content: '', data: { ...searchView(snapshotId, snapshot, args.count),
          networkRequests: 1, latency_ms: Math.round(performance.now() - start) } };
      } catch (error) {
        signal.throwIfAborted();
        if (combined.aborted) return failed('WEB_SEARCH_TIMEOUT', '搜索超过 30 秒，未自动重试；是否计费以提供商为准', null, true);
        if (error instanceof UmiError) return failed(error.code, error.message);
        return failed('WEB_SEARCH_NETWORK', '搜索网络或响应读取失败，未自动重试', null, true);
      }
    },
  });
}
