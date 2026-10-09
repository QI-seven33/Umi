import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { removeTestRoot, eventually } from './fixtures.js';
import { settingsSchema } from '../packages/protocol/src/model.js';

test('无界面实际入口：Umi 就绪、严格命令、持久设置、输入回执与历史', {timeout:15000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'umi-cli-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../apps/headless/src/cli.js',import.meta.url)),'--data',join(root,'data')],
    {stdio:['pipe','pipe','pipe'],env:{...process.env,DEEPSEEK_API_KEY:''}});
  const rows:Record<string,unknown>[]=[];const output=createInterface({input:child.stdout});output.on('line',line=>rows.push(JSON.parse(line) as Record<string,unknown>));
  child.stderr.on('data',()=>{});const send=(c:unknown)=>child.stdin.write(`${JSON.stringify(c)}\n`);
  try {
    const ready=await eventually(()=>rows.find(r=>r.kind==='ready'));assert.equal(ready.name,'Umi');assert.equal((ready.capabilities as {shell:boolean}).shell,process.platform==='win32');
    assert.equal(ready.databaseVersion,5);assert.equal((ready.capabilities as {osSandbox:boolean}).osSandbox,false);
    send({type:'create',workspace:root});const c=await eventually(()=>rows.find(r=>r.type==='create'));assert.equal(typeof c.conversationId,'string');
    send({type:'settings',conversationId:c.conversationId,settings:settingsSchema.parse({thinking:'high',executionPolicy:'auto'})});
    const settings=await eventually(()=>rows.find(r=>r.type==='settings'));assert.equal((settings.settings as {thinking:string}).thinking,'high');
    send({type:'send',conversationId:c.conversationId,commandId:'cli-command',text:'测试输入'});await eventually(()=>rows.find(r=>r.kind==='ack'&&r.type==='send'));
    send({type:'history',conversationId:c.conversationId});const history=await eventually(()=>rows.find(r=>r.kind==='snapshot'));
    assert.equal((history.messages as {payload:{content:string}}[])[0]?.payload.content,'测试输入');
    send({type:'send',conversationId:c.conversationId,commandId:'cli-command',text:'不同输入'});assert.equal((await eventually(()=>rows.find(r=>r.kind==='error'))).code,'COMMAND_CONFLICT');
    const exited=once(child,'exit');send({type:'shutdown'});await exited;
  }finally{
    output.close();if(child.exitCode===null&&!child.killed){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}removeTestRoot(root);
  }
});
