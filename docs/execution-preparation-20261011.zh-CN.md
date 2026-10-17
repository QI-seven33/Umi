# Umi 执行准备与任务执行分离

日期：2026-10-11。实现目录：E:\SOME_SEVEN_PROJECT-57\Umi_v2.0。目标是让普通用户和开发者在本地把任务做完：先观察是否具备条件，必要时具体批准准备，再执行及核验成果。

## 最新源码中的实际断点

来源物化会跳过 node_modules、.venv 等目录。模型拿到工作副本，不代表依赖已安装。旧 CommandPreparation 已有真实程序 hash、cwd 内容指纹、具体批准和启动前复查，但缺少独立的准备观察；模型容易连续尝试同一失败命令。

命令指纹还会完整遍历依赖目录，有 20000 项、128 MiB 总内容、32 MiB 单文件、深度 24、约 5 秒等上限。安装出较大的依赖树后，后续构建可能被这个边界拦住。此次没有偷偷跳过依赖或撤销检查；专项测试确认大依赖文件仍明确失败。**这仍是复杂编码任务的实际限制，不能把本阶段说成已解决任意项目构建。**

新模块沿用唯一 AgentEngine/ToolExecutor。没有新安装器、依赖解析器、SQL 表、插件市场、UI 改版或操作系统沙箱。程序和目录解析在实际需要共享的位置抽成两个小函数，观察与执行仍分开。

## 模型现在如何使用

1. inspect_execution 指定 cwd、programs 和 requiredFiles。工具只读取有界清单、入口元数据及依赖目录属性；不执行 --version、不安装、不请求网络。结果直接返回 inspectionExecutionId，模型从实际工具消息即可引用，无需页面或数据库帮助。
2. 根据 issues 判断：缺少程序、缺少副本输入、依赖未物化、锁文件缺失/不匹配/结构不可核验、其他包管理器、workspace、Python 或预算/不安全路径等。observed 只表示没有本工具发现的问题，不表示可以运行。
3. 需要准备时仍调用 run_command/run_shell，增加 preparation：inspectionExecutionId、changes、network（not-requested/may-access）、installScripts。具体批准会展示准备目的、完整程序/参数/脚本、联网和安装脚本声明、任务缓存位置及宿主权限含义。
4. 批准前、派发后及挂起释放前都会重新观察。清单、选定输入、工具入口或依赖目录观察版本变化则拒绝原命令，返回重新 inspect_execution 的指引。未完整观察的输入不能作为已冻结版本的准备依据。
5. 准备退出后重新 inspect_execution，再执行实际测试。退出 0、依赖目录存在、生成文件和实际导出仍分别核验。准备失败保留输出和已发生效果，未知/重启仍按原进程核验，不重新安装或运行脚本。

preparation 是显式准备契约，未标注的普通命令继续沿既有具体宿主批准，兼容旧调用与旧冻结快照。本轮没有用 Shell 字符串分析去识别所有“安装命令”，也不承诺脚本受文件/网络隔离。相同运行内拒绝过的相同具体准备命令，不能换检查 ID 或目的描述重复申请。

## 观察什么，不能证明什么

| 对象 | 本轮观察 | 实际限制 |
| --- | --- | --- |
| cwd | 当前会话获准副本或 task/scratch、research、artifacts；目录身份与安全祖先 | 不向来源回溯找依赖；单文件权限不能扩成相邻项目清单检查；cwd 不是磁盘沙箱 |
| 程序 | 最多 8 个明确入口；共享直接程序解析，入口路径、身份、大小和元数据时间 | located 不证明可执行或可信；外部版本不启动则为 null。node 恰为 Umi 当前独立 Node 进程时，版本来源明确标为 umi-process |
| npm 入口 | 观察 Node 相邻或 PATH 中的 npm.cmd | 不运行 npm、不推测版本；实际 CMD 的名称解析未被此观察固定，脚本应明确真实入口。Node 的直接执行解析不代表 Shell 一定能按名称找到同一 Node |
| 清单/指定输入 | 固定 Node/Python 清单及最多 20 个 requiredFiles，文件 hash/身份/大小；每文件 256 KiB、总计 1 MiB、约 1.5 秒 | 不遍历整个项目、不执行 scripts、不展开配置正文。npm 锁只做根记录对照，不解析全部依赖图或复刻 npm 的兼容检查 |
| 依赖目录 | node_modules/.venv 的存在、身份和目录元数据，拒绝联接；不读取来源目录的依赖 | 存在不代表安装完整，内部文件变化不保证反映在目录属性上；实际执行仍用原完整 cwd 指纹，不拿浅观察取代内容保护 |
| Node 项目 | dependencyCount、有限 scriptNames 和总数、声明的 engines/packageManager；根依赖字段对照 | engines 是项目声明，未实现 SemVer 判断；pnpm/yarn、workspaces、特殊 npm 配置与旧锁需审阅，不自动切换工具或改锁 |
| Python 项目 | pyproject.toml/requirements.txt 的定位和 hash，提示 Python 准备需求 | 没有 TOML/requirements 依赖解析、pip/venv 自动创建器或就绪证明 |

初始清单或输入超过预算时保留 limited/unsafe 反馈，不用“没读到”冒充不存在。后续准备如需这些输入，应缩小范围或单独安排流程，不把这份不完整回执当冻结版本。programs/requiredFiles 由模型明确选定，不扫描用户所有应用、全局配置或个人凭据。

## 缓存和联网声明

