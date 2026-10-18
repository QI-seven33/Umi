import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopMenuRequestSchema } from '../packages/protocol/src/desktop.js';
import { desktopMenuTemplate } from '../apps/desktop/window-chrome.js';

test('桌面菜单只接受固定名称、整数坐标和既定字段', () => {
  assert(desktopMenuRequestSchema.safeParse({menu:'app',x:20,y:40}).success);
  for (const value of [
    {menu:'shell',x:0,y:0}, {menu:'edit',x:-1,y:40}, {menu:'app',x:0.2,y:40},
    {menu:'app',x:0,y:Infinity}, {menu:'app',x:0,y:0,development:true},
    {menu:'app',x:0,y:0,items:[{role:'toggleDevTools'}]},
  ]) assert(!desktopMenuRequestSchema.safeParse(value).success);
});
test('发行菜单保留关于/退出和原生编辑，拒绝伪造开发菜单', () => {
  let about=0,quit=0;
  const actions={about:()=>{about++;},quit:()=>{quit++;}};
  const items=desktopMenuTemplate('app',false,actions);
  items[0]!.click!(undefined!,undefined!,undefined!);
  items[2]!.click!(undefined!,undefined!,undefined!);
  assert.equal(about,1); assert.equal(quit,1);
  assert.deepEqual(desktopMenuTemplate('edit',false,actions).filter(item=>item.role).map(item=>item.role),['undo','redo','cut','copy','paste','selectAll']);
  assert.throws(()=>desktopMenuTemplate('development',false,actions),{code:'PERMISSION_DENIED'});
  assert.deepEqual(desktopMenuTemplate('development',true,actions).map(item=>item.role),['reload','toggleDevTools']);
});
