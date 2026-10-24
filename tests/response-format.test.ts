import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../apps/desktop/renderer/src/Timeline.js';
import {resolveFileReference} from '../apps/desktop/renderer/src/file-links.js';
const mounts=[{mountId:'project',resourceId:'resource',sourceRoot:'C:\\项目\\微型世界'},{mountId:'external',sourceRoot:'D:\\other'}];
const render=(text:string)=>renderToStaticMarkup(React.createElement(Markdown,{text,mounts,onPreview:()=>{}}));
test('预览链接解析已授权绝对路径、空格/中文、逻辑句柄和文件URL，多个根不猜测',()=>{
 for(const value of ['C:\\项目\\微型世界\\有 空格.html','c:/项目/微型世界/有 空格.html','file:///C:/%E9%A1%B9%E7%9B%AE/微型世界/有%20空格.html','@working/project/有 空格.html','@working/resource/有 空格.html'])
  assert.deepEqual(resolveFileReference(value,mounts),{mountId:'project',path:'有 空格.html'},value);
 assert.equal(resolveFileReference('a.html',mounts),null);assert.deepEqual(resolveFileReference('a.html',mounts.slice(0,1)),{mountId:'project',path:'a.html'});
 for(const value of ['C:/项目/微型世界-other/a.html','C:/秘密/a.html','@working/missing/a.html','@working/project/../a.html','C:/项目/微型世界/../a.html','file:///C:/项目/微型世界/../a.html','javascript:alert(1)','data:text/html,test'])assert.equal(resolveFileReference(value,mounts),null,value);
});
test('文件链接在粗体、表格与代码中可预览；未知file路径不转外部跳转',()=>{
 const html=render('**[预览文件](@working/project/a.html)**\n\n`C:\\项目\\微型世界\\a.html`\n\n| 文件 | 结果 |\n| --- | --- |\n| [查看](@working/project/a.html) | **完成** |\n\n[未知](file:///C:/secret.txt)\n\n[危险](javascript:alert(1))');
 assert.equal((html.match(/aria-label="预览文件：a.html"/g)??[]).length,3);assert(html.includes('<strong><button'));assert(html.includes('message-table-scroll'));assert(!html.includes('href="file:'));assert(!html.includes('href="javascript:'));
});
test('中文标点重点加粗，代码与转义星号原样保留',()=>{
 const html=render('**结论：**已恢复；**“重点”**内容。\n\n\\*\\*结论：\\*\\*这是转义。\n\n`**结论：**代码`\n\n```text\n**结论：**代码块\n```');
 assert(html.includes('<strong>结论：</strong>'));assert(html.includes('<strong>“重点”</strong>'));assert(html.includes('**结论：**这是转义'));assert(html.includes('**结论：**代码'));assert(html.includes('**结论：**代码块'));
});

test('单行无语言代码围栏仍是代码块，不会变成文件预览按钮',()=>{
 const html=render('```\n@working/project/a.html\n```');
 assert(html.includes('code-block'));assert(!html.includes('aria-label="预览文件：'));
 assert(html.includes('@working/project/a.html'));
});

test('嵌套围栏和跨行行内代码不泄漏中文强调修补符，不改变代码字节',()=>{
 const source='> ```text\n> **结论：**嵌套代码\n> ```\n\n- 项目\n\n  ```text\n  **“重点”**列表代码\n  ```\n\n`跨行\n**结论：**仍是代码`';
 const html=render(source);
 assert(!html.includes('\uE000'));assert(!html.includes('<strong>'));
 assert(html.includes('**结论：**嵌套代码'));assert(html.includes('**“重点”**列表代码'));assert(html.includes('**结论：**仍是代码'));
});
