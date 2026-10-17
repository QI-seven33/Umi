import { z } from 'zod';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { hostContext } from '../host-files/scratch.js';
import type { ToolResult } from '../../../agent/src/persistence.js';
import { UmiError } from '../../../protocol/src/model.js';

export function registerWebSearch(
  registry: ToolRegistry,
  key: () => string,
  baseUrl = 'https://api.deepseek.com',
  transport: typeof fetch = fetch,
) {
  const endpoint = new URL(baseUrl);
  if (
    (endpoint.protocol !== 'https:' &&
      endpoint.hostname !== 'localhost' &&
      endpoint.hostname !== '127.0.0.1') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new UmiError('PROTOCOL_INVALID', '搜索端点必须为不含凭据的 HTTPS 地址');
  const schema = z.object({ query: z.string().min(1).max(6000) }).strict();
  registry.register({
    name: 'deepseek_server_web_search',
    description:
      '通过 DeepSeek 已接入的 Anthropic 兼容接口联网搜索实时公开资料，只有取得结构化网页来源才确认有搜索证据。',
    schema,
    effect: 'network',
    prepare: hostContext,
    async execute(input, _context, _conversationId, signal): Promise<ToolResult> {
      const { query } = schema.parse(input),
        start = performance.now();
      if (!key()) throw new UmiError('PROVIDER_CONFIG', '未配置 DeepSeek 搜索凭据');
      const resp = await transport(
        `${baseUrl.replace(/\/$/, '')}/anthropic/v1/messages`,
        {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key(),
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'deepseek-flash',
            max_tokens: 2048,
            system:
              '只依据联网搜索返回的网页资料回答。保留关键事实和来源 URL；查不到就说明查不到。',
            messages: [{ role: 'user', content: query }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
          }),
        },
      );
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new UmiError(
          resp.status === 429 || resp.status === 402 ? 'PROVIDER_QUOTA' : 'SEARCH_HTTP',
          `搜索接口返回 HTTP ${resp.status}`,
        );
      }
      if (!resp.body) throw new UmiError('PROTOCOL_INVALID', '搜索响应为空');
      const reader = resp.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const abort = () => {
        void reader.cancel(signal.reason).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2_000_000)
            throw new UmiError('PROTOCOL_INVALID', '搜索响应超过大小限制');
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let response: { content?: unknown; usage?: unknown };
      try {
        response = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        ) as typeof response;
      } catch {
        throw new UmiError('PROTOCOL_INVALID', '搜索响应不是合法 UTF-8 JSON');
      }
      if (!Array.isArray(response.content))
        throw new UmiError('PROTOCOL_INVALID', '搜索响应缺少内容块');
      const texts: string[] = [],
        sources: { url: string; title: string | null }[] = [],
        seen = new Set<string>();
      for (const value of response.content) {
        const b = value as { type?: string; text?: unknown; content?: unknown };
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim())
          texts.push(b.text.trim());
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
          for (const value of b.content) {
            const r = value as { type?: string; url?: unknown; title?: unknown };
            if (
              r.type === 'web_search_result' &&
              typeof r.url === 'string' &&
              /^https?:\/\//.test(r.url) &&
              !seen.has(r.url)
            ) {
              seen.add(r.url);
              sources.push({
                url: r.url,
                title: typeof r.title === 'string' ? r.title : null,
              });
            }
          }
      }
      const verified = Boolean(texts.length && sources.length),
        data = {
          provider: 'deepseek_server',
          query,
          execution_status: verified ? 'succeeded' : 'failed',
          evidence_status: sources.length ? 'found' : 'empty',
          sources,
          error_code: verified ? null : 'NO_VERIFIED_WEB_RESULT',
          latency_ms: Math.round(performance.now() - start),
          usage: response.usage ?? null,
        };
      return {
        outcome: verified ? 'succeeded' : 'failed',
        content: verified
          ? `${texts.join('\n')}\n来源：\n${sources.map((s) => s.url).join('\n')}`
          : '搜索未取得可核验网页结果。',
        data,
      };
    },
  });
}
