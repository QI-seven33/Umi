import { z } from 'zod';
import { extname } from 'node:path';
import { observe, safeFile, fileIdentity } from './paths.js';
import type { ResourceFiles } from './resources.js';
import { hostContext } from './scratch.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import type { DocumentOpener, DocumentTarget } from '../../../protocol/src/native-open.js';
import type { DeliveryReceipt } from '../../../protocol/src/resources.js';
import { filePath } from '../../../protocol/src/file-path.js';
import { UmiError } from '../../../protocol/src/model.js';

const documentExtensions = new Set(['.html', '.htm', '.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.pptx', '.csv']);
// 主进程在系统打开前再核验：没有任意路径、程序或命令行入口。
export function verifiedDocumentPath(target: DocumentTarget) {
  if (!documentExtensions.has(extname(target.path).toLowerCase()))
    throw new UmiError('OPEN_UNSUPPORTED', '只支持打开文档、网页和图片，不执行程序或脚本');
  const entry = observe(target.root, target.path, target.rootIdentity);
  if (!entry || entry.hash !== target.hash || entry.identity !== target.identity)
    throw new UmiError('RESOURCE_CHANGED', '交付文件已变化，未请求打开');
  return safeFile(target.root, target.path, target.rootIdentity);
}

function deliveredReference(files: ResourceFiles, conversationId: string, changeSetId: string, path: string): Omit<DocumentTarget, 'identity'> {
  const store = files.repo.store, env = store.environment(store.conversation(conversationId).environment_id as string);
  const cs = files.repo.changeSet(changeSetId, env.id), mount = files.repo.mount(cs.mountId, env.id);
  files.assertPath(mount.scope, path);
  const change = cs.changes.find(item => item.path === path);
  if (!change?.after) throw new UmiError('PERMISSION_DENIED', '此冻结文件没有可打开的交付版本');
  const item = files.repo.items(cs.id).find(item => item.path === path);
  const receipt = item?.receipt_ref ? store.readArtifact<DeliveryReceipt>(item.receipt_ref as string) : null;
  if (!receipt || !['applied', 'satisfied'].includes(receipt.outcome) || receipt.observed?.hash !== change.after.hash)
    throw new UmiError('DELIVERY_REQUIRED', '此文件尚未成功交付');
  if (!documentExtensions.has(extname(path).toLowerCase()))
    throw new UmiError('OPEN_UNSUPPORTED', '只支持打开文档、网页和图片，不提供脚本启动入口');
  return { root: mount.sourceRoot, rootIdentity: mount.sourceIdentity, path, hash: change.after.hash };
}

// 具体打开批准代替旧 run 的读取许可：prepare 只观察元数据，不读取文件正文。
function plannedDeliveredTarget(files: ResourceFiles, conversationId: string, changeSetId: string, path: string): DocumentTarget {
  const target = deliveredReference(files, conversationId, changeSetId, path);
  const file = safeFile(target.root, target.path, target.rootIdentity);
  try { return { ...target, identity: fileIdentity(file) }; }
  catch { throw new UmiError('RESOURCE_CHANGED', '交付文件已消失，未请求打开'); }
}

// 仅用于获准的打开/手动点击及已有证据核验；不授予通用 read/edit 或新挂载。
export function deliveredTarget(files: ResourceFiles, conversationId: string, changeSetId: string, path: string): DocumentTarget {
  const target = deliveredReference(files, conversationId, changeSetId, path);
  const observed = observe(target.root, target.path, target.rootIdentity);
  if (!observed || observed.hash !== target.hash)
    throw new UmiError('RESOURCE_CHANGED', '来源文件已改变，未打开旧交付版本');
  return { ...target, identity: observed.identity };
}

export function registerDeliveredOpen(registry: ToolRegistry, files: ResourceFiles, open: DocumentOpener) {
  const schema = z.object({ changeSetId: z.string().min(1), path: filePath }).strict();
  registry.register({
    name: 'open_delivered_file',
    description: '按用户要求，使用系统默认应用打开已成功交付且当前版本匹配的文档/HTML/图片。可跨轮传原 changeSetId 和相对路径；此次打开需要具体批准，无需恢复旧读取权限或重新交付。系统接收打开请求不证明页面渲染或内容正确。不要用宿主脚本代替此动作。',
    schema, effect: 'host-code',
    prepare: (args, env) => {
      const a = schema.parse(args), conversationId = files.repo.scope(env.id).conversationId;
      const target = plannedDeliveredTarget(files, conversationId, a.changeSetId, a.path);
      const context = hostContext(args, env), mount = files.repo.mount(files.repo.changeSet(a.changeSetId, env.id).mountId, env.id);
      return { ...context, locations: [{ schemaVersion: 1, environmentId: env.id,
        rootRef: { kind: 'source', resourceId: mount.resourceId, bindingVersion: mount.bindingVersion },
        relativePath: a.path, beforeHash: target.hash, desiredHash: target.hash,
        physicalRoot: target.root, physicalRootIdentity: target.rootIdentity, beforeIdentity: target.identity }] };
    },
    approvalDescription: (_args, context) => `使用系统默认应用打开已交付文件：${context.locations[0]!.physicalRoot}/${context.locations[0]!.relativePath}。批准包含核验此文件当前内容哈希和对象身份，再打开该交付版本；不授予通用读取、编辑或脚本执行权限。默认应用可自行处理文档内容。`,
    execute: async (args, context, conversationId, signal) => {
      const a = schema.parse(args), location = context.locations[0]!;
      let target: DocumentTarget;
      try {
        target = deliveredTarget(files, conversationId, a.changeSetId, a.path);
        if (target.hash !== location.beforeHash || target.identity !== location.beforeIdentity || target.rootIdentity !== location.physicalRootIdentity)
          throw new UmiError('RESOURCE_CHANGED', '打开前交付对象变化');
        signal.throwIfAborted();
      } catch (e) {
        // 此分支尚未调用系统；不把已知的无副作用失败变成整个环境的未知执行。
        return { outcome: signal.aborted ? 'cancelled' : 'failed', content: e instanceof Error ? e.message : '打开前核验失败',
          data: { code: e instanceof UmiError ? e.code : 'OPEN_REJECTED', systemAccepted: false }, mutated: false };
      }
      try { await open(target, signal); }
      catch (e) {
        if (e instanceof UmiError && e.code === 'OPEN_REJECTED')
          return { outcome: 'failed', content: e.message, data: { code: e.code, systemAccepted: false }, mutated: false };
        throw e; // 回执丢失/停止仍保持未知，不能据此再次打开。
      }
      return { outcome: 'succeeded', content: '', data: { changeSetId: a.changeSetId, path: a.path, hash: target.hash,
        systemAccepted: true, instruction: '系统打开请求已接收；不证明窗口呈现、页面布局或内容验证。' }, mutated: false };
    },
    inspect: async () => ({ outcome: 'unknown', content: '打开回执未保存，可能已经打开；未再次打开。', data: null, mutated: false }),
    reconcile: async () => ({ outcome: 'unknown', content: '打开结果未知，未重放系统打开动作。', data: null, mutated: false }),
  });
}
