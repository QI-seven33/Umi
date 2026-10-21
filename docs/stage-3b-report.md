# Umi 阶段 3B：宿主命令与进程生命周期

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


日期：2026-10-04，Asia/Shanghai。产品名称为 **Umi**，开发目录为 `E:\SOME_SEVEN_PROJECT-57\Umi_v2.0`。

本阶段在原有 TS 核心中实现 Windows 命令与 Shell 工具，沿用唯一 Agent 循环、权限入口、SQLite 写入者、事件日志、归约函数和会话游标。没有引入大型框架、第二套 Agent 或 Python 服务。阶段 4 的长任务记忆和阶段 5 的前端、Electron 尚未实施。

## 1. 当前增加了什么

| 能力 | 实际行为 |
|---|---|
| `run_command`（明确程序执行） | 模型提供程序和 `argv` 参数数组，直接创建进程；不把数组拼接成模型控制的 Shell 脚本 |
| `run_shell`（命令解释器执行） | 接受完整 PowerShell 或 CMD 脚本，保存脚本及指纹并申请具体批准 |
| `read_process_output`（读取进程输出） | 按执行 ID、标准输出/错误通道和 UTF-8 字节范围读取本会话的脱敏归档 |
| 进程生命周期 | 启动前记录所有者；目标挂起创建、加入 Windows Job Object 后等待释放；停止、超时或父连接退出时清理普通进程树 |
| 结果核验 | 保存退出码、终止原因、清理结果、输出资料和执行后目录观察；非零退出仍保留已发生的修改 |
| 重启恢复 | 查找原执行及原进程身份，终止并核验；不因为结果未知而重跑原命令 |
| 开发者预览 | JSON 入口新增 `preview_process`，读取与模型工具相同的归档事实 |

`argv` 是程序收到的参数数组；`cwd` 是进程的起始工作目录；`stdout/stderr` 分别为标准输出和标准错误；`Job Object` 是 Windows 的进程组管理对象，**不是文件和网络沙箱**。

## 2. 用户视角的完整过程

1. 用户选择初始工作区并提出任务。已有阶段 3A 机制复制资料到同会话工作副本，原文件尚未被修改。
2. 模型读取、编辑副本，判断需要执行测试、构建或 Git。普通副本编辑继续沿已有能力自动执行。
3. 模型提出具体命令。系统解析实际程序、参数、目录及脚本，确定执行范围，冻结快照。
4. 用户看到具体批准请求：实际程序、实际参数或完整脚本、目录、范围、超时、输出上限，以及宿主执行可以访问其他文件和网络的说明。
5. 拒绝则不创建目标进程，明确回填拒绝。批准后再次检查程序、依赖内容和环境修订；对象改变时原批准失效，需要新的具体请求。
6. 系统记录执行意图、桥接进程身份和挂起目标身份，提交释放意图后运行。生成中的输出按分片归档并发布同一会话事件。
7. 进程退出或被停止，系统清理普通后代进程、保存回执，随后提交工具结果。模型获得有界输出摘录和回执，必要时继续读取输出、检查生成文件或修复测试。
8. 源文件交付仍使用阶段 3A 的固定 ChangeSet（变更集）和独立批准。命令批准不等于源文件交付批准。
9. 事件订阅断线不停止任务；明确停止、应用退出和显式恢复继续按原有独立语义处理。

当前 `ask/auto` 两档均要求每次宿主命令具体批准，包括 Git 状态查询。并未增加“全部允许”档位或基于首词的宽泛白名单。用户无需自行设计命令或选择内部实现路径。

## 3. 系统视角与代码导航

下列路径相对于开发目录，英文方法名保留为代码定位关键字。

### 3.1 组装与唯一调度入口

- `apps/headless/src/application.ts`：`UmiApplication` 组装 `CommandTools`，通过 `registerCommands` 接入现有注册表；`previewProcess` 检查会话归属后读取归档；恢复检查返回对应进程投影。
- `packages/agent/src/loop/engine.ts`：现有 `AgentEngine` 仍调度模型轮次、完整工具调用、批准等待、结果回填和下一轮。本阶段未创建新循环。
- `packages/agent/src/tools/executor.ts`：`ToolExecutor.execute` 校验完整参数，执行 `prepare`，等待持久批准，提交派发与开始事实，调用执行器，最后结算。`host-code` 是新增副作用类别；恢复仍调用原工具的 `reconcile`。
- `packages/agent/src/tools/registry.ts`：工具定义增加执行超时和批准轮询配置，不在具体执行器内重新建立权限系统。
- `packages/agent/src/context/prompts.ts`：中文说明命令能力、批准边界及退出码的含义；版本为 `umi-persona-3`。主上下文入口和 DeepSeek 原始 reasoning 回传规则保持原有职责。

