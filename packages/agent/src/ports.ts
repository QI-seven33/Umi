import type {
  Settings,
  WireMessage,
  ToolSpec,
  ProviderCall,
} from '../../protocol/src/model.js';

export type PreparedRequest = {
  adapterId: string;
  adapterVersion: string;
  protocol: string;
  endpointProfileId: string;
  model: string;
  settings: Settings;
  maxOutputTokens: number;
  body: Record<string, unknown>;
};
export type ModelFrame =
  | { kind: 'delta'; channel: 'reasoning' | 'text' | 'tool'; key: string; text: string }
  | {
      kind: 'response';
      message: WireMessage;
      finishReason: string;
      usage: Record<string, unknown> | null;
      raw: unknown;
    };
export interface ModelPort {
  prepare(
    messages: WireMessage[],
    tools: ToolSpec[],
    settings: Settings,
    maxOutputTokens: number,
  ): PreparedRequest;
  // activity 只报告真实传输数据（含心跳），不生成对话或执行事实。
  stream(request: PreparedRequest, signal: AbortSignal, activity?: () => void): AsyncIterable<ModelFrame>;
}
export type ModelResponse = {
  message: WireMessage;
  calls: ProviderCall[];
  finishReason: string;
};
export interface EnvironmentInitializer {
  initialize(environmentId: string): void;
}
