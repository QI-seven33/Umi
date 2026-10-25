import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuRequest } from '../../packages/protocol/src/desktop.js';
import { UmiError } from '../../packages/protocol/src/model.js';

export const TITLE_BAR_HEIGHT = 40;

/** 菜单内容归主进程；发行判断来自 app.isPackaged，不接受页面传入的开发标记。 */
export function desktopMenuTemplate(
  menu: DesktopMenuRequest['menu'],
  development: boolean,
  actions: { about: () => void; quit: () => void },
  language: 'zh-CN' | 'en' = 'zh-CN',
): MenuItemConstructorOptions[] {
  const ui = (zh: string, en: string) => language === 'en' ? en : zh;
  switch (menu) {
    case 'app':
      return [
        { label: ui('关于 Umi', 'About Umi'), click: actions.about },
        { type: 'separator' },
        { label: ui('退出 Umi', 'Quit Umi'), click: actions.quit },
      ];
    case 'edit':
      return [
        { role: 'undo', label: ui('撤销', 'Undo') }, { role: 'redo', label: ui('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: ui('剪切', 'Cut') }, { role: 'copy', label: ui('复制', 'Copy') },
        { role: 'paste', label: ui('粘贴', 'Paste') },
        { type: 'separator' }, { role: 'selectAll', label: ui('全选', 'Select all') },
      ];
    case 'development':
      if (!development) throw new UmiError('PERMISSION_DENIED', '发行版不提供开发菜单');
      return [{ role: 'reload', label: ui('重新加载', 'Reload') }, { role: 'toggleDevTools', label: ui('开发者工具', 'Developer tools') }];
  }
}
