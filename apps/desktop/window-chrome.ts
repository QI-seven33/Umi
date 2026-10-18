import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuRequest } from '../../packages/protocol/src/desktop.js';
import { UmiError } from '../../packages/protocol/src/model.js';

export const TITLE_BAR_HEIGHT = 40;

/** 菜单内容归主进程；发行判断来自 app.isPackaged，不接受页面传入的开发标记。 */
export function desktopMenuTemplate(
  menu: DesktopMenuRequest['menu'],
  development: boolean,
  actions: { about: () => void; quit: () => void },
): MenuItemConstructorOptions[] {
  switch (menu) {
    case 'app':
      return [
        { label: '关于 Umi', click: actions.about },
        { type: 'separator' },
        { label: '退出 Umi', click: actions.quit },
      ];
    case 'edit':
      return [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' }, { role: 'selectAll', label: '全选' },
      ];
    case 'development':
      if (!development) throw new UmiError('PERMISSION_DENIED', '发行版不提供开发菜单');
      return [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }];
  }
}
