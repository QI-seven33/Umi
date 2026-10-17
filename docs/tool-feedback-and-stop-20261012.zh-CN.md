# Umi：工具反馈完整可见、停止请求及时可达（2026-10-12）

本轮只在 `E:\SOME_SEVEN_PROJECT-57\Umi_v2.0` 开发，保留既有未提交修改与学习注释。下面的“已实现”对应当前源码与本轮验收；后续方案不代表授权。生产数据库、真实 API、便携包、发布中转目录和 Windows 配置均未修改。

## 1. 选择的路线

沿唯一 `UmiApplication → AgentEngine → ContextManager → ModelPort / ToolExecutor → 适配器 → SQLite → 桌面事件流` 修复反馈和控制链。使用现有工具模块和端口，不新增 Agent 循环、安装器前置或插件平台。

DeepSeek 建议的核心适用于 Umi，但“本轮”应精确定义为**刚执行、等待反馈给模型的工具调用组**。这组结果完整进入下一次模型请求；后续模型已经有机会看到它后，才可按旧历史策略压缩。这样既避免新读取被 11 条历史均分成 744 字节，也避免一个长任务的所有读取永远占满上下文。保存可见证据后，旧正文被折叠不会抹掉此前已发送的范围。

| 优先级 | 当前源码行为 | 验收与边界 |
| --- | --- | --- |
| P0 新结果完整反馈 | 最新 assistant 工具调用及全部对应结果整体保留，不均分、不二次裁读、不被维护折叠 | 11/30 条旧结果不缩小新范围；一次读 11 文件含 7,968 字节源码完整可用 |
| P0 工具负责分页 | `read_file` 返回完整 hash、真实 start/end、nextStartByte；历史、资料、进程输出也返回真实范围/续读位置 | UTF-8 边界对齐，范围内正文完整。超出模型硬预算明确阻塞，不能为了塞入请求隐藏新正文 |
| P1 正文去重 | 新回执在 content/data 中只保留一份正文；旧双份回执只在模型/展示视图去重 | SQLite 原消息/资料保持不可变；同一记录不再内嵌两份正文，但消息与资料仍分别承担持久化职责 |
| P1 已观察与可见区分 | 编辑必须找到完整读取回执出现在已冻结的模型请求中，并有对应完整模型响应 | 仅 prepare/inspect、工具成功或原始资料存在都不算。整文件替换需完整文件范围；局部编辑需命中可见回执范围 |
| P2 真正追回 | 新的 `read_history`、`read_artifact`、`read_process_output` 回执作为最新组完整反馈 | 已归档范围可完整追回；未归档进程输出不可凭分页找回，见第 5 节 |

工具投影策略版本是 `tool-roles-v2`，纳入请求元数据及预算恢复指纹。原话折叠清单仍兼容 `bounded-v1`，不改旧迁移校验值。旧工具正文使用独立预算，近期优先，摘录带原消息 ID/hash/范围与追回方法；原消息组配对及原文永久保留。

## 2. 关键代码怎么读

1. `packages/agent/src/context/bounded.ts` 的 `freshToolIds/toolResultViews` 找到最新工具组，先完整给新结果，再分配旧结果预算。`manager.ts` 在自动维护中同时保护这组，防止“没有截取却直接折叠了新结果”。
2. `packages/agent/src/tools/result.ts` 的 `singleResultBody` 只消除重复 JSON，保留非重复说明、退出事实及结构化字段。`SqliteStore.settle` 对新回执应用它，并兼容旧等价回执幂等重发，不改旧记录。
3. `SqliteStore.modelReceivedToolResult` 比较**实际冻结请求**中的读取 data 与原回执，并核对对应完整 assistant 响应。`host-files/read-evidence.ts` 在共同编辑入口要求这条证据，失败返回 `MODEL_READ_REQUIRED`。这证明模型获得可用范围并作出响应，不证明它主观理解每个字符。原 hash、对象身份、会话、挂载、当前文件版本核验继续有效。
4. `apps/headless/src/application.ts` 的 `requestStop` 同步保存意图并 abort；旧 `stop` 仍可供核心调用者等待清理。`DesktopService` 立即返回接收状态，worker 的 `WorkerCommandQueue` 让经过协议校验的 stop 绕过普通等待；实例和会话校验仍在处理器中。
5. `ToolExecutor` 在工具边界让出事件循环；`CommandTools.reconcile → runner.probe` 传递 signal。运行桥接收到 stop 后清理 Job，失联有关闭兜底；缺少真实回执仍是 unknown，不能重放或解锁新副作用。
6. `DesktopService.tool_detail` 显示去重后的实际正文，以 UTF-8 字节分页取代 16,000 字符硬截取；`Timeline` 可继续显示。批准区仅有批准动作，外层保留会话级“停止任务”；收到停止状态后禁用重复停止。

