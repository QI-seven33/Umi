export type PreviewPage = {
  displayPath?: string | undefined; text?: string; dataUrl?: string; hash?: string; startByte?: number; endByte?: number;
  totalBytes?: number; size?: number; nextStartByte?: number | null; truncated?: boolean;
  previewSupported?: boolean; deleted?: boolean;
};
/** 分页只拼接同一版本的连续范围，不能把前一版开头和后一版末尾混在一起。 */
export function appendPreviewPage(current: PreviewPage, page: PreviewPage): PreviewPage {
  if (current.hash !== page.hash || current.endByte !== page.startByte)
    throw { code: 'PREVIEW_CHANGED', message: '文件已改变，正在重新读取。' };
  return { ...page, ...(current.startByte === undefined ? {} : { startByte: current.startByte }), text: (current.text ?? '') + (page.text ?? '') };
}
