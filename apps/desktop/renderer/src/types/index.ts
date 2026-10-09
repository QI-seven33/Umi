import type {Settings} from '../../../../../packages/protocol/src/model.js';

// 本文件仅保留旧组件的显示参数；运行、工具和事件身份直接使用共享协议。
export type ThemeMode = 'light' | 'dark' | 'system';
export type ThinkingLevel = Settings['thinking'];
export type ExecutionPolicy = Settings['executionPolicy'];
export type ModelOption = {id:string;name:string;description:string;available:boolean;context_window?:number;
  capabilities:{vision:boolean;thinking:boolean;tools:boolean}};
export type WorkContextStats = {
  tokens:number;budget:number;context_window:number;output_reserved:number;safety_margin:number;
  summarized_messages:number;token_source:'estimated'|'provider';scope:'current_estimate'|'latest_request';
  cached?:boolean;includes_images?:boolean;images_omitted?:boolean;
};
export type Conversation = {id:string;workspaceId:string;title:string;messages:Message[];pinned?:boolean;updatedAt?:number|null};
export type Workspace = {workspaceId:string;name:string;path:string|null;mode:'work';worktreeRoot:string|null;createdAt:string|null};
export type Attachment = {id:string;name:string;size:number;progress:number;state:'selected'|'uploading'|'done'|'error';
  kind:'image'|'text'|'archive'|'other';file?:File;serverId?:string;previewUrl?:string;error?:string};
export type MessageAttachment = {id:string;name:string;size:number;kind:Attachment['kind'];previewUrl?:string};
export type Message = {id:string;messageId:string;role:'user'|'assistant';text:string;attachments?:MessageAttachment[];createdAt:number|null};
