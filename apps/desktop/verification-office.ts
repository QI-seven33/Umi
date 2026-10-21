import {formatSize} from './renderer/src/utils/file.js';
import type {AgentBroker} from './broker.js';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserWindow} from 'electron';

// 仅桌面验收夹具：最小未压缩ZIP，独立于产品提取器构造来源与预期。
function archive(files:[string,string][]){
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,text] of files){
    const n=Buffer.from(name),data=Buffer.from(text),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc32(data),14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);h.copy(c,6,4,30);c.writeUInt32LE(offset,42);local.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,dir,end]).toString('base64');
}
function officeFixtures(){
  const w='http://schemas.openxmlformats.org/wordprocessingml/2006/main',s='http://schemas.openxmlformats.org/spreadsheetml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const type=(kind:'wordprocessingml.document'|'spreadsheetml.sheet',part:string)=>`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${kind}.main+xml"/></Types>`;
  const cases=[{name:'桌面资料.docx',base64:archive([['[Content_Types].xml',type('wordprocessingml.document','/word/document.xml')],['word/document.xml',`<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>DOCX-UI 中文😀 保留原话</w:t></w:r></w:p></w:body></w:document>`]]),expected:'DOCX-UI 中文😀 保留原话',note:'正文段落'},
    {name:'桌面资料.xlsx',base64:archive([['[Content_Types].xml',type('spreadsheetml.sheet','/xl/workbook.xml')],['xl/workbook.xml',`<workbook xmlns="${s}" xmlns:r="${r}"><sheets><sheet name="验收数据" sheetId="1" r:id="r1"/></sheets></workbook>`],['xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${r}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],['xl/worksheets/sheet1.xml',`<worksheet xmlns="${s}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSX-UI-57</t></is></c><c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>`]]),expected:'XLSX-UI-57',note:'未计算'}];
  return cases;
}
export async function verifyOfficeAttachments(win:BrowserWindow){
  const cases=officeFixtures();
  const wait=async(script:string)=>{for(let i=0;i<120;i++){if(await win.webContents.executeJavaScript(script))return;await delay(100);}throw Error('Office桌面验收超时：'+script);};
  const panelWasOpen=await win.webContents.executeJavaScript(`document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true'`);
  const evidence:string[]=[];
  for(const file of cases){
    await win.webContents.executeJavaScript(`(()=>{const data=new DataTransfer(),bytes=Uint8Array.from(atob(${JSON.stringify(file.base64)}),c=>c.charCodeAt(0));data.items.add(new File([bytes],${JSON.stringify(file.name)}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
    const chip=`Array.from(document.querySelectorAll('.composer .attachment-chip')).find(n=>n.querySelector('.attachment-name').textContent===${JSON.stringify(file.name)})`;
    await wait(`(()=>{const n=${chip};return n&&n.classList.contains('done');})()`);
    assert.match(await win.webContents.executeJavaScript(`(${chip}).textContent`),/本地提取文本/);
    await win.webContents.executeJavaScript(`(${chip}).querySelector('.attachment-name').click()`);
    await wait(`document.querySelector('.file-preview-scroll')?.textContent.includes(${JSON.stringify(file.expected)})`);
    assert(await win.webContents.executeJavaScript(`document.querySelector('[role="note"]')?.textContent.includes(${JSON.stringify(file.note)})`));
    if(file.name.endsWith('.xlsx'))assert(await win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll').textContent.includes('cachedValue')`));
    evidence.push(file.name.endsWith('.docx')?'DOCX真实拖放经固定IPC提取，段落来源与限制在预览可见':'XLSX真实拖放与单元格预览，公式缓存未重算明确展示');
    await win.webContents.executeJavaScript(`(${chip}).querySelector('.attachment-remove').click()`);
  }
  await win.webContents.executeJavaScript(`if((document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true')!==${panelWasOpen})document.querySelector('.right-rail-toggle').click();`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.composer .attachment-chip.done').length`),2);
  return evidence;
}

// 模拟尚未确认发送的持久草稿：刷新真实页面后，从固定preview IPC恢复附件。
export async function verifyOfficeRecovery(broker:AgentBroker,win:BrowserWindow,conversationId:string){
  const c=await broker.request({type:'new_conversation',conversationId}) as {conversationId:string};
  const cases=officeFixtures(),rows:{id:string;name:string;originalBytes:number;textBytes:number}[]=[];
  for(const file of cases){
    const uploaded=await broker.request({type:'upload_document',conversationId:c.conversationId,name:file.name,
      format:file.name.endsWith('.docx')?'docx':'xlsx',base64:file.base64}) as {id:string;byteLength:number};
    const preview=await broker.request({type:'preview_attachment',conversationId:c.conversationId,attachmentId:uploaded.id,startByte:0,byteLength:8192}) as {originalBytes:number;totalBytes:number};
    assert.equal(preview.originalBytes,uploaded.byteLength);assert.notEqual(formatSize(preview.originalBytes),formatSize(preview.totalBytes));
    rows.push({id:uploaded.id,name:file.name,originalBytes:preview.originalBytes,textBytes:preview.totalBytes});
  }
  const pending={id:randomUUID(),text:'保留待发送的Office原件',attachments:rows.map(row=>row.id)};
  await win.webContents.executeJavaScript(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(c.conversationId)});localStorage.setItem('umi.pending.'+${JSON.stringify(c.conversationId)},${JSON.stringify(JSON.stringify(pending))});location.reload();`);
  let restored=false;
  for(let i=0;i<120;i++){
    if(await win.webContents.executeJavaScript(`document.querySelectorAll('.composer .attachment-chip.done').length===2`)){restored=true;break;}
    await delay(100);
  }
  assert(restored,'Office待发附件应从持久身份恢复');
  for(const row of rows){
    const chip=await win.webContents.executeJavaScript(`(()=>{const n=Array.from(document.querySelectorAll('.composer .attachment-chip')).find(n=>n.querySelector('.attachment-name').textContent===${JSON.stringify(row.name)});return {meta:n?.querySelector('.attachment-meta').textContent,classes:n?.className};})()`);
    assert.equal(chip.meta,formatSize(row.originalBytes)+' · 本地提取文本','恢复卡片必须显示原件大小，不能误用派生正文大小');
    assert(!chip.classes.includes('is-image'));
  }
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.composer textarea').value`),pending.text);
  const restoredIds=await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('umi.pending.'+${JSON.stringify(c.conversationId)})).attachments`);
  assert.deepEqual(restoredIds,pending.attachments);
  return rows;
}
