import {createHash} from 'node:crypto';
import {officeUploadSchema,officeDescriptorSchema,officeMime} from '../../../protocol/src/attachments.js';
import {uid} from '../../../agent/src/identity.js';
import type { SqliteStore } from './store.js';
import { UmiError } from '../../../protocol/src/model.js';
import { attachmentListSchema,attachmentSearchSchema } from '../../../protocol/src/attachments.js';
import type { SentAttachment,AttachmentReadOptions } from '../../../protocol/src/attachments.js';
import { attachmentTextPage,attachmentTextSearch } from './attachment-text.js';

export class AttachmentRepository{
  constructor(private readonly store:SqliteStore){}
  async uploadDocument(conversationId:string,input:unknown){
    this.store.conversation(conversationId);const a=officeUploadSchema.parse(input);
    if(/[\\/\x00-\x1f]/.test(a.name)||!a.name.toLowerCase().endsWith('.'+a.format))throw new UmiError('PROTOCOL_INVALID','Office附件名称或后缀无效');
    const bytes=Buffer.from(a.base64,'base64');if(bytes.toString('base64')!==a.base64)throw new UmiError('PROTOCOL_INVALID','Office附件base64不规范');
    // 解析依赖按需加载，普通启动和文本/图片附件不加载Office读取器。
    const {extractOfficeDocument}=await import('../documents/office-documents.js');
    const extracted=await extractOfficeDocument(a.format,bytes);
    // 异步提取结束再次核对会话；删除/失败不留下半套原件和派生资料。
    return this.store.transaction(()=>{
      this.store.conversation(conversationId);
      const old=this.store.get(`SELECT a.artifact_ref FROM attachments a JOIN artifacts r ON r.id=a.artifact_ref
        WHERE a.conversation_id=? AND r.kind='attachment-document' AND json_extract(r.content,'$.format')=?
        AND json_extract(r.content,'$.original.hash')=? AND json_extract(r.content,'$.extraction.version')=? LIMIT 1`,
        conversationId,a.format,extracted.originalHash,extracted.version);
      const descriptor=old?String(old.artifact_ref):this.store.artifact({schemaVersion:1,kind:'office-document',format:a.format,
        original:{artifactRef:this.store.artifact({base64:a.base64},'attachment-original'),hash:extracted.originalHash,byteLength:bytes.length},
        extraction:{artifactRef:this.store.artifact({text:extracted.text},'attachment-extracted'),hash:extracted.hash,
          byteLength:Buffer.byteLength(extracted.text),version:extracted.version,units:extracted.units,coverage:extracted.coverage},
      },'attachment-document');
      const id=uid(),mime=officeMime[a.format];this.store.run('INSERT INTO attachments VALUES(?,?,?,?,?,?)',id,conversationId,a.name,mime,bytes.length,descriptor);
      return {id,name:a.name,mime,byteLength:bytes.length,extraction:{version:extracted.version,coverage:extracted.coverage}};
    });
  }
  private text(row:ReturnType<SqliteStore['attachment']>){
    const value=this.store.readArtifact<{text?:string;kind?:string}>(String(row.artifact_ref));
    if(value.kind==='office-document'){
      const descriptor=officeDescriptorSchema.parse(value);
      if(officeMime[descriptor.format]!==row.mime||descriptor.original.byteLength!==Number(row.byte_length))throw new UmiError('PROTOCOL_INVALID','附件原件元数据不一致');
      const text=this.store.readArtifact<{text:string}>(descriptor.extraction.artifactRef).text;
      if(typeof text!=='string'||Buffer.byteLength(text)!==descriptor.extraction.byteLength||createHash('sha256').update(text).digest('hex')!==descriptor.extraction.hash)
        throw new UmiError('PROTOCOL_INVALID','附件提取文本指纹不一致');
      const {artifactRef,...extraction}=descriptor.extraction;
      return {text,metadata:{kind:'document' as const,originalHash:descriptor.original.hash,originalBytes:descriptor.original.byteLength,extraction,
        sourceNote:'本地提取文本，非Office版式预览。'+extraction.coverage}};
    }
    if(typeof value.text!=='string')throw new UmiError('PROTOCOL_INVALID','附件没有可用文本');
    return {text:value.text,metadata:{}};
  }
  // 草稿仅允许当前会话用户预览；模型目录/搜索/读取必须另过已发送且已应用的来源检查。
  sent(conversationId:string,id:string):SentAttachment{
    const row=this.store.get(`SELECT a.id,a.name,a.mime,a.byte_length byteLength,m.id messageId,m.created_at createdAt
      FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id
      WHERE a.conversation_id=? AND m.conversation_id=? AND a.id=? AND m.applied=1 AND m.role='user'`,conversationId,conversationId,id);
    if(!row)throw new UmiError('PERMISSION_DENIED','附件尚未由用户发送并应用到当前会话');
    return row as unknown as SentAttachment;
  }
  list(conversationId:string,input:unknown){
    this.store.conversation(conversationId);const a=attachmentListSchema.parse(input);
    const where="a.conversation_id=? AND m.conversation_id=? AND m.applied=1 AND m.role='user' AND instr(a.name,?)>0",args=[conversationId,conversationId,a.query??''];
    const rows=this.store.all(`SELECT a.id,a.name,a.mime,a.byte_length byteLength,m.id messageId,m.created_at createdAt
      FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id
      WHERE ${where} ORDER BY m.rowid,a.rowid LIMIT ? OFFSET ?`,...args,a.limit,a.offset) as unknown as SentAttachment[];
    const total=this.store.get(`SELECT count(*) n FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id
      JOIN messages m ON m.id=ma.message_id WHERE ${where}`,...args)!.n as number;
    return {entries:rows,total,offset:a.offset,nextOffset:a.offset+rows.length<total?a.offset+rows.length:null,
      coverage:'本会话已发送且已应用的附件元数据；不读取正文、不包括草稿，query为文件名区分大小写的字面包含'};
  }
  read(conversationId:string,id:string,startByte=0,byteLength=8192,options:AttachmentReadOptions={}){
    const a=this.store.attachment(conversationId,id);
    if(String(a.mime).startsWith('image/'))return {id,name:a.name,mime:a.mime,totalBytes:Number(a.byte_length),kind:'image' as const,
      text:'这是图片附件，Flash通过原用户消息的图片块读取，不能按文本字节/行读取；不提供OCR文本。',truncated:false,nextStartByte:null};
    const {text,metadata}=this.text(a);
    return {id,name:a.name,mime:a.mime,...attachmentTextPage(text,startByte,byteLength,options),...metadata};
  }
  search(conversationId:string,input:unknown){
    const a=attachmentSearchSchema.parse(input),source=this.sent(conversationId,a.attachmentId),row=this.store.attachment(conversationId,a.attachmentId);
    if(source.mime.startsWith('image/'))throw new UmiError('ATTACHMENT_NOT_TEXT','图片没有可搜索文本；请使用支持图片的模型查看，不以空搜索冒充未命中');
    const {text,metadata}=this.text(row);
    return {id:source.id,name:source.name,mime:source.mime,messageId:source.messageId,...attachmentTextSearch(text,a.query,a.offset,a.limit,a.expectedHash),...metadata};
  }
}