### 3.2 冻结执行快照与批准失效

`packages/protocol/src/process.ts` 用 Zod（运行时数据校验库）定义参数、进程身份、执行快照和回执。

`packages/adapters/src/host-process/prepare.ts`：

- `CommandPreparation.prepare` 将逻辑目录解析为明确物理根：编辑能力有效的挂载副本，或 `task/scratch`、`task/research`，再加相对路径。
- `fingerprint`（内容指纹）检查完整命令目录，包括已有 `.git` 和依赖文件。入口脚本未变而依赖改变，也不能继续复用原批准。
- `resolveProgram` 解析实际 `.exe`；`node` 指向当前 Node 程序。批处理使用明确 Shell 模式。直接提交 `cmd.exe/powershell.exe/pwsh.exe` 被拒绝，避免绕过固定 Shell 入口。
- `executable` 保存实际程序的内容 hash（哈希指纹）与对象身份；等待期间可使用内容缓存，真正创建和释放前重新读取校验。
- `quoteArgument` 按 Windows 参数编码规则处理空格、引号、反斜线、空参数及 Unicode；CMD 完整脚本使用其自身的 `/s /c` 规则。
- `ProcessRepository.trackFingerprint` 对账外部目录变化，更新环境修订；批准绑定快照，包括修订、租约代次、程序/脚本指纹、实际参数、目录身份和内容指纹、环境变量及限额。

环境变量只保留必要系统变量、PATH 和明确白名单；不会直接继承 API 密钥、NODE_OPTIONS、代理凭据、SSH agent 或用户 Git 全局配置。此规则减少意外暴露，不能阻止已批准宿主代码自行读取磁盘上的凭据。

### 3.3 挂起创建与持久化边界

`packages/adapters/src/host-process/windows-bridge.ts` 保存固定 PowerShell + C#/.NET Win32 桥接源码。模型不能修改此桥接或向桥接注入代码；模型脚本仅在获准的目标 Shell 中执行。

`packages/adapters/src/host-process/runner.ts` 的 `WindowsProcessRunner.run` 按以下握手执行：

```text
既有 tool.dispatch_intent / tool.started
  → process.planned：保存不可变执行快照
  → 固定桥接启动，发出 owner（所有者身份）
  → process.owner_bound 提交后，才发送 prepare（允许准备目标）
  → CreateProcessW 挂起创建目标、加入 Job Object
  → process.ready：保存桥接与目标 PID + 创建时间
  → 再次核验冻结快照、环境租约和目录内容
  → process.release_intent 提交后，才发送 go（释放执行）
  → ResumeThread，收到实际启动确认，提交 process.started
  → process.output：有序分片 + 不可变输出资料
  → 原程序退出 / stop / timeout / 父连接关闭
  → 清理普通后代进程，核对 Job 活动数
  → 完整通道归档 + 退出回执 + process.exited 同事务保存
  → tool.settled + 工具结果
  → 下一模型轮
```

`PID` 是进程编号，可以被操作系统复用；创建时间采用原生 FILETIME（Windows 时间格式）。恢复核验在同一个原生进程句柄上比较创建时间并终止，不仅凭旧 PID 终止可能无关的新进程。

固定桥接设置 `KILL_ON_JOB_CLOSE`（最后句柄关闭时终止组内进程）；普通目标创建失败或无法加入 Job 时不释放。进程组上限为 64 个进程、2 GiB 作业内存。根程序结束后也清理残留后代，所以当前不支持将后台服务留在应用之外继续运行。

### 3.4 存储、事件与唯一投影

`packages/adapters/src/sqlite/process-schema.ts` 提供 schema（数据库结构）版本 3 的实际 SQL 迁移。`store.ts` 在原有事务入口校验迁移指纹；版本 1/2 的消息、挂载、定位资料和游标保留。

