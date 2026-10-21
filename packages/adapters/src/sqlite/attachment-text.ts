import { createHash } from 'node:crypto';
import { UmiError } from '../../../protocol/src/model.js';
import type { AttachmentReadOptions } from '../../../protocol/src/attachments.js';

function source(text:string,expectedHash?:string){
  const bytes=Buffer.from(text,'utf8');
  if(bytes.toString('utf8')!==text)throw new UmiError('PROTOCOL_INVALID','附件原文含无效Unicode，未静默替换');
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(expectedHash&&expectedHash!==hash)throw new UmiError('RESOURCE_CHANGED','附件内容hash与指定版本不符，请核对attachmentId');
  // 末尾换行不额外制造一个空行；空附件为0行。索引只在按需读取/搜索中创建。
  const lines=bytes.length?[0]:[];
  for(let i=0;i<bytes.length;i++)if(bytes[i]===10&&i+1<bytes.length)lines.push(i+1);
  return {bytes,hash,lines};
}
function lineAt(lines:number[],position:number){
  let lo=0,hi=lines.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(lines[mid]!<=position)lo=mid+1;else hi=mid;}
  return Math.max(1,lo);
}
function endBoundary(bytes:Buffer,end:number){while(end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--;return end;}
function startBoundary(bytes:Buffer,start:number){while(start<bytes.length&&(bytes[start]!&0xc0)===0x80)start++;return start;}
export function attachmentTextPage(text:string,startByte:number,byteLength:number,options:AttachmentReadOptions={}){
  if(!Number.isInteger(startByte)||startByte<0||!Number.isInteger(byteLength)||byteLength<1||byteLength>64000)
    throw new UmiError('PROTOCOL_INVALID','附件读取范围无效');
  const {bytes,hash,lines}=source(text,options.expectedHash);
  let start=Math.min(startByte,bytes.length),desiredEnd=bytes.length;
  if(options.startLine!==undefined){
    const count=options.lineCount??200;
    if(!Number.isInteger(options.startLine)||options.startLine<1||!Number.isInteger(count)||count<1||count>1000)
      throw new UmiError('PROTOCOL_INVALID','附件行范围无效');
    start=lines[options.startLine-1]??bytes.length;
    desiredEnd=lines[options.startLine-1+count]??bytes.length;
  }else if(options.lineCount!==undefined)throw new UmiError('PROTOCOL_INVALID','lineCount必须与startLine一起使用');
  if(start<bytes.length&&(bytes[start]!&0xc0)===0x80)throw new UmiError('PROTOCOL_INVALID','读取起点切开 UTF-8 字符');
  const end=endBoundary(bytes,Math.min(desiredEnd,start+byteLength));
  if(start<bytes.length&&end===start)throw new UmiError('ATTACHMENT_RANGE_TOO_SMALL','byteLength不足以容纳一个完整UTF-8字符；请至少使用4字节，不要原位反复读取');
  const hasMore=end<bytes.length;
  return {kind:'text' as const,encoding:'utf-8',hash,startByte:start,endByte:end,totalBytes:bytes.length,
    totalLines:lines.length,startLine:lineAt(lines,start),endLine:end>start?lineAt(lines,end-1):lineAt(lines,start)-1,
    startsMidLine:start>0&&bytes[start-1]!==10,endsMidLine:hasMore&&end>0&&bytes[end-1]!==10,
    truncated:hasMore,nextStartByte:hasMore?end:null,nextLine:hasMore?lineAt(lines,end):null,
    text:bytes.subarray(start,end).toString('utf8'),coverage:'仅此UTF-8字节范围；行读取遇长行仍可截断，按nextStartByte/hash续读，不代表已读全文'};
}
export function attachmentTextSearch(text:string,query:string,offset:number,limit:number,expectedHash?:string){
  if(!query||query.length>1000||Buffer.from(query).toString('utf8')!==query||!Number.isInteger(offset)||offset<0||offset>1_000_000||!Number.isInteger(limit)||limit<1||limit>20)
    throw new UmiError('PROTOCOL_INVALID','附件搜索参数无效');
  const {bytes,hash,lines}=source(text,expectedHash),needle=Buffer.from(query);
  const matches:{matchStartByte:number;matchEndByte:number;line:number;startByte:number;endByte:number;text:string}[]=[];
  let position=0,count=0,hasMore=false;
  while(position<=bytes.length-needle.length){
    const found=bytes.indexOf(needle,position);if(found<0)break;position=found+1;
    if(count++<offset)continue;
    if(matches.length===limit){hasMore=true;break;}
    const start=startBoundary(bytes,Math.max(0,found-160)),end=endBoundary(bytes,Math.min(bytes.length,found+needle.length+160));
    matches.push({matchStartByte:found,matchEndByte:found+needle.length,line:lineAt(lines,found),startByte:start,endByte:end,text:bytes.subarray(start,end).toString('utf8')});
  }
  return {kind:'text' as const,encoding:'utf-8',hash,query,caseSensitive:true,literal:true,totalBytes:bytes.length,totalLines:lines.length,
    matches,offset,nextOffset:hasMore?offset+matches.length:null,hasMore,totalMatches:hasMore?null:count,totalMatchesLowerBound:count,totalExact:!hasMore,
    coverage:hasMore?'本页命中摘录，后续命中未展示；不是附件全文':'字面搜索已到末尾；命中摘录仍不是附件全文，不证明没有同义表述'};
}
