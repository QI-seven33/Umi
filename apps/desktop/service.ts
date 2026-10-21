import { deliveredTarget } from '../../packages/adapters/src/host-files/delivered-open.js';
import { byteExcerpt } from '../../packages/agent/src/context/bounded.js';
import { singleResultBody } from '../../packages/agent/src/tools/result.js';
import type { ToolResult } from '../../packages/agent/src/persistence.js';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UmiApplication } from '../headless/src/application.js';
import type { DesktopCommand } from '../../packages/protocol/src/desktop.js';
import { UmiError } from '../../packages/protocol/src/model.js';
import { safeRoot, safeFile } from '../../packages/adapters/src/host-files/paths.js';

// 传输只调已有应用入口；不创建第二套循环，也不在主进程保存第二份业务状态。
export class DesktopService {
  //constructor 声明构造器；readonly app: UmiApplication 是带 readonly 修饰符的参数属性，自动生成只读属性 app 并赋值
  constructor(readonly app: UmiApplication) {}
  snapshot(id: string) {
    const state = this.app.store.snapshot(id);
    return {
      state,
      messages: this.app.store.userMessages(id).map((m) => ({
        //把 m 的所有自身可枚举属性，原样铺进新对象
        ...m,
        // UI 按接收事实定位；模型上下文另按 input.applied 排列，不能混用两种时序。
        //!	非空断言：告诉 TS "结果一定不是 null/undefined"
        // 上行保留原学习笔记；这里现在复用查询结果，不再需要非空断言。
        projectionSequence: m.projectionSequence,
        attachments: this.app.store.messageAttachments(id, m.id),
      })),
      settings: this.app.store.settings(id),
      context: this.app.contextStatistics(id, state),
      resources: this.app.store.runtimeFacts(
        this.app.store.conversation(id).environment_id as string,
        state,
      ),
    };
  }
  async handle(command: DesktopCommand | { type: 'create_internal'; workspace: string }) {
    const a = this.app,
      s = a.store,
      c = command;
    //是"内部创建"就创建会话并返回
    if (c.type === 'create_internal') return a.createConversation(c.workspace);
    //是"列表"就返回会话列表
    if (c.type === 'list') return s.listConversations(c.archived);
    //是"创建"就抛权限错误，拒绝
    if (c.type === 'create')
      throw new UmiError('PERMISSION_DENIED', '目录选择证据只能由桌面主进程解析');
    //switch (表达式) —— 拿 c.type 的值匹配下面每个 case
    switch (c.type) {
      case 'skills_import_start': return this.app.skillImports.start(c.input);
      case 'skills_import_list': return this.app.skillImports.list();
      case 'skills_import_detail': return this.app.skillImports.detail(c.id);
      case 'skills_import_install': return this.app.skillImports.install(c.id,c.planHash);
      case 'skills_import_cancel': return this.app.skillImports.cancel(c.id);
      case 'skills_import_remove': return this.app.skillImports.remove(c.id);
      case 'skills_list': return c.refresh ? this.app.skills.refresh() : this.app.skills.library();
      case 'skills_enable': return this.app.skills.setEnabled(c.name,c.enabled,c.version);
      case 'skills_preview': return this.app.skills.preview(c.name,c.version);
      //新建会话，校验根目录后返回草稿或创建结果。
      case 'new_conversation': {
        const conv = s.conversation(c.conversationId),
          w = s.get(
            'SELECT source_root FROM workspaces WHERE id=?',
            conv.workspace_id as string,
          )!;
        const original = s.get(
          'SELECT identity FROM resource_candidates WHERE environment_id=? AND initial=1',
          conv.environment_id as string,
        );
        //?.	original?.identity	可选链，防空
        safeRoot(w.source_root as string, original?.identity as string | undefined);
        const draft = s.emptyConversation(conv.workspace_id as string);
        return draft
          ? {
              conversationId: String(draft.id),
              workspaceId: String(draft.workspaceId),
              environmentId: String(draft.environmentId),
            }
          : a.createConversation(w.source_root as string, s.settings(c.conversationId));
      }
      //Object.values(obj)	取对象所有值组成数组
      //.find(fn)	找第一个满足的，找不到返回 undefined
      //查某个工具调用的参数和结果，不属于本会话就报错
      // 上方 Object.values 学习笔记保留；当前联表核验归属，摘要不扫描快照或读取正文。
      case 'tool_detail': {
        const owned = s.get('SELECT t.id FROM tool_executions t JOIN runs r ON r.id=t.run_id WHERE t.call_id=? AND r.conversation_id=?', c.callId, c.conversationId);
        if (!owned) throw new UmiError('PERMISSION_DENIED', '工具不属于当前会话');
        const row = s.tool(String(owned.id)), args = JSON.parse(row.args);
        // 参数中的 path 不是文件存在证据；仅已成功的文件读写提供工作副本入口。
        const file = row.state === 'succeeded' && ['read_file', 'edit_file', 'write_file'].includes(row.name) && args.mountId && args.path
          ? { mountId: args.mountId, path: args.path } : null;
        if (c.summaryOnly) return {
          arguments: Object.fromEntries(['mountId','path','relativePath','query','program','messageId'].filter(key => typeof args[key] === 'string').map(key => [key, args[key].slice(0, 4096)])), file,
        };
        const result = row.result_ref ? singleResultBody(s.readArtifact<ToolResult>(row.result_ref)) : null;
        const display = result ? (result.content || JSON.stringify(result.data, null, 2)) : '';
        const page = byteExcerpt(display, c.startByte ?? 0, c.byteLength ?? 64000);
        return {
          arguments: args,
          file,
          // 仅投影检查报告的固定字段，不向页面开放任意 artifact/数据库读取。
          inspection:
            row.name === 'inspect_execution' && result?.outcome === 'succeeded'
              ? (() => {
                  const data = s.readArtifact<{
                    data: {
                      status: string;
                      root: string;
                      issues: { code: string; message: string }[];
                      instruction: string;
                    };
                  }>(row.result_ref!).data;
                  return {
                    status: data.status,
                    root: data.root.slice(0, 4096),
                    issues: data.issues.slice(0, 40).map((i) => ({
                      code: i.code.slice(0, 120),
                      message: i.message.slice(0, 1000),
                    })),
                    instruction: data.instruction.slice(0, 2000),
                  };
                })()
              : null,
          result: result
            ? {
                outcome: result.outcome,
                content: page.text,
                startByte: page.startByte,
                endByte: page.endByte,
                totalBytes: Buffer.byteLength(display),
                nextStartByte: page.endByte < Buffer.byteLength(display) ? page.endByte : null,
                truncated: page.endByte < Buffer.byteLength(display),
              }
            : null,
        };
      }
      //返回会话快照，转调本类 snapshot
      case 'snapshot':
        return this.snapshot(c.conversationId);
      //按游标拉一批有界事件，附带相关消息、资源、设置、上下文
      case 'events': {
        // pull + cursor 是有界订阅；客户端消费后才请求下一批，没有无限推送缓冲。
        const events = s.events(c.conversationId, c.cursor, 128);
        let size = 0,
          limit = events.length;
        for (let i = 0; i < events.length; i++) {
          size += Buffer.byteLength(JSON.stringify(events[i]));
          if (size > 512000 && i > 0) {
            limit = i;
            break;
          }
        }
        const batch = events.slice(0, limit),
          ids = batch.flatMap((e) =>
            e.type === 'input.accepted' ? [e.payload.messageId] : [],
          );
        return {
          events: batch,
          hasMore: Boolean(batch.length && BigInt(batch.at(-1)!.sequence) < BigInt(String(s.conversation(c.conversationId).next_sequence)) - 1n),
          messages: ids
            .map((id) => s.messageById(c.conversationId, id))
            .filter((m) => m !== undefined)
            .map((m) => ({
              ...m,
              attachments: s.messageAttachments(c.conversationId, m.id),
            })),
          ...(batch.some((e) => e.type.startsWith('resource.'))
            ? {
                resources: s.runtimeFacts(
                  s.conversation(c.conversationId).environment_id as string,
                ),
              }
            : {}),
          ...(batch.some((e) => e.type === 'settings.changed')
            ? { settings: s.settings(c.conversationId) }
            : {}),
          ...(batch.some(
            (e) => e.type === 'usage.recorded' || e.type.startsWith('context.') ||
              ['model.attempt_completed', 'model.attempt_failed', 'tool.measured', 'approval.decided', 'approval.invalidated',
                'run.completed', 'run.failed', 'run.interrupted', 'run.stopped'].includes(e.type),
          )
            ? { context: a.contextStatistics(c.conversationId) }
            : {}),
        };
      }
      //发送用户消息
      case 'send':
        return a.send(c.conversationId, c.commandId, c.text, c.attachmentIds);
      //查某个命令的回执，没有就返回 null
      case 'receipt': {
        s.conversation(c.conversationId);
        const row = s.get(
          'SELECT receipt FROM commands WHERE conversation_id=? AND id=?',
          c.conversationId,
          c.commandId,
        );
        return row ? JSON.parse(row.receipt as string) : null;
      }
      //更新设置并返回最新设置
      case 'settings':
        s.updateSettings(c.conversationId, c.settings);
        return s.settings(c.conversationId);
      //提交批准决定，返回已接受
      case 'answer_question':
        return a.questions.answer(c.conversationId, c.questionId, c.answers);
      case 'approve':
        a.approve(c.conversationId, c.approvalId, c.decision);
        return { accepted: true };
      // 停止请求确认接收后立即返回；最终清理状态经事件流更新。
      case 'stop':
        a.requestStop(c.conversationId, c.runId);
        return s.getRun(c.runId);
      //恢复某个运行，返回已接受
      case 'resume':
        a.resume(c.conversationId, c.runId);
        return { accepted: true };
      //检查某个运行的恢复情况
      case 'recovery':
        return a.inspectRecovery(c.conversationId, c.runId);
      //重命名会话，返回已接受
      case 'rename':
        s.editConversation(c.conversationId, c.title);
        return { accepted: true };
      //取消归档会话，返回已接受
      case 'delete_conversation':
        return a.deleteArchivedConversation(c.conversationId);
      case 'restore':
        s.editConversation(c.conversationId, null, false);
        return { accepted: true };
      //查批准详情，工具不属于本会话就报错
      case 'approval_detail': {
        const approval = s.snapshot(c.conversationId).approvals[c.approvalId];
        if (!approval) throw new UmiError('PERMISSION_DENIED', '批准不属于当前会话');
        const row = s.tool(s.approval(c.approvalId).execution_id);
        if (row.name !== 'deliver_changeset')
          return { kind: 'operation', description: approval.description };
        const args = JSON.parse(row.args) as { changeSetId: string };
        return {
          kind: 'delivery',
          ...a.previewChangeSet(c.conversationId, args.changeSetId),
        };
      }
      //归档会话，返回已接受
      case 'archive':
        s.editConversation(c.conversationId, null, true);
        return { accepted: true };
      //预览文件内容
      case 'list_outputs':
        return a.outputs.list(c.conversationId, { offset: c.offset, limit: c.limit });
      case 'preview_output':
        return a.outputs.read(c.conversationId, {
          outputId: c.outputId,
          startByte: c.startByte,
          byteLength: c.byteLength,
        });
      case 'inspect_export':
        return a.outputs.inspectExport(c.conversationId, c.executionId);
      case 'open_export':
        return { path: a.outputs.exportedPath(c.conversationId, c.executionId, c.index) };
      case 'preview_file': {
        const page = a.previewFile(c.conversationId, c.mountId, c.path, c.startByte, c.byteLength, c.expectedHash);
        const env = s.environment(s.conversation(c.conversationId).environment_id as string);
        const mount = a.files.repo.mount(c.mountId, env.id);
        return { ...page, displayPath: resolve(mount.root, ...c.path.split('/')) };
      }
      //核验路径后返回可打开的文件路径，不合法就报错
      case 'open_file': {
        const env = s.environment(
            s.conversation(c.conversationId).environment_id as string,
          ),
          m = a.files.repo.mount(c.mountId, env.id);
        // read 完成能力、根身份、链接和路径核验；仅返回主进程内部使用的已绑定路径。
        a.files.read(m, c.path, 0, 1);
        const path = realpathSync(safeFile(m.root, c.path, m.rootIdentity));
        if (!statSync(path).isFile())
          throw new UmiError('PERMISSION_DENIED', '只能打开已核验的副本文件位置');
        return { path };
      }
      //预览变更集
      case 'preview_change_file': {
        const page = a.frozenPreview.read(c.conversationId, c.changeSetId, c.path, c.side, c.startByte, c.byteLength);
        const env = s.environment(s.conversation(c.conversationId).environment_id as string);
        const cs = a.files.repo.changeSet(c.changeSetId, env.id), mount = a.files.repo.mount(cs.mountId, env.id);
        return { ...page, displayPath: resolve(mount.sourceRoot, ...c.path.split('/')) };
      }
      case 'open_delivered':
        return deliveredTarget(a.files, c.conversationId, c.changeSetId, c.path);
      case 'preview_changeset':
        return a.previewChangeSet(c.conversationId, c.changeSetId);
      //上传图片
      case 'upload_document':
        return s.uploadDocument(c.conversationId,{name:c.name,format:c.format,base64:c.base64});
      case 'upload_image':
        return s.uploadImage(c.conversationId, c.name, c.base64);
      //预览附件
      case 'preview_attachment':
        return s.previewAttachment(c.conversationId, c.attachmentId, c.startByte, c.byteLength);
      //上传附件
      case 'upload_attachment':
        return s.uploadAttachment(c.conversationId, c.name, c.mime, c.text);
      //读取附件内容
      case 'read_attachment':
        return s.readAttachment(
          c.conversationId,
          c.attachmentId,
          c.startByte,
          c.byteLength,
        );
    }
  }
}
