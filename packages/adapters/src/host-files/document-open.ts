import {extname} from 'node:path';
import {observe,safeFile} from './paths.js';
import type {DocumentTarget} from '../../../protocol/src/native-open.js';
import {UmiError} from '../../../protocol/src/model.js';

const documentExtensions=new Set(['.html','.htm','.txt','.md','.pdf','.png','.jpg','.jpeg','.gif','.webp','.docx','.xlsx','.pptx','.csv']);
// 系统打开前重新核验具体版本和身份；不接收程序、参数或URL。
export function verifiedDocumentPath(target:DocumentTarget) {
  if(!documentExtensions.has(extname(target.path).toLowerCase()))throw new UmiError('OPEN_UNSUPPORTED','只支持打开文档、网页和图片，不执行程序或脚本');
  const entry=observe(target.root,target.path,target.rootIdentity);
  if(!entry||entry.hash!==target.hash||entry.identity!==target.identity)throw new UmiError('RESOURCE_CHANGED','文件已变化，未请求打开');
  return safeFile(target.root,target.path,target.rootIdentity);
}
