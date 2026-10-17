import { lstatSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash } from '../../../agent/src/identity.js';
import type { Environment, ToolResult } from '../../../agent/src/persistence.js';
import type { ToolRegistry } from '../../../agent/src/tools/registry.js';
import { UmiError, executionContextSchema } from '../../../protocol/src/model.js';
import { inspectionSchema } from '../../../protocol/src/process.js';
import type { DirectCommand } from '../../../protocol/src/process.js';
import { ResourceFiles } from '../host-files/resources.js';
import {
  safeRoot,
  safeFile,
  rootIdentity,
  fileIdentity,
  bytesHash,
} from '../host-files/paths.js';
import { hostContext } from '../host-files/scratch.js';
import { resolveProgram } from './programs.js';
import { commandCwd } from './cwd.js';

type Observation = {
  path: string;
  status: 'missing' | 'present' | 'limited' | 'unsafe';
  hash?: string;
  identity?: string;
  size?: number;
};
const manifests = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
];
const message = (error: unknown) =>
  error instanceof UmiError ? error.message : '该对象无法安全观察';

export class ExecutionInspection {
  constructor(readonly files: ResourceFiles) {}

  inspect(input: unknown, env: Environment, signal?: AbortSignal) {
    const args = inspectionSchema.parse(input),
      root = commandCwd(this.files, env, args.cwd);
    if (
      args.cwd.kind === 'mount' &&
      this.files.repo.mount(args.cwd.mountId, env.id).scope.kind === 'file'
    )
      throw new UmiError(
        'PERMISSION_DENIED',
        '单文件资源不能扩展为项目依赖检查；请先发现并申请具体目录',
      );
    const started = Date.now();
    const check = () => {
      signal?.throwIfAborted();
      if (Date.now() - started > 1500)
        throw new UmiError('PREFLIGHT_LIMIT', '执行准备观察超过 1.5 秒，请缩小检查范围');
    };
    let consumed = 0;
    const bodies = new Map<string, string>();
    const observations = [...new Set([...manifests, ...args.requiredFiles])].map(
      (path): Observation => {
        check();
        try {
          const file = safeFile(root, path),
            s = lstatSync(file);
          if (s.size > 256 * 1024 || consumed + s.size > 1024 * 1024)
            return { path, status: 'limited', size: s.size };
          consumed += s.size;
          const identity = fileIdentity(file),
            bytes = readFileSync(file);
          if (fileIdentity(file) !== identity || bytes.length !== s.size)
            throw new UmiError('RESOURCE_CHANGED', '观察期间文件变化');
          // 配置只保留摘要哈希；不展开配置/凭据内容，也不执行清单中的脚本。
          if (
            path === 'package.json' ||
            path === 'package-lock.json' ||
            path === 'npm-shrinkwrap.json'
          )
            bodies.set(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          return {
            path,
            status: 'present',
            identity,
            size: bytes.length,
            hash: bytesHash(bytes),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { path, status: 'missing' };
          return { path, status: 'unsafe' };
        }
      },
    );
    const programs = args.programs.map((program) => {
      check();
      try {
        let path: string;
        if (program === 'npm') {
          const parent = dirname(resolveProgram('node'));
          path =
            [
              join(parent, 'npm.cmd'),
              ...(process.env.PATH ?? '')
                .split(';')
                .filter(Boolean)
                .map((p) => join(p, 'npm.cmd')),
            ].find((p) => existsSync(p)) ?? '';
          if (!path) throw new UmiError('PROGRAM_NOT_FOUND', '没有找到 npm.cmd');
        } else path = resolveProgram(program);
        safeRoot(dirname(path));
        const s = lstatSync(path, { bigint: true });
        // Windows 系统程序可能由 WinSxS 正常硬链接；入口只 stat，执行仍走原程序 hash 与批准。
        if (!s.isFile() || s.isSymbolicLink())
          throw new UmiError('PERMISSION_DENIED', '工具入口不是普通文件');
        return {
          program,
          status: 'located' as const,
          path,
          identity: fileIdentity(path),
          size: Number(s.size),
          stamp: `${s.mtimeNs}:${s.ctimeNs}`,
          version:
            program === 'node' && path === process.execPath && !process.versions.electron
              ? process.versions.node
              : null,
          versionBasis:
            program === 'node' && path === process.execPath && !process.versions.electron
              ? 'umi-process'
              : 'not-executed',
        };
      } catch (error) {
        return { program, status: 'unavailable' as const, reason: message(error) };
      }
    });
    const directories = ['node_modules', '.venv'].map((path) => {
      check();
      try {
        const absolute = join(root, path);
        safeRoot(absolute);
        const s = lstatSync(absolute, { bigint: true });
        return {
          path,
          status: 'present' as const,
          identity: rootIdentity(absolute),
          stamp: `${s.mtimeNs}:${s.ctimeNs}`,
        };
      } catch (error) {
        return {
          path,
          status:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? ('missing' as const)
              : ('unsafe' as const),
        };
      }
    });
    const issues: { code: string; message: string }[] = [];
    for (const entry of programs.filter((p) => p.status === 'unavailable'))
      issues.push({
        code: 'PROGRAM_UNAVAILABLE',
        message: `未定位 ${entry.program}；不要反复启动，先决定工具准备方式`,
      });
    for (const file of observations) {
      if (file.status === 'limited' || file.status === 'unsafe')
        issues.push({
          code: 'INPUT_UNOBSERVED',
          message: `${file.path} 超出预算或无法安全观察`,
        });
      if (args.requiredFiles.includes(file.path) && file.status === 'missing')
        issues.push({
          code: 'REQUIRED_FILE_MISSING',
          message: `工作副本缺少 ${file.path}；不能把来源存在当作副本存在`,
        });
    }
    const json = (path: string): Record<string, unknown> | undefined => {
      const body = bodies.get(path);
      if (body === undefined) return;
      try {
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        return data;
      } catch {
        issues.push({ code: 'MANIFEST_INVALID', message: `${path} 不是有效 JSON 对象` });
      }
    };
    const pkg = json('package.json'),
      lock = json('npm-shrinkwrap.json') ?? json('package-lock.json');
    const record = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const modernLock = lock?.lockfileVersion === 2 || lock?.lockfileVersion === 3;
    if (
      lock &&
      (![1, 2, 3].includes(Number(lock.lockfileVersion)) ||
        (modernLock && !Object.hasOwn(record(lock.packages), '')))
    )
      issues.push({
        code: 'LOCK_INVALID',
        message: 'npm 锁文件版本/根记录不可核验；不把 JSON 存在当作 npm ci 已就绪',
      });
    const dependencyNames = [
      ...new Set([
        ...Object.keys(record(pkg?.dependencies)),
        ...Object.keys(record(pkg?.devDependencies)),
        ...Object.keys(record(pkg?.optionalDependencies)),
      ]),
    ];
    const packageManager =
      typeof pkg?.packageManager === 'string' ? pkg.packageManager.slice(0, 160) : null;
    if (pkg) {
      if (dependencyNames.length && directories[0]!.status !== 'present')
        issues.push({
          code: 'DEPENDENCIES_MISSING',
          message: '工作副本没有普通 node_modules；物化默认跳过依赖，需先准备再测试',
        });
      if (dependencyNames.length && !lock)
        issues.push({
          code: 'LOCK_MISSING',
          message: '没有可读 npm 锁文件；不能直接假定 npm ci 可用，也不自动改锁文件',
        });
      if (packageManager && !packageManager.startsWith('npm@'))
        issues.push({
          code: 'PACKAGE_MANAGER_REVIEW',
          message: '项目声明了其他包管理器；不自动改用 npm',
        });
      if (pkg.workspaces)
        issues.push({
          code: 'WORKSPACES_REVIEW',
          message: '存在 workspaces；本次只观察选定目录，不证明所有包已就绪',
        });
      const lockedRoot = record(record(lock?.packages)['']);
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
        if (
          lock?.lockfileVersion &&
          modernLock &&
          Object.hasOwn(record(lock?.packages), '') &&
          hash(record(pkg[section])) !== hash(record(lockedRoot[section]))
        )
          issues.push({
            code: 'LOCK_MISMATCH',
            message: `package.json 与锁文件根的 ${section} 不匹配；需审阅，不能静默更新`,
          });
    }
    const python = observations.some(
      (o) =>
        ['pyproject.toml', 'requirements.txt'].includes(o.path) && o.status === 'present',
    );
    if (python)
      issues.push({
        code: 'PYTHON_REVIEW',
        message:
          '识别到 Python 清单；本阶段未解析 Python 依赖，.venv 存在也不证明解释器和依赖可用',
      });
    if (directories.some((d) => d.status === 'unsafe'))
      issues.push({
        code: 'DEPENDENCY_LOCATION_UNSAFE',
        message: '依赖目录有联接或无法核验，未跟随读取',
      });
    const snapshot = {
      schemaVersion: 1,
      environmentId: env.id,
      cwd: args.cwd,
      root,
      rootIdentity: rootIdentity(root),
      observations,
      programs,
      directories,
      project: {
        node: !!pkg,
        python,
        packageManager,
        dependencyCount: dependencyNames.length,
        scriptNames: Object.keys(record(pkg?.scripts)).slice(0, 20),
        scriptNamesTotal: Object.keys(record(pkg?.scripts)).length,
        engines:
          typeof record(pkg?.engines).node === 'string'
            ? String(record(pkg?.engines).node).slice(0, 160)
            : null,
      },
      issues,
    };
    return {
      ...snapshot,
      fingerprint: hash(snapshot),
      status: issues.length ? 'needs_attention' : 'observed',
      commandObservation: { kind: 'root-identity', recursive: false },
      limits: {
        files: manifests.length + args.requiredFiles.length,
        maxFileBytes: 256 * 1024,
        maxTotalBytes: 1024 * 1024,
        maxMs: 1500,
      },
      instruction:
        '这是只读观察，不是运行就绪或隔离证明。外部程序未执行，不推测版本；依赖目录仅观察存在，不验证依赖完整。准备需具体批准，完成后重新检查并运行实际测试。宿主网络声明不构成强制网络边界。',
    };
  }

  assertCurrent(executionId: string, cwd: DirectCommand['cwd'], env: Environment) {
    const store = this.files.repo.store,
      tool = store.tool(executionId),
      cid = store.getRun(tool.run_id).conversation_id;
    if (
      tool.name !== 'inspect_execution' ||
      tool.state !== 'succeeded' ||
      tool.environment_id !== env.id ||
      !tool.result_ref ||
      !tool.context_ref ||
      store.conversation(cid).environment_id !== env.id
    )
      throw new UmiError('PREFLIGHT_INVALID', '检查回执不属于当前会话的成功观察');
    const context = executionContextSchema.parse(store.readArtifact(tool.context_ref!));
    if (context.inspectionExecutionId !== tool.id)
      throw new UmiError('PREFLIGHT_INVALID', '检查上下文与实际执行不一致');
    const args = inspectionSchema.parse(JSON.parse(tool.args));
    if (hash(args.cwd) !== hash(cwd))
      throw new UmiError('PREFLIGHT_INVALID', '命令目录与检查回执不一致');
    const prior = store.readArtifact<ToolResult>(tool.result_ref);
    const current = this.inspect(args, env);
    if (
      prior.outcome !== 'succeeded' ||
      (prior.data as { inspectionExecutionId?: string } | null)?.inspectionExecutionId !==
        tool.id ||
      (prior.data as { fingerprint?: string } | null)?.fingerprint !== current.fingerprint
    )
      throw new UmiError(
        'PREFLIGHT_STALE',
        '工具链或准备输入已变化；未启动，请重新 inspect_execution 后再提交具体命令',
      );
    if (current.issues.some((i) => i.code === 'INPUT_UNOBSERVED'))
      throw new UmiError(
        'PREFLIGHT_INCOMPLETE',
        '准备输入超限或无法安全观察；不能以这份检查回执绑定版本，请缩小范围',
      );
    return current.fingerprint;
  }
}

export function registerInspection(
  registry: ToolRegistry,
  inspection: ExecutionInspection,
) {
  registry.register({
    name: 'inspect_execution',
    description:
      '只读检查选定工作副本/task 目录的清单、明确工具入口、缺失文件及依赖目录，不启动程序或安装依赖。返回当前检查回执；准备命令用 preparation 绑定本工具执行 ID。外部版本未知，目录存在不证明可运行。',
    schema: inspectionSchema,
    effect: 'read',
    prepare(input, env, id) {
      if (!id) throw new UmiError('PROTOCOL_INVALID', '执行检查缺少实际执行身份');
      return { ...hostContext(input, env), inspectionExecutionId: id };
    },
    async execute(input, ctx, cid, signal) {
      const store = inspection.files.repo.store,
        id = ctx.inspectionExecutionId;
      if (!id) throw new UmiError('PROTOCOL_INVALID', '检查缺少原执行 ID');
      const tool = store.tool(id);
      if (
        tool.name !== 'inspect_execution' ||
        tool.environment_id !== ctx.environmentId ||
        store.getRun(tool.run_id).conversation_id !== cid
      )
        throw new UmiError('PERMISSION_DENIED', '检查执行与当前会话不一致');
      return {
        outcome: 'succeeded',
        mutated: false,
        content: '执行准备观察完成；请按缺失项和限制决定下一步。',
        data: {
          inspectionExecutionId: id,
          ...inspection.inspect(input, store.environment(ctx.environmentId), signal),
        },
      };
    },
    async reconcile(input, ctx, cid, signal) {
      return this.execute(input, ctx, cid, signal);
    },
  });
}
