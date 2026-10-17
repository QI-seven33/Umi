# Umi 开发状态与当前阅读入口

## 2026-10-17：GitHub与Windows预发布 0.2.0-alpha.1

本轮同步安装器、完整便携包和校验清单，图标改为平面圆角白底。版本入口：[v0.2.0-alpha.1](https://github.com/QI-seven33/Umi/releases/tag/v0.2.0-alpha.1)；本地输出release/installers/。公共README、贡献/安全/授权/第三方声明、Issue/PR模板和Windows CI已整理。项目未选择新的开源许可证，状态为UNLICENSED。

本轮类型检查和构建通过，439/439核心测试通过（测试文件并发度2）；源码桌面72/72通过；实际便携exe 64/72检查已通过，随后因已知HTML可见排版断言失败而结束，余下8项未执行。安装器实际嵌入载荷解包后182个运行文件逐项hash通过，载荷exe与便携exe相同。安装/卸载交互和注册表/快捷方式行为没有在本机额外执行验收；安装文件未代码签名。

详情见[本版发布说明](releases/0.2.0-alpha.1.zh-CN.md)和[Windows流程](windows-release.zh-CN.md)。已有历史改动、学习注释和3个旧删除保留并纳入本次提交范围；证据/旧exe备份保存在E:\Codex\Workspace\output\umi-github-release-20261017。HTML首帧偶发空白及A-01/A-02/A-03仍待单独处理。此条不授权下一轮自动实施旧计划。


核对日期：2026-10-11。本文按实际源码说明实现与缺口，产品名称始终是 Umi。旧报告的案例数只属于对应阶段，不能视为本次重新验收。


## 2026-10-11 当前：删减命令扫描与会话加载开销

命令不再递归读取/哈希整个 cwd，也不记录新 process_fingerprints；改为绑定目录根、真实程序、参数和原批准。普通内容变化不重新批准，根被替换仍阻止释放；具体文件编辑、来源交付与未知恢复保留原核验。inspect_execution/preparation 是可选观察，常规测试/构建不用先走准备流程。宿主本来没有网络沙箱，已用回环 HTTP 验证批准后可联网；外网/代理/服务可用性未测。command_exit 只证明指定执行退出 0，当前文件状态须由 file_hash 等独立证明，不能宣称整个项目没变。

桌面快照只查询用户原话并复用一次状态投影；正文首屏渲染近期 8 条用户消息，可加载更早消息、历史刻度展开跳转，新消息保留当前窗口与阅读位置。原始历史、完整工具组及模型上下文不裁剪。临时 20 轮样本：热快照中位约 29→1.3ms，首次正文服务端渲染约 517→236ms，冷快照约 75→49ms；不代表生产 Electron 全链路延迟已经修复，IPC/utility 启动及实际长会话仍待实测。

本轮相关 7 文件最终共 107 项通过（新增 2 项；最终命令/会话 2 文件 36 项另复测），核心/桌面构建通过；临时浏览器验证历史展开、滚动锚点、跳转与追加消息。没有真实 API、生产数据库、产品启动、依赖安装、发布或 Windows 修改。备份/日志：E:\Codex\Workspace\output\umi-streamline-20261011。后续优先常规任务能力与完成率/延迟样本，再讨论工作区直接编辑和显式宿主信任范围；不把 OS 沙箱、自动安装器或留存框架当能力前置。学习入口：[删减与加载调用链](streamline-and-session-loading-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：成果/准备 UI 与本地执行研究

本轮补右侧首页成果分页、核验预览、系统选址后生成导出请求、原目标只读核验/文件位置，以及固定字段的准备检查摘要。请求导出仍需发送给唯一 Agent 并确认原批准，选址本身不保存文件；准备报告明确为历史观察，非就绪或隔离证明。正文增量不刷新成果列表，会话切换隔离迟到响应。新增 UI 沿用现有紧凑圆角风格，没有新增依赖。

本轮相关 5 个测试文件 85/85 通过（新增 5 项），类型检查、核心和桌面构建通过；临时浏览器夹具验证交互及视觉，不代表 Electron/生产端到端验收。没有真实 API、生产数据库、产品启动、发布、依赖安装或 Windows 修改。备份/差异/日志在 E:\Codex\Workspace\output\umi-local-workflow-ui-20261011。旧数量只代表各自阶段。

核对本地 Harness 与固定版本 Reasonix 后，OS 沙箱不列入核心当前路线；下一阶段先解开全 cwd 内容指纹与大依赖执行的耦合，再做具体项目准备安装计划和按引用/使用权管理的缓存留存。大依赖限制、自动安装器、总配额/清理仍未实现，不能把研究方案当作已完成能力。学习入口：[本地执行、安装、留存与成果 UI](local-workflow-and-ui-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：执行准备观察与具体命令绑定

增加 inspect_execution 只读观察选定目录的工具入口、清单、指定副本输入和依赖目录，直接返回模型可引用的 inspectionExecutionId；不启动程序、不安装或联网。run_command/run_shell 可用 preparation 绑定真实成功检查回执，批准/派发/挂起释放前重查；漂移或未观察输入拒绝原命令。批准说明准备目的、完整命令、联网/安装脚本声明及会话任务缓存。任务缓存可复用，准备阶段不预先创建；同 run 拒绝不能换检查回执重复申请。新增 artifacts cwd，命令生成文件后沿既有 capture_output/Export 交付。

本阶段新增 31 项专项；最终相关 11 个测试文件 191/191 通过，类型检查、核心与桌面构建通过。固定模型、临时目录/测试 SQLite，部分场景真实运行本地 Node/Windows 进程；没有联网安装、真实模型 API、生产数据库、产品启动、发布或 Windows 修改。学习注释和前端/CSS 保留；备份、差异与日志在 E:\Codex\Workspace\output\umi-preparation-20261011。下面旧阶段数量按历史归属保留。

观察不是可运行证明：外部版本未执行则未知，依赖目录存在不代表完整；Node 锁只做根记录核对，Python/其他包管理器/workspaces 仍需审阅。准备网络/安装脚本字段及缓存变量不构成 OS 强制范围；普通命令继续具体宿主批准。当前完整命令 cwd 指纹仍有 20000 项/128 MiB/单文件 32 MiB 等限制，大依赖树可能阻塞后续构建，本轮明确验出并保留，未用浅观察偷换内容保护。没有自动安装器、专用准备 UI 或缓存总配额。

学习入口：[执行准备调用链与限制](execution-preparation-20261011.zh-CN.md)。后续优先研究依赖树规模与执行复查的实际断点，再贯通长命令输出、取消/恢复和任务成果验收；涉及弱化检查或扩大自动宿主执行先协商。目标保持普通用户和开发者的本地任务助手，Docker/WSL2 为可选后端，MXC 退役，不为生态扩大核心。

## 2026-10-11 历史阶段：独立成果、具体导出与只读续作核验

文件路线第三阶段的后端契约已实施：create_output 独立创建 UTF-8 成果，capture_output 将 task/artifacts 下的普通文件（含二进制）复制冻结；list_outputs 只读元数据分页，read_output 核验完整 hash 后有界预览。export_outputs 绑定具体成果、绝对目标和父目录身份，批准后逐项独占创建、不覆盖，保存不可变 intent/receipt。生成成功与实际交付分开；部分失败/取消保留逐项结果，未知与重启只观察、不补写。inspect_export 提供新一轮任务的当前只读证据，export_receipt 加入任务验收。

本阶段新增 32 项专项场景；最终相关 7 个测试文件 117/117 通过，类型检查、核心和桌面构建通过。固定模型、临时目录与测试 SQLite，无真实 API、生产会话库、产品启动、发布或 Windows 修改。学习注释与前端/CSS 保留；备份、差异及日志在 E:\Codex\Workspace\output\umi-outputs-20261011。下面数量按旧阶段保留，不是本次重新验收。

成果单文件 4 MiB、批次 16 MiB/20 项，文本输入 256000 字符，预览单次 64000 字节。mime 为声明；二进制默认元数据，显式 base64 可读取范围，无 Office/PDF 渲染。导出父目录须已存在，不提供覆盖、目录管理或删除。wx 不保证正文事务原子，路径复查不是 OS 沙箱；成果总留存配额/清理未实现。桌面固定 list/preview/inspect/open_export 接口已加入，open_export 核验后仅在 Explorer 定位；没有新增 renderer 成果卡片或按钮。

学习入口：[独立成果与导出](outputs-export-20261011.zh-CN.md)。下一阶段补依赖准备与执行分离，再贯通命令输出和成果验收；可选 Docker/WSL2 后端不构成当前产品实现。MXC 保持退役，不修改 Windows、不新建庞大插件框架。见 [执行计划](execution-boundary-plan-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：文本创建与读取绑定替换

文件路线第二阶段已实施：write_file 默认 mode=create，仅新建且独占名称、不覆盖；mode=replace 必须绑定当前会话成功的完整 read_file 回执、哈希及对象身份。edit_file 继续处理实际已读范围内的唯一片段，两种修改共用只读证据校验。派发后再次检查；无变化不落盘，崩溃恢复只观察冻结目标，不重复写入。旧参数未指定 mode 的调用现在只能新建，这是有意的契约收紧；旧已派发执行仍可按原冻结目标核验。

本轮新增 24 项专项场景；最终相关 16 个测试文件 207/207 通过，类型检查、核心和桌面构建通过。固定模型、临时目录与测试 SQLite，无真实 API、生产会话库、产品启动、发布或 Windows 修改。前端与学习注释保留；备份、差异及日志在 E:\Codex\Workspace\output\umi-text-write-20261011。下面旧阶段数量保留历史归属。

完整读取单次最多 64000 字节；超过该预算不能整文件替换，应分段 read_file + edit_file。create 的独占名称不意味着整个正文事务原子：中断可留下部分文件，恢复未知时不清除或重放。应用层路径与替换复查仍不是 OS 沙箱或原子 CAS。修改副本和交付来源仍为不同权限。

学习入口：[文本创建与替换](text-write-20261011.zh-CN.md)。下一阶段先补独立 Artifact/Export 成果链，再围绕本地宿主执行的批准、依赖准备、输出核验和效率补缺。Docker/WSL2 是开发者可选后端方向，尚无产品实现；不把 AppContainer/LPAC 探针作为主线前提，也不新增庞大插件框架。具体边界与验收见 [执行计划](execution-boundary-plan-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：有界文件发现与元数据分页

文件边界路线第一阶段已实现：discover_resource 支持指定根下的文件名/扩展名/相对路径字面匹配，结果含覆盖范围、预算、跳过原因与分页游标；单文件候选仍经具体批准后仅物化该文件。list_files 改为不读取正文的元数据分页，游标绑定对象、查询与元数据版本，重启可续页，目录变化明确要求重新列举。

list_files 条目不再返回内容 hash；需要内容版本使用 read_file/stat_file。cursor 只翻页预算内已观察结果，不延续未遍历目录；totalExact=false 时须缩小 root/depth 或 prefix。原完整扫描、内容限额、批准和 ChangeSet 交付规则保持。尚未实现新建/整文件替换的分离契约、独立成果导出或 OS 执行隔离。

本轮新增 16 项专项场景，最终相关 11 个测试文件 132/132 通过；类型检查、核心与桌面构建通过。固定模型、临时目录与临时 SQLite 验证，无真实 API、生产会话库、产品启动或发布；Windows 未修改。备份与日志位于 E:\Codex\Workspace\output\umi-file-discovery-20261011。

学习调用链与限制见 [发现与分页](file-discovery-20261011.zh-CN.md)；后续隔离候选及正反向探针矩阵见 [执行边界计划](execution-boundary-plan-20261011.zh-CN.md)。本机 Home 系列不把 Windows Sandbox 作为默认路线；AppContainer/LPAC 仅列待验证候选，尚无原生可行性结论。下一阶段为创建/替换意图，再补 Artifact/Export。

## 1. MXC 清理与保留边界

按用户决定暂缓 MXC，移出五个 MXC 专用 adapter 文件（freeze/policy/prepare/runtime/ui）、三个专项测试、对应 dist 产物和五份专项文档。独立 SDK 与四个专项实验目录归入项目外的同一退役目录。没有添加新沙箱或放宽原批准。

退役资料完整保存在 E:\Codex\Workspace\output\umi-mxc-cleanup-20261011\retired；project 保存移出的源码/文档，generated 保存旧构建产物，experiments 保存 SDK/诊断。before 保存清理前全部 194 个源码文件字节。归档不参与编译、测试发现或产品模块组装，历史实验脚本不再是可运行入口。

保留 LegacyWindowsProcessPort、共享参数编码、ToolModule、通用 Plan/Locator/Observation 和证据端口。它们不依赖 MXC，可供现有宿主实现或未来后端复用；默认产品仍是 Windows V1，中立 provider 仅可选注入，目前没有生产实现，不把预留接口说成完成能力。模块工厂显式传依赖，没有全局服务容器或动态插件发现。

MXC SDK 从未进入产品 package/lock，因此无安装或卸载脚本变更。共享便携 Node 保留，没有覆盖全局 Node、修改 Windows 或系统权限。现有学习注释保留；旧 Windows 端口注释仅将特定后端名称改成一般后端描述，运行代码一致。

## 2. 上一阶段任务验收与续作

已新增 record_task_checkpoint/read_task_checkpoints、TaskPort、TaskRepository 和按当前对象观察的验收端口。检查点绑定原话与固定验收项，版本递增；跨 run 读回原任务，verified 只能使用匹配真实工具的证据。报告与 run.completed 同事务；最终提交失败可人工恢复，已有派发失败及 unknown 恢复规则保持。

当前状态区分 untracked、criteria_verified、needs_work、blocked、needs_review。criteria_verified 只指模型所记录的验收项，不能当作完整用户目标保证。活跃投影最多 6 项，完整检查点可分页读取；停止不会自动续作。没有新增前端任务卡片。

该阶段实际新增 21 项专项场景；相关 13 个测试文件 165/165 通过，类型检查和核心/桌面构建通过。使用固定模型/进程替身和临时数据，不使用真实 API、生产会话库，不启动产品或发布；Windows 未修改。

详见 [任务验收学习文档](task-acceptance-20261011.zh-CN.md) 和 [文件边界实施计划](file-boundaries-plan-20261011.zh-CN.md)。MXC 清理段描述上一阶段，不代表该阶段又执行清理。

## 3. 四个方向到底完成到哪里

| 方向 | 当前实现 | 尚未完成 |
| --- | --- | --- |
| 有界上下文 | bounded-v1 活跃窗口；永久历史保留；完整工具消息组折叠；有界输出投影；原话来源索引与分页追回 | 单条最新原话超限仍阻塞；语义追回与长任务完成率未验收；历史核验/检索性能仍待测量 |
| 任务完成与续作 | 原话绑定的持久任务检查点、三类真实证据核验、结束报告、跨 run 续作；原停止/恢复与未知副作用核验 | 用户目标完整覆盖、主观审阅、范围调整/关闭、自动长期调度、基于真实模型失败证据的完成率评测 |
| 执行边界 | 范围与路径校验；单文件资源；工作副本；读回执/哈希绑定局部编辑与完整替换；默认独占新建；冻结交付与具体批准；Windows Job/挂起复核及恢复 | 宿主命令没有 OS 文件/网络沙箱；可选后端的可信 gate、生产实现与在线输出预算尚未完成；独立 Artifact/Export 尚未实现 |
| 日常能力与效率 | 有界文件名/扩展名发现与稳定元数据分页；文件搜索/读写/编辑/回收、资源获取和交付；命令/脚本与输出分页；历史检索；可选网络搜索 | 完整任务基准、成本/耗时/要求保留测量，复杂项目上的工具覆盖与性能优化；浏览器/办公自动化等尚非通用能力 |

四个方向都已有基础，但只有特定功能已经落地；不能把“有接口/工具/提示词”描述成全面完成。有界上下文也只完成当前 bounded-v1 契约，不是无限长任务保证。

## 4. 按调用链阅读

1. [application.ts](../apps/headless/src/application.ts) → [modules.ts](../packages/agent/src/tools/modules.ts)：组装内置工具，明确注入点，唯一 AgentEngine 不变。
2. [bounded.ts](../packages/agent/src/context/bounded.ts) → [manager.ts](../packages/agent/src/context/manager.ts) → [memory.ts](../packages/agent/src/tools/memory.ts)：原话定位、活跃投影、预算和分页追回。
3. [engine.ts](../packages/agent/src/loop/engine.ts) → [executor.ts](../packages/agent/src/tools/executor.ts)：一次模型调用产生工具，准备、批准、派发、执行与恢复核验。
4. [text-edit.ts](../packages/adapters/src/host-files/text-edit.ts) → [read-evidence.ts](../packages/adapters/src/host-files/read-evidence.ts)：绑定成功读回执，唯一片段替换，拒绝版本漂移；[text-write.ts](../packages/adapters/src/host-files/text-write.ts) 区分独占创建与完整读取绑定替换，复用同一证据端口。
5. [port.ts](../packages/adapters/src/host-process/port.ts) → [prepare.ts](../packages/adapters/src/host-process/prepare.ts) → [runner.ts](../packages/adapters/src/host-process/runner.ts)：真实 Windows V1 准备、挂起与释放，不把 cwd/Job 误称沙箱。
6. [execution.ts](../packages/protocol/src/execution.ts) → [execution-provider.ts](../packages/agent/src/tools/execution-provider.ts) → [provider-tools.ts](../packages/agent/src/tools/provider-tools.ts) → [executions.ts](../packages/adapters/src/sqlite/executions.ts)：可选中立协议；计划、locator 和 observation 分开，恢复不重放执行。

任务阅读新增 protocol/task.ts → agent/tools/tasks.ts → sqlite/tasks.ts → host-files/task-evidence.ts → AgentEngine。run.completed 仍是运行结束；runs[runId].acceptance 保存当时验收报告，inspectRecovery.taskAcceptance 重新评估当前检查点。record_work_note 仍是来源笔记。新输入创建 run 时能读回原检查点，不是独立子任务调度器。

已有细节见 [有界上下文](bounded-context-20261010.zh-CN.md)、[单文件范围](resource-scope-20261010.zh-CN.md)、[文件操作](file-operations-comparison-20261010.zh-CN.md)与 [中立执行协议](neutral-execution-20261011.zh-CN.md)。混合历史文档中的 MXC 提及仅描述当时试验，不代表当前代码或路线。

## 5. 下一阶段顺序

有界发现/元数据分页、创建/读取绑定替换和独立成果/导出后端已落地。执行准备观察与具体命令绑定已实施。下一阶段优先评估大依赖树对完整 cwd 指纹和批准复查的影响，保持可信版本/当前状态证据，再贯通长命令输出与成果验收。保持工作副本与源交付独立权限，不把 cwd/Job 当沙箱。具体顺序见执行边界计划。

任务层后续补稳定要求覆盖、范围变更/关闭和人工审阅，再测复杂项目修复率、长任务完成率及费用/耗时。当前证据核验仍可能遍历全量历史和目录，性能尚未量化。真实模型验证按当次费用授权安排。

## 6. 上一阶段验证与保护

该阶段实际新增 21 项专项场景；相关 13 个测试文件 165/165 通过，类型检查和核心/桌面构建通过。使用固定模型/进程替身和临时数据，不使用真实 API、生产会话库，不启动产品或发布；Windows 未修改。

日志、修改前 182 个文件的原字节和最终保护清单位于 E:\Codex\Workspace\output\umi-task-acceptance-20261011。未修改旧 SQL 迁移、package/lock、前端/CSS；学习注释和其他已有改动保留。新协议事件为加法扩展；当前程序读取旧历史，含新事件的历史不保证被旧程序识别。
