import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteStore } from '../packages/adapters/src/sqlite/store.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
const [root, mode] = process.argv.slice(2) as [string, string];
if (mode === 'limit-crash') {
  const app = new UmiApplication(join(root, 'data'), new ScriptModel([call('search_history', { query: 'x' })]), { limits: { maxTurns: 1, maxRetries: 0, modelTimeoutMs: 1000, retryDelayMs: 1 } });
  const c = app.createConversation(root);
  const original = app.store.persistFailureSummary.bind(app.store);
  app.store.persistFailureSummary = (...args) => { original(...args); process.exit(33); };
  const run = app.send(c.conversationId, uid(), '测试轮次上限');
  console.log(JSON.stringify({ conversationId: c.conversationId, runId: run.runId }));
} else if (mode === 'legacy-empty') {
  mkdirSync(join(root, 'writer.starting'));
  console.log(JSON.stringify({ status: 'empty' }));
  process.stdin.once('data', () => {
    try { writeFileSync(join(root, 'writer.starting/owner.json'), JSON.stringify({ pid: process.pid, instanceId: uid() }), { flag: 'wx' }); console.log(JSON.stringify({ status: 'claimed' })); }
    catch { console.log(JSON.stringify({ status: 'blocked' })); }
    process.exit();
  });
} else {
  try {
    const store = new SqliteStore(root);
    console.log(JSON.stringify({ status: 'ready' }));
    process.stdin.once('data', () => { store.close(); process.exit(); });
  } catch (error) { console.log(JSON.stringify({ status: 'blocked', code: (error as { code?: string }).code })); process.exit(); }
}