PowerShell 本轮实际验收发现 `-EncodedCommand` 即使指定 Text，stderr 仍走 CLIXML。改为原生 Unicode `-Command`，保持完整 argv/script 冻结、现有命令行编码与批准；UTF-8 编码及禁用进度仅作用于本次子进程。不设置全局 ErrorActionPreference，也不改 Windows 设置。中文成功、中文错误、退出码 7 和长输出追回已真实验证。参数说明见 [Microsoft 官方文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)。

## 3. 最新对照，不把建议当源码事实

2026-10-12 从官方 GitHub API 固定当前提交并下载选定源码。本地 Harness 学习副本仍是 `639ed015…`，本轮官方 master 为 `d743267388641bc76f17c45ce8b4c231aed1d32c`；Reasonix studio 为 `4a0b3888cb09aef911e9ad64d243f77bf0bd18a5`。这是选定路径核对，非全仓安全审计。

- [Reasonix readfile.go](https://github.com/esengine/DeepSeek-Reasonix/blob/4a0b3888cb09aef911e9ad64d243f77bf0bd18a5/internal/tools/builtin/readfile.go) 声明 Paged，并给出行续读位置；其 [窗口读取测试](https://github.com/esengine/DeepSeek-Reasonix/blob/4a0b3888cb09aef911e9ad64d243f77bf0bd18a5/internal/tools/builtin/readfile_window_test.go) 验证小窗口不为统计总行数耗尽整文件。Umi 借鉴续读契约，继续沿用 UTF-8 字节/hash，避免行号与写入字节再建一套映射。
- [Harness read-render.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/fs/tool-fs/src/read-render.ts) 有读取窗口、总输出上限及续读提示，但也截超长单行。“从不裁正文”不是它的统一事实；Umi 对工具承诺的字节范围选择更严格的完整性。
- [Reasonix turn_cancel.go](https://github.com/esengine/DeepSeek-Reasonix/blob/4a0b3888cb09aef911e9ad64d243f77bf0bd18a5/internal/session/control/turn_cancel.go) 将取消门控与后台收尾分开，批准等待通过 context 取消唤醒；[Harness tool-calls.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/tool-calls.ts) 区分已启动调用、未派发取消与有序结算。Umi 对应采用及时接收、停止后续派发、真实清理事实分离。
- [Harness 安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/SAFETY.md) 和 [Reasonix 安全说明](https://github.com/esengine/DeepSeek-Reasonix/blob/4a0b3888cb09aef911e9ad64d243f77bf0bd18a5/SECURITY.md) 都不能作为 Umi 已具备其隔离能力的证明。Umi 的结构化文件核验、命令授权和 OS 隔离是不同边界，当前宿主命令没有文件/网络沙箱。

## 4. 本轮验收与证据

证据目录：`E:\Codex\Workspace\output\umi-feedback-stop-20261012`。修改前备份 216 个源码/文档/测试文件及 Git 状态、完整 diff；未 reset/clean。

| 验收 | 本轮结果 |
| --- | --- |
| 相关集合 | `tests-final.log`：200 项全部通过；含真实读改、可见证据拒绝、窗口预算、重启恢复、桌面和任务验收 |
| 实际进程专项 | `native-final.log`：4 项通过，含 Node 子进程树、输出归档/跨分片脱敏、PowerShell、CMD |
| 小项目 | 11 文件读取，关键源码 7,968 字节；模型视图完整，显式 replace 后真实 `node --test` 退出 0，源目录保持原文 |
| 日常文件 | 17,120 字节中文 CRLF 文本按 4,000 字节续页，范围内原文逐字匹配；最后范围局部编辑；历史/资料与 UI 详情可完整追回 |
| 长命令反馈 | 20 KiB 以上 stdout 含中间关键内容，经 `read_process_output` 全部取回；中文 stderr 可读、无 CLIXML/替代字符，退出码 7 没被当成成功 |
| 同步读取与停止 | 30 文件批次中停止后剩余未派发工具取消，不再请求模型；probe 取消不等 20 秒 |
| 实际子进程树停止 | 接收约 3.8ms，清理约 55ms；PID 已退出，副本已发生效果保留 |
| 最终 Electron 构建的真实 worker IPC | 接收约 3.8ms，模拟模型任务约 10.2ms 完成停止；临时数据、无窗口、API 调用 0 |
| UI | 实际组件/CSS 的临时浏览器样本；停止在批准卡片外可点击，宽度 64px 单行；工具详情分页控件可操作，超过旧截取长度的正文仍可显示 |
| 构建 | Node 24 类型检查、核心编译、桌面构建通过；未重新发布、未同步便携包 |

回归中有两个旧失败，在修改前备份中同样复现（`baseline-pair.log`）。已将“普通文件变化必须阻止命令”改成仍适用的目录根替换样本；预算样本改用容纳当前完整工具规格/输出余量的窗口，旧大原话仍触发阻塞。不恢复全目录指纹，也没有削弱当前版本/未知结果核验。

这些是离线固定模型与真实工具链的证据，不代表付费模型自主完成率；单次停止计时不代表生产会话 p50/p95，更不证明旧现场的三次超时已逐项复现。UI 截图是隔离样本，非生产会话。

## 5. 下一小阶段与未实现边界

下一阶段建议采用同一工作链再补 4 个具体样本：中文文件筛选生成、跨多文件修复失败测试、较大模块定点改动、长日志定位。先离线量化有效读取/追回次数、无效重试、批准数、总耗时及 renderer→main→broker→worker 的暖/冷停止 p50/p95。真实模型任务质量单独安排费用和范围，当前没有自动调用授权。

进程当前按 `maxOutputBytes` 归档，上限之后只能证明观察到的字节数及 truncated，无法追回未归档正文。本轮实现的是**已返回/已归档范围完整可用**。若要完整超长日志，应另列契约：预览预算与磁盘归档预算分开，溢出写独立资料、分页读取，磁盘上限及到限状态明确；不把无限日志、自动安装器或留存治理加入普通任务前置。

后续仍需讨论这些契约，尚未实现或扩大授权：

| 选择 | 收益 | 必须说清的取舍 |
| --- | --- | --- |
| 用户选定工作区直接文件操作 vs 工作副本 | 直接模式减少复制、依赖缺失和交付摩擦 | 改的是源文件，需明确模式、版本冲突与可恢复写入；结构化路径检查约束文件工具，不能约束已批准任意代码 |
| 结构化网络工具 vs 宿主代码联网 | URL、范围、回应/分页容易反馈；代码仍可完成复杂网络任务 | 当前宿主代码可访问网络，工作目录和“未请求联网”声明都不阻断网络；网络信任不能靠脚本词法判断 |
| 每次具体命令批准 vs 明确任务内宿主信任 | 任务信任减少重复批准，适合项目测试/构建循环 | 工作区/程序只是用户授权的描述，不是代码只能访问那些资源的隔离保证；项目内容不得自行扩大信任 |
| 用户消息续作 vs “继续任务” | 自然消息续作更符合个人助手体验 | 先核验未知执行，再应用新输入；发新消息目前还不能可靠地启动异常任务，本轮未改这条逻辑 |

因此，Umi 当前最合适的道路是先把工具契约和停止控制做可靠，以实际任务完成情况决定下一项删减；直接工作区与宿主信任模式在明确上述取舍后再实施。Docker/WSL2 或 OS 沙箱仍为可选能力，MXC 继续退役。
