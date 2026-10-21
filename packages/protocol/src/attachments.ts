import { z } from 'zod';
const ref=z.string().min(1).max(160),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const attachmentReadSchema=z.object({
  attachmentId:ref,startByte:z.number().int().nonnegative().optional(),
  byteLength:z.number().int().min(1).max(64000).optional(),
  startLine:z.number().int().positive().optional(),lineCount:z.number().int().min(1).max(1000).optional(),
  expectedHash:digest.optional(),
}).strict().refine(a=>a.startLine===undefined?a.lineCount===undefined:a.startByte===undefined,
  'startLine/lineCount和startByte互斥');
export const attachmentListSchema=z.object({
  query:z.string().max(180).optional(),offset:z.number().int().min(0).max(1_000_000).default(0),
  limit:z.number().int().min(1).max(20).default(10),
}).strict();
export const attachmentSearchSchema=z.object({
  attachmentId:ref,query:z.string().min(1).max(1000),expectedHash:digest.optional(),
  offset:z.number().int().min(0).max(1_000_000).default(0),limit:z.number().int().min(1).max(20).default(5),
}).strict();
export type AttachmentListInput=z.infer<typeof attachmentListSchema>;
export type AttachmentSearchInput=z.infer<typeof attachmentSearchSchema>;
export type AttachmentReadOptions=Pick<z.infer<typeof attachmentReadSchema>,'startLine'|'lineCount'|'expectedHash'>;
export type SentAttachment={id:string;name:string;mime:string;byteLength:number;messageId:string;createdAt:string};

// 文本载体不冒充容器解析；ASCII PDF也不能因能UTF-8解码就被当成已提取正文。
export function attachmentTextProblem(text:string):string|null{
  if(/^%PDF-\d\.\d/.test(text))return 'PDF尚未接入文档解析；请先导出文本，或在明确获准的处理工具中提取，不能把PDF文件语法当正文';
  if(/[\x00-\x08\x0e-\x1f]/.test(text))return '此文件不是支持的纯文本；其他二进制文档尚未接入';
  for(let i=0;i<text.length;i++){
    const unit=text.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return '附件包含无效Unicode，未静默替换';}
    else if(unit>=0xdc00&&unit<=0xdfff)return '附件包含无效Unicode，未静默替换';
  }
  return null;
}

// Office入口只接收原字节；模型仍复用附件检索工具，不接收容器或任意宿主路径。
export const OFFICE_MAX_BYTES=8*1024*1024;
export const OFFICE_MAX_BASE64=Math.ceil(OFFICE_MAX_BYTES/3)*4;
export const officeMime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as const;
export type OfficeFormat=keyof typeof officeMime;
export const officeUploadSchema=z.object({name:z.string().min(1).max(180),format:z.enum(['docx','xlsx']),base64:z.string().min(1).max(OFFICE_MAX_BASE64)}).strict();
export const officeDescriptorSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('office-document'),format:z.enum(['docx','xlsx']),
  original:z.object({artifactRef:ref,hash:digest,byteLength:z.number().int().min(1).max(OFFICE_MAX_BYTES)}).strict(),
  extraction:z.object({artifactRef:ref,hash:digest,byteLength:z.number().int().nonnegative().max(2*1024*1024),version:z.string().min(1).max(80),units:z.number().int().nonnegative(),coverage:z.string().max(2000)}).strict(),
}).strict();
