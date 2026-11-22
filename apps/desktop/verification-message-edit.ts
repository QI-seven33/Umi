import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { AgentBroker } from './broker.js';
import type { Snapshot } from './renderer/src/transport.js';

export async function verifyMessageEditing(broker: AgentBroker, win: BrowserWindow, dataRoot: string) {
  const names: string[] = [], workspace = dataRoot + '-message-edit-workspace';
  mkdirSync(workspace); writeFileSync(join(workspace, 'keep.txt'), '源文件不会因消息编辑回退');
  const until = async <T>(read: () => Promise<T>, check: (value: T) => boolean) => {
    for (let i = 0; i < 180; i++) { const value = await read(); if (check(value)) return value; await delay(80); }
    throw new Error('消息编辑桌面验收等待失败');
  };
  const c = await broker.request({ internal: 'create_internal', payload: { workspace } }) as { conversationId: string };
  const snapshot = () => broker.request({ type: 'snapshot', conversationId: c.conversationId }) as Promise<Snapshot>;
  for (const prompt of ['快速提交验证：保留第一条', '快速提交验证：待编辑第二条', '快速提交验证：后续第三条']) {
    const r = await broker.request({ type: 'send', conversationId: c.conversationId, commandId: randomUUID(), text: prompt, attachmentIds: [] }) as { runId: string };
    await until(snapshot, s => s.state.runs[r.runId]?.status === 'completed');
  }
  if (win.webContents.isLoading()) await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
  const loaded = new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
  await win.webContents.executeJavaScript(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(c.conversationId)});location.reload()`);
  await loaded; win.showInactive(); win.webContents.setBackgroundThrottling(false);
  await until(() => win.webContents.executeJavaScript(`document.querySelectorAll('.message.user [aria-label="编辑消息"]').length`), n => n === 3);
  names.push('历史用户消息有真实编辑入口，保留复制操作');
  const begin = () => win.webContents.executeJavaScript(`document.querySelectorAll('.message.user [aria-label="编辑消息"]')[1].click()`);
  const enter = (value: string) => win.webContents.executeJavaScript(`(() => {const input=document.querySelector('.umi-message-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await begin(); await until(() => win.webContents.executeJavaScript(`document.querySelector('.umi-message-editor textarea')?.value`), value => value === '快速提交验证：待编辑第二条');
  await enter('取消的草稿');
  await win.webContents.executeJavaScript(`document.querySelector('.umi-message-edit-actions button[type=button]').click()`);
  assert.equal((await snapshot()).messages[1]!.payload.content, '快速提交验证：待编辑第二条');
  names.push('编辑原文与取消实际可用，取消不产生新任务');
  await begin(); await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.umi-message-editor textarea')`), Boolean);
  await enter('快速提交验证：更正后的第二条');
  const style = await win.webContents.executeJavaScript(`(() => {const form=document.querySelector('.umi-message-editor'),input=form.querySelector('textarea'),button=form.querySelector('.is-primary'),note=form.querySelector('.umi-message-edit-note'),actions=form.querySelector('.umi-message-edit-actions');return {note:note.textContent,radius:getComputedStyle(form).borderRadius,font:getComputedStyle(input).fontSize,shadow:getComputedStyle(form).boxShadow,inputBackground:getComputedStyle(input).backgroundColor,inputBorder:getComputedStyle(input).borderWidth,inputShadow:getComputedStyle(input).boxShadow,autoSize:CSS.supports('field-sizing','content'),footerShared:note.parentElement===actions.parentElement,overflow:form.scrollWidth>form.clientWidth};})()`);
  assert(style.note.includes('已有文件和命令效果保留')); assert.equal(style.radius, '20px'); assert.equal(style.font, '14px'); assert.equal(style.shadow, 'none');
  assert.equal(style.inputBackground,'rgba(0, 0, 0, 0)'); assert.equal(style.inputBorder,'0px'); assert.equal(style.inputShadow,'none'); assert(style.footerShared && style.autoSize && !style.overflow);
  await delay(120); writeFileSync(join(dataRoot, 'message-edit-preview.png'), (await win.webContents.capturePage()).toPNG());
  names.push('一体式蓝色编辑气泡：透明无边框输入、同层页脚、内容自适应，无额外阴影');
  await win.webContents.executeJavaScript(`const button=document.querySelector('.umi-message-edit-actions button[type=submit]');button.click();button.click()`);
  const result = await until(snapshot, s => s.messages.length === 2 && s.messages[1]?.payload.content === '快速提交验证：更正后的第二条' && s.state.runs[s.messages[1].runId]?.status === 'completed');
  assert.equal(result.state.revisions?.length, 1); assert.equal(Object.keys(result.state.runs).length, 4);
  assert.equal(result.messages[0]!.payload.content, '快速提交验证：保留第一条');
  await until(() => win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.message.user .message-body')).map(node=>node.textContent)`), values => values.length === 2 && values[1] === '快速提交验证：更正后的第二条');
  assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), '源文件不会因消息编辑回退');
  names.push('连续点击仅建立一次修订；后续旧聊天退出实时视图，新任务完成且源文件保留');
  return names;
}
