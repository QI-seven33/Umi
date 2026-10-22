import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldSend,readSendShortcut} from '../apps/desktop/renderer/src/features/settings/input-preferences.js';
test('发送快捷键支持多行与平台修饰键，不误发输入法选词、Shift或Alt组合',()=>{
 const enter={key:'Enter',shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,isComposing:false,keyCode:13};
 assert(shouldSend(enter,'enter'));assert(!shouldSend(enter,'mod-enter'));
 for(const mode of ['enter','mod-enter'] as const){
  assert(shouldSend({...enter,ctrlKey:true},mode));assert(shouldSend({...enter,metaKey:true},mode));
  for(const patch of [{shiftKey:true},{altKey:true},{isComposing:true},{keyCode:229},{key:'a'}])assert(!shouldSend({...enter,ctrlKey:true,...patch},mode));
 }
 assert.equal(readSendShortcut({getItem:()=>null}),'enter');assert.equal(readSendShortcut({getItem:()=>'{broken'}),'enter');assert.equal(readSendShortcut({getItem:()=>{throw Error('denied');}}),'enter');assert.equal(readSendShortcut({getItem:()=>'mod-enter'}),'mod-enter');
});
