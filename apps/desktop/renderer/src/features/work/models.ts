import type {ModelOption,ThinkingLevel} from '../../types/index.js';

export const THINKING_LABELS:Record<ThinkingLevel,string>={off:'Off',normal:'Normal',high:'High'};

// 显示产品版本，调用仍使用官方 API 路由 ID。核对日期：2026-10-18。
// https://api-docs.deepseek.com/updates/（2026-10-17 Flash 升级，API ID 不变）
// 日期是官方公告中的版本号，不是可调用或锁定该快照的新 API ID；Pro 继续提供 0813 版本。
export const MODEL_OPTIONS:ModelOption[]=[
  {id:'deepseek-flash',name:'DeepSeek-V4.1-Flash-1017',description:'支持文字、图片与工具调用',available:true,capabilities:{vision:true,thinking:true,tools:true}},
  {id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro-0813',description:'支持文字、推理与工具调用',available:true,capabilities:{vision:false,thinking:true,tools:true}},
];
