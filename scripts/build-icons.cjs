// 品牌图形保持原样；使用固定几何白底导出可重复的应用图标。
const { app, BrowserWindow, nativeImage } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
app.whenReady().then(async () => {
  const sourcePath = resolve(process.argv[2] || 'assets/brand/umi-symbol.png');
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty() || source.getSize().width !== source.getSize().height) throw Error('图标源应为有效方形 PNG');
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>Umi icon export</title>');
  const input = 'data:image/png;base64,' + readFileSync(sourcePath).toString('base64');
  const data = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(input)}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.beginPath(); context.roundRect(0, 0, 1024, 1024, 208); context.fill();
    context.imageSmoothingQuality = 'high'; context.drawImage(image, 64, 64, 896, 896);
    return canvas.toDataURL('image/png');
  })()`);
  window.destroy();
  const icon = nativeImage.createFromDataURL(data).resize({ width: 512, height: 512, quality: 'best' });
  const root = resolve('apps/desktop/renderer/public'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'umi-logo.png'), icon.toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(size => icon.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i; header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(images[i].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += images[i].length;
  });
  writeFileSync(join(root, 'umi.ico'), Buffer.concat([header, ...images]));
  console.log('Umi 白底圆角 PNG 和七尺寸 ICO 已导出。'); app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });