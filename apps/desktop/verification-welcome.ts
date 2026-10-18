import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserWindow} from 'electron';

export async function verifyWelcomeLayout(win:BrowserWindow,dataRoot:string,pass:(name:string,details?:unknown)=>void) {
  const original=await win.webContents.executeJavaScript("({theme:document.documentElement.dataset.theme,material:document.documentElement.dataset.material,right:document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true'})");
  const bounds=win.getBounds();
  const measure=()=>win.webContents.executeJavaScript(`(()=>{
    const main=document.querySelector('.main-area'),c=document.querySelector('.composer'),h=document.querySelector('.welcome-title'),intro=document.querySelector('.empty-conversation'),bar=document.querySelector('.topbar');
    const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
    const luminance=color=>{const values=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
    const color=getComputedStyle(h).color,ink=luminance(color),paper=luminance(getComputedStyle(c).backgroundColor),contrast=(Math.max(ink,paper)+.05)/(Math.min(ink,paper)+.05);
    return {welcome:main.classList.contains('is-welcome'),main:rect(main),composer:rect(c),title:rect(h),intro:rect(intro),extras:intro.querySelectorAll('img,p,small').length,header:rect(bar),font:parseFloat(getComputedStyle(h).fontSize),fontFamily:getComputedStyle(h).fontFamily,color,contrast,shadow:getComputedStyle(c).boxShadow,surfaceShadow:getComputedStyle(document.querySelector('.work-surface')).boxShadow,sendShadow:getComputedStyle(document.querySelector('.send-button')).boxShadow};
  })()`);
  const check=(v:any)=>{
    assert(v.welcome);assert(v.font>=26&&v.font<=32);assert(v.contrast>=4.5);
    assert.equal(v.extras,0);assert(v.title.right<=v.intro.right+1);
    assert(Math.abs((v.title.left+v.title.right-v.composer.left-v.composer.right)/2)<1);
    assert(Math.abs(v.intro.width-v.composer.width)<1);assert(Math.abs(v.intro.left-v.composer.left)<1);
    assert(v.intro.bottom+10<=v.composer.top);
    const center=((v.composer.top+v.composer.bottom)/2-v.header.bottom)/(v.main.bottom-v.header.bottom);
    assert(center>.38&&center<.64,'新会话输入区应在视觉中部：'+center);
    assert(v.composer.bottom<v.main.bottom-40);
    assert.notEqual(v.shadow,'none');assert.notEqual(v.surfaceShadow,'none');assert.equal(v.sendShadow,'none');
  };
  const capture=async(name:string)=>{
    for(let i=0;i<4;i++){try{writeFileSync(join(dataRoot,name),(await win.webContents.capturePage(undefined,{stayAwake:true})).toPNG());return;}catch(error){if(!String(error).includes('UnknownVizError')||i===3)throw error;await delay(100);}}
  };
  const cases=[];
  try {
    await win.webContents.executeJavaScript("if(document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true')document.querySelector('.right-rail-toggle').click();document.documentElement.dataset.material='solid'");
    for(const theme of ['light','dark']){
      await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));
      await delay(280);
      const resting=await measure();check(resting);
      await win.webContents.executeJavaScript("document.querySelector('.composer textarea').focus()");
      await delay(230);const focused=await measure();
      assert.equal(focused.shadow,resting.shadow);assert.equal(focused.composer.height,resting.composer.height);
      await capture('welcome-centered-'+theme+'.png');
      cases.push({theme,...resting});
    }
    win.setSize(1120,720);
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light';document.querySelector('.right-rail-toggle').click()");
    await delay(300);
    const narrow=await measure();check(narrow);await capture('welcome-centered-narrow.png');cases.push({theme:'narrow-preview-open',...narrow});
    // 发送首条消息后还要核验节点身份，不能用第二个表单伪装位置变化。
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.composer textarea').length"),1);
    await win.webContents.executeJavaScript("window.__umiWelcomeInput=document.querySelector('.composer textarea')");
    pass('欢迎单句居中，无图标或小字，浅深对比度与窄区布局契合输入框',cases);
  } finally {
    win.setBounds(bounds);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(original.theme)};document.documentElement.dataset.material=${JSON.stringify(original.material)};if((document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true')!==${original.right})document.querySelector('.right-rail-toggle').click();`);
    await delay(250);
  }
}
