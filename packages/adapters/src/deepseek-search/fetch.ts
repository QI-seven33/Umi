import { isIP } from 'node:net';
import { z } from 'zod';
import { UmiError } from '../../../protocol/src/model.js';
import { hash } from '../../../agent/src/identity.js';
import type { ToolResult } from '../../../agent/src/persistence.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import type { WebPageArchive, WebPageSnapshot } from '../../../agent/src/tools/webpage.js';
import { webPageView, WEB_TEXT_LIMIT } from '../../../agent/src/tools/webpage.js';
import { hostContext } from '../host-files/scratch.js';

export const WEB_RESPONSE_LIMIT = 4 * 1024 * 1024;
// 这里只验证明显的非公开目标；实际抓取在提供商侧，不声称能观测 DNS/跳转或隔离宿主网络。
export function publicWebUrl(value: string): string {
  if (value.length > 8192) throw new UmiError('WEB_URL_INVALID', '网页地址超过 8192 字符');
  let url: URL;
  try { url = new URL(value); } catch { throw new UmiError('WEB_URL_INVALID', '网页地址无效'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new UmiError('WEB_URL_INVALID', '只读取无内嵌凭据的公开 HTTP/HTTPS 网页');
  const ip = isIP(host), octets = host.split('.').map(Number);
  const privateV4 = ip === 4 && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) || octets[0]! >= 224);
  const privateV6 = ip === 6 && (host === '::' || host === '::1' || /^(?:fc|fd|fe[89ab])/i.test(host) || host.startsWith('::ffff:') || host.startsWith('ff'));
  if (!host || (!ip && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host))) || privateV4 || privateV6)
    throw new UmiError('WEB_URL_PRIVATE', '此工具只读取公开网页，不向提供商发送本地或内网地址');
  if ([...url.searchParams.keys()].some(key => /^(?:password|access_token|api_key|x-amz-signature|x-goog-signature)$/i.test(key)))
    throw new UmiError('WEB_URL_CREDENTIALS', '网址含认证或签名参数，请提供公开链接');
  url.hash = '';
  if (url.href.length > 8192) throw new UmiError('WEB_URL_INVALID', '编码后的网页地址超过 8192 字符');
  return url.href;
}