标注 preparation 的命令环境增加 NPM_CONFIG_CACHE、PIP_CACHE_DIR、XDG_CACHE_HOME，分别指向本会话 `task/cache/npm`、`pip`、`xdg`。缓存属于会话环境，可供后续准备复用；准备/批准阶段只检查位置，不提前创建目录。缓存祖先出现联接时不启动原准备命令。

这是默认缓存建议，不是强制 IO 边界。程序仍可忽略变量、读取全局配置或按批准脚本访问其他路径；任务缓存也没有总配额/清理实现。network=not-requested 表示本次没有请求联网，批准明确说明宿主没有强制阻断；installScripts 同样是声明，不是安全沙箱。实际安装命令、包来源、生命周期脚本、额外缓存和网络需求需具体审阅。不能将忽略安装脚本的失败包装为完整功能已准备。

查阅 npm 官方文档：npm ci 依赖现有且匹配的锁文件，不更新清单/锁文件，会先清除已有 node_modules；特定依赖解析配置需与生成锁时一致。ignore-scripts 会跳过安装脚本，而显式 npm run 等仍执行指定脚本。Umi 因此没有默认静默执行 npm ci 或承诺忽略脚本后一定可用。[npm ci 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

Claude Code 官方把权限与 Bash 沙箱分成不同机制，沙箱承担文件系统/网络约束。对 Umi 的启发是清楚区分准备观察、用户批准和实际隔离；本文的这个选择是基于资料的设计判断，不表示 Umi 已实现相同机制。[Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)

此前 Harness/Reasonix 的固定源码盘点保留在 [边界计划](file-boundaries-plan-20261011.zh-CN.md)。本阶段没有重新运行或全面比较这些项目，也不把以往资料当今天验收。普通用户关心是否能完成任务；开发者需要准确的工具入口、失败原因和可追回日志，不必承受额外生态配置。

## 按实际代码阅读

1. [process 协议](../packages/protocol/src/process.ts)：inspectionSchema、可选 preparation 和 ProcessSnapshot.preparation。旧上下文未带新字段仍可读取。cwd 增加 artifacts，命令生成文件后可直接 capture_output，不必靠相对跳出 scratch 表达成果位置。
2. [cwd.ts](../packages/adapters/src/host-process/cwd.ts) 与 [programs.ts](../packages/adapters/src/host-process/programs.ts)：复用真实目录/程序解析的小函数。没有扫描或安装应用，没有万能 FileService。
3. [preflight.ts](../packages/adapters/src/host-process/preflight.ts)：ExecutionInspection.inspect 收集快照，registerInspection 让执行 ID 出现在真实工具消息；assertCurrent 核对实际成功执行、会话、cwd、上下文和当前 fingerprint。
4. [prepare.ts](../packages/adapters/src/host-process/prepare.ts)：带 preparation 时先核验观察回执，默认任务缓存，继续原真实程序 hash/cwd 指纹/环境冻结，并检查同 run 拒绝。观察没有替代执行保护。
5. [tools.ts](../packages/adapters/src/host-process/tools.ts)：批准描述解释准备行为；execute 在计划及挂起释放前复查，原 Windows V1 执行器、Job、输出和恢复链保持。没有平行循环或跳过派发。
6. [prompts.ts](../packages/agent/src/context/prompts.ts)：模型指引准备、重新检查、实际测试和产物核验。指引不能替代具体批准、内容保护或 OS 限制。

一个例子：用户要求“修好项目并跑测试”，模型 inspect_execution 看见 package.json/锁文件有版本、node_modules 缺失 → 解释缺的是副本依赖 → 用具体准备命令和声明申请批准 → 退出后重新观察 → 运行测试 → 检查改动和成果 → 沿 ChangeSet 交付来源。用户不必理解 mountId 或手工安排这些步骤。若工具入口缺失、清单不匹配或依赖树超限，系统给出明确原因，不能无限尝试同一命令。

## 本轮验证与剩余工作

新增 [31 项专项场景](../tests/preflight.test.ts)：只读无启动/安装/批准、未知外部版本、缺工具/文件、清单异常/锁不匹配/包管理器/workspaces/Python、预算、链接/硬链接、取消、跨会话、准备拒绝、输入内容/身份/工具漂移、错误回执/目录、任务缓存、真实本地离线准备后继续执行、跨重启与零重跑、artifacts 二进制生成收录、单文件权限不扩展、大依赖仍拒绝、未观察输入及换回执重复申请、实际模型消息引用检查 ID。

最终相关 11 个测试文件 **191/191** 通过，类型检查、核心与桌面构建通过。固定模型、临时目录/测试 SQLite；部分场景真实执行本地 Node/Windows 命令。不联网下载/安装包，不调用真实模型，不操作生产库、不启动产品、不发布、不改变 Windows 或提交 Git。这个数量不是全部历史测试或真实模型任务完成率。备份、差异、日志、保留核对在 E:\Codex\Workspace\output\umi-preparation-20261011。

当前没有专用准备 UI、Node/Python 自动安装器、完整依赖图验证或大型依赖树执行方案。通用命令的宿主批准仍不能限制全部副作用；Docker/WSL2 保留开发者可选后端，MXC 继续退役。下一步应先解决大依赖目录导致的执行复查/效率断点，明确版本绑定和变更观察如何兼顾规模；再把长命令输出、取消/恢复与当前任务成果验收贯通，随后安排普通任务和小项目的实际完成率验证。涉及弱化内容检查或扩大宿主自动执行，应先列收益/范围与用户协商，不为“流畅”静默取消保护。
