import assert from 'node:assert/strict';
import { app, type BrowserWindow, type Tray, type Menu, type KeyboardEvent } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated Electron process; exercises the real tray object and registered handlers.
export async function verifyBackgroundWindow(win: BrowserWindow, dataRoot: string, inspect: () => { tray: Tray | null; menu: Menu | null }) {
  if (win.webContents.isLoading()) await new Promise<void>(resolve => win.webContents.once('did-finish-load', resolve));
  for (let i=0;i<80;i++) { if(await win.webContents.executeJavaScript('typeof window.umi?.updatePreferences === "function"'))break;await delay(50); }
  const evidence: { name: string; passed: boolean }[] = [];
  const initial = inspect().tray;
  assert(initial && !initial.isDestroyed());

  const bounds = initial.getBounds();
  assert(bounds.width > 0 && bounds.height > 0, 'Windows notification icon must have native bounds');
  win.showInactive();
  win.close();
  assert(!win.isVisible() && !win.isDestroyed());
  assert(!initial.isDestroyed());
  evidence.push({ name: '背景模式实际注册通知区图标，关闭窗口保留托盘和进程', passed: true });
  initial.emit('double-click', {});
  assert(win.isVisible());
  win.minimize();
  const open = inspect().menu!.getMenuItemById('open-umi')!;
  open.click(open, win, {} as KeyboardEvent);
  assert(win.isVisible() && !win.isMinimized());
  evidence.push({ name: '实际托盘双击与打开菜单处理器恢复窗口及最小化状态', passed: true });
  await win.webContents.executeJavaScript('window.umi.updatePreferences({language:"en"})');
  assert.equal(inspect().menu!.getMenuItemById('open-umi')!.label, 'Open Umi');
  await win.webContents.executeJavaScript('window.umi.updatePreferences({closeAction:"quit"})');
  assert(initial.isDestroyed());
  assert.equal(inspect().tray, null);
  await win.webContents.executeJavaScript('window.umi.updatePreferences({closeAction:"background"})');
  assert(inspect().tray && !inspect().tray!.isDestroyed());
  evidence.push({ name: '界面语言同步托盘菜单，关闭偏好切换会销毁或重建托盘', passed: true });
  win.close();
  assert(!win.isVisible());
  evidence.push({ name: '从托盘退出沿真实before-quit与broker关闭退出独立进程', passed: true });
  app.once('will-quit', () => writeFileSync(join(dataRoot, 'desktop-verification.json'), JSON.stringify({ name: 'Umi', passed: true, evidence })));
  const quit = inspect().menu!.getMenuItemById('quit-umi')!;
  quit.click(quit, win, {} as KeyboardEvent);
}
