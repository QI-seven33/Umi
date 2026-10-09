// 图形内容由 imagegen 输出；这里只导出桌面所需的固定尺寸与 ICO 容器。
const {app,nativeImage}=require('electron');
const {writeFileSync,mkdirSync}=require('node:fs');
const {resolve,join}=require('node:path');
app.whenReady().then(()=>{
  const source=nativeImage.createFromPath(resolve(process.argv[2]));
  if(source.isEmpty())throw Error('图标源文件无法读取');
  const root=resolve('apps/desktop/renderer/public');mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'umi-logo.png'),source.resize({width:512,height:512,quality:'best'}).toPNG());
  const sizes=[16,24,32,48,64,128,256],pngs=sizes.map(size=>source.resize({width:size,height:size,quality:'best'}).toPNG());
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
  sizes.forEach((size,i)=>{const at=6+16*i;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(pngs[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=pngs[i].length;});
  writeFileSync(join(root,'umi.ico'),Buffer.concat([header,...pngs]));console.log('Umi PNG 与七种尺寸 ICO 已导出。');app.exit(0);
}).catch(error=>{console.error(error.message);app.exit(1);});
