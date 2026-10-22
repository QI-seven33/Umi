import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AgentBroker } from './broker.js';

export async function verifyRunContinuity(broker:AgentBroker, win:BrowserWindow, parent:string, dataRoot:string) {
  const until=async(read:()=>Promise<any>,test:(value:any)=>boolean)=>{
    for(let i=0;i<160;i++){const value=await read();if(test(value))return value;await delay(100);}
    throw Error('运行连续性桌面验收未满足');
  };
  const created=await broker.request({type:'new_conversation',conversationId:parent}) as {conversationId:string},cid=created.conversationId;
  const snapshot=()=>broker.request({type:'snapshot',conversationId:cid}) as Promise<any>;
  const reload=async()=>{
    const loaded=new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
    await win.webContents.executeJavaScript(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(cid)});location.reload();`);
    await loaded;await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.composer textarea:not(:disabled)')`),Boolean);
  };
  const settings=async()=>{
    await win.webContents.executeJavaScript(`document.querySelector('.profile-trigger').click()`);
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.profile-menu [role=menuitem]:last-child')`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('.profile-menu [role=menuitem]:last-child').click()`);
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[data-category=conversation]')`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('[data-category=conversation]').click()`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.settings-heading h1')?.textContent==='会话'`),Boolean);
  };
  const send=async(text:string)=>(await broker.request({type:'send',conversationId:cid,commandId:randomUUID(),text,attachmentIds:[]}) as {runId:string}).runId;
  const names:string[]=[];
  await reload();await settings();
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[aria-label="本轮输出预算"]')===null`),true);
  assert.equal((await snapshot()).settings.runOutputTokenLimit??null,null);
  names.push('正常会话无轮数、耗时或输出预算输入框，默认不限');
  await broker.request({type:'settings',conversationId:cid,settings:{...(await snapshot()).settings,runOutputTokenLimit:24}});
  await reload();await settings();
  await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="取消旧版输出限制"]')`),Boolean);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('input[aria-label="本轮输出预算"]')===null`),true);
  names.push('旧版显式限制如实展示，提供解除入口而不继续推广设置');
  await win.webContents.executeJavaScript(`document.querySelector('.settings-page-back').click()`);
  const runId=await send('预算结束验证');
  await until(snapshot,s=>s.state.runs[runId]?.code==='RUN_OUTPUT_BUDGET');
  await until(()=>win.webContents.executeJavaScript(`document.body.innerText`),s=>s.includes('24 / 24')&&s.includes('Umi 执行说明'));
  await reload();await until(()=>win.webContents.executeJavaScript(`document.body.innerText`),s=>s.includes('24 / 24')&&s.includes('累计输出预算'));
  names.push('预算暂停具有真实执行说明和累计用量，重载后仍显示');
  await settings();await win.webContents.executeJavaScript(`document.querySelector('[aria-label="取消旧版输出限制"]').click()`);await until(snapshot,s=>s.settings.runOutputTokenLimit===null);await win.webContents.executeJavaScript(`document.querySelector('.settings-page-back').click()`);
  assert.equal(await send('结束说明继续验证'),runId);await until(snapshot,s=>s.state.runs[runId]?.status==='completed');
  await until(()=>win.webContents.executeJavaScript(`document.body.innerText`),s=>s.includes('按新要求继续完成')&&s.includes('累计输出预算'));
  names.push('解除预算后继续原运行，新答复与旧暂停记录同时保留');
  const failedRun=await send('只有思考结束验证');await until(snapshot,s=>s.state.runs[failedRun]?.status==='failed');
  await until(()=>win.webContents.executeJavaScript(`document.body.innerText`),s=>s.includes('模型未给出可用正文'));
  await reload();await until(()=>win.webContents.executeJavaScript(`document.body.innerText`),s=>s.includes('模型未给出可用正文'));
  names.push('只有思考的响应明确失败，宿主答复跨重载保留');
  writeFileSync(join(dataRoot,'run-continuity.png'),(await win.webContents.capturePage()).toPNG());
  return names;
}
