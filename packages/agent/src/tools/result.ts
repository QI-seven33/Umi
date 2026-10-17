import { hash } from '../identity.js';
import type { ToolResult } from '../persistence.js';

// 正文只存一次；非重复的说明、退出事实和结构化字段仍保留。旧记录只在投影视图去重。
export function singleResultBody(result: ToolResult): ToolResult {
  if (result.data != null && typeof result.content === 'string') {
    try {
      if (hash(JSON.parse(result.content)) === hash(result.data))
        return { ...result, content: '' };
    } catch { /* 正常文本说明不做 JSON 去重。 */ }
  }
  return result;
}
export function modelToolContent(content: string) {
  try {
    const result = JSON.parse(content);
    if (result && typeof result === 'object' && typeof result.outcome === 'string') {
      const normalized = singleResultBody(result);
      if (normalized !== result) return JSON.stringify(normalized);
    }
  } catch { /* 非 JSON 反馈也是合法正文。 */ }
  return content;
}
