import assert from 'node:assert/strict';
import { app, Menu, desktopCapturer, nativeTheme, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TITLE_BAR_HEIGHT } from './window-chrome.js';

export async function verifyWindowChrome(
  win: BrowserWindow, dataRoot: string,
  pass: (name: string, details?: unknown) => void,
) {
  const wait = async (check: () => Promise<boolean>) => {
    for(let i=0;i<60;i++) { if(await check())return;await delay(50); }
    throw Error('顶栏条件未满足');
  };
  await wait(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.titlebar-menu').length===${app.isPackaged?2:3}`));
  assert.equal(Menu.getApplicationMenu(),null);
  assert.equal(win.isMenuBarVisible(),false);

  if(app.isPackaged) {
    win.webContents.openDevTools({mode:'detach'});
    await delay(100);
    assert.equal(win.webContents.isDevToolsOpened(),false);
  }
  const menus=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.titlebar-menu')).map(n=>n.textContent)`);
  assert.deepEqual(menus,app.isPackaged?['应用','编辑']:['应用','编辑','开发']);
  const rejected=await win.webContents.executeJavaScript(`(async()=>{
    const requests=[{menu:'shell',x:0,y:0},{menu:'app',x:-1,y:0},{menu:'app',x:0,y:0,items:[]}];
    if(${app.isPackaged})requests.push({menu:'development',x:0,y:0});
    const codes=[];for(const request of requests){try{await window.umi.showMenu(request);codes.push('accepted');}catch(error){codes.push(error.code);}}return codes;
  })()`);
  assert.deepEqual(rejected,['PROTOCOL_INVALID','PROTOCOL_INVALID','PROTOCOL_INVALID',...(app.isPackaged?['PERMISSION_DENIED']:[])]);
  pass('真实打包状态决定开发入口，发行版禁用调试且固定菜单桥拒绝伪造请求',{packaged:app.isPackaged,menus,rejected});

  const originalTheme = nativeTheme.themeSource;
  const originalPageTheme = await win.webContents.executeJavaScript("document.documentElement.dataset.theme");
  const styles = [];
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    for (const theme of ['light','dark']) {
      nativeTheme.themeSource = theme as 'light' | 'dark';
      await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));
      await delay(260);
      const resting = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.app-titlebar button')).map(n=>({name:n.textContent||n.getAttribute('aria-label'),expanded:n.getAttribute('aria-expanded'),background:getComputedStyle(n).backgroundColor,shadow:getComputedStyle(n).boxShadow,filter:getComputedStyle(n).filter}))`);
      for(const button of resting){assert.equal(button.background,'rgba(0, 0, 0, 0)');assert.equal(button.shadow,'none');assert.equal(button.filter,'none');}
      const doc = await win.webContents.debugger.sendCommand('DOM.getDocument');
      const node = await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.left-title-toggle'});
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['hover']});
      await delay(180);
      const hover = await win.webContents.executeJavaScript(`(()=>{const n=document.querySelector('.left-title-toggle'),s=getComputedStyle(n);return {background:s.backgroundColor,shadow:s.boxShadow,filter:s.filter,transform:s.transform};})()`);
      assert.equal(hover.shadow,'none');assert.equal(hover.filter,'none');assert.equal(hover.transform,'none');
      assert.notEqual(hover.background,'rgba(0, 0, 0, 0)');
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[]});
      await delay(180);
      const restored = await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.left-title-toggle')).backgroundColor");
      assert.equal(restored,'rgba(0, 0, 0, 0)');
      styles.push({theme,resting,hover});
      // capturePage 不含原生按钮；只保存本验收窗口的桌面捕获，其他窗口的资料不留存。
      const ownId = win.getMediaSourceId();
      const frames = await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:1920,height:1280},fetchWindowIcons:false});
      const own = frames.find(frame=>frame.id===ownId);
      assert(own && !own.thumbnail.isEmpty(),'需要包含原生标题按钮的本窗口截图');
      writeFileSync(join(dataRoot,'titlebar-native-'+theme+'.png'),own.thumbnail.toPNG());
    }
  } finally {
    win.webContents.debugger.detach();
    nativeTheme.themeSource = originalTheme;
    await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(originalPageTheme));
    await delay(260);
  }
  pass('浅深主题顶栏静止透明、展开无常驻灰底、悬停无投影，原生窗口截图已保存',styles);

  // 原生菜单不能由 capturePage 捕获；观察实际弹出与关闭回调，不用静态 DOM 冒充菜单验收。
  const popup=Menu.prototype.popup;
  let observed: Menu | null=null;
  Menu.prototype.popup=function(options){observed=this;return popup.call(this,options);};
  try {
    for(const kind of ['app','edit']) {
      observed=null;
      await win.webContents.executeJavaScript(`document.querySelector('[data-menu=${kind}]').click()`);
      await wait(async()=>observed!==null);
      const menu=observed as unknown as Menu;
      assert(menu.items.length>=3);
      await wait(()=>win.webContents.executeJavaScript(`document.querySelector('[data-menu=${kind}]').getAttribute('aria-expanded')==='true'`));
      menu.closePopup(win);
      await wait(()=>win.webContents.executeJavaScript(`document.querySelector('[data-menu=${kind}]').getAttribute('aria-expanded')==='false'`));
    }
  } finally { Menu.prototype.popup=popup; }
  pass('应用/编辑原生菜单真实弹出并正常关闭，无重复原生菜单栏');

  const bounds=win.getBounds();
  const layout=()=>win.webContents.executeJavaScript(`(()=>{
    const h=document.querySelector('.app-titlebar'),r=h.getBoundingClientRect(),s=getComputedStyle(h),b=h.querySelector('button'),w=document.querySelector('.work-surface').getBoundingClientRect();
    const overlay=navigator.windowControlsOverlay,area=overlay?.getTitlebarAreaRect();
    return {height:r.height,right:r.right,width:innerWidth,workTop:w.top,drag:s.getPropertyValue('-webkit-app-region'),buttonDrag:getComputedStyle(b).getPropertyValue('-webkit-app-region'),overlay:overlay?.visible,area:area?{x:area.x,width:area.width,height:area.height}:null,shadow:getComputedStyle(b).boxShadow};
  })()`);
  const check=(v:Awaited<ReturnType<typeof layout>>)=>{
    assert.equal(v.height,TITLE_BAR_HEIGHT);assert(v.workTop>=v.height);assert.equal(v.drag,'drag');assert.equal(v.buttonDrag,'no-drag');assert.equal(v.shadow,'none');
    if(process.platform==='win32'){assert.equal(v.overlay,true);assert(v.right<=v.area.x+v.area.width+1);assert(v.width-v.right>=100);}
  };
  const normal=await layout();check(normal);
  win.setSize(840,680);await delay(220);const narrow=await layout();check(narrow);
  writeFileSync(join(dataRoot,'titlebar-narrow.png'),(await win.webContents.capturePage()).toPNG());
  win.maximize();await wait(async()=>win.isMaximized());await delay(180);const maximized=await layout();check(maximized);
  win.unmaximize();await wait(async()=>!win.isMaximized());win.setBounds(bounds);
  win.minimize();await wait(async()=>win.isMinimized());win.restore();win.showInactive();await delay(220);
  assert(!win.isDestroyed());assert(win.isVisible());
  pass('紧凑顶栏为原生窗口按钮留位，最窄/最大化/最小化恢复后顶栏布局正常',{normal,narrow,maximized});
}
