import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopPreferenceStore } from '../apps/desktop/preferences.js';
import { desktopPreferencePatchSchema, dataLocationSchema } from '../packages/protocol/src/desktop-preferences.js';

test('desktop preferences persist independently; malformed data is not overwritten on read',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-ui-prefs-'));
 try {
  let store=new DesktopPreferenceStore(root);
  assert.deepEqual(store.read(),{language:'zh-CN',closeAction:'background',reducedMotion:false,exportDirectory:null});
  assert.deepEqual(desktopPreferencePatchSchema.parse({}),{});
  assert.deepEqual(desktopPreferencePatchSchema.parse({closeAction:'quit'}),{closeAction:'quit'});
  store.save(desktopPreferencePatchSchema.parse({language:'en'}));
  store.save(desktopPreferencePatchSchema.parse({closeAction:'quit'}));
  store=new DesktopPreferenceStore(root);
  assert.equal(store.read().language,'en');assert.equal(store.read().closeAction,'quit');
  store.save({language:undefined,reducedMotion:true});assert.equal(store.read().language,'en');
  assert.equal(desktopPreferencePatchSchema.safeParse({answerLocale:'en'}).success,false);
  assert.equal(desktopPreferencePatchSchema.safeParse({exportDirectory:'C:\\arbitrary'}).success,false);
  assert.equal(dataLocationSchema.safeParse('C:\\arbitrary').success,false);
  assert.equal(dataLocationSchema.safeParse('exports').success,true);
  writeFileSync(join(root,'desktop-preferences.json'),'broken');
  assert.equal(new DesktopPreferenceStore(root).read().closeAction,'background');
  assert.equal(readFileSync(join(root,'desktop-preferences.json'),'utf8'),'broken');
 } finally {rmSync(root,{recursive:true,force:true});}
});
