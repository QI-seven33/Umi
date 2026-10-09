import {UmiError} from '../../../protocol/src/model.js';
export function decodeImage(base64:string){
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new UmiError('PROTOCOL_INVALID','图片编码无效');
  const bytes=Buffer.from(base64,'base64');if(bytes.length>1_000_000||bytes.length<16)throw new UmiError('PROTOCOL_INVALID','图片大小无效，单张上限 1 MB');
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mime)throw new UmiError('PROTOCOL_INVALID','只支持 PNG、JPEG、GIF、WebP 图片');
  return {bytes,mime};
}
