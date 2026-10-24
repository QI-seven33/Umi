import {registerFileVersions} from './file-versions.js';
import { registerTextSearch } from './text-search.js';
import { registerTextWrite } from './text-write.js';
import { fileReadEvidencePort } from './read-evidence.js';
import { hash } from '../../../agent/src/identity.js';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { ResourceFiles } from './resources.js';
import { DeliveryFiles } from './delivery.js';
import { hostContext } from './scratch.js';
import { observe, safeFile, safeRoot } from './paths.js';
import { filePath } from '../../../protocol/src/resources.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { UmiError } from '../../../protocol/src/model.js';

const mountId = z.string().min(1).max(160),
  readSchema = z
    .object({
      mountId,
      path: filePath,
      startByte: z.number().int().nonnegative().optional(),
      byteLength: z.number().int().min(1).max(64000).optional(),
      startLine: z.number().int().min(1).max(10000000).optional(),
      lineCount: z.number().int().min(1).max(10000).optional(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict().refine(a => a.startByte === undefined || (a.startLine === undefined && a.lineCount === undefined),
      {message:'行范围和字节起点互斥：startByte 不能同时搭配 startLine/lineCount；请选择一种定位方式',path:['startByte']})
    .meta({not:{allOf:[{required:['startByte']},{anyOf:[{required:['startLine']},{required:['lineCount']}]}]}});
const fileSchema = z.object({ mountId, path: filePath }).strict();
function dataResult(data: unknown, content = '') {
  return { outcome: 'succeeded' as const, content, data };
}
export function registerFiles(
  registry: ToolRegistry,
  files: ResourceFiles,
  delivery = new DeliveryFiles(files),
) {
  const repo = files.repo;
  registerFileVersions(registry,files);
  const discover = z
    .object({
      query: z.string().max(200).default(''),
      path: z.string().min(1).max(4096).optional(),
      root: z
        .string()
        .min(1)
        .max(4096)
        .refine(isAbsolute, '发现根必须是绝对路径')
        .optional(),
      kind: z.enum(['file', 'directory', 'any']).default('directory'),
      match: z.enum(['name', 'extension', 'relative_path']).default('name'),
      depth: z.number().int().min(0).max(8).default(2),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(1024).optional(),
    })
    .strict()
    .refine(
      (a) => !a.path || (!a.root && !a.cursor),
      'path 精确定位不能同时使用 root/cursor',
    )
    .refine(
      (a) =>
        a.match !== 'extension' ||
        (a.kind === 'file' && Boolean(a.query) && !/[\\/]/.test(a.query)),
      '扩展名匹配需 kind=file 和非空字面扩展名',
    );
  registry.register({
    name: 'discover_resource',
    description:
      '发现具体文件或目录，仅返回身份、范围和元数据，不读取正文。指定 path 精确定位文件时只授权该文件；默认查附近/常用目录名称；kind=file 配合 root 搜索文件，match=name/extension/relative_path 为字面匹配。预算与跳过原因见 coverage，nextCursor 翻页覆盖结果；变化需重新搜索。空结果不证明不存在。',
    schema: discover,
    effect: 'read',
    prepare: hostContext,
    async execute(input, ctx, _conversation, signal) {
      signal.throwIfAborted();
      const a = discover.parse(input);
      return dataResult(
        files.discover(repo.store.environment(ctx.environmentId), a.query, a.path, {
          ...a,
          signal,
        }),
      );
    },
    async reconcile(input, ctx, c, s) {
      return this.execute(input, ctx, c, s);
    },
  });
  const request = z
    .object({
      candidateId: z.string().min(1),
      access: z.enum(['read', 'edit']),
      purpose: z.string().min(1).max(500),
    })
    .strict();
  registry.register({
    name: 'request_resource',
    available:env=>!repo.direct.enabled(env.id),
    description:
      '申请具体外部来源的读取或工作副本编辑权限，批准后物化到托管副本。一次资源批准可支持多个副本文件连续编辑；不包含源目录交付权限。被拒绝的等价权限不能换名重复申请。',
    schema: request,
    effect: 'resource',
    prepare(input, env, executionId) {
      const a = request.parse(input);
      return files.resourceContext(input, env, a.candidateId, a.access, executionId);
    },
    approvalRequired(input, ctx) {
      const a = request.parse(input);
      return !repo.authorized(a.candidateId, ctx.environmentId, a.access === 'edit');
    },
    approvalDescription(input, ctx) {
      const a = request.parse(input),
        c = repo.getCandidate(a.candidateId, ctx.environmentId);
      return `我需要${a.access === 'edit' ? '读取并在工作副本中修改' : '读取'} ${c.path}，用于${a.purpose}。批准仅限本次任务${c.scope.kind === 'file' ? '的这一个文件，不包含同目录其他文件' : '的该目录范围'}；真实来源写回仍需单独交付确认。`;
    },
    denied(input, ctx) {
      const a = request.parse(input);
      repo.recordDenial(repo.getCandidate(a.candidateId, ctx.environmentId), a.access);
    },
    async execute(input, ctx, _conversation, signal) {
      signal.throwIfAborted();
      const a = request.parse(input),
        c = repo.getCandidate(a.candidateId, ctx.environmentId);
      if (!repo.authorized(c.id, c.environmentId, a.access === 'edit'))
        repo.grant(c, a.access);
      const location = ctx.locations.find((l) => l.rootRef.kind === 'mount');
      if (!location || location.rootRef.kind !== 'mount')
        throw new UmiError('PROTOCOL_INVALID', '资源派发缺少物化目标');
      let m;
      try {
        m = await files.materializeAsync(c, location.rootRef.mountId, signal);
      } catch (e) {
        return files.materializationFailure(c, ctx, e);
      }
      return dataResult(
        {
          mountId: m.id,
          resourceId: m.resourceId,
          sourceDirectory: m.sourceRoot,
          resourceScope: m.scope,
          excluded:
            repo.store.snapshot(repo.scope(ctx.environmentId).conversationId).resources[
              c.id
            ]?.excluded ?? [],
        },
        '资源已获准并物化。后续使用 mountId 和相对路径操作副本；源目录未修改。',
      );
    },
    async reconcile(input, ctx) {
      const a = request.parse(input),
        c = repo.getCandidate(a.candidateId, ctx.environmentId),
        location = ctx.locations.find((l) => l.rootRef.kind === 'mount');
      if (hash(ctx.resourceScope ?? { kind: 'directory' }) !== hash(c.scope))
        throw new UmiError('RESOURCE_CHANGED', '原执行的资源范围无法对应候选');
      const m =
        repo
          .mounts(ctx.environmentId)
          .find(
            (m) =>
              m.resourceId === c.id &&
              location?.rootRef.kind === 'mount' &&
              m.id === location.rootRef.mountId &&
              m.root === location.physicalRoot,
          ) ?? files.reconcileMaterialization(c, ctx);
      if (m && repo.authorized(c.id, ctx.environmentId, a.access === 'edit')) {
        safeRoot(m.root, m.rootIdentity);
        return {
          ...dataResult(
            { mountId: m.id, resourceId: c.id, resourceScope: m.scope },
            '原资源权限与挂载已核验；没有重新读取或复制来源。',
          ),
          verification: 'materialized-plan-verified',
        };
      }
      const prior = repo.store.snapshot(repo.scope(ctx.environmentId).conversationId)
        .resources[c.id]?.materializationError;
      repo.store.commit(repo.scope(ctx.environmentId), {
        type: 'resource.materialization_failed',
        payload: {
          resourceId: c.id,
          code: prior?.code ?? 'MATERIALIZATION_INCOMPLETE',
          reason:
            (prior ? prior.reason + '；' : '') +
            '原物化未完成；部分托管资料保留，不重新复制',
          failure: { stage: 'reconcile', effects: 'partial-or-unknown' },
        },
      });
      return {
        outcome: 'failed',
        content: '资源物化未完成；已保存批准事实和原目标，没有自动重新复制。',
        data: { candidateId: c.id },
        verification: 'not-materialized',
      };
    },
  });
  registry.register({
    name: 'list_resources',
    description:
      '列出当前获准目录、mountId及direct标记。direct=true直接读改真实文件；旧副本仍按原权限处理。directAccess提供当前工作区授权及撤销状态，不授予其他能力。',
    schema: z.object({}).strict(),
    effect: 'read',
    prepare: hostContext,
    async execute(_a, ctx, _c, signal) {
      signal.throwIfAborted();
      return dataResult(repo.store.runtimeFacts(ctx.environmentId));
    },
    async reconcile(a, ctx, c, s) {
      return this.execute(a, ctx, c, s);
    },
  });
  registry.register({
    name:'request_directory_access', available:env=>repo.direct.enabled(env.id), schema:request,effect:'resource',
    description:'申请明确来源的读取或直接编辑权限。获准后真实文件立即可改；授权按当前工作区保存，跨run和重启可复用，可由用户撤销。不授予命令执行、安装、外发或发布权限。被拒绝/撤销不能换用途绕过。',
    prepare(input,env) {
      const a=request.parse(input),c=repo.getCandidate(a.candidateId,env.id);
      const grants=repo.direct.grants(env.id).filter(g=>g.root===files.sourceRoot(c));
      if(grants.length && grants.every(g=>g.revoked===1)) throw new UmiError('ACCESS_REVOKED','用户已撤销这个来源的授权，请让用户通过目录选择入口重新授权');
      const context=files.resourceContext(input,env,a.candidateId,a.access);
      files.direct.protect(c.path);
      return {...context,locations:context.locations.filter(l=>l.rootRef.kind==='source')};
    },
    approvalRequired(input,ctx){const a=request.parse(input);return !repo.direct.authorized(a.candidateId,ctx.environmentId,a.access==='edit');},
    approvalDescription(input,ctx){const a=request.parse(input),c=repo.getCandidate(a.candidateId,ctx.environmentId);return '允许'+(a.access==='edit'?'直接读取和修改':'读取')+' '+c.path+'，用于'+a.purpose+'。范围：'+(c.scope.kind==='file'?'仅此文件':'此目录')+'；本工作区跨run、重启及新会话保留，可撤销。修改会立即生效，保存恢复记录；不包含命令、安装、外发或发布。读取的内容可用于当前配置模型的上下文。';},
    denied(input,ctx){const a=request.parse(input);repo.recordDenial(repo.getCandidate(a.candidateId,ctx.environmentId),a.access);},
    async execute(input,ctx,_c,signal){signal.throwIfAborted();const a=request.parse(input),c=repo.getCandidate(a.candidateId,ctx.environmentId);
      files.resourceContext(input,repo.store.environment(ctx.environmentId),a.candidateId,a.access);
      if(!repo.direct.authorized(c.id,ctx.environmentId,a.access==='edit')) repo.store.assertApprovedExecution(repo.scope(ctx.environmentId).executionId!,ctx);
      const m=files.direct.grant(c,a.access,'approval:'+repo.scope(ctx.environmentId).executionId);
      return dataResult({mountId:m.id,resourceId:c.id,sourceDirectory:m.root,direct:true},'目录已获准；后续按mountId和相对路径直接操作真实文件，无需交付。');},
    async reconcile(input,ctx){const a=request.parse(input),m=repo.direct.mounts(ctx.environmentId).find(m=>m.resourceId===a.candidateId&&repo.direct.authorized(m.resourceId,ctx.environmentId,a.access==='edit'));
      if(!m) return {outcome:'failed',content:'原授权未完成，没有重新授权或写入。',data:null};files.direct.check(m);return {...dataResult({mountId:m.id,direct:true}),verification:'original-grant-verified'};},
  });
  const list = z
    .object({
      mountId,
      prefix: z.string().max(1024).default(''),
      cursor: z.string().min(1).max(1024).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict();
  registry.register({
    name: 'list_files',
    description:
      '分页列举获准目录文件的元数据，不读取正文。使用相同 mountId/prefix 和 nextCursor 续页；restart_required 时去掉 cursor。totalExact=false 表示覆盖不完整，需缩小 prefix；内容 hash 请用 read_file/stat_file。',
    schema: list,
    effect: 'read',
    prepare(input, env) {
      const a = list.parse(input);
      if (a.prefix) filePath.parse(a.prefix);
      return files.mountContext(input, env, a.mountId);
    },
    async execute(input, ctx, _c, signal) {
      signal.throwIfAborted();
      const a = list.parse(input),
        m = repo.mount(a.mountId, ctx.environmentId);
      return dataResult(files.listMetadata(m, a.prefix, a.limit, a.cursor, signal));
    },
    async reconcile(a, ctx, c, s) {
      return this.execute(a, ctx, c, s);
    },
  });
  registry.register({
    name: 'read_file',
    description:
      '读取获准文件原文。startLine/lineCount 为1-based行选择（省略 startLine 从第1行，省略 lineCount 取200行），不能与 startByte 混用；byteLength 为范围上限（字节模式默认 8192，行模式默认 64000）。范围内正文完整；长行用 nextStartByte/expectedHash 连续续读，不自己计算中文偏移。返回 hash、对象身份、readExecutionId 可绑定编辑；二进制仅元数据。',
    schema: readSchema,
    effect: 'read',
    prepare(input, env, executionId) {
      const a = readSchema.parse(input);
      return {
        ...files.mountContext(input, env, a.mountId, a.path),
        ...(executionId ? { fileReadExecutionId: executionId } : {}),
      };
    },
    async execute(input, ctx, _c, signal) {
      signal.throwIfAborted();
      const a = readSchema.parse(input);
      const data = files.read(
        repo.mount(a.mountId, ctx.environmentId),
        a.path,
        a.startByte ?? 0,
        a.byteLength ?? (a.startLine !== undefined || a.lineCount !== undefined ? 64000 : 8192),
        a.expectedHash,
        a.startLine !== undefined || a.lineCount !== undefined ? { startLine: a.startLine ?? 1, lineCount: a.lineCount ?? 200 } : undefined,
      );
      return dataResult({
        ...data,
        ...(ctx.fileReadExecutionId ? { readExecutionId: ctx.fileReadExecutionId } : {}),
      });
    },
    async reconcile(a, ctx, c, s) {
      return this.execute(a, ctx, c, s);
    },
  });
  registry.register({
    name: 'stat_file',
    description:
      '查看获准目录中的文件大小、内容 hash 和对象身份；文件缺失明确返回 null。',
    schema: fileSchema,
    effect: 'read',
    prepare(input, env) {
      const a = fileSchema.parse(input);
      return files.mountContext(input, env, a.mountId, a.path);
    },
    async execute(input, ctx, _c, s) {
      s.throwIfAborted();
      const a = fileSchema.parse(input),
        m = repo.mount(a.mountId, ctx.environmentId);
      files.assertPath(m.scope, a.path);
      return dataResult({
        mountId: m.id,
        path: a.path,
        entry: observe(m.root, a.path, m.rootIdentity),
      });
    },
    async reconcile(a, ctx, c, s) {
      return this.execute(a, ctx, c, s);
    },
  });
  registerTextSearch(registry, files);
  registerTextWrite(registry, files, fileReadEvidencePort(repo.store));
  registry.register({
    name: 'delete_file',
    description:
      '删除获准范围内的一个文件。direct=true时需具体批准并保存恢复内容；旧副本删除仍不影响来源。移入系统回收站使用recycle_file。',
    schema: fileSchema,
    effect: 'file-write',
    approvalRequired(input,ctx){return Boolean(repo.mount(fileSchema.parse(input).mountId,ctx.environmentId).direct);},
    approvalDescription(input,ctx){const a=fileSchema.parse(input),m=repo.mount(a.mountId,ctx.environmentId);return '永久删除真实文件 '+m.root+'/'+a.path+'，保存原字节以供恢复；此批准仅限当前文件版本。是否允许？';},
    prepare(input, env) {
      const a = fileSchema.parse(input),
        desired = null;
      return files.mountContext(input, env, a.mountId, a.path, desired, true);
    },
    async execute(input, ctx, _c, s) {
      s.throwIfAborted();
      const a = fileSchema.parse(input),
        m = repo.mount(a.mountId, ctx.environmentId),
        loc = ctx.locations[0]!;
      files.assertPath(m.scope, a.path);
      const before = observe(m.root, a.path, m.rootIdentity);
      if (
        (before?.hash ?? null) !== loc.beforeHash ||
        (before?.identity ?? null) !== loc.beforeIdentity
      )
        return {
          outcome: 'failed',
          content: '副本目标在派发后变化，未修改。',
          data: null,
        };
      if(m.direct) files.direct.write(m,a.path,ctx,null,s,repo.scope(ctx.environmentId).executionId);
      else if (before) unlinkSync(safeFile(m.root, a.path, m.rootIdentity));
      const after = observe(m.root, a.path, m.rootIdentity);
      if ((after?.hash ?? null) !== loc.desiredHash)
        throw new UmiError('RESOURCE_CHANGED', '副本操作后核验失败');
      return dataResult(
        { mountId: m.id, path: a.path, observed: after },
        m.direct ? '真实文件已删除，恢复内容已保存。' : '工作副本已修改并回读核验；真实来源未改变。',
      );
    },
    async reconcile(input, ctx) {
      const a = fileSchema.parse(input),
        m = repo.mount(a.mountId, ctx.environmentId),
        loc = ctx.locations[0]!;
      files.assertPath(m.scope, a.path);
      files.direct.checkObservation(m,a.path);
      const after = observe(m.root, a.path, m.rootIdentity);
      if(m.direct && (after?.hash??null)===loc.desiredHash) files.direct.reconcile(m,repo.scope(ctx.environmentId).executionId!,true);
      return (after?.hash ?? null) === loc.desiredHash
        ? {
            ...dataResult(
              { mountId: m.id, path: a.path, observed: after },
              '副本目标已满足预期状态；未再次写入，不断言原执行来源。',
            ),
            verification: 'desired-state-verified',
          }
        : {
            outcome: 'unknown',
            content: '原副本目标不符合预期，未重复操作。',
            data: { observed: after },
            verification: 'unknown',
          };
    },
  });
  const build = z
    .object({
      mountId,
      paths: z
        .array(filePath)
        .min(1)
        .max(200)
        .refine((p) => new Set(p).size === p.length, '不能重复选取同一文件')
        .optional(),
    })
    .strict();
  registry.register({
    name: 'build_changeset',
    available:env=>!repo.direct.enabled(env.id),
    description:
      '将选定工作副本当前字节冻结为交付变更集，返回真实目录、文件操作和前后内容；不会编译、构建或写回。若修了源码，先更新实际要交付的成品；paths由你选择，不要求额外验证流水线。',
    schema: build,
    effect: 'read',
    prepare(input, env) {
      const a = build.parse(input);
      return files.mountContext(input, env, a.mountId, undefined, undefined, true);
    },
    async execute(input, ctx, _c, s) {
      s.throwIfAborted();
      const a = build.parse(input);
      return dataResult(
        delivery.build(repo.store.environment(ctx.environmentId), a.mountId, a.paths),
      );
    },
    async inspect(_input, ctx, _c, signal, executionId) {
      signal.throwIfAborted();
      const saved = repo.store.get('SELECT id FROM changesets WHERE execution_id=?', executionId);
      if (!saved) return { outcome: 'failed', content: '原变更集未保存，没有重新扫描/冻结；按最新要求创建新快照。', data: null, verification: 'not-saved' };
      const cs = repo.changeSet(saved.id as string, ctx.environmentId), m = repo.mount(cs.mountId, ctx.environmentId);
      return { ...dataResult(delivery.preview(cs, m, repo.store.environment(ctx.environmentId))), verification: 'original-snapshot-reused' };
    },
    async reconcile(input, ctx, c, s) {
      const scope = repo.scope(ctx.environmentId),
        saved = scope.executionId
          ? repo.store.get(
              'SELECT id FROM changesets WHERE execution_id=?',
              scope.executionId,
            )
          : undefined;
      if (saved) {
        const cs = repo.changeSet(saved.id as string, ctx.environmentId),
          m = repo.mount(cs.mountId, ctx.environmentId);
        return {
          ...dataResult(
            delivery.preview(cs, m, repo.store.environment(ctx.environmentId)),
          ),
          verification: 'original-snapshot-reused',
        };
      }
      return {
        ...(await this.execute(input, ctx, c, s)),
        verification: 'recomputed-read',
      };
    },
  });
  const deliver = z.object({ changeSetId: z.string().min(1) }).strict();
  registry.register({
    name: 'deliver_changeset',
    available:env=>!repo.direct.enabled(env.id),
    description:
      '申请一次固定变更集交付批准。系统逐项核验源文件和副本、记录写回回执；等待批准时阻塞，不再请求模型。批准不覆盖之后的新变化。',
    schema: deliver,
    effect: 'source-write',
    prepare(input, env) {
      return delivery.prepare(env, deliver.parse(input).changeSetId);
    },
    approvalDescription(input, ctx) {
      const cs = repo.changeSet(deliver.parse(input).changeSetId, ctx.environmentId),
        m = repo.mount(cs.mountId, ctx.environmentId);
      return `以下 ${cs.changes.length} 项修改将写回 ${m.sourceRoot}。\n${cs.changes
        .slice(0, 12)
        .map((c) => c.path)
        .join(
          '、',
        )}${cs.changes.length > 12 ? '等文件，完整范围见批准卡片' : ''}\n是否交付？delete 项会永久删除源文件，不移入回收站；需要回收时应使用系统回收站工具。本批准仅绑定此变更集。`;
    },
    async execute(input, ctx, _c, s) {
      return delivery.apply(
        repo.store.environment(ctx.environmentId),
        deliver.parse(input).changeSetId,
        ctx,
        s,
      );
    },
    async reconcile(input, ctx) {
      return delivery.reconcile(
        repo.store.environment(ctx.environmentId),
        deliver.parse(input).changeSetId,
        ctx,
      );
    },
  });
}
