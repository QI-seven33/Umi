import {OFFICE_MAX_BYTES,attachmentTextProblem} from '../../../../../../packages/protocol/src/attachments.js';
import {userFacingError} from '../../ui-error.js';
import {useEffect,useRef,useState} from 'react';
import type {Attachment} from '../../types/index.js';

export const MAX_ATTACHMENTS=8;
export const MAX_ATTACHMENT_BYTES=1_000_000;
export function officeFormat(name:string){return /\.docx$/i.test(name)?'docx' as const:/\.xlsx$/i.test(name)?'xlsx' as const:null;}
export async function encodeOfficeAttachment(file:File){
  const format=officeFormat(file.name);if(!format)throw Error('目前文档附件支持DOCX、XLSX；PDF、旧DOC/XLS请先导出文本');
  if(!file.size||file.size>OFFICE_MAX_BYTES)throw Error('Office附件须为非空文件且不能超过8 MiB');
  const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {format,base64:btoa(binary)};
}
// 以内容解码判断文本，不把没有后缀的文件和其他源码后缀误判为二进制。
export async function decodeAttachment(file:File):Promise<string>{
  if(file.size>MAX_ATTACHMENT_BYTES)throw Error('文本附件不能超过 1 MB');
  const bytes=new Uint8Array(await file.arrayBuffer());
  let encoding='utf-8';
  if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';
  else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
  let text:string;
  try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw Error('此文件不是 UTF-8 或 UTF-16 文本；请上传文本或 PNG、JPEG、GIF、WebP 图片');}
  const problem=attachmentTextProblem(text);if(problem)throw Error(problem);
  if(new TextEncoder().encode(text).byteLength>MAX_ATTACHMENT_BYTES)throw Error('转为 UTF-8 后附件超过 1 MB');
  return text;
}
export function insertPlainText(value:string,start:number,end:number,text:string){return {value:value.slice(0,start)+text+value.slice(end),caret:start+text.length};}

export function useAttachments(conversationId:string,onError:(e:unknown)=>void){
  const [attachments,setState]=useState<Attachment[]>([]);
  const rows=useRef<Attachment[]>([]),scope=useRef({id:conversationId,token:0});
  const replace=(next:Attachment[])=>{rows.current=next;setState(next);};
  useEffect(()=>{
    scope.current={id:conversationId,token:scope.current.token+1};const current=scope.current;replace([]);
    if(!conversationId)return;
    try{const pending=JSON.parse(localStorage.getItem('umi.pending.'+conversationId)??'null');
      if(Array.isArray(pending?.attachments)){
        const ids=pending.attachments.slice(0,8).filter((id:unknown):id is string=>typeof id==='string');
        replace(ids.map((id:string)=>({id,serverId:id,name:'正在恢复附件…',size:0,state:'uploading',progress:0,kind:'text'})));
        for(const id of ids)void window.umi.request({type:'preview_attachment',conversationId,attachmentId:id}).then(data=>{
          if(scope.current!==current)return;const a=data as {id:string;name:string;totalBytes:number;originalBytes?:number;mime?:string;dataUrl?:string};
          replace(rows.current.map(row=>row.id===id?{...row,name:a.name,size:a.originalBytes??a.totalBytes,state:'done',progress:100,kind:a.dataUrl?'image':officeFormat(a.name)?'other':'text',...(a.dataUrl?{previewUrl:a.dataUrl}:{})}:row));
        }).catch(error=>{if(scope.current!==current)return;replace(rows.current.map(row=>row.id===id?{...row,state:'error',error:'附件未能恢复'}:row));onError(error);});
      }
    }catch{}
  },[conversationId]);
  const remove=(id:string)=>replace(rows.current.filter(a=>a.id!==id));
  const consume=(ids:string[])=>replace(rows.current.filter(a=>!ids.includes(a.serverId??a.id)));
  const addFiles=async(files:FileList|File[])=>{
    if(!conversationId||scope.current.id!==conversationId)return [];
    const current=scope.current,available=MAX_ATTACHMENTS-rows.current.length,list=Array.from(files);
    if(list.length>available)onError(Error('每条消息最多添加 8 个附件'));
    const selected=list.slice(0,available).map(file=>({id:crypto.randomUUID(),name:file.name,size:file.size,file,state:'uploading' as const,progress:0,kind:(/^image\//.test(file.type)||/\.(png|jpe?g|gif|webp)$/i.test(file.name)?'image':officeFormat(file.name)?'other':'text') as Attachment['kind']}));
    replace([...rows.current,...selected]); // 在异步读取前保留名额，防止多次粘贴越过上限。
    for(const item of selected){
      try{
        if(scope.current!==current||!rows.current.some(a=>a.id===item.id))continue;
        let uploaded:{id:string;byteLength:number};let previewUrl:string|undefined;
        if(item.kind==='image'){
          if(item.file.size>MAX_ATTACHMENT_BYTES)throw Error('单张图片不能超过 1 MB');
          let bitmap:ImageBitmap;try{bitmap=await createImageBitmap(item.file);}catch{throw Error('图片无法解码，请使用 PNG、JPEG、GIF 或 WebP');}
          const {width,height}=bitmap;bitmap.close();if(width>4096||height>4096)throw Error('图片长边不能超过 4096 像素，请缩小后添加');
          previewUrl=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(item.file);});
          if(scope.current!==current||!rows.current.some(a=>a.id===item.id))continue;
          uploaded=await window.umi.request({type:'upload_image',conversationId,name:item.name,base64:previewUrl.slice(previewUrl.indexOf(',')+1)}) as {id:string;byteLength:number};
        }else if(officeFormat(item.name)){
          const document=await encodeOfficeAttachment(item.file);
          if(scope.current!==current||!rows.current.some(a=>a.id===item.id))continue;
          uploaded=await window.umi.request({type:'upload_document',conversationId,name:item.name,...document}) as {id:string;byteLength:number};
        }else{
          const text=await decodeAttachment(item.file),mime=/\.md$/i.test(item.name)?'text/markdown':/\.json$/i.test(item.name)?'application/json':/\.csv$/i.test(item.name)?'text/csv':'text/plain';
          if(scope.current!==current||!rows.current.some(a=>a.id===item.id))continue;
          uploaded=await window.umi.request({type:'upload_attachment',conversationId,name:item.name,mime,text}) as {id:string;byteLength:number};
        }
        if(scope.current!==current)continue;
        replace(rows.current.map(a=>a.id===item.id?{...a,serverId:uploaded.id,size:uploaded.byteLength,state:'done',progress:100,...(previewUrl?{previewUrl}:{})}:a));
      }catch(error){if(scope.current!==current)continue;const message=userFacingError(error)||'附件回执暂未返回，请稍后重试。';replace(rows.current.map(a=>a.id===item.id?{...a,state:'error',error:message}:a));onError(error);}
    }
    return rows.current.filter(row=>selected.some(item=>item.id===row.id));
  };
  return {attachments,addFiles,remove,consume};
}
