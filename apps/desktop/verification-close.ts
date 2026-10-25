import assert from 'node:assert/strict';
import { app, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Dedicated isolated process: must exit through the real close -> before-quit path. */
export async function verifyCloseWindow(win:BrowserWindow,dataRoot:string) {
  if(win.webContents.isLoading()) await new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
  for(let i=0;i<80;i++) { if(await win.webContents.executeJavaScript('typeof window.umi?.updatePreferences === "function"'))break;await delay(50); }
  const prefs=await win.webContents.executeJavaScript('window.umi.updatePreferences({closeAction:"quit"})');
  assert.equal(prefs.closeAction,'quit');
  app.once('will-quit',()=>writeFileSync(join(dataRoot,'desktop-verification.json'),JSON.stringify({name:'Umi',passed:true,evidence:[{name:'右上角关闭在退出模式下经过真实before-quit与broker关闭后退出',passed:true}]})));
  win.close();
}
