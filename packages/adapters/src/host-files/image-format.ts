import { crc32 } from 'node:zlib';
import { UmiError } from '../../../protocol/src/model.js';
import { decodeImage } from '../sqlite/images.js';
// 有界的格式/容器/尺寸检查，不运行图片、脚本或原生桌面应用。
// JPEG/GIF/WebP不在这里做完整像素解码；提供商仍可能拒绝损坏的像素流。
export function inspectObservedImage(bytes: Buffer) {
  const { mime } = decodeImage(bytes.toString('base64'));
  const bad = () => { throw new UmiError('IMAGE_INVALID', '图片容器或尺寸无效，可能已损坏或截断'); };
  let width = 0, height = 0;
  if (mime === 'image/png') {
    let position = 8, data = false, ended = false;
    while (position + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(position), end = position + 12 + size;
      if (end > bytes.length) bad();
      const name = bytes.toString('ascii', position + 4, position + 8);
      if (crc32(bytes.subarray(position + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) bad();
      if (position === 8 && (name !== 'IHDR' || size !== 13)) bad();
      if (name === 'IHDR') {
        if (position !== 8 || size !== 13) bad();
        width = bytes.readUInt32BE(position + 8); height = bytes.readUInt32BE(position + 12);
        const depth = bytes[position + 16]!, colour = bytes[position + 17]!;
        const depths: Record<number, number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
        if (!depths[colour]?.includes(depth) || bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20]! > 1) bad();
      }
      if (name === 'IDAT' && size) data = true;
      if (name === 'IEND') { if (size || end !== bytes.length) bad(); ended = true; break; }
      position = end;
    }
    if (!data || !ended) bad();
  } else if (mime === 'image/jpeg') {
    if (bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) bad();
    let p = 2;
    while (p + 3 < bytes.length) {
      if (bytes[p++] !== 0xff) bad();
      while (bytes[p] === 0xff) p++;
      const marker = bytes[p++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) bad();
      const size = bytes.readUInt16BE(p); if (size < 2 || p + size > bytes.length) bad();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8) bad(); height = bytes.readUInt16BE(p + 3); width = bytes.readUInt16BE(p + 5);
      }
      p += size;
    }
  } else if (mime === 'image/gif') {
    if (bytes.length < 14 || bytes.at(-1) !== 0x3b) bad();
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else {
    if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length) bad();
    const kind = bytes.toString('ascii', 12, 16), size = bytes.readUInt32LE(16);
    if (20 + size + (size % 2) > bytes.length) bad();
    if (kind === 'VP8X') {
      if (size !== 10 || bytes.length < 30) bad(); width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === 'VP8L') {
      if (size < 5 || bytes[20] !== 0x2f) bad();
      const dimensions = bytes.readUInt32LE(21); width = (dimensions & 0x3fff) + 1; height = ((dimensions >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ') {
      if (size < 10 || !bytes.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))) bad();
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else bad();
  }
  if (!width || !height) bad();
  if (width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new UmiError('IMAGE_LIMIT', '图片超过8192像素单边或16Mi像素上限；请生成较小的副本后读取');
  return { mime: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', width, height };
}