| 新增表 | 保存内容 | 与已有事实的关系 |
|---|---|---|
| `process_executions` | 原工具执行 ID、快照引用、准备/运行/退出状态、桥接和目标身份、释放标志、回执引用 | 外键引用原 `tool_executions`，不是第二套任务身份 |
| `process_outputs` | 每个原执行的连续分片编号、通道、资料引用、字节长度 | 内容放现有不可变 `artifacts`，事件与分片同事务提交 |
| `process_fingerprints` | 环境中已观察到的目录指纹 | 对账缓存；变化需产生环境修订，不能独自证明任务成功 |

`packages/adapters/src/sqlite/processes.ts` 的 `ProcessRepository` 复用原 SQLite 连接：`plan/owner/ready/release/started/output/finish` 对应执行边界；`confirmCleanup` 追加新核验资料和 `process.reconciled`，保留旧回执。

`packages/protocol/src/events.ts` 为进程事件规定完整 run/turn/attempt/call/execution 归属。`reducer.ts` 仍为唯一纯归约函数，新增 `commandExecutions` 投影及顺序检查。

实时订阅、重连及历史使用同一个 `(conversationId, logEpoch, sequence)` 游标；没有新增进程游标。事件中的输出保存资料引用，不把全部日志放入 reducer 状态或模型上下文。前端接入留到阶段 5，当前验证的是共享投影与无界面入口。

### 3.5 输出、超时与停止

原生桥接通过管道捕获字节，Runner 用 UTF-8 解码，处理跨分片字符及已知敏感环境值，再保存脱敏内容。默认合计输出上限为 64 KiB，可配置 1 KiB—1 MiB；超限后继续排空管道，但丢弃多余内容并标记截断。已丢弃内容不能通过后续读取找回。

默认命令执行超时为 30 秒，可配置 100 毫秒—5 分钟，计算从实际释放目标开始。输入上限 64K 字符，Shell 脚本上限 8K 字符。模型工具结果每通道只给约 8000 字符摘录；`read_process_output` 每次最多读取 64000 字节，不能跨会话读取，也不能从 UTF-8 字符中间切开。

正常回执的字节数来自原生观测；崩溃恢复回执只知道已归档量，以 `byteCountBasis=archived-lower-bound` 明确表示下界，不伪装成完整原始计数。输出不是未经处理的 raw（原始）字节存储。

### 3.6 恢复不会重跑原命令

`packages/adapters/src/host-process/tools.ts`：`CommandTools.execute` 检查冻结上下文，调度原生 Runner，保存回执，再生成结果；`CommandTools.reconcile` 读取原执行和不可变快照：

| 中断位置 | 恢复判定 |
|---|---|
| 有工具派发、无进程计划 | 没有完成允许目标准备的握手，记录未执行失败 |
| 已计划或挂起就绪、未释放 | 核对并清理原进程，记录 `not_started`，不运行目标 |
| 已释放、没有可信退出回执 | 清理并核对原进程，记录 `interrupted`；工具失败，副作用仍需读文件核验 |
| 已有退出回执、工具结果尚未提交 | 使用原回执补结算；不重复启动或执行 |
| 原回执清理不明 | 可以再次核验原进程并追加清理确认；不覆写先前事实 |
| 身份、存活或清理无法确认 | 保持 unknown（结果未知）及环境恢复阻塞；不杀不相关 PID，不重试原命令 |

目录存在或生成文件存在，不被当成退出成功。停止、超时和非零退出仍可能已修改副本；只要释放过目标，对已知结算保守推进环境修订。当前机制无法穷举获准宿主程序的全部外部副作用。

### 3.7 Git 的边界

直接 Git 请求区分检查、联网、破坏性操作和写入，但所有类别都需要具体宿主批准。直接适配器关闭系统/用户全局配置、交互式认证、credential helper（凭据助手）、hooks（钩子）、fsmonitor（文件监控程序）和 ext 协议；diff/show 禁用外部差异程序及文本转换。拒绝模型覆盖配置或上传/接收程序参数。

这些默认值不能保证仓库本地过滤器、项目脚本或任意 Shell 内的 Git 永远不执行代码；它们均属于已披露的宿主执行范围。真实验收覆盖 init/status，没有真实推送、拉取或凭据管理验收。

## 4. 验收与证据

最终验收记录见 阶段 3B 工程证据（维护者本地证据/生成产物，不随源码仓库分发），真实模型记录见 DeepSeek 阶段 3B 证据（维护者本地证据/生成产物，不随源码仓库分发）。

