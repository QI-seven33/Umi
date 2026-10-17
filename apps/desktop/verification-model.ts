import { setTimeout as delay } from 'node:timers/promises';
import type {
  ModelPort,
  PreparedRequest,
  ModelFrame,
} from '../../packages/agent/src/ports.js';
import type {
  WireMessage,
  Settings,
  ToolSpec,
} from '../../packages/protocol/src/model.js';
import { DeepSeekAdapter } from '../../packages/adapters/src/deepseek/adapter.js';
// 仅由主进程私有验收启动参数启用，替换模型端口；使用产品的同一循环、工具和 SQLite。
export class DesktopVerificationModel implements ModelPort {
  private adapter = new DeepSeekAdapter(() => '', 'https://api.deepseek.com');
  prepare(m: WireMessage[], t: ToolSpec[], s: Settings, n: number) {
    return this.adapter.prepare(m, t, s, n);
  }
  async *stream(
    request: PreparedRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ModelFrame> {
    const messages = request.body.messages as WireMessage[],
      lastUser = messages.findLastIndex((m) => m.role === 'user'),
      content = messages[lastUser]?.content as unknown,
      raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('')
            : '',
      settled = messages.slice(lastUser + 1).some((m) => m.role === 'tool');
    const final = !request.body.tools;
    let message: WireMessage;
    if (raw.includes('紧凑问答验证') && !settled) {
      message = { role: 'assistant', content: '请确认这两项偏好。', tool_calls: [{ id: 'question-check', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [
        { id: 'appearance', prompt: '你希望使用哪种界面风格？', options: [{ label: '简洁', description: '紧凑布局与轻量视觉。' }, { label: '宽松', description: '更大的留白。' }] },
        { id: 'detail', prompt: '报告需要哪些补充？', options: [{ label: '保留证据' }, { label: '只要结论' }] },
      ] }) } }] };
    } else if (raw.includes('交付卡片验证')) {
      const last = messages.filter((m) => m.role === 'tool').at(-1),
        result = last ? JSON.parse(last.content) : null,
        data = result?.data;
      const lastName = messages
        .filter((m) => m.role === 'assistant' && m.tool_calls?.length)
        .at(-1)?.tool_calls?.[0]?.function.name;
      const domains: Record<string, any> = {};
      for (const item of messages) {
        if (item.role === 'system' && item.content.startsWith('当前宿主事实按域更新；'))
          Object.assign(domains, JSON.parse(item.content.slice(item.content.indexOf('\n') + 1)));
      }
      const mountId = domains['runtime.resources'].mounts[0].mountId;
      let name: string | null;
      let args: Record<string, unknown> = {};
      switch (lastName) {
        case 'read_file':
          name = 'write_file';
          args = {
            mountId,
            path: 'delivery-preview.txt',
            content: '冻结预览正文。'.repeat(300),
            mode: 'replace',
            readExecutionId: data.readExecutionId,
            expectedReadHash: data.hash,
          };
          break;
        case 'write_file':
          name = 'build_changeset';
          args = { mountId };
          break;
        case 'build_changeset':
          if (data) {
            name = 'deliver_changeset';
            args = { changeSetId: data.changeSetId };
          } else {
            name = 'read_history';
            args = { messageId: result.messageId, byteLength: 512 };
          }
          break;
        case 'read_history':
          name = 'deliver_changeset';
          // 长变更集在活跃窗口中截断；从真实 read_history 片段取回头部定位。
          args = {
            changeSetId: data.text
              ?.replace(/\\"/g, '"')
              .match(/"changeSetId":"([a-f0-9-]+)"/)?.[1],
          };
          break;
        case 'deliver_changeset':
          name = null;
          break;
        default:
          name = 'read_file';
          args = { mountId, path: 'delivery-preview.txt', byteLength: 64000 };
      }
      message = name
        ? {
            role: 'assistant',
            content: '批准后将写回这份文件。',
            tool_calls: [
              {
                id: 'delivery-call',
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          }
        : { role: 'assistant', content: '文件交付完成，回执已核验。' };
    } else if (raw.includes('快速提交验证'))
      message = { role: 'assistant', content: '收到，附件已接收。' };
    else if (raw.startsWith('请阅读附件“长消息.txt”'))
      message = { role: 'assistant', content: '长消息附件已接收。' };
    else if (raw.includes('滚动验证'))
      message = {
        role: 'assistant',
        content: Array.from(
          { length: 80 },
          (_, i) => `这是第 ${i + 1} 段用于验证滚动位置的文本。`,
        ).join('\n\n'),
      };
    else if (final)
      message = { role: 'assistant', content: '任务结束，实际工具结果已核验。' };
    else if (settled)
      message = { role: 'assistant', content: '任务结束，实际工具结果已核验。' };
    else if (raw.includes('等待停止')) {
      yield { kind: 'delta', channel: 'text', key: 'text', text: '任务仍在运行。' };
      await delay(30000, undefined, { signal });
      message = { role: 'assistant', content: '任务仍在运行。' };
    } else
      message = {
        role: 'assistant',
        reasoning_content: '先核对目标并等待具体批准。',
        content: '我先准备这项操作。',
        tool_calls: [
          {
            id: 'verification-call',
            type: 'function',
            function: {
              name: raw.includes('验证命令') ? 'run_command' : 'write_scratch',
              arguments: JSON.stringify(
                raw.includes('验证命令')
                  ? {
                      program: 'node',
                      argv: ['-e', raw.includes('失败') ? "process.stderr.write('intentional-fixture-failure');process.exitCode=1" : "process.stdout.write('umi-electron-node')"],
                      cwd: { kind: 'task', area: 'scratch' },
                      timeoutMs: 10000,
                    }
                  : {
                      relativePath: 'desktop-check.txt',
                      content: 'Umi desktop verified',
                    },
              ),
            },
          },
        ],
      };
    if (message.reasoning_content)
      yield {
        kind: 'delta',
        channel: 'reasoning',
        key: 'reasoning',
        text: message.reasoning_content,
      };
    yield {
      kind: 'delta',
      channel: 'text',
      key: 'text',
      text: message.content.slice(0, 3),
    };
    await delay(20, undefined, { signal });
    yield { kind: 'delta', channel: 'text', key: 'text', text: message.content.slice(3) };
    for (const t of message.tool_calls ?? [])
      yield { kind: 'delta', channel: 'tool', key: t.id, text: t.function.arguments };
    yield {
      kind: 'response',
      message,
      finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
      raw: { verification: true, message },
      usage: { prompt_tokens: 32, completion_tokens: 24 },
    };
  }
}
