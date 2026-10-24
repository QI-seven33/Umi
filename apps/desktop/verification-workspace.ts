import {UmiError} from '../../packages/protocol/src/model.js';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserWindow} from 'electron';
import type {AgentBroker} from './broker.js';

export async function verifyWorkspaceDeletion(broker:AgentBroker,win:BrowserWindow,dataRoot:string) {
 const names:string[]=[],workspace=dataRoot+'-workspace-delete';mkdirSync(workspace);writeFileSync(join(workspace,'keep.txt'),'源文件始终保留');
 const until=async(read:()=>Promise<any>,test:(value:any)=>boolean)=>{for(let i=0;i<160;i++){const value=await read();if(test(value))return value;await delay(100);}throw Error('工作区删除桌面验收未满足');};
 const first=await broker.request({internal:'create_internal',payload:{workspace}}) as {conversationId:string;workspaceId:string;environmentId:string};
 const second=await broker.request({internal:'create_internal',payload:{workspace}}) as {conversationId:string;environmentId:string};
 await broker.request({type:'archive',conversationId:first.conversationId});
 const others=(await broker.request({type:'list',archived:false}) as any[]).filter(row=>row.workspaceId!==first.workspaceId).map(row=>row.id);
 const reload=async()=>{
  const loaded=new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
  await win.webContents.executeJavaScript("localStorage.setItem('umi.work.activeThread',"+JSON.stringify(second.conversationId)+");location.reload()");
  await loaded;await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.composer textarea:not(:disabled)')"),Boolean);
 };
 await reload();
 await win.webContents.executeJavaScript("document.querySelector('.workspace-group.active [data-menu-trigger=workspace]').click()");
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('[aria-label=工作区菜单]')"),Boolean);
 await until(()=>win.webContents.executeJavaScript("Number(getComputedStyle(document.querySelector('.workspace-group.active .workspace-more')).opacity)"),value=>value===1);
 await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
 const layout=await win.webContents.executeJavaScript("(()=>{const row=document.querySelector('.workspace-group.active .workspace-row'),more=row.querySelector('.workspace-more'),fresh=row.querySelector('.workspace-new-chat:not(.workspace-more)'),menu=row.querySelector('.workspace-item-menu'),a=more.getBoundingClientRect(),b=fresh.getBoundingClientRect();return {left:a.left< b.left,width:a.width,height:a.height,freshWidth:b.width,freshHeight:b.height,shadow:getComputedStyle(menu).boxShadow,sidebar:document.querySelector('.left-sidebar').getBoundingClientRect().width};})()");
 assert(layout.left);assert.equal(layout.width,layout.freshWidth);assert.equal(layout.height,layout.freshHeight);assert.equal(layout.shadow,'none');assert.equal(layout.sidebar,232);
 writeFileSync(join(dataRoot,'workspace-menu-preview.png'),(await win.webContents.capturePage()).toPNG());names.push('工作区行在新会话按钮左侧显示同尺寸管理按钮，使用会话菜单与原232px侧栏');
 await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('[aria-label=工作区菜单] button')).find(n=>n.textContent==='目录权限').click()");
 await until(()=>win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.workspace-access-dialog button')).some(n=>n.textContent==='撤销授权')"),Boolean);
 await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.workspace-access-dialog button')).find(n=>n.textContent==='撤销授权').click()");
 await until(()=>broker.request({type:'list_directory_access',conversationId:second.conversationId}),grants=>(grants as any[]).some(g=>g.revoked));
 await win.webContents.executeJavaScript("document.querySelector('.workspace-access-dialog .umi-confirm-actions button').click()");
 await until(()=>win.webContents.executeJavaScript("!document.querySelector('.workspace-access-dialog')"),Boolean);
 names.push('目录权限从工作区菜单管理，实际撤销后同工作区授权事实更新，旧顶部卡片无需保留');
 await win.webContents.executeJavaScript("document.querySelector('.workspace-group.active [data-menu-trigger=workspace]').click()");
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('[aria-label=工作区菜单]')"),Boolean);
 await win.webContents.executeJavaScript("document.querySelector('[aria-label=工作区菜单] .archive-delete').click()");
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.workspace-delete-confirm')"),Boolean);
 assert.equal(await win.webContents.executeJavaScript("document.activeElement.textContent"),'取消');
 await win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm button').click()");
 await until(()=>win.webContents.executeJavaScript("!document.querySelector('.workspace-delete-confirm')"),Boolean);
 assert((await broker.request({type:'list',archived:true}) as any[]).some(row=>row.id===first.conversationId));
 assert((await broker.request({type:'list',archived:false}) as any[]).some(row=>row.id===second.conversationId));names.push('工作区删除确认默认聚焦取消，取消后草稿与归档会话完整保留');
 await win.webContents.executeJavaScript("localStorage.setItem('umi.pending.'+"+JSON.stringify(first.conversationId)+",'待发');localStorage.setItem('umi.feedback.'+"+JSON.stringify(second.conversationId)+"+'.message','like');document.querySelector('.workspace-group.active [data-menu-trigger=workspace]').click()");
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('[aria-label=工作区菜单]')"),Boolean);
 await win.webContents.executeJavaScript("document.querySelector('[aria-label=工作区菜单] .archive-delete').click()");
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.workspace-delete-confirm')"),Boolean);
 writeFileSync(join(dataRoot,'workspace-delete-preview.png'),(await win.webContents.capturePage()).toPNG());
 // 注入的仅是管理响应丢失；真实删除已经由原worker提交，renderer须查询完成凭据。
 const originalRequest=broker.request.bind(broker);let lostReceipt=false,statusQueries=0;
 broker.request=async payload=>{
  const result=await originalRequest(payload);
  if(!('internal' in payload)&&payload.type==='workspace_deletion_status'&&payload.workspaceId===first.workspaceId)statusQueries++;
  if(!lostReceipt&&!('internal' in payload)&&payload.type==='delete_workspace'&&payload.workspaceId===first.workspaceId){lostReceipt=true;throw new UmiError('COMMAND_TIMEOUT','verification: deletion response lost');}
  return result;
 };
 await win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm .workspace-delete').click()");
 await until(()=>win.webContents.executeJavaScript("!document.querySelector('.workspace-delete-confirm')"),Boolean);
 broker.request=originalRequest;assert(lostReceipt);assert.equal(statusQueries,1);
 names.push('真实删除提交后丢失响应，界面查询原工作区完成凭据并收敛，没有重发删除');
 const rows=await broker.request({type:'list',archived:false}) as any[],archived=await broker.request({type:'list',archived:true}) as any[];
 assert(![...rows,...archived].some(row=>row.workspaceId===first.workspaceId));assert.deepEqual(rows.map(row=>row.id).sort(),others.sort());
 assert.equal(readFileSync(join(workspace,'keep.txt'),'utf8'),'源文件始终保留');
 assert(!existsSync(join(dataRoot,'agent','environments',first.environmentId)));assert(!existsSync(join(dataRoot,'agent','environments',second.environmentId)));
 assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('umi.pending.'+"+JSON.stringify(first.conversationId)+")"),null);
 assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('umi.feedback.'+"+JSON.stringify(second.conversationId)+"+'.message')"),null);
 await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.composer textarea:not(:disabled)')"),Boolean);
 assert.notEqual(await win.webContents.executeJavaScript("localStorage.getItem('umi.work.activeThread')"),second.conversationId);
 names.push('确认后整组工作区及归档、草稿、本机反馈消失，源文件与其他工作区保留并自动切换');
 // 仅有一个空草稿的工作区也可删；删除最后一个工作区后仍能从加号重新选择目录。
 const last=rows[0]!.workspaceId;
 if(rows.every(row=>row.workspaceId===last)){
  await win.webContents.executeJavaScript("document.querySelector('.workspace-group.active [data-menu-trigger=workspace]').click()");
  await until(()=>win.webContents.executeJavaScript("!!document.querySelector('[aria-label=工作区菜单]')"),Boolean);
  await win.webContents.executeJavaScript("document.querySelector('[aria-label=工作区菜单] .archive-delete').click()");
  await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.workspace-delete-confirm')"),Boolean);
  // 前面的通用验收刻意留下等待批准的会话；先证明整组删除不会绕过它们。
  const activeRuns=[] as {conversationId:string;runId:string}[];
  for(const row of [...rows,...archived].filter(row=>row.workspaceId===last)) {
    const snapshot=await broker.request({type:'snapshot',conversationId:row.id}) as any;
    for(const [runId,run] of Object.entries(snapshot.state.runs) as [string,{status:string}][])
      if(['queued','running','waiting_permission','stopping','recovering'].includes(run.status))activeRuns.push({conversationId:row.id,runId});
  }
  if(activeRuns.length){
    await win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm .workspace-delete').click()");
    await until(()=>win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm [role=alert]')?.textContent"),value=>typeof value==='string'&&value.includes('任务'));
    assert.equal((await broker.request({type:'list',archived:false}) as any[]).length,rows.length);
    names.push('其他会话等待批准时整组删除被拒绝，工作区与会话完整保留');
    await win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm button').click()");
    await until(()=>win.webContents.executeJavaScript("!document.querySelector('.workspace-delete-confirm')"),Boolean);
    for(const run of activeRuns){
      await broker.request({type:'stop',...run});
      await until(()=>broker.request({type:'snapshot',conversationId:run.conversationId}),snapshot=>!['queued','running','waiting_permission','stopping','recovering'].includes(snapshot.state.runs[run.runId].status));
    }
    await win.webContents.executeJavaScript("document.querySelector('.workspace-group.active [data-menu-trigger=workspace]').click()");
    await until(()=>win.webContents.executeJavaScript("!!document.querySelector('[aria-label=工作区菜单]')"),Boolean);
    await win.webContents.executeJavaScript("document.querySelector('[aria-label=工作区菜单] .archive-delete').click()");
    await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.workspace-delete-confirm')"),Boolean);
  }
  await win.webContents.executeJavaScript("document.querySelector('.workspace-delete-confirm .workspace-delete').click()");
  await until(()=>win.webContents.executeJavaScript("document.querySelector('.workspace-empty')?.textContent"),value=>value==='暂无工作区');
  assert.equal((await broker.request({type:'list',archived:false}) as any[]).length,0);assert.equal(await win.webContents.executeJavaScript("!!document.querySelector('[aria-label=新建工作区]:not(:disabled)')"),true);
  names.push('删除最后一个工作区后正确回到空态，保留新建工作区入口');
 }
 return names;
}
