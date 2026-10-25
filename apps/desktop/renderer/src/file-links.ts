// 兼容语法定位入口；UI不得把这个候选当作已存在的文件。
import {fileReferenceCandidates} from '../../../../packages/protocol/src/file-reference.js';
import type {PreviewMount} from '../../../../packages/protocol/src/file-reference.js';
export type {PreviewMount};
export function resolveFileReference(value:string,mounts:readonly PreviewMount[]) {
 const candidates=fileReferenceCandidates(value,mounts);return candidates.length===1?candidates[0]!:null;
}
