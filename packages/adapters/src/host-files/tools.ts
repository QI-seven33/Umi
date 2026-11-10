import {registerFileVersions} from './file-versions.js';
import { registerTextSearch } from './text-search.js';
import { registerTextWrite } from './text-write.js';
import { fileReadEvidencePort } from './read-evidence.js';
import { hash } from '../../../agent/src/identity.js';

import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { ResourceFiles } from './resources.js';
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
    name: 'list_resources',
    description:
      '列出当前获准目录与mountId，直接读改真实文件。directAccess提供当前工作区授权及撤销状态，不授予其他能力。',
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
    name:'request_directory_access', schema:request,effect:'resource',
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
      '删除获准范围内的一个文件。需具体批准并保存恢复内容。移入系统回收站使用recycle_file。',
    schema: fileSchema,
    effect: 'file-write',
    approvalRequired(){return true;},
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
          content: '文件目标在派发后变化，未修改。',
          data: null,
        };
      files.direct.write(m,a.path,ctx,null,s,repo.scope(ctx.environmentId).executionId);
      const after = observe(m.root, a.path, m.rootIdentity);
      if ((after?.hash ?? null) !== loc.desiredHash)
        throw new UmiError('RESOURCE_CHANGED', '文件操作后核验失败');
      return dataResult(
        { mountId: m.id, path: a.path, observed: after },
        '真实文件已删除，恢复内容已保存。',
      );
    },
    async reconcile(input, ctx) {
      const a = fileSchema.parse(input),
        m = repo.mount(a.mountId, ctx.environmentId),
        loc = ctx.locations[0]!;
      files.assertPath(m.scope, a.path);
      files.direct.checkObservation(m,a.path);
      const after = observe(m.root, a.path, m.rootIdentity);
      if((after?.hash??null)===loc.desiredHash) files.direct.reconcile(m,repo.scope(ctx.environmentId).executionId!,true);
      return (after?.hash ?? null) === loc.desiredHash
        ? {
            ...dataResult(
              { mountId: m.id, path: a.path, observed: after },
              '文件目标已满足预期状态；未再次写入，不断言原执行来源。',
            ),
            verification: 'desired-state-verified',
          }
        : {
            outcome: 'unknown',
            content: '原文件目标不符合预期，未重复操作。',
            data: { observed: after },
            verification: 'unknown',
          };
    },
  });
}
