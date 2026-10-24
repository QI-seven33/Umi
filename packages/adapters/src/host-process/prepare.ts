import { quoteArgument } from './command-line.js';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash } from '../../../agent/src/identity.js';
import { UmiError } from '../../../protocol/src/model.js';
import { executionContextSchema } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import {
  directCommandSchema,
  shellCommandSchema,
  processSnapshotSchema,
} from '../../../protocol/src/process.js';
import type { ProcessSnapshot } from '../../../protocol/src/process.js';
import { ResourceFiles } from '../host-files/resources.js';
import { safeRoot, rootIdentity, fileIdentity, bytesHash } from '../host-files/paths.js';
import { hostContext } from '../host-files/scratch.js';
import { ProcessRepository } from '../sqlite/processes.js';
import { WINDOWS_BRIDGE } from './windows-bridge.js';
import { resolveProgram } from './programs.js';
import { commandCwd } from './cwd.js';
import { ExecutionInspection } from './preflight.js';

export function bridgeProgram() {
  if (process.platform !== 'win32' || !process.env.SystemRoot)
    throw new UmiError('CAPABILITY_UNAVAILABLE', '当前宿主命令执行器仅实现 Windows');
  return join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}
export function bridgeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.PATH = join(process.env.SystemRoot!, 'System32');
  env.PSModulePath = join(
    process.env.SystemRoot!,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
  );
  return env;
}
// 按 Windows C 运行库 argv 规则编码。CMD 的脚本另用其 /s /c 语义，不复用此规则。
export { quoteArgument } from './command-line.js';
const executableCache = new Map<string, { stamp: string; digest: string }>();
function executable(path: string, fresh = false) {
  const file = realpathSync(path);
  safeRoot(dirname(file));
  const s = lstatSync(file, { bigint: true });
  if (!s.isFile() || s.size > 160n * 1024n * 1024n)
    throw new UmiError('PERMISSION_DENIED', '程序不是可核验的普通可执行文件');
  const identity = fileIdentity(file),
    stamp = `${identity}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
    old = executableCache.get(file);
  let digest =
    old?.stamp === stamp && !fresh ? old.digest : bytesHash(readFileSync(file));
  if (fileIdentity(file) !== identity)
    throw new UmiError('RESOURCE_CHANGED', '程序身份变化');
  executableCache.set(file, { stamp, digest });
  return { path: file, identity, digest };
}
export class CommandPreparation {
  constructor(
    readonly files: ResourceFiles,
    readonly repo: ProcessRepository,
  ) {}
  prepare(
    input: unknown,
    mode: 'direct' | 'shell',
    executionId: string,
    fresh = false,
  ): ExecutionContext {
    bridgeProgram();
    const a =
        mode === 'direct'
          ? directCommandSchema.parse(input)
          : shellCommandSchema.parse(input),
      t = this.repo.store.tool(executionId),
      env = this.repo.store.environment(t.environment_id);
    const root = commandCwd(this.files, env, a.cwd, true);
    const preparation = a.preparation
      ? {
          ...a.preparation,
          fingerprint: new ExecutionInspection(this.files).assertCurrent(
            a.preparation.inspectionExecutionId,
            a.cwd,
            env,
          ),
          cacheRoot: join(env.root, 'task', 'cache'),
        }
      : undefined;
    if (preparation) {
      for (const target of [
        preparation.cacheRoot,
        join(preparation.cacheRoot, 'npm'),
        join(preparation.cacheRoot, 'pip'),
        join(preparation.cacheRoot, 'xdg'),
      ]) {
        let existing = target;
        while (true) {
          try {
            lstatSync(existing);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            existing = dirname(existing);
          }
        }
        safeRoot(existing);
      }
    }
    const cwdIdentity = rootIdentity(root);
    const context = hostContext(input, this.repo.store.environment(env.id));
    let program: string,
      argv: string[],
      script: string | undefined,
      shell: 'powershell' | 'cmd' | 'direct' = 'direct';
    if (mode === 'direct') {
      const d = directCommandSchema.parse(input);
      program = resolveProgram(d.program);
      argv = d.argv;
    } else {
      const s = shellCommandSchema.parse(input);
      script = s.script;
      shell = s.shell;
      program =
        s.shell === 'powershell'
          ? bridgeProgram()
          : join(process.env.SystemRoot!, 'System32', 'cmd.exe');
      argv =
        s.shell === 'powershell'
          ? [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-OutputFormat',
              'Text',
              '-Command',
              // CreateProcessW/argv 保留 Unicode；原生 Command 避免 EncodedCommand 的 stderr CLIXML。
              '$ProgressPreference="SilentlyContinue";[Console]::InputEncoding=New-Object System.Text.UTF8Encoding;[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding;$OutputEncoding=[Console]::OutputEncoding;' + script,
            ]
          : ['/d', '/s', '/c', script];
    }
    const exe = executable(program, fresh);
    let scope: ProcessSnapshot['scope'] = 'host-code-execution';
    const environment: Record<string, string> = {
      ...bridgeEnvironment(),
      PATH: process.env.PATH ?? '',
    };
    if (preparation) {
      environment.NPM_CONFIG_CACHE = join(preparation.cacheRoot, 'npm');
      environment.PIP_CACHE_DIR = join(preparation.cacheRoot, 'pip');
      environment.XDG_CACHE_HOME = join(preparation.cacheRoot, 'xdg');
    }
    for (const [key, value] of Object.entries(a.env))
      if (value !== undefined) environment[key] = value;
    if (mode === 'direct' && /(?:^|[\\/])(?:powershell|pwsh|cmd)\.exe$/i.test(exe.path))
      throw new UmiError(
        'PROGRAM_UNSUPPORTED',
        'Windows Shell 请使用 run_shell，以固定 NoProfile 或禁用 AutoRun 的入口执行',
      );
    // 不继承 API 密钥、NODE_OPTIONS、代理凭据、SSH agent、PowerShell profile 或用户 Git 全局配置。
    if (/(?:^|[\\/])git\.exe$/i.test(exe.path)) {
      const verb = argv[0];
      if (
        !verb ||
        verb.startsWith('-') ||
        argv.some(
          (x) =>
            x === '-c' ||
            x.startsWith('--config-env') ||
            x.startsWith('--exec-path') ||
            x.startsWith('--upload-pack') ||
            x.startsWith('--receive-pack'),
        )
      )
        throw new UmiError(
          'GIT_ARGUMENTS_UNSUPPORTED',
          'Git 必须指定明确子命令；不接受配置/执行程序覆盖参数',
        );
      scope = ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'].includes(verb)
        ? 'git-inspect'
        : ['clone', 'fetch', 'pull', 'push'].includes(verb)
          ? 'git-network'
          : ['reset', 'clean', 'restore'].includes(verb)
            ? 'git-destructive'
            : 'git-write';
      environment.GIT_CONFIG_NOSYSTEM = '1';
      environment.GIT_CONFIG_GLOBAL = 'NUL';
      environment.GIT_TERMINAL_PROMPT = '0';
      environment.GCM_INTERACTIVE = 'Never';
      argv = [
        '-c',
        'credential.helper=',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=NUL',
        '-c',
        'protocol.ext.allow=never',
        ...argv,
      ];
      if (verb === 'diff' || verb === 'show') argv.push('--no-ext-diff', '--no-textconv');
    }
    const commandLine =
      shell === 'cmd'
        ? `${quoteArgument(exe.path)} /d /s /c "${script}"`
        : [exe.path, ...argv].map(quoteArgument).join(' ');
    const snapshot = processSnapshotSchema.parse({
      schemaVersion: 1,
      executionId,
      leaseGeneration: this.repo.store.getRun(t.run_id).generation,
      mode: shell,
      program: exe.path,
      programIdentity: exe.identity,
      programHash: exe.digest,
      argv,
      commandLine,
      cwd: root,
      cwdIdentity,
      cwdObservation: 'root-identity',
      cwdRef: a.cwd,
      env: environment,
      stdin: a.stdin,
      ...(script !== undefined ? { script, scriptHash: hash(script) } : {}),
      bridgeHash: hash(WINDOWS_BRIDGE),
      timeoutMs: a.timeoutMs,
      maxOutputBytes: a.maxOutputBytes,
      scope,
      ...(preparation ? { preparation } : {}),
    });
    {
      const signature = (s: ProcessSnapshot) =>
        hash({
          mode: s.mode,
          program: s.program,
          argv: s.argv,
          script: s.script ?? null,
          cwd: s.cwd,
          stdin: s.stdin,
        });
      for (const prior of this.repo.store.tools(t.run_id)) {
        if (
          !['run_command', 'run_shell'].includes(prior.name) ||
          prior.state !== 'denied' ||
          !prior.context_ref
        )
          continue;
        const original = executionContextSchema.parse(
          this.repo.store.readArtifact(prior.context_ref),
        ).process;
        if (original && signature(original) === signature(snapshot))
          throw new UmiError(
            'PERMISSION_DENIED',
            '本任务该具体命令已被拒绝，不能更换参数外壳或目的描述再次申请',
          );
      }
    }
    return { ...context, runtimeId: 'host-windows-job-process', process: snapshot };
  }
}
