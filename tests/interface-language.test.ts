import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../apps/desktop/renderer/src/Timeline.js';
import {setUiLanguage,t} from '../apps/desktop/renderer/src/ui-language.js';
test('UI language changes controls while preserving original chat Markdown and code',()=>{
 try {
  setUiLanguage('en');assert.equal(t('新对话'),'New chat');
  const original='原始中文 **重点**\n\n```text\n原始代码内容\n```';
  const html=renderToStaticMarkup(createElement(Markdown,{text:original,mounts:[],onPreview:()=>{}}));
  assert(html.includes('原始中文'));assert(html.includes('<strong>重点</strong>'));assert(html.includes('原始代码内容'));assert(html.includes('Copy code'));
  assert.equal(t('移除 {name}',{name:'我的中文文件.txt'}),'Remove 我的中文文件.txt');
 } finally {setUiLanguage('zh-CN');}
});