async function fetchJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new UmiError('WEB_FETCH_INVALID', '网页抓取响应为空');
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > WEB_RESPONSE_LIMIT) throw new UmiError('WEB_FETCH_TOO_LARGE', '网页响应超过 4 MiB，未建立完整快照；不要当作已读全文');
      parts.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
    catch { throw new UmiError('WEB_FETCH_INVALID', '网页抓取响应不是合法 UTF-8 JSON'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export function registerWebFetch(registry: ToolRegistry, archive: WebPageArchive,
  key: () => string, baseUrl = 'https://api.deepseek.com', transport: typeof fetch = fetch) {
  const endpoint = new URL(baseUrl);
  if ((endpoint.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname)) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new UmiError('PROTOCOL_INVALID', '网页抓取端点必须为不含凭据的 HTTPS 地址');
  const schema = z.object({ url: z.string().min(1).max(8192), refresh: z.boolean().default(false) }).strict();
  registry.register({
    name: 'fetch_webpage',
    description: '通过 DeepSeek Fetch 读取指定公开 URL 并保存提供商返回的完整 Markdown 快照；不带浏览器登录/Cookie，不执行网页脚本。首次仅展示 8 KiB 摘录与目录，截断不表示正文丢失；用 read_webpage 的 find 在完整快照定位或按字节续读，勿根据首段声称全文没有某事实。同一轮默认复用成功快照，refresh=true 明确重新联网。不能证明原网页完整或视觉排版。',
    schema, effect: 'network',
    prepare(input, env, executionId) {
      publicWebUrl(schema.parse(input).url);
      if (!executionId) throw new UmiError('PROTOCOL_INVALID', '网页抓取缺少执行身份');
      return { ...hostContext(input, env), webReadExecutionId: executionId };
    },
    async execute(input, context, _cid, signal): Promise<ToolResult> {
      signal.throwIfAborted();
      const args = schema.parse(input), requestedUrl = publicWebUrl(args.url), executionId = context.webReadExecutionId;
      if (!executionId) throw new UmiError('PROTOCOL_INVALID', '网页抓取执行身份缺失');
      if (!args.refresh) {
        const cached = archive.cached(executionId, requestedUrl);
        if (cached) return { outcome: 'succeeded', content: '', data: {
          ...webPageView(cached.snapshotId, cached.page, 0, undefined, true), cacheHit: true, networkRequests: 0 } };
      }
      const secret = key();
      if (!secret) throw new UmiError('PROVIDER_CONFIG', '未配置 DeepSeek 网页抓取凭据');
      const combined = AbortSignal.any([signal, AbortSignal.timeout(30000)]), started = performance.now();
      const failed = (code: string, content: string, httpStatus: number | null = null, retryable = false): ToolResult => ({
        outcome: 'failed', content, data: { provider: 'deepseek-fetch', requestedUrl, code, httpStatus, retryable,
          networkRequests: 1, billingStatus: '以提供商结算为准', latency_ms: Math.round(performance.now() - started) } });
      try {
        const response = await transport(`${baseUrl.replace(/\/$/, '')}/v1/tools/fetch`, {
          method: 'POST', signal: combined, redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ url: requestedUrl }),
        });
        combined.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel();
          const messages: Record<number,string> = {
            400: '网页抓取参数被接口拒绝', 401: 'DeepSeek 抓取凭据无效', 402: 'DeepSeek 余额不足',
            403: '提供商拒绝访问该网页', 404: '提供商未能取得可用正文；不等于目标网页一定不存在',
            408: '网页抓取请求超时', 413: '网页抓取请求过大', 429: '网页抓取受到账号或目标域名限流',
          };
          return failed(`WEB_FETCH_HTTP_${response.status}`, messages[response.status] ?? `网页抓取接口返回 HTTP ${response.status}`,
            response.status, [408,429].includes(response.status) || response.status >= 500);
        }
        const parsed = z.object({ title: z.string(), content: z.string() }).safeParse(await fetchJson(response, combined));
        if (!parsed.success) return failed('WEB_FETCH_INVALID', '网页抓取响应缺少有效标题/正文结构', response.status);
        if (!parsed.data.content.trim()) return failed('WEB_FETCH_EMPTY', '提供商未返回可用正文，未建立快照', response.status);
        if (Buffer.byteLength(parsed.data.content) > WEB_TEXT_LIMIT || Buffer.byteLength(parsed.data.title) > 8192)
          return failed('WEB_FETCH_TOO_LARGE', 'Markdown 正文超过 2 MiB 或标题过大，未建立完整快照；不要当作已读全文', response.status);
        const page: WebPageSnapshot = { version: 1, provider: 'deepseek-fetch', requestedUrl,
          title: parsed.data.title, content: parsed.data.content, retrievedAt: new Date().toISOString(), contentHash: hash(parsed.data.content) };
        signal.throwIfAborted();
        const snapshotId = archive.save(executionId, page);
        return { outcome: 'succeeded', content: '', data: { ...webPageView(snapshotId, page, 0, undefined, true),
          cacheHit: false, networkRequests: 1, latency_ms: Math.round(performance.now() - started) } };
      } catch (error) {
        signal.throwIfAborted();
        if (combined.aborted) return failed('WEB_FETCH_TIMEOUT', '网页抓取超过 30 秒，未自动重试；是否计费以提供商为准', null, true);
        if (error instanceof UmiError) return failed(error.code, error.message);
        return failed('WEB_FETCH_NETWORK', '网页抓取网络或响应读取失败，未自动重试', null, true);
      }
    },
  });
}