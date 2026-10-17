import { nativeOpenRequestSchema } from '../../packages/protocol/src/native-open.js';
import type { DocumentTarget } from '../../packages/protocol/src/native-open.js';
import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { RequestAdmission } from './request-admission.js';
import {
  readySchema,
  ipcResponseSchema,
  bootErrorSchema,
} from '../../packages/protocol/src/desktop.js';
import type {
  DesktopCommand,
  DesktopConfig,
} from '../../packages/protocol/src/desktop.js';
import { UmiError } from '../../packages/protocol/src/model.js';

export class AgentBroker {
  private child: UtilityProcess | null = null;
  private current: ReturnType<typeof readySchema.parse> | null = null; //ReturnType 给一个函数类型，取出它的返回类型
  private starting: Promise<ReturnType<typeof readySchema.parse>> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (x: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly admission = new RequestAdmission();
  private closing = false;
  private nextStartAt = 0;
  private failures = 0;
  //接收入口路径、数据根目录、配置、是否验证模式，自动存成实例属性
  constructor(
    private readonly entry: string,
    private readonly dataRoot: string,
    private config: DesktopConfig,
    private verification = false,
    private readonly openDocument?: (target: DocumentTarget) => Promise<void>,
  ) {}
  async ready() {
    //正在关闭 → 抛错
    if (this.closing) throw new UmiError('APP_SHUTDOWN', '应用正在退出');
    //已就绪（current 有值）→ 直接返回缓存的就绪数据
    if (this.current) return this.current;
    //正在启动（starting 有值）→ 返回那个进行中的 Promise（复用，不重复启动）
    if (this.starting) return this.starting;
    //还在退避期 → 抛错，稍后再试
    if (Date.now() < this.nextStartAt)
      throw new UmiError('READY_BACKOFF', 'Agent 尚未就绪，请稍后重试；不会自动恢复任务');
    //子进程发来的消息分四类处理
    //非当前进程忽略、启动失败 reject、就绪 resolve、普通响应按 correlationId 找到等待者并 resolve/reject
    //手动创建 Promise，把 resolve/reject 存起来，将来异步调用
    this.starting = new Promise<ReturnType<typeof readySchema.parse>>(
      (resolve, reject) => {
        //收集允许传给子进程的环境变量（白名单）
        const env: Record<string, string> = {};
        for (const k of [
          'PATH',
          'SystemRoot',
          'WINDIR',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'HOMEDRIVE',
          'HOMEPATH',
        ])
          if (process.env[k]) env[k] = process.env[k]!;
        //启动一个子进程（Electron 的 utilityProcess）
        const child = utilityProcess.fork(this.entry, [], {
          env,
          stdio: 'pipe',
          serviceName: 'Umi Agent',
        });
        this.child = child;
        //20 秒超时，超时就杀掉子进程并 reject
        const timer = setTimeout(() => {
          child.kill();
          reject(new UmiError('READY_TIMEOUT', 'Agent 未完成数据库与协议就绪检查'));
        }, 20000);

        child.on('message', (message) => {
          //过滤 避免已废弃的子进程发来的消息影响当前状态
          if (child !== this.child) return;
          //message?.kind 可选链，防空
          if (message?.kind === 'boot_error') {
            //safeParse —— Zod 的安全校验，不抛错，返回 { success, data/error }
            const e = bootErrorSchema.safeParse(message);
            clearTimeout(timer);
            child.kill();
            //reject(...) —— 让 Promise 失败
            reject(
              new UmiError(
                ////三元 e.success ? A : B —— 校验过就用它的字段，否则用兜底字符串
                e.success ? e.data.code : 'READY_FAILED',
                e.success ? e.data.message : 'Agent 初始化失败',
              ),
            );
            return;
          }
          if (message?.kind === 'ready') {
            try {
              this.current = readySchema.parse(message.payload); //会抛错的校验（对比 safeParse 不抛）
              this.failures = 0;
              this.nextStartAt = 0;
              clearTimeout(timer);
              resolve(this.current);
            } catch {
              child.kill();
              reject(new UmiError('PROTOCOL_INVALID', 'Agent 就绪协议不兼容'));
            }
            return;
          }
          // 仅 utility process 的固定文档动作；页面没有此消息频道。
          if (message?.kind === 'open_document') {
            const request = nativeOpenRequestSchema.safeParse(message);
            if (!request.success || !this.current || request.data.instanceId !== this.current.instanceId || this.closing) return;
            const { correlationId, target, instanceId } = request.data;
            void (async () => {
              let error: string | undefined, code: 'OPEN_REJECTED' | 'OPEN_UNKNOWN' | undefined;
              try {
                if (!this.openDocument || this.verification) throw new UmiError('OPEN_UNAVAILABLE', '当前验收模式不启动系统应用');
                await this.openDocument(target);
              } catch (e) {
                error = e instanceof Error ? e.message.slice(0, 4096) : '系统打开失败';
                code = e instanceof UmiError && ['OPEN_FAILED', 'OPEN_UNAVAILABLE', 'OPEN_UNSUPPORTED', 'RESOURCE_CHANGED', 'PERMISSION_DENIED'].includes(e.code) ? 'OPEN_REJECTED' : 'OPEN_UNKNOWN';
              }
              if (child === this.child) child.postMessage({ kind: 'open_document_result', correlationId, instanceId, ...(error ? { error, code } : {}) });
            })();
            return;
          }
          //校验消息 → 不是就忽略
          const parsed = ipcResponseSchema.safeParse(message);
          if (!parsed.success) return;
          const response = parsed.data;
          //检查 instanceId 匹配（防串消息）
          if (!this.current || response.instanceId !== this.current.instanceId) return;
          //从 pending 按 correlationId 取出对应的 resolve/reject
          const p = this.pending.get(response.correlationId);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(response.correlationId);
          if (response.kind === 'error')
            p.reject(new UmiError(response.code, response.message));
          else p.resolve(response.payload);
        });
        //进程退出就清理并 reject；进程启动就发 init；标准输出故意丢弃
        child.on('exit', () => {
          clearTimeout(timer);
          if (child !== this.child) return;
          this.child = null;
          this.current = null;
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(
              new UmiError(
                'AGENT_DISCONNECTED',
                'Agent 进程退出；命令可能已接收，请按原 commandId 查询',
              ),
            );
          }
          this.pending.clear();
          reject(new UmiError('AGENT_DISCONNECTED', 'Agent 启动或执行进程退出'));
        });
        child.on('spawn', () =>
          child.postMessage({
            kind: 'init',
            dataRoot: this.dataRoot,
            config: this.config,
            ...(this.verification ? { verification: true } : {}),
          }),
        );
        // stderr 不转发给渲染器；避免诊断回显成为秘密泄露通道。
        child.stderr?.on('data', () => {});
        child.stdout?.on('data', () => {});
      },
    )
      .catch((error) => {
        this.failures++;
        this.nextStartAt = Date.now() + Math.min(30000, 1000 * 2 ** this.failures);
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  async request(
    payload:
      | DesktopCommand
      | { internal: 'create_internal' | 'configure' | 'shutdown'; payload: unknown },
  ) {
    const release = this.admission.reserve(
      'internal' in payload ? payload.internal === 'shutdown' : payload.type === 'stop',
    );
    try {
      const ready = await this.ready(),
        correlationId = randomUUID();
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(correlationId);
          reject(
            new UmiError(
              'COMMAND_TIMEOUT',
              '命令回执超时；请查询原 commandId，不要重复提交新命令',
            ),
          );
        }, 20000);
        this.pending.set(correlationId, { resolve, reject, timer });
        try {
          this.child!.postMessage(
            'internal' in payload
              ? {
                  kind: payload.internal,
                  correlationId,
                  instanceId: ready.instanceId,
                  payload: payload.payload,
                }
              : {
                  protocolVersion: 1,
                  correlationId,
                  instanceId: ready.instanceId,
                  payload,
                },
          );
        } catch {
          clearTimeout(timer);
          this.pending.delete(correlationId);
          reject(new UmiError('AGENT_DISCONNECTED', '消息未能发送到执行进程'));
        }
      });
    } finally { release(); }
  }
  async configure(config: DesktopConfig) {
    if (config.baseUrl !== this.config.baseUrl)
      throw new UmiError(
        'CONFIG_RESTART_REQUIRED',
        '修改端点后请重启 Umi；正在运行的任务不会切换模型路由',
      );
    await this.request({ internal: 'configure', payload: config });
    this.config = config;
    if (this.current) this.current.modelConfigured = Boolean(config.apiKey);
  }
  async close() {
    if (this.closing) return;
    if (this.child && this.current) {
      try {
        await this.request({ internal: 'shutdown', payload: {} });
      } catch {
        this.child?.kill();
      }
    }
    this.closing = true;
    this.child?.kill();
  }
  killForVerification() {
    this.child?.kill();
  }
}
