import { z } from 'zod';
import type {
  Settings,
  ToolSpec,
  WireMessage,
  ProviderCall,
} from '../../../protocol/src/model.js';
import { messageSchema, validatePairs, UmiError } from '../../../protocol/src/model.js';
import type { ModelPort, PreparedRequest, ModelFrame } from '../../../agent/src/ports.js';
import { readSse } from './sse.js';
import { ProviderChunkArchive, responseMemoryBytes } from './chunk-archive.js';

const chunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: z
        .object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                id: z.string().optional(),
                type: z.string().optional(),
                function: z
                  .object({
                    name: z.string().optional(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        })
        .optional(),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z.record(z.string(), z.unknown()).nullable().optional(),
});
export class DeepSeekAdapter implements ModelPort {
  private readonly baseUrl: string;
  constructor(
    private readonly apiKey: () => string,
    baseUrl = 'https://api.deepseek.com',
    private readonly transport: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' &&
      url.hostname !== '127.0.0.1' &&
      url.hostname !== 'localhost'
    )
      throw new UmiError('PROTOCOL_INVALID', '模型端点必须使用 HTTPS');
    if (url.username || url.password || url.search || url.hash)
      throw new UmiError('PROTOCOL_INVALID', '模型地址不可含凭据或查询参数');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  prepare(
    messages: WireMessage[],
    tools: ToolSpec[],
    settings: Settings,
    maxOutputTokens: number,
  ): PreparedRequest {
    validatePairs(messages);
    const names = new Set<string>();
    for (const tool of tools) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name))
        throw new UmiError('PROTOCOL_INVALID', '模型工具名称无效或重复');
      names.add(tool.name);
      // 整份工具表每轮都发送。单个规格错误也会让普通聊天收到 HTTP 400。
      if (tool.parameters.type !== 'object')
        throw new UmiError('PROTOCOL_INVALID', `工具 ${tool.name} 的模型参数根必须是 object`);
    }
    if (messages.some((m) => m.images?.length) && settings.model !== 'deepseek-flash')
      throw new UmiError('PROTOCOL_INVALID', '此模型不支持图片输入');
    const wire = messages.map((m) => {
      const copy = structuredClone(m);
      if (settings.thinking === 'off') delete copy.reasoning_content;
      else if (
        tools.length &&
        copy.role === 'assistant' &&
        copy.reasoning_content === undefined
      )
        copy.reasoning_content = '';
      const { images, ...textMessage } = copy;
      return images?.length
        ? {
            ...textMessage,
            content: [
              { type: 'text', text: copy.content },
              ...images.map((image) => ({
                type: 'image_url',
                image_url: { url: image.dataUrl },
              })),
            ],
          }
        : textMessage;
    });
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: wire,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxOutputTokens,
      thinking: { type: settings.thinking === 'off' ? 'disabled' : 'enabled' },
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 48 * 1024 * 1024)
      throw new UmiError(
        'PROTOCOL_INVALID',
        '图片历史使请求超过 48 MiB 传输上限，原记录未删除',
      );
    if (settings.thinking !== 'off')
      body.reasoning_effort = settings.thinking === 'normal' ? 'low' : 'high';
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
    return {
      adapterId: 'deepseek',
      adapterVersion: '1',
      protocol: 'chat-completions',
      endpointProfileId: this.baseUrl,
      model: settings.model,
      settings: structuredClone(settings),
      maxOutputTokens,
      body,
    };
  }
  async *stream(
    request: PreparedRequest,
    signal: AbortSignal,
    activity?: () => void,
  ): AsyncGenerator<ModelFrame> {
    if (request.adapterId !== 'deepseek' || request.endpointProfileId !== this.baseUrl)
      throw new UmiError('PROTOCOL_INVALID', '请求快照不属于当前适配器');
    const key = this.apiKey();
    if (!key) throw new UmiError('PROVIDER_CONFIG', '未配置 DEEPSEEK_API_KEY');
    const response = await this.transport(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(request.body),
      signal,
    });
    if (!response.ok) {
      // 不输出厂商错误原文，避免请求回显泄露资料或认证信息。
      await response.body?.cancel();
      const quota = response.status === 402 || response.status === 429;
      throw new UmiError(
        quota ? 'PROVIDER_QUOTA' : 'PROVIDER_HTTP',
        `模型接口返回 HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!response.body) throw new UmiError('PROTOCOL_INVALID', '模型未返回响应流');
    let content = '',
      reasoning = '',
      finish: string | null = null,
      usage: Record<string, unknown> | null = null,
      sawDone = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const raw = new ProviderChunkArchive();
    let outputBytes = 0;
    const observeOutput = (text: string | null | undefined) => {
      outputBytes += Buffer.byteLength(text ?? '');
      if (outputBytes > responseMemoryBytes)
        throw new UmiError('PROVIDER_RESOURCE_LIMIT', '单次模型响应的正文、思考与工具参数超过 64 MiB 内存容量；已显示内容保留，未完成工具未执行。');
    };
    for await (const data of readSse(response.body, signal, 2_000_000, activity)) {
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        throw new UmiError('PROTOCOL_INVALID', '模型事件不是合法 JSON');
      }
      const parsed = chunkSchema.safeParse(json);
      if (!parsed.success)
        throw new UmiError('PROTOCOL_INVALID', '模型分片结构不符合协议');
      const chunk = parsed.data;
      raw.append(json);
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices) {
        if (choice.index !== 0)
          throw new UmiError('PROTOCOL_INVALID', '当前仅支持一个响应候选');
        const d = choice.delta;
        observeOutput(d?.reasoning_content); observeOutput(d?.content);
        for (const part of d?.tool_calls ?? []) {
          observeOutput(part.function?.name); observeOutput(part.function?.arguments);
        }
        if (d?.reasoning_content) {
          reasoning += d.reasoning_content;
          yield {
            kind: 'delta',
            channel: 'reasoning',
            key: 'reasoning',
            text: d.reasoning_content,
          };
        }
        if (d?.content) {
          content += d.content;
          yield { kind: 'delta', channel: 'text', key: 'text', text: d.content };
        }
        for (const part of d?.tool_calls ?? []) {
          const t = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
          if (part.id) {
            if (!t.id) observeOutput(part.id);
            if (t.id && t.id !== part.id)
              throw new UmiError('PROTOCOL_INVALID', '工具调用身份中途改变');
            t.id = part.id;
          }
          if (part.function?.name) t.name += part.function.name;
          if (part.function?.arguments) {
            t.arguments += part.function.arguments;
            yield {
              kind: 'delta',
              channel: 'tool',
              key: `tool-${part.index}`,
              text: part.function.arguments,
            };
          }
          calls.set(part.index, t);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    if (!sawDone || !finish)
      throw new UmiError('PROVIDER_INTERRUPTED', '模型流未完整结束', true);
    if (!['stop', 'tool_calls', 'length'].includes(finish))
      throw new UmiError('PROVIDER_TRUNCATED', `模型响应未完整生成：${finish}`);
    const toolCalls: ProviderCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.arguments },
      }));
    if (finish !== 'length' && (
      toolCalls.some((t) => !t.id || !t.function.name) ||
      new Set(toolCalls.map((t) => t.id)).size !== toolCalls.length
    ))
      throw new UmiError('PROTOCOL_INVALID', '工具调用身份或名称不完整');
    if (finish !== 'length' && (finish === 'tool_calls') !== Boolean(toolCalls.length))
      throw new UmiError('PROTOCOL_INVALID', '结束原因与工具调用不一致');
    const message = messageSchema.parse({
      role: 'assistant',
      content,
      ...(reasoning || request.settings.thinking !== 'off'
        ? { reasoning_content: reasoning }
        : {}),
      ...(finish !== 'length' && toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    // 草稿不是工具调用；原始分片无损压缩，不拼接不同请求，不重复存储协议外壳。
    const archive = raw.finish();
    const responseRaw = finish === 'length'
      ? { kind: 'output-limit', draft: { content, toolCalls }, providerChunks: archive }
      : { kind: 'umi-provider-stream', archive };
    yield { kind: 'response', message, finishReason: finish, usage, raw: responseRaw };
  }
}
