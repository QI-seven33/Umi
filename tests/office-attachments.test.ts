import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateRawSync,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {extractOfficeDocument} from '../packages/adapters/src/documents/office-documents.js';
import {officeDescriptorSchema,OFFICE_MAX_BYTES,officeMime} from '../packages/protocol/src/attachments.js';
import {desktopCommandSchema} from '../packages/protocol/src/desktop.js';
import {UmiApplication} from '../apps/headless/src/application.js';
import {DesktopService} from '../apps/desktop/service.js';
import {encodeOfficeAttachment} from '../apps/desktop/renderer/src/features/work/attachments.js';
import {appendPreviewPage} from '../apps/desktop/renderer/src/preview-page.js';
import {ScriptModel,call,text,removeTestRoot} from './fixtures.js';
import {uid} from '../packages/agent/src/identity.js';
import {validatePairs,type WireMessage} from '../packages/protocol/src/model.js';
import type {Step} from './fixtures.js';

// 测试夹具自行写最小ZIP，不调用系统Office/压缩程序，也不让测试依赖产品提取器来构造预期文本。
function zip(files:[string,string][],options:{deflate?:boolean;badCrc?:boolean;declaredSize?:number;encrypted?:boolean}={}){
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,body] of files){const n=Buffer.from(name),raw=Buffer.from(body),data=options.deflate?deflateRawSync(raw):raw;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(options.encrypted?1:0,6);h.writeUInt16LE(options.deflate?8:0,8);
    h.writeUInt32LE(options.badCrc?0:crc32(raw),14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(options.declaredSize??raw.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);h.copy(c,6,4,30);c.writeUInt32LE(offset,42);
    local.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',S='http://schemas.openxmlformats.org/spreadsheetml/2006/main',R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const types=(format:'docx'|'xlsx')=>`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${format==='docx'?'word/document.xml':'xl/workbook.xml'}" ContentType="application/vnd.openxmlformats-officedocument.${format==='docx'?'wordprocessingml.document':'spreadsheetml.sheet'}.main+xml"/></Types>`;
const document=(content:string)=>`<w:document xmlns:w="${W}"><w:body>${content}</w:body></w:document>`;
const paragraph=(value:string)=>`<w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p>`;
const doc=(value='中文😀 original & exact')=>zip([['[Content_Types].xml',types('docx')],['word/document.xml',document(paragraph(value))]],{deflate:true});
function book(options:{external?:boolean;target?:string;cells?:string;shared?:string;hidden?:boolean;empty?:boolean}={}){
 const worksheet=`<worksheet xmlns="${S}"><sheetData><row r="1">${options.cells??'<c r="A1" t="s"><v>0</v></c><c r="B1"><v>9007199254740993</v></c><c r="C1"><f>SUM(B1,1)</f><v>9007199254740994</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="inlineStr"><is><t>inline😀</t></is></c>'}</row></sheetData></worksheet>`;
 return zip([['[Content_Types].xml',types('xlsx')],['xl/workbook.xml',`<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${options.empty?'':`<sheet name="数据&amp;一" sheetId="1" r:id="s1"${options.hidden?' state="hidden"':''}/>`}</sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="${R}/worksheet" Target="${options.target??'worksheets/sheet1.xml'}"${options.external?' TargetMode="External"':''}/></Relationships>`],
  ['xl/worksheets/sheet1.xml',worksheet],['xl/sharedStrings.xml',`<sst xmlns="${S}"><si>${options.shared??'<r><t>共享</t></r><r><t>😀 &amp; literal</t></r><rPh><t>phonetic</t></rPh>'}</si></sst>`]],{deflate:true});
}
function fixture(steps:Step[]=[]){
 const root=mkdtempSync(join(tmpdir(),'umi-office-')),workspace=join(root,'source');mkdirSync(workspace);
 const model=new ScriptModel(steps),app=new UmiApplication(join(root,'data'),model),c=app.createConversation(workspace),service=new DesktopService(app);
 return {root,workspace,model,app,c,service,async upload(bytes:Buffer,name='资料.docx',cid=c.conversationId){return app.store.uploadDocument(cid,{name,format:name.endsWith('.xlsx')?'xlsx':'docx',base64:bytes.toString('base64')});},
  async close(){await app.close();removeTestRoot(root);}};
}

test('DOCX：正文段落/表内段落、空白/Unicode/制表/换行保留，删除修订与域指令不冒充正文',async()=>{
 const content=paragraph('  中文😀 & 原文  ')+'<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t><w:instrText>NETWORK()</w:instrText></w:r><w:del><w:r><w:delText>DELETED</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc>'+paragraph('表格文字')+'</w:tc></w:tr></w:tbl>';
 const result=await extractOfficeDocument('docx',zip([['[Content_Types].xml',types('docx')],['word/document.xml',document(content)],['word/header1.xml',paragraph('HEADER')]],{deflate:true}));
 assert.equal(result.text,'word/document.xml#p=1\t  中文😀 & 原文  \nword/document.xml#p=2\tA\tB\nC\nword/document.xml#p=3\t表格文字\n');assert.equal(result.units,3);
 assert(!result.text.includes('DELETED'));assert(!result.text.includes('NETWORK'));assert(!result.text.includes('HEADER'));assert.match(result.coverage,/不含页眉页脚/);
});
test('DOCX：严格命名空间、不同前缀仍解析，未做版式/OCR/图片提取',async()=>{
 const value=document(paragraph('严格文本')).replaceAll(W,'http://purl.oclc.org/ooxml/wordprocessingml/main').replaceAll('w:','q:').replace('xmlns:w=','xmlns:q=');
 const result=await extractOfficeDocument('docx',zip([['[Content_Types].xml',types('docx')],['word/document.xml',value]]));assert.match(result.text,/严格文本/);assert.match(result.coverage,/图片/);
});
test('XLSX：共享/行内富文本、精确数值文本、布尔、公式与缓存分别标记，地址/工作表可引用',async()=>{
 const result=await extractOfficeDocument('xlsx',book({hidden:true})),rows=result.text.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows[0],{sheet:'数据&一',visibility:'hidden',part:'xl/worksheets/sheet1.xml'});
 assert.equal(rows[1].value,'共享😀 & literal');assert.equal(rows[2].value,'9007199254740993');assert.equal(rows[3].formula,'SUM(B1,1)');assert.equal(rows[3].cachedValue,'9007199254740994');assert(!('value' in rows[3]));
 assert.equal(rows[4].value,true);assert.equal(rows[5].value,'inline😀');assert.equal(rows[5].cell,'E1');assert.match(result.coverage,/未计算/);assert.match(result.coverage,/缓存可能过期/);
});
test('XLSX：错误、日期文本、无缓存/共享公式保留来源而不伪造重新计算结果',async()=>{
 const result=await extractOfficeDocument('xlsx',book({cells:'<c r="A1" t="e"><v>#REF!</v></c><c r="B1" t="d"><v>2026-10-20</v></c><c r="C1" s="4"><f t="shared" si="2" ref="C1:C9">A1</f></c><c r="C2"><f t="shared" si="2"/></c>'}));
 const rows=result.text.trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows[1].value,'#REF!');assert.equal(rows[2].value,'2026-10-20');assert.equal(rows[3].cachedValue,'');assert.equal(rows[3].styleIndex,'4');assert.deepEqual(rows[4].formulaAttributes,{t:'shared',si:'2'});
});
test('Office：外部工作表/越界关系不读取，缺失部件、错误后缀类型和空工作簿明确拒绝',async()=>{
 for(const bytes of [book({external:true,target:'https://example.org/evil.xml'}),book({target:'../../outside.xml'}),book({target:'missing.xml'}),book({empty:true})])await assert.rejects(()=>extractOfficeDocument('xlsx',bytes));
 await assert.rejects(()=>extractOfficeDocument('xlsx',doc()),/类型不符/);await assert.rejects(()=>extractOfficeDocument('docx',Buffer.from('not ZIP')));await assert.rejects(()=>extractOfficeDocument('docx',Buffer.alloc(OFFICE_MAX_BYTES+1)),/8 MiB/);
});
test('Office：DTD/实体、XML损坏、压缩包CRC错误/重复路径/路径穿越/加密/宏被拒绝',async()=>{
 const file=(xml:string)=>[['[Content_Types].xml',types('docx')],['word/document.xml',xml]] as [string,string][];
 for(const value of ['<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///C:/secret">]>'+document(paragraph('text')),document('<w:p>'),document('<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>')])await assert.rejects(()=>extractOfficeDocument('docx',zip(file(value))));
 for(const bytes of [zip(file(document(paragraph('ok'))),{badCrc:true}),zip([...file(document(paragraph('ok'))),['word/document.xml',document(paragraph('other'))]]),zip([...file(document(paragraph('ok'))),['../escape','oops']]),zip(file(document(paragraph('ok'))),{encrypted:true}),zip([...file(document(paragraph('ok'))),['word/vbaProject.bin','macro']])])await assert.rejects(()=>extractOfficeDocument('docx',bytes));
});
test('Office：声明与实际解压预算、文本预算和XML深度预算拒绝，未留下假完整正文',async()=>{
 const files:[string,string][]=[['[Content_Types].xml',types('docx')],['word/document.xml',document(paragraph('a'.repeat(2*1024*1024)))]];
 await assert.rejects(()=>extractOfficeDocument('docx',zip(files,{deflate:true})),/2 MiB/);
 await assert.rejects(()=>extractOfficeDocument('docx',zip(files,{deflate:true,declaredSize:9*1024*1024})),/8 MiB/);
 const deep='<w:p>'+('<w:r>'.repeat(130))+'<w:t>x</w:t>'+('</w:r>'.repeat(130))+'</w:p>';
 await assert.rejects(()=>extractOfficeDocument('docx',zip([['[Content_Types].xml',types('docx')],['word/document.xml',document(deep)]])),/层级/);
});
test('XLSX：非法/重复/越界地址、损坏共享字符串与布尔值不静默丢格或替换',async()=>{
 for(const cells of ['<c r="A1" t="s"><v>999</v></c>','<c r="A1" t="b"><v>2</v></c>','<c r="A1"><v>1</v></c><c r="A1"><v>2</v></c>','<c r="XFE1"><v>1</v></c>','<c r="A1048577"><v>1</v></c>','<c><v>1</v></c>'])await assert.rejects(()=>extractOfficeDocument('xlsx',book({cells})));
});
test('Office上传：前端与固定IPC有界，名称/后缀/base64/路径不能扩大宿主权限',async()=>{
 const bytes=doc(),encoded=await encodeOfficeAttachment(new File([bytes],'材料.DOCX'));assert.equal(encoded.base64,bytes.toString('base64'));assert.equal(encoded.format,'docx');
 await assert.rejects(()=>encodeOfficeAttachment(new File(['x'],'x.pdf')),/目前文档附件/);await assert.rejects(()=>encodeOfficeAttachment(new File([Buffer.alloc(OFFICE_MAX_BYTES+1)],'x.docx')),/8 MiB/);
 const f=fixture();try{
  const input={type:'upload_document',conversationId:f.c.conversationId,name:'材料.docx',...encoded};assert(desktopCommandSchema.safeParse(input).success);assert(!desktopCommandSchema.safeParse({...input,path:'C:/secret'}).success);
  for(const value of [{...encoded,name:'../escape.docx'},{...encoded,name:'fake.xlsx'},{...encoded,name:'x.docx',base64:encoded.base64+'\n'},{...encoded,name:'x.docx',base64:'===='}])await assert.rejects(()=>f.app.store.uploadDocument(f.c.conversationId,value));
  const a=await f.service.handle(desktopCommandSchema.parse(input)) as {id:string};assert.equal(f.app.store.attachment(f.c.conversationId,a.id).mime,officeMime.docx);
 }finally{await f.close();}
});
test('Office存储：原件字节hash与派生文本hash分开，重复原件复用且同名版本独立',async()=>{
 const f=fixture();try{
  const bytes=doc(),a=await f.upload(bytes),b=await f.upload(bytes,'别名.docx'),other=await f.upload(doc('NEW VERSION'));
  assert.notEqual(a.id,b.id);const row=f.app.store.attachment(f.c.conversationId,a.id),ref=String(row.artifact_ref);assert.equal(f.app.store.attachment(f.c.conversationId,b.id).artifact_ref,ref);assert.notEqual(f.app.store.attachment(f.c.conversationId,other.id).artifact_ref,ref);
  const d=officeDescriptorSchema.parse(f.app.store.readArtifact(ref));assert.equal(d.original.hash,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(Buffer.from(f.app.store.readArtifact<{base64:string}>(d.original.artifactRef).base64,'base64'),bytes);
  const page=f.app.store.readAttachment(f.c.conversationId,a.id);assert('hash' in page&&'originalHash' in page);assert.notEqual(page.hash,page.originalHash);assert.equal(page.originalBytes,bytes.length);assert.match(String(page.sourceNote),/非Office版式/);
 }finally{await f.close();}
});
test('Office读取：正文只加载派生资料，目录/启动路径不加载原件，连续分页与搜索保持同版本',async()=>{
 const f=fixture();try{
  const a=await f.upload(doc('long '.repeat(9000)+'TAIL-CODE: R7中文😀'));const accepted=f.app.store.acceptInput(f.c.conversationId,uid(),'引用资料',[a.id]);f.app.store.applyInputs(accepted.runId);await f.app.stop(f.c.conversationId,accepted.runId);
  const row=f.app.store.attachment(f.c.conversationId,a.id),descriptor=officeDescriptorSchema.parse(f.app.store.readArtifact(String(row.artifact_ref))),read=f.app.store.readArtifact.bind(f.app.store);
  f.app.store.readArtifact=<T>(id:string):T=>{assert.notEqual(id,descriptor.original.artifactRef,'日常检索不得加载原件base64');return read<T>(id);};
  assert.equal(f.app.store.listAttachments(f.c.conversationId,{}).total,1);f.app.store.listConversations();f.app.store.snapshot(f.c.conversationId);
  const hit=f.app.store.searchAttachment(f.c.conversationId,{attachmentId:a.id,query:'TAIL-CODE'});assert.equal(hit.matches.length,1);assert.match(hit.matches[0]!.text,/R7中文😀/);
  const first=f.app.store.previewAttachment(f.c.conversationId,a.id,0,8192),second=f.app.store.previewAttachment(f.c.conversationId,a.id,8192,64000);const full=appendPreviewPage(first,second);assert.match(full.text!,/TAIL-CODE/);assert.equal(full.truncated,false);assert.match(String(full.sourceNote),/正文段落/);
  assert.throws(()=>f.app.store.readAttachment(f.c.conversationId,a.id,0,8192,{expectedHash:'0'.repeat(64)}),/hash/);
 }finally{await f.close();}
});
test('Office唯一循环：工具数不扩张，模型按表名/单元格搜索补读，原始历史/思考/工具组保留',async()=>{
 let id='';const steps:Step[]=[()=>call('search_attachment',{attachmentId:id,query:'C1'}),r=>{
  const d=JSON.parse((r.body.messages as WireMessage[]).filter(m=>m.role==='tool').at(-1)!.content).data;
  assert.match(d.extraction.coverage,/未计算/);return call('read_attachment',{attachmentId:id,startLine:d.matches[0].line,lineCount:1,expectedHash:d.hash});
 },r=>{const wire=r.body.messages as WireMessage[];validatePairs(wire);assert(!JSON.stringify(wire).includes('UEsDB'));assert(wire.some(m=>m.reasoning_content==='我先核实必要的信息。'));return text('数据&一!C1是保存的公式与缓存值，未重新计算。');}];
 const f=fixture(steps);try{
  const a=await f.upload(book(),'数据.xlsx');id=a.id;assert.equal(f.app.store.listAttachments(f.c.conversationId,{}).total,0);assert.throws(()=>f.app.store.searchAttachment(f.c.conversationId,{attachmentId:id,query:'C1'}),/尚未/);
  const other=f.app.createConversation(f.workspace);assert.throws(()=>f.app.store.readAttachment(other.conversationId,id),/不属于/);
  const r=f.app.send(f.c.conversationId,uid(),'查看保存的C1公式，不要重新计算',[id]);assert.equal((await f.app.wait(r.runId)).status,'completed');
  assert.deepEqual(f.app.store.tools(r.runId).map(t=>t.name),['search_attachment','read_attachment']);assert.equal(Object.keys(f.app.store.snapshot(f.c.conversationId).approvals).length,0);
  assert.equal(f.app.store.messages(f.c.conversationId).filter(m=>m.role==='user').at(-1)!.payload.content,'查看保存的C1公式，不要重新计算');
  assert(!f.app.registry.specs().some(t=>/office|document/.test(t.name)));assert.equal(f.app.store.databaseVersion,7);
 }finally{await f.close();}
});
test('Office失败原子性：提取失败不保存半套资料，数据库写入失败整套回滚',async()=>{
 const f=fixture();try{
  const before=Number(f.app.store.get('SELECT count(*) n FROM artifacts')!.n);
  await assert.rejects(()=>f.upload(Buffer.from('broken')));assert.equal(Number(f.app.store.get('SELECT count(*) n FROM artifacts')!.n),before);
  f.app.store.db.exec("CREATE TRIGGER fail_office BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'injected failure'); END;");await assert.rejects(()=>f.upload(doc()),/injected/);
  assert.equal(Number(f.app.store.get('SELECT count(*) n FROM artifacts')!.n),before);assert.equal(f.app.store.all('SELECT * FROM attachments').length,0);
 }finally{await f.close();}
});
test('Office重启/删除：原件与提取文本可追回，永久删除按引用闭包清理且另一会话保留',async()=>{
 const f=fixture();try{
  const a=await f.upload(doc()),row=f.app.store.attachment(f.c.conversationId,a.id),d=officeDescriptorSchema.parse(f.app.store.readArtifact(String(row.artifact_ref)));
  const other=f.app.createConversation(f.workspace),b=await f.upload(doc('其它会话'), 'other.docx',other.conversationId);
  await f.app.close();const next=new UmiApplication(join(f.root,'data'),new ScriptModel([]));try{
   assert.match(next.store.readAttachment(f.c.conversationId,a.id).text,/original & exact/);assert.equal(next.store.readArtifact<{base64:string}>(d.original.artifactRef).base64,doc().toString('base64'));
   next.store.editConversation(f.c.conversationId,null,true);next.deleteArchivedConversation(f.c.conversationId);
   for(const id of [row.artifact_ref,d.original.artifactRef,d.extraction.artifactRef])assert.equal(next.store.get('SELECT id FROM artifacts WHERE id=?',String(id)),undefined);
   assert.match(next.store.readAttachment(other.conversationId,b.id).text,/其它会话/);assert.equal(next.store.all('PRAGMA foreign_key_check').length,0);
  }finally{await next.close();}
 }finally{await f.close();}
});
