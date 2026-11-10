import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {removeTestRoot} from './fixtures.js';
const script=resolve(dirname(fileURLToPath(import.meta.url)),'../../scripts/prune-dist.mjs');
const put=(root:string,path:string,content='test')=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);return target;};
test('构建清理仅移除失去源码的TS输出，保留现有输出、前端bundle及其它生成资料',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-build-prune-'));try{
  put(root,'package.json','{"name":"umi"}');put(root,'apps/keep.ts');put(root,'apps/view.tsx');
  const keep=['dist/apps/keep.js','dist/apps/view.js','dist/apps/desktop/renderer/app.js','dist/umi-build.json','dist/apps/notes.txt'].map(p=>put(root,p));
  const obsolete=['dist/apps/old.js','dist/apps/old.js.map','dist/apps/old.d.ts','dist/tests/old.test.js'].map(p=>put(root,p));
  const result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  assert(keep.every(p=>existsSync(p)));assert(obsolete.every(p=>!existsSync(p)));assert(existsSync(join(root,'apps/keep.ts')));
 }finally{removeTestRoot(root);}
});
test('构建清理拒绝链接和非Umi目录，计划失败时不先删除前面的文件',()=>{
 const root=mkdtempSync(join(tmpdir(),'umi-build-prune-'));try{
  put(root,'package.json','{"name":"umi"}');const stale=put(root,'dist/apps/a.js'),outside=join(root,'outside');mkdirSync(outside);put(root,'outside/protected.js');
  symlinkSync(outside,join(root,'dist/apps/linked'),process.platform==='win32'?'junction':'dir');
  let result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'});assert.notEqual(result.status,0);assert(existsSync(stale));assert(existsSync(join(outside,'protected.js')));
  put(root,'package.json','{"name":"other"}');result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8'});assert.notEqual(result.status,0);assert(existsSync(stale));
 }finally{removeTestRoot(root);}
});

test('构建清理拒绝生成区域本身的目录链接，不删除区域外文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'umi-build-prune-'));
  try {
    put(root, 'package.json', '{"name":"umi"}');
    const outside = join(root, 'outside');
    const protectedFile = put(root, 'outside/protected.js');
    mkdirSync(join(root, 'dist'));
    symlinkSync(outside, join(root, 'dist/apps'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert(existsSync(protectedFile));
  } finally {
    removeTestRoot(root);
  }
});
