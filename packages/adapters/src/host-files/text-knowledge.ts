import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { TextFileReadReceipt } from '../../../protocol/src/file-edit.js';
import { writeFileSchema } from '../../../protocol/src/file-write.js';
import { bytesHash } from './paths.js';
import { requireTextRead } from './read-evidence.js';
import type { FileReadEvidencePort } from './read-evidence.js';

export type KnownRange = { startByte: number; endByte: number };
export type TextSource = { receipt: TextFileReadReceipt; resultRef: string };
type Target = { mountId: string; path: string; expectedReadHash?: string | undefined;
  readExecutionId?: string | undefined; readExecutionIds?: string[] | undefined };

export function mergeKnownRanges(ranges: KnownRange[]): KnownRange[] {
  const merged: KnownRange[] = [];
  for (const range of [...ranges].sort((a,b)=>a.startByte-b.startByte)) {
    const last=merged.at(-1);
    if(last && range.startByte<=last.endByte) last.endByte=Math.max(last.endByte,range.endByte);
    else merged.push({...range});
  }
  return merged;
}

// 已见范围随精确编辑平移；替换的新字节由本次模型参数提供，不扩张到未读原文。
export function editedKnownRanges(sources: TextSource[], edits: {startByte:number;oldByteLength:number;newByteLength:number}[]) {
  const shift=(position:number)=>edits.reduce((sum,e)=>sum+(e.startByte+e.oldByteLength<=position?e.newByteLength-e.oldByteLength:0),0);
  return mergeKnownRanges(sources.map(s=>s.receipt)).map(r=>({startByte:r.startByte+shift(r.startByte),endByte:r.endByte+shift(r.endByte)}));
}

// 从现有不可变执行事实取依据。返回临时内存视图，不创建虚构 read_file 或追加模型消息。
export function textSources(reads: FileReadEvidencePort, a: Target, ctx: ExecutionContext,
  conversationId: string, bytes: Buffer): TextSource[] {
  const ids=a.readExecutionIds??(a.readExecutionId?[a.readExecutionId]:undefined);
  if(ids) return ids.map(readExecutionId=>{
    const saved=reads.read(readExecutionId)?.result.data as {hash?:unknown}|undefined;
    return requireTextRead(reads,{mountId:a.mountId,path:a.path,readExecutionId,
      expectedReadHash:a.expectedReadHash??(typeof saved?.hash==='string'?saved.hash:'')},ctx.environmentId,conversationId);
  });
  const loc=ctx.locations[0]!, hash=bytesHash(bytes);
  if(hash!==loc.beforeHash || (a.expectedReadHash && a.expectedReadHash!==hash))
    throw new UmiError('READ_STALE','当前文件版本与已知哈希不同；请读取需要修改的范围。');
  const sources:TextSource[]=[];
  for(const id of reads.find(ctx.environmentId,a.mountId,a.path)) {
    const e=reads.read(id);
    if(!e || e.conversationId!==conversationId || e.tool.environment_id!==ctx.environmentId ||
      e.tool.state!=='succeeded' || e.result.outcome!=='succeeded') continue;
    if(e.tool.name==='read_file') {
      const data=e.result.data as {hash?:unknown;identity?:unknown}|null;
      if(data?.hash!==hash || data.identity!==loc.beforeIdentity) continue;
      try { sources.push(requireTextRead(reads,{mountId:a.mountId,path:a.path,readExecutionId:id,expectedReadHash:hash},ctx.environmentId,conversationId)); }
      catch(error) {if(!(error instanceof UmiError))throw error;}
    } else {
      const parsed=executionContextSchema.safeParse(e.context);
      if(!parsed.success)continue;
      const source=parsed.data, previous=source.locations[0], args=JSON.parse(e.tool.args) as Target;
      const data=e.result.data as {observed?:{hash?:unknown;identity?:unknown;size?:unknown}}|null;
      if(source.environmentId!==ctx.environmentId || !previous || previous.rootRef.kind!=='mount' ||
        previous.rootRef.mountId!==a.mountId || previous.relativePath!==a.path ||
        previous.physicalRootIdentity!==loc.physicalRootIdentity || loc.rootRef.kind!=='mount' ||
        previous.rootRef.bindingVersion!==loc.rootRef.bindingVersion || args.mountId!==a.mountId || args.path!==a.path ||
        previous.desiredHash!==hash || data?.observed?.hash!==hash || data.observed.identity!==loc.beforeIdentity ||
        data.observed.size!==bytes.length) continue;
      let ranges:KnownRange[]|undefined;
      if(e.tool.name==='write_file') {
        const write=writeFileSchema.safeParse(args);
        if(!write.success || source.fileWrite?.executionId!==id || bytesHash(Buffer.from(write.data.content))!==hash)continue;
        // 模型已提供完整新正文；成功落盘事实足够，不强迫它再读自己刚写的字节。
        ranges=[{startByte:0,endByte:bytes.length}];
      } else if(e.tool.name==='edit_file' && source.fileEdit?.executionId===id) ranges=source.fileEdit.knownRanges;
      for(const r of ranges??[]) {
        if(r.startByte>r.endByte || r.endByte>bytes.length)continue;
        sources.push({resultRef:e.resultRef,receipt:{readExecutionId:id,mountId:a.mountId,path:a.path,
          kind:'text',encoding:'utf-8',hash,identity:loc.beforeIdentity!,size:bytes.length,
          startByte:r.startByte,endByte:r.endByte,truncated:r.startByte!==0||r.endByte!==bytes.length,
          text:bytes.subarray(r.startByte,r.endByte).toString('utf8')}});
      }
    }
    const ranges=mergeKnownRanges(sources.map(s=>s.receipt));
    if((ranges[0]?.startByte===0 && ranges[0].endByte===bytes.length)||sources.length>=64)break;
  }
  if(!sources.length)throw new UmiError('READ_RECEIPT_REQUIRED','没有当前版本的已见原文；请用 read_file 读取目标范围，自己成功写入的正文无需重读。');
  return sources.slice(0,64);
}
