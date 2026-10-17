import { replaceFilesSteps } from './file-write-fixtures.js';
import { UmiApplication } from '../apps/headless/src/application.js';
import { ScriptModel, call, eventually } from './fixtures.js';
import { uid } from '../packages/agent/src/identity.js';
import type { PreparedRequest } from '../packages/agent/src/ports.js';

const [data, workspace, mode] = process.argv.slice(2);
if (!data || !workspace || !mode) throw new Error('缺少测试参数');
const lastData = (r: PreparedRequest) =>
  JSON.parse(
    (r.body.messages as { role: string; content: string }[])
      .filter((m) => m.role === 'tool')
      .at(-1)!.content,
  ).data as { changeSetId: string };
let mountId = '',
  conversationId = '',
  environmentId = '',
  runId = '';
const app = new UmiApplication(
  data,
  new ScriptModel([
    ...replaceFilesSteps(
      () => mountId,
      [
        ['a.txt', '新甲'],
        ['b.txt', '新乙'],
      ],
    ),
    () => call('build_changeset', { mountId }),
    (r) => call('deliver_changeset', { changeSetId: lastData(r).changeSetId }),
  ]),
  {
    async deliveryBoundary(point, path) {
      if (
        (mode === point && path === 'a.txt') ||
        (mode === 'all-receipts' && point === 'after-receipt' && path === 'b.txt')
      ) {
        const t = app.store.tools(runId).find((t) => t.name === 'deliver_changeset')!;
        process.send?.({
          conversationId,
          environmentId,
          runId,
          mountId,
          executionId: t.id,
          changeSetId: JSON.parse(t.args).changeSetId,
        });
        await new Promise(() => {});
      }
    },
  },
);
const c = app.createConversation(workspace);
conversationId = c.conversationId;
environmentId = c.environmentId;
mountId = app.files.repo.mounts(environmentId)[0]!.id;
runId = app.send(conversationId, uid(), '修改并交付两个文件').runId;
const approvalId = await eventually(
  () =>
    Object.entries(app.store.snapshot(conversationId).approvals).find(
      ([, a]) => a.status === 'pending',
    )?.[0],
  10000,
);
if (mode === 'pending')
  process.send?.({
    conversationId,
    environmentId,
    runId,
    mountId,
    approvalId,
    executionId: app.store.approval(approvalId).execution_id,
  });
else app.approve(conversationId, approvalId, 'allow');
setInterval(() => {}, 1000);
