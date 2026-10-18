import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { DesktopMenuRequest } from '../../../../packages/protocol/src/desktop.js';
import { PanelIcon } from './components/ui/PanelIcon.js';
import { userFacingError } from './ui-error.js';

export function TitleBar({ left, onToggle, settingsOpen }: {
  left: boolean; onToggle: () => void; settingsOpen: boolean;
}) {
  const [development, setDevelopment] = useState(false);
  const [open, setOpen] = useState<DesktopMenuRequest['menu'] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void window.umi.windowInfo().then(info => setDevelopment(info.development)).catch(() => {}); }, []);
  const show = async (menu: DesktopMenuRequest['menu'], event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setOpen(menu); setError('');
    try { await window.umi.showMenu({ menu, x: Math.round(bounds.left), y: Math.round(bounds.bottom + 2) }); }
    catch (failure) { setError(userFacingError(failure)); }
    finally { setOpen(null); }
  };
  return <header className="app-titlebar" aria-label="应用顶栏">
    <button type="button" className="sidebar-toggle left-title-toggle" aria-label={left ? '收起侧边栏' : '展开侧边栏'} aria-expanded={left} disabled={settingsOpen} onClick={onToggle}><PanelIcon side="left" /></button>
    <nav aria-label="应用菜单">
      {([{ id: 'app', label: '应用', key: 'a' }, { id: 'edit', label: '编辑', key: 'e' }, ...(development ? [{ id: 'development' as const, label: '开发', key: 'd' }] : [])] as const).map(item =>
        <button type="button" className="titlebar-menu" key={item.id} data-menu={item.id} accessKey={item.key} aria-haspopup="menu" aria-expanded={open === item.id} onClick={event => void show(item.id, event)}>{item.label}</button>
      )}
    </nav>
    {error && <span className="titlebar-error" role="alert">{error}</span>}
  </header>;
}
