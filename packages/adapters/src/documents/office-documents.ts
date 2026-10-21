import {posix} from 'node:path';
import {createHash} from 'node:crypto';
import {UmiError} from '../../../protocol/src/model.js';
import {OFFICE_MAX_BYTES,officeMime,type OfficeFormat} from '../../../protocol/src/attachments.js';
import {officeArchive,xml,attribute as attr,relationshipId,invalid,limit} from './office-archive.js';

export const OFFICE_EXTRACTION_VERSION='ooxml-text-v1';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const w=(uri:string)=>uri==='http://schemas.openxmlformats.org/wordprocessingml/2006/main'||uri==='http://purl.oclc.org/ooxml/wordprocessingml/main';
const s=(uri:string)=>uri==='http://schemas.openxmlformats.org/spreadsheetml/2006/main'||uri==='http://purl.oclc.org/ooxml/spreadsheetml/main';
const relNs='http://schemas.openxmlformats.org/package/2006/relationships';
const typesNs='http://schemas.openxmlformats.org/package/2006/content-types';

// 有界派生文本与原字节分开保存；到预算就明确拒绝，不把截断前缀标为全文。
class Lines{
  rows:string[]=[];bytes=0;
  add(text:string){this.bytes+=Buffer.byteLength(text)+1;if(this.bytes>2*1024*1024)limit('文档提取文本超过2 MiB');this.rows.push(text);}
  text(){return this.rows.join('\n')+(this.rows.length?'\n':'');}
}
async function docx(archive:Awaited<ReturnType<typeof officeArchive>>,signal:AbortSignal){
  const lines=new Lines();let body=0,skip=0,paragraph:string[]|null=null,number=0,inText=0;
  await xml(await archive.read('word/document.xml'),signal,{
    open(t){
      if(!w(t.uri))return;
      if(t.local==='body')body++;
      if(!body)return;
      if(['del','moveFrom','drawing','object','txbxContent','altChunk'].includes(t.local))skip++;
      if(skip)return;
      if(t.local==='p'){if(paragraph)invalid('正文含不支持的嵌套段落');paragraph=[];if(++number>20000)limit('文档超过20000个段落');}
      if(paragraph){if(t.local==='t')inText++;if(t.local==='tab')paragraph.push('\t');if(t.local==='br'||t.local==='cr')paragraph.push('\n');}
    },
    text(value){if(paragraph&&inText&&!skip)paragraph.push(value);},
    close(t){
      if(!w(t.uri)||!body)return;
      if(!skip){if(t.local==='t'&&paragraph)inText--;if(t.local==='p'&&paragraph){lines.add(`word/document.xml#p=${number}\t${paragraph.join('')}`);paragraph=null;}}
      if(['del','moveFrom','drawing','object','txbxContent','altChunk'].includes(t.local))skip--;
      if(t.local==='body')body--;
    },
  });
  if(!number)invalid('文档没有可提取的正文段落');
  return {text:lines.text(),units:number,coverage:'仅word/document.xml正文段落（含表格内段落），保留段落标识；不含页眉页脚、批注、脚注、图片、文本框、删除修订或版式；域仅含保存的显示文本，未更新。'};
}
async function xlsx(archive:Awaited<ReturnType<typeof officeArchive>>,signal:AbortSignal){
  const sheets:{name:string;id:string;visibility:string}[]=[];
  await xml(await archive.read('xl/workbook.xml'),signal,{open(t){if(s(t.uri)&&t.local==='sheet'){
    const name=attr(t,'name'),id=relationshipId(t);if(!name||!id||sheets.some(v=>v.name===name||v.id===id))invalid('工作表身份缺失或重复');
    sheets.push({name:name!,id:id!,visibility:attr(t,'state')??'visible'});if(sheets.length>20)limit('工作簿超过20张工作表');
  }}});
  if(!sheets.length)invalid('工作簿没有工作表');
  const relations=new Map<string,{target:string;type:string;external:boolean}>();
  await xml(await archive.read('xl/_rels/workbook.xml.rels'),signal,{open(t){if(t.uri===relNs&&t.local==='Relationship'){
    const id=attr(t,'Id'),target=attr(t,'Target'),type=attr(t,'Type');if(!id||!target||!type||relations.has(id))invalid('工作簿关系缺失或重复');
    relations.set(id!,{target:target!,type:type!,external:attr(t,'TargetMode')==='External'});
  }}});
  const targetOf=(r:{target:string;external:boolean})=>{
    if(r.external||/[\\\0?#]/.test(r.target)||/^[a-z][a-z0-9+.-]*:/i.test(r.target))invalid('不读取外部文档关系');
    const path=posix.normalize(r.target.startsWith('/')?r.target.slice(1):posix.join('xl',r.target));
    if(!path.startsWith('xl/')||path.includes('../'))invalid('工作簿关系越界');return path;
  };
  const shared:string[]=[];let value='',inT=0,phonetic=0,inSi=false;
  const sharedRelations=[...relations.values()].filter(r=>r.type.endsWith('/sharedStrings'));
  if(sharedRelations.length>1)invalid('共享字符串关系重复');
  const sharedPath=sharedRelations[0]?targetOf(sharedRelations[0]):archive.has('xl/sharedStrings.xml')?'xl/sharedStrings.xml':null;
  if(sharedPath)await xml(await archive.read(sharedPath),signal,{
    open(t){if(!s(t.uri))return;if(t.local==='si'){inSi=true;value='';}if(t.local==='rPh')phonetic++;if(t.local==='t')inT++;},
    text(v){if(inSi&&inT&&!phonetic)value+=v;},
    close(t){if(!s(t.uri))return;if(t.local==='t')inT--;if(t.local==='rPh')phonetic--;if(t.local==='si'){shared.push(value);inSi=false;if(shared.length>100000)limit('共享字符串超过100000项');}},
  });
  const lines=new Lines();let cells=0;
  for(const sheet of sheets){
    const relation=relations.get(sheet.id);if(!relation||!relation.type.endsWith('/worksheet'))invalid('不支持非普通单元格工作表或缺失的工作表关系');
    const path=targetOf(relation!);lines.add(JSON.stringify({sheet:sheet.name,visibility:sheet.visibility,part:path}));
    const seen=new Set<string>();let cell:{address:string;type:string;style:string|undefined;value:string;inline:string;formula:string;formulaAttrs:Record<string,string>;hasFormula:boolean}|null=null;
    let field='',inCellText=0,phoneticCell=0;
    await xml(await archive.read(path),signal,{
      open(t){if(!s(t.uri))return;
        if(t.local==='c'){
          const address=attr(t,'r');if(!address||!/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.test(address)||seen.has(address))invalid('单元格地址缺失、重复或无效');
          const match=/^([A-Z]+)(\d+)$/.exec(address!)!;let col=0;for(const c of match[1]!)col=col*26+c.charCodeAt(0)-64;
          if(col>16384||Number(match[2])>1048576)invalid('单元格地址超出XLSX范围');seen.add(address!);
          if(++cells>50000)limit('工作簿超过50000个已保存单元格');
          cell={address:address!,type:attr(t,'t')??'n',style:attr(t,'s'),value:'',inline:'',formula:'',formulaAttrs:{},hasFormula:false};
        }
        if(!cell)return;
        if(t.local==='v')field='value';if(t.local==='f'){field='formula';cell.hasFormula=true;for(const key of ['t','si','ref']){const a=attr(t,key);if(a!==undefined)cell.formulaAttrs[key]=a;}}
        if(t.local==='t')inCellText++;if(t.local==='rPh')phoneticCell++;
      },
      text(v){if(!cell)return;if(field==='value')cell.value+=v;else if(field==='formula')cell.formula+=v;else if(inCellText&&!phoneticCell)cell.inline+=v;},
      close(t){if(!s(t.uri)||!cell)return;
        if(t.local==='v'||t.local==='f')field='';if(t.local==='t')inCellText--;if(t.local==='rPh')phoneticCell--;
        if(t.local==='c'){
          let value:string|boolean=cell.value;
          if(cell.type==='s'){if(!/^\d+$/.test(cell.value)||shared[Number(cell.value)]===undefined)invalid('单元格共享字符串索引无效');value=shared[Number(cell.value)]!;}
          else if(cell.type==='inlineStr')value=cell.inline;
          else if(cell.type==='b'){if(!/^[01]$/.test(cell.value))invalid('布尔单元格值无效');value=cell.value==='1';}
          else if(!['n','str','e','d'].includes(cell.type))invalid('不支持的单元格类型');
          if(value!==''||cell.hasFormula)lines.add(JSON.stringify({sheet:sheet.name,cell:cell.address,type:cell.type,
            ...(cell.style!==undefined?{styleIndex:cell.style}:{}),...(cell.hasFormula?{formula:cell.formula,formulaAttributes:cell.formulaAttrs,cachedValue:value}:{value})}));
          cell=null;
        }
      },
    });
  }
  return {text:lines.text(),units:cells,coverage:'逐表输出已保存单元格的工作表名/可见性/A1地址/类型；字符串与原始数值文本，公式及缓存值分列且未计算（缓存可能过期，shared公式不展开）。未渲染日期/数值样式、图表、图片、批注、合并布局；不读取外部链接、不运行宏。'};
}
export async function extractOfficeDocument(format:OfficeFormat,bytes:Buffer){
  if(bytes.length>OFFICE_MAX_BYTES)limit('Office附件不能超过8 MiB');
  const signal=AbortSignal.timeout(12000);let archive:Awaited<ReturnType<typeof officeArchive>>|undefined;
  try{
    archive=await officeArchive(bytes,signal);let mainType='';
    await xml(await archive.read('[Content_Types].xml'),signal,{open(t){if(t.uri!==typesNs)return;
      const type=attr(t,'ContentType')??'';if(/macroEnabled|vbaProject/i.test(type))invalid('不支持含宏文档');
      if(t.local==='Override'&&attr(t,'PartName')===(format==='docx'?'/word/document.xml':'/xl/workbook.xml'))mainType=type;
    }});
    const expected=format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
    if(mainType!==expected)invalid('文件内容与DOCX/XLSX类型不符，或属于不支持的Office格式');
    const extracted=await(format==='docx'?docx(archive,signal):xlsx(archive,signal));
    return {...extracted,format,mime:officeMime[format],version:OFFICE_EXTRACTION_VERSION,originalHash:sha(bytes),hash:sha(extracted.text)};
  }catch(error){if(error instanceof UmiError)throw error;throw new UmiError(signal.aborted?'DOCUMENT_LIMIT':'DOCUMENT_INVALID',signal.aborted?'文档提取超过12秒，未保存残缺正文':'文档损坏或结构不支持，未保存残缺正文');}
  finally{archive?.close();}
}
