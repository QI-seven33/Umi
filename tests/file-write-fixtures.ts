import { call } from './fixtures.js';
import type { Step } from './fixtures.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';
import { uid } from '../packages/agent/src/identity.js';

// 旧交付场景迁移到真实 read_file → 显式 replace；不伪造回执或绕过产品派发。
export function replaceFilesSteps(
  mount: (r: PreparedRequest) => string,
  changes: [string, string][],
): Step[] {
  let mountId = '';
  return [
    (r) => {
      mountId = mount(r);
      const calls = changes.map(
        ([path]) =>
          call(
            'read_file',
            { mountId, path, byteLength: 64000 },
            '先完整读取副本。',
            uid(),
          ).tool_calls![0]!,
      );
      return { role: 'assistant', content: '读取要替换的副本文件。', tool_calls: calls };
    },
    (r) => {
      const messages = r.body.messages as { role: string; content: string }[];
      const results = messages
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(m.content));
      const calls = changes.map(([path, content]) => {
        const read = results.findLast(
          (result) =>
            result.outcome === 'succeeded' &&
            result.data?.readExecutionId &&
            result.data.mountId === mountId &&
            result.data.path === path,
        )?.data;
        if (!read) throw new Error('测试流程未取得真实读取回执：' + path);
        return call(
          'write_file',
          {
            mountId,
            path,
            content,
            mode: 'replace',
            readExecutionId: read.readExecutionId,
            expectedReadHash: read.hash,
          },
          '绑定已读取版本替换副本。',
          uid(),
        ).tool_calls![0]!;
      });
      return {
        role: 'assistant',
        content: '显式替换已读取的副本版本。',
        tool_calls: calls,
      };
    },
  ];
}
export function replaceFileSteps(
  mount: (r: PreparedRequest) => string,
  path: string,
  content: string,
) {
  return replaceFilesSteps(mount, [[path, content]]);
}