- 自动套件共 94 个：既有 66 个，加 22 个进程用例和 6 个真实父进程强制退出用例。
- 新用例覆盖真实 Node/argv、PowerShell、CMD、Git、批准拒绝、auto 模式仍阻塞、目录/依赖漂移、PID 复用、输出范围与脱敏、非零退出、停止和超时进程树清理、事务失败、schema 2→3 升级、实时/历史归约一致。
- 六个真实硬退出位置为 planned、ready、released、started、output、receipt。恢复核验未重复执行原命令。连同此前案例，全套包含 22 个实际进程退出案例。
- 真实 DeepSeek Flash high 短任务：5 次模型调用、1 次具体命令批准；模型执行固定 Node 核验脚本，读取输出及生成文件，完成总结；原项目未修改。输入 29097 token、输出 1646 token、缓存命中输入 16640 token。不能作为长期成本或缓存目标。
- 真实模型验收后补充了回执字节数来源标记、直接 Shell 入口限制和执行身份检查，由最终自动测试验证；没有为这些元数据修订额外重复付费调用。

首次全量回归发现旧 CLI 断言未更新及一次 Git 长耗时超时。旧断言已按 Windows 命令能力/schema 3 更新，Git 独立复测通过。最终交付是否通过，以独立目标目录的完整验收证据为准；不隐藏首次失败，也不跳过或延长该 Git 用例的 60 秒限制。

## 5. 可运行入口

```powershell
npm run typecheck
npm test
npm run demo
node --env-file=.env dist/apps/headless/src/cli.js --data .umi
```

新预览请求：

```json
{"type":"preview_process","conversationId":"会话 ID","executionId":"工具执行 ID","channel":"stdout","startByte":0,"byteLength":8192}
```

真实模型验证需自行提供 API 配置，会产生费用：

```powershell
npm run build
node --env-file=.env dist/scripts/verify-process.js
```

## 6. 尚存在的限制

1. **没有 OS 文件或网络沙箱。** cwd 只是起点；获准代码仍有当前用户的宿主访问能力。工作副本和固定交付保护结构化写回，不能单独限制任意 Shell。
2. Job Object 管理普通 CreateProcess 后代，不等于对恶意代码的全面约束。由 WMI 或外部服务代为启动的进程可能不进入原 Job；不能承诺所有可能进程都会被停止或恢复清理。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
3. 此执行器仅实现 Windows，需要 PowerShell 5/.NET 原生桥接可用。不能启动或核验时明确失败/未知；没有回退到不受管理的直接 Node spawn。
4. 完整目录指纹当前限 20000 个对象、128 MiB 总内容、32 MiB 单文件、24 层及检查时间预算；程序内容上限 160 MiB。大型依赖树可能拒绝执行，安装后超过限制也可能影响后续命令。同步文件 I/O 的预算不是对阻塞磁盘操作的硬超时。
5. 指纹、独占租约和二次检查不能消除外部恶意程序在检查后改变磁盘的全部竞态。桥接及批准不是权限隔离替代品。
6. 输出按 UTF-8 解码；旧 CMD 程序或第三方程序使用其他编码时可能乱码。没有把未实现的通用编码能力写成已支持。
7. 64 进程/2 GiB 是已设置限制，不是大型构建压力验收结果；当前不支持长期后台服务。输出归档有限额，不承诺完整保存无限日志。
8. 一次真实 Flash high 短任务验证协议与闭环，没有验证 Pro、大型工程、长期成本、恶意批准脚本或全部网络行为。
9. 旧前端未接入新核心、未改变 UI；Docker/WSL 插件和 Electron 在后续阶段实施。当前核心无需 Python；固定 Windows 桥接包含 C#，不是重新引入 Python 后端。
10. 完整要求清单、主动窗口切换、消息组压缩和大规模记忆检索属于阶段 4。当前保留完整事实和有界上下文入口，超预算明确停止，不假装已完成长任务上下文优化。

原生挂起创建与入组依据见 [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。本文只承诺实际实现及已验证边界，不承诺依靠批准阻止获准代码的所有危险行为。

## 7. 下一阶段

阶段 4 在原 `ContextManager` 上实现带原文来源的要求清单、任务笔记、完整消息组压缩、预算与窗口维护；既有历史查询和资料范围读取继续使用。模型请求、系统事实和前端投影继续各有明确边界，压缩不重写原始消息，也不把本阶段全部进程事件塞入模型。
