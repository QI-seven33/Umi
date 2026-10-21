import {fromBufferPromise,type Entry} from 'yauzl';
import {crc32} from 'node:zlib';
import {SaxesParser,type SaxesTagNS} from 'saxes';
import {setImmediate} from 'node:timers/promises';
import {UmiError} from '../../../protocol/src/model.js';

export const invalid=(message:string):never=>{throw new UmiError('DOCUMENT_INVALID',message);};
export const limit=(message:string):never=>{throw new UmiError('DOCUMENT_LIMIT',message);};
const MAX_XML=8*1024*1024,MAX_SELECTED=16*1024*1024;
// 只读内存包；不把ZIP条目解压到磁盘，不跟随关系URL，不运行Office或宏。
export async function officeArchive(bytes:Buffer,signal:AbortSignal){
  const zip=await fromBufferPromise(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true});
  const entries=new Map<string,Entry>();let declared=0,selected=0;
  try{
    if(zip.entryCount>1024)limit('文档超过1024个包条目');
    for await(const entry of zip.eachEntry()){
      signal.throwIfAborted();const name=entry.fileName;
      if(entries.has(name)||name.includes('\0')||name.split('/').some(p=>p==='.'||p==='..'))invalid('文档包含重复或不安全条目');
      if(entry.isEncrypted())invalid('不支持加密文档');
      if(/vbaProject\.bin$/i.test(name))invalid('不支持含宏文档');
      declared+=entry.uncompressedSize;if(!Number.isSafeInteger(declared)||declared>64*1024*1024)limit('文档声明解压体积超过64 MiB');
      entries.set(name,entry);
    }
  }catch(error){zip.close();throw error;}
  return {
    has:(name:string)=>entries.has(name),
    close:()=>zip.close(),
    async read(name:string):Promise<Buffer>{
      signal.throwIfAborted();const entry=entries.get(name);if(!entry)invalid('文档缺少部件：'+name);
      if(entry!.uncompressedSize>MAX_XML)limit('单个XML部件超过8 MiB');
      const stream=await zip.openReadStreamPromise(entry!);const chunks:Buffer[]=[];let size=0,crc=0;
      const abort=()=>stream.destroy(new UmiError('DOCUMENT_CANCELLED','文档提取超时或已取消'));
      signal.addEventListener('abort',abort,{once:true});
      try{
        signal.throwIfAborted();
        for await(const chunk of stream){
          signal.throwIfAborted();const b=Buffer.from(chunk);size+=b.length;selected+=b.length;
          if(size>MAX_XML||selected>MAX_SELECTED)limit('文档实际提取XML超过体积预算');
          crc=crc32(b,crc);chunks.push(b);
        }
        if(size!==entry!.uncompressedSize||crc!==entry!.crc32)invalid('文档部件长度或CRC不一致');
        return Buffer.concat(chunks,size);
      }finally{signal.removeEventListener('abort',abort);stream.destroy();}
    },
  };
}
export type XmlTag=SaxesTagNS;
export const attribute=(tag:XmlTag,name:string)=>tag.attributes[name]?.value;
export const relationshipId=(tag:XmlTag)=>Object.values(tag.attributes).find(a=>a.local==='id'&&
  /^https?:\/\/(schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships$/.test(a.uri))?.value;

// 解析器拒绝DTD；分块让出worker事件循环，超时可生效。XML只产生数据，不解释指令。
export async function xml(bytes:Buffer,signal:AbortSignal,handlers:{open?:(t:XmlTag)=>void;close?:(t:XmlTag)=>void;text?:(s:string)=>void}){
  let encoding='utf-8';if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
  let text:string;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{invalid('文档XML编码损坏或不支持');}
  const parser=new SaxesParser({xmlns:true});let depth=0,nodes=0;
  parser.on('error',error=>{throw error;});parser.on('doctype',()=>invalid('文档XML不允许DTD或外部实体'));
  parser.on('opentag',tag=>{if(++depth>128||++nodes>500000)limit('文档XML层级或节点数超过预算');handlers.open?.(tag);});
  parser.on('closetag',tag=>{handlers.close?.(tag);depth--;});parser.on('text',s=>handlers.text?.(s));parser.on('cdata',s=>handlers.text?.(s));
  for(let offset=0;offset<text!.length;offset+=8192){signal.throwIfAborted();parser.write(text!.slice(offset,offset+8192));if(offset%131072===0)await setImmediate();}
  parser.close();signal.throwIfAborted();
}
