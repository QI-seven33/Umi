import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { AgentBroker } from './broker.js';

export async function verifyInterface(broker:AgentBroker,win:BrowserWindow,dataRoot:string) {
 const names:string[]=[];
 const js=(s:string)=>win.webContents.executeJavaScript(s);
 const until=async(read:()=>Promise<any>,test:(v:any)=>boolean)=>{for(let i=0;i<100;i++){const v=await read();if(test(v))return v;await delay(70);}throw Error('Interface condition failed: '+read.toString());};
 const click=async(selector:string)=>{await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),Boolean).catch(()=>{throw Error('Missing UI control: '+selector);});await js(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(40);};
 const setInput=async(selector:string,value:string)=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const choose=async(label:string,index:number)=>{await click(`[role=combobox][aria-label="${label}"]`);await click(`.ui-select-popup [data-index="${index}"]`);};
 const rows=await broker.request({type:'list',archived:false}) as any[],target=rows.find(row=>row.hasMessages);assert(target);
 await js(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(target.id)})`);
 const initialLoad=new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
 win.webContents.reload();await initialLoad;await until(()=>js("!!document.querySelector('.workspace-conversation')"),Boolean);
 await click('.workspace-conversation-wrap.active .conversation-more');await click('.rename-conversation');
 const title='UI验证 · 保留中文标题 · '+ 'Long title for hover scrolling '.repeat(3).trim();
 await setInput('.rename-dialog input',title);await js("document.querySelector('.rename-dialog form').requestSubmit()");
 await until(()=>broker.request({type:'list',archived:false}),list=>list.some((row:any)=>row.id===target.id&&row.title===title));
 await until(()=>js("!document.querySelector('.rename-dialog')"),Boolean);
 assert.equal(await js("!!document.querySelector('.conversation-search input')"),false);
 const searchLayout=await js("(()=>{const search=document.querySelector('.workspace-search-toggle').getBoundingClientRect(),create=document.querySelector('[aria-label=新建工作区]').getBoundingClientRect();return {search:search.toJSON(),create:create.toJSON()};})()");
 assert.equal(searchLayout.search.width,searchLayout.create.width);assert.equal(searchLayout.search.height,searchLayout.create.height);assert(searchLayout.search.right<=searchLayout.create.left);
 await click('.workspace-search-toggle');assert.equal(await js("document.activeElement===document.querySelector('.conversation-search input')"),true);
 await setInput('.conversation-search input','不存在的标题UI123');
 await until(()=>js("document.querySelectorAll('.workspace-conversation').length"),v=>v===0);
 await setInput('.conversation-search input','保留中文标题');
 await until(()=>js("document.querySelectorAll('.workspace-conversation').length"),v=>v===1);
 const overflow=await js("(()=>{const e=document.querySelector('.overflow-title');return {overflow:e.classList.contains('overflows'),text:e.textContent,title:e.title};})()");
 assert(overflow.overflow);assert.equal(overflow.text,title);assert.equal(overflow.title,title);
 if(!await js('matchMedia("(prefers-reduced-motion: reduce)").matches')) {
   const rect=await js("document.querySelector('.workspace-conversation').getBoundingClientRect().toJSON()");
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rect.x+8),y:Math.round(rect.y+8)});await delay(850);
   const measure=()=>js("(()=>{const s=getComputedStyle(document.querySelector('.overflow-title>span'));return {name:s.animationName,transform:s.transform};})()");
   let animation=await measure();
   // A background test window need not receive native hover. Verify that state
   // explicitly through Chromium when the pointer is outside this window.
   if(!await js("document.querySelector('.workspace-conversation').matches(':hover')")) {
     win.webContents.debugger.attach('1.3');
     try {
       await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
       const doc=await win.webContents.debugger.sendCommand('DOM.getDocument');
       const node=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.workspace-conversation'});
       await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['hover']});await delay(850);
       animation=await measure();
       await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:[]});
     } finally {win.webContents.debugger.detach();}
   }
   assert.equal(animation.name,'title-scroll');assert.notEqual(animation.transform,'none');
 }
 names.push('真实重命名经既有入口保存；标题搜索过滤、清空与长标题完整提示正常');
 await click('.conversation-search button');
 await js("document.querySelector('.conversation-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
 await until(()=>js("!!document.querySelector('.conversation-search input')"),v=>v===false);
 assert.equal(await js("document.activeElement===document.querySelector('.workspace-search-toggle')"),true);
 await click('.workspace-search-toggle');await setInput('.conversation-search input','不存在的标题UI123');await click('.workspace-search-toggle');
 await until(()=>js("document.querySelectorAll('.workspace-conversation').length"),v=>v>0);
 await js("document.querySelector('.composer textarea').focus()");
 const inputStyle=await js("(()=>{const s=getComputedStyle(document.querySelector('.composer textarea'));return {outline:s.outlineStyle,shadow:s.boxShadow};})()");
 assert.equal(inputStyle.outline,'none');assert.equal(inputStyle.shadow,'none');
 writeFileSync(join(dataRoot,'composer-no-inner-frame.png'),(await win.webContents.capturePage(undefined,{stayAwake:true})).toPNG());
 names.push('搜索默认收起，同尺寸图标位于新工作区左侧；展开聚焦、Esc收起及关闭清除过滤通过；输入区没有内部焦点方框');
 const before=await broker.request({type:'snapshot',conversationId:target.id}) as any;
 await click('.profile-trigger');await click('.profile-menu [role=menuitem]:last-child');
 await until(()=>js("document.querySelector('[aria-label=界面语言]')?.disabled"),v=>v===false);
 await click('[data-category=skills]');await until(()=>js("document.querySelectorAll('[data-skill] input.ui-switch').length"),v=>v>0);
 const skill=await js("(()=>{const n=document.querySelector('[data-skill] input.ui-switch'),s=getComputedStyle(n);return {name:n.closest('[data-skill]').dataset.skill,checked:n.checked,role:n.getAttribute('role'),appearance:s.appearance,radius:s.borderRadius,width:n.getBoundingClientRect().width};})()");
 assert.equal(skill.role,'switch');assert.equal(skill.appearance,'none');assert.equal(skill.radius,'20px');assert.equal(skill.width,34);
 const selector='[data-skill="'+skill.name+'"] input.ui-switch';await click(selector);
 await until(()=>broker.request({type:'skills_list',refresh:false}),v=>v.skills.some((s:any)=>s.name===skill.name&&s.enabled!==skill.checked));
 await click(selector);await until(()=>broker.request({type:'skills_list',refresh:false}),v=>v.skills.some((s:any)=>s.name===skill.name&&s.enabled===skill.checked));
 await delay(100);writeFileSync(join(dataRoot,'skills-blue-switches.png'),(await win.webContents.capturePage(undefined,{stayAwake:true})).toPNG());
 names.push('技能使用蓝色圆角开关，实际启停保存并恢复原状态');
 await click('[data-category=general]');await until(()=>js("document.querySelector('[aria-label=界面语言]')?.disabled"),v=>v===false);
 // Arrow keys operate the custom combobox; Escape closes without changing selection.
 await js("document.querySelector('[aria-label=主题]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
 assert.equal(await js("!!document.querySelector('.ui-select-popup')"),true);
 const popupStyle=await js("(()=>{const s=getComputedStyle(document.querySelector('.ui-select-popup'));return {shadow:s.boxShadow,radius:s.borderRadius};})()");assert.equal(popupStyle.shadow,'none');assert.equal(popupStyle.radius,'12px');
 await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
 assert.equal(await js("!!document.querySelector('.ui-select-popup')"),false);
 await choose('界面语言',1);await until(()=>js("document.documentElement.lang"),v=>v==='en');
 assert.equal(await js("document.querySelector('.settings-heading h1').textContent"),'General');
 assert.equal(await js("document.querySelector('.new-chat').textContent"),'New chat');
 const after=await broker.request({type:'snapshot',conversationId:target.id}) as any;
 assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.messages,before.messages);
 assert.equal((await broker.request({type:'list',archived:false}) as any[]).find(r=>r.id===target.id).title,title);
 names.push('界面切换英文后菜单即时更新，模型配置、聊天消息和中文历史标题逐项保持不变');
 await choose('When closing the window',1);await until(()=>js('window.umi.preferences()'),p=>p.closeAction==='quit');
 await choose('When closing the window',0);await until(()=>js('window.umi.preferences()'),p=>p.closeAction==='background');
 await click('[aria-label="Reduce motion"]');await until(()=>js('document.documentElement.dataset.reducedMotion'),v=>v==='true');
 win.close();await delay(150);assert(!win.isDestroyed());assert(!win.isVisible());win.showInactive();
 names.push('关闭窗口偏好已保存；后台模式实际隐藏窗口并保持进程，减少动效即时生效');
 await click('[data-category=storage]');await until(()=>js('document.querySelectorAll(".storage-copy code").length'),v=>v===4);
 const info=await js('window.umi.applicationInfo()');assert.equal(info.paths.data,dataRoot);
 await assert.rejects(js('window.umi.updatePreferences({answerLocale:"en"})'));
 await assert.rejects(js('window.umi.updatePreferences({exportDirectory:"C:/arbitrary"})'));
 await assert.rejects(js('window.umi.showDataLocation("C:/arbitrary")'));
 names.push('存储页显示真实隔离目录；固定IPC拒绝任意路径与会话语言字段');
 writeFileSync(join(dataRoot,'ui-storage-en.png'),(await win.webContents.capturePage()).toPNG());
 await click('[data-category=general]');await choose('Theme',2);await choose('Interface language',0);
 await until(()=>js('document.documentElement.lang'),v=>v==='zh-CN');await delay(150);
 writeFileSync(join(dataRoot,'ui-general-dark.png'),(await win.webContents.capturePage()).toPNG());
 await choose('主题',1);await delay(150);writeFileSync(join(dataRoot,'ui-general-light.png'),(await win.webContents.capturePage()).toPNG());
 await choose('界面语言',1);
 const localeReload=new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
 win.webContents.reload();await localeReload;await until(()=>js("document.querySelector('.new-chat')?.textContent"),v=>v==='New chat');
 assert.equal((await js('window.umi.preferences()')).language,'en');
 await click('.profile-trigger');await click('.profile-menu [role=menuitem]:last-child');await until(()=>js("document.querySelector('[aria-label=\"Interface language\"]')?.disabled"),v=>v===false);
 await choose('Interface language',0);await click('[aria-label="减少动态效果"]');await click('.settings-page-back');
 await until(()=>js("!document.querySelector('.settings-page')"),Boolean);
 if(await js("document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')")!=='true')await click('.right-rail-toggle');
 const top=await js("(()=>{const e=document.querySelector('.work-preview-tabs'),s=getComputedStyle(e);return {border:s.borderBottomWidth,height:e.getBoundingClientRect().height};})()");assert(parseFloat(top.border)>0&&parseFloat(top.border)<=1);assert(top.height>0);
 names.push('界面语言刷新后恢复；设置和预览分隔线保留统一边缘');
 return names;
}
