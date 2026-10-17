# Umi 后端阅读整理与 Agent 机制研究

> 研究日期：2026-10-10。本文区分源码观察、上游文档描述和对 Umi 的建议；建议尚未实现。本轮没有调用真实模型、运行两个参考项目或访问生产会话数据库。

## 1. 本轮实际改动与验证

在 `E:\SOME_SEVEN_PROJECT-57\Umi_v2.0` 整理后端 TypeScript：`packages/`、`apps/headless/`、`apps/desktop/` 下直接属于桌面进程层的 `.ts` 文件。共检查 56 个文件，54 个发生排版变化；前端 renderer、CSS、测试和验证脚本不在格式化范围。

使用临时 Prettier 3.6.2，2 空格缩进、90 列排版宽度、单引号、分号和多行尾逗号，保留各文件原有换行类型。展开了多语句、函数体、参数、对象、类型和错误分支。短小的条件返回仍可能在一行，避免把简单代码展开成无意义的长块。SQL 迁移、提示词、嵌入的 PowerShell/C# 等字符串不做内容重排：SQL 指纹和实际执行文本也属于行为。

**契约变化：无。** 不改函数签名、权限、工具参数、数据库迁移、事件或任务完成规则。格式化工具仅安装在 Workspace 的临时目录，没有加入 Umi 依赖，也没有修改 package.json 或锁文件。

| 本轮验收 | 实际证据 |
| --- | --- |
| 当前本地改动不被 Git 基线覆盖 | 从工作目录现有文件格式化；修改前保存 diff、原始文件和 SHA-256 |
| 学习注释保留 | 56 个文件的解析后注释文本一致，比较忽略排版空白 |
| 可执行内容不变 | 56 个文件格式化前后 esbuild 完整 minify 输出一致，包括运行时字符串 |
| 非目标源码保留 | 格式化结束时另外 101 个已跟踪/非忽略未跟踪文件字节一致；随后仅按本轮需要补充学习与交接文档 |
| 类型仍成立 | 本轮 `npm run typecheck` 通过 |
| diff 排版合法 | 本轮 `git diff --check` 通过；Git 的 CRLF/LF 提示不是检查失败 |

本轮没有执行行为测试、桌面视觉验收或发布。此前单文件开发的测试数量不能算成本轮重新执行的结果。备份与可复现检查脚本位于 `E:\Codex\Workspace\output\umi-backend-reading-20261010`。

## 2. 现在怎样阅读 Umi 后端

先读一条真实流程，之后再看接口和错误路径。排版变化使下面几处控制流更容易跟踪：

| 顺序与入口 | 阅读重点 |
| --- | --- |
| [DesktopService.handle](../apps/desktop/service.ts#L33) → [UmiApplication.send/start](../apps/headless/src/application.ts#L182) | 固定命令怎样转成输入事实；commandId 是输入回执身份；runId 是一次执行身份；本地运行 Map 管理取消与等待 |
| [AgentEngine.run](../packages/agent/src/loop/engine.ts#L136) | 先恢复未结算工具，再初始化环境、接收新输入、构建请求；模型响应持久化后才执行工具；有工具则继续下一轮 |
| [ContextManager.project/prepareTurn](../packages/agent/src/context/manager.ts#L47) | 稳定 persona、摘要、保留历史、当前事实怎样组成请求；预算检查与上下文维护的先后关系 |
| [ToolExecutor.execute](../packages/agent/src/tools/executor.ts#L13) | 已派发/未知走 reconcile；新调用解析参数、prepare、等待批准、重新核验、保存 dispatch，然后执行并 settle |
| [SqliteStore.dispatch](../packages/adapters/src/sqlite/store.ts#L1336) | 为什么派发和授权先入库；request hash、环境版本、lease generation 如何约束执行 |
| [资源路径校验](../packages/adapters/src/host-files/paths.ts#L56) → [文件工具](../packages/adapters/src/host-files/tools.ts#L39) → [交付](../packages/adapters/src/host-files/delivery.ts) | 单文件范围和目录范围；副本编辑与来源交付为何需要不同授权 |

例如，`ToolExecutor` 中 `store.dispatch(...)` 在 `definition.execute(...)` 前面。模型提出的参数会经过工具 schema 与 prepare 检查，批准还要与本次参数和环境匹配。执行中断后，系统留下的是需要核验的事实；恢复不能简单再调一次 execute。这条次序比提示词中写“谨慎操作”更关键。

`AgentEngine` 的 `calls.length` 分支说明工具返回以后还需要模型读结果。无工具响应、正文有效、没有新输入且没有 prepared/dispatched/unknown 工具时，才保存 `run.completed`。**这证明运行已经结算，不证明用户全部验收条件已经满足。** 普通聊天用这种终止条件很自然；多步骤操作需要另一层目标与证据判断。

## 3. 两个参考项目的研究范围

本地 Harness：`E:\Deepseek-Harness\dsh-learn\deepseek-harness`，分支 `master`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`（2026-09-29）；本次 Git status 没有本地修改。读取了根 AGENTS、architecture，以及工具管线、批准、沙箱、上下文、压缩、重复调用提醒、目标工具和续轮驱动的选定源码。没有修改这份源码。

Reasonix：研究 [仓库默认分支 studio](https://github.com/esengine/DeepSeek-Reasonix/tree/studio)，它是 Go 实现；README 同时列出另一个维护中的 1.x 分支。网络环境未能完成只读克隆，已停止克隆进程，改用官方 GitHub 源码与文档页面。未取得同一提交的完整快照；部分源码页面有不同缓存日期，因此本文只对明确引用的实现/文档作判断，不宣称完成了当前 HEAD 的全量审计或验收。[版本说明](https://github.com/esengine/DeepSeek-Reasonix#versions)

## 4. 边界与安全：应该学什么

### Harness 的执行策略与实际执行器分开

[`sandbox-policy.resolve`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/sandbox/sandbox-policy/src/index.ts) 按调用选择完整策略：批准的显式覆盖、会话模式、部署默认依次生效，工作区路径随策略一起返回。文件、Shell 和终端等执行能力消费同一策略，具体执行器负责落实约束。动态策略作为运行上下文进入会话日志，而不是只存在于某个 UI 开关里。

[`ToolRuntime.prepareExecution`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/core/tools/src/index.ts) 先固定调用身份和参数快照，经过 pre-execute、ask，再经过只能拒绝的 guard。guard 没有“允许”返回值，后续插件不能用一个 allow 抹掉已有禁止；取消也在派发前再检查。[批准服务](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/interaction/user-approval/src/index.ts) 没有可用答复者时返回 unavailable；工具管线缺少审批能力不能把 ask 变成允许。

Windows 的 [`createRestrictedToken`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/sandbox/sandbox-windows-acl/src/token.ts:216) 使用 restricted token；配合 Low integrity、工作区与私有临时目录的 SID/ACL 限制写入。关键 Win32 步骤失败就拒绝启动。上游明确记录：读取、网络、NTFS 硬链接等仍有边界，工作区 standing ACL 会保留，不能当成完整隔离方案。[实现与限制](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/sandbox/sandbox-windows-acl/README.md)

**对 Umi 的建议：** 保留当前具体批准与工作副本交付机制，另补执行策略和 RuntimePort。执行计划必须报告实际限制了哪些写入、读取、网络和进程能力；策略要求无法满足时拒绝派发。Windows Job 继续承担进程生命周期职责。要限制命令访问宿主原文件与凭据，还需要实际的沙箱执行环境；不能以 cwd、环境变量白名单或 Job 代替。

### Reasonix 的配置来源与权限规则

公开的 `Policy.DecideSubject/DecideSubjects` 将策略判断与交互 Gate 分开：显式 deny 优先，移动文件等多路径操作检查每个端点，复合 Shell 检查各片段；动态解释器和命令替换不会天然继承宽泛命令前缀放行。这样的分类适合减少日常批准负担，但只能作为权限判断，不能单靠解析任意 Shell 实现 OS 隔离。[权限源码](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/permission/permission.go)

同一公开源码的通用 Gate 在 `Ask` 且 Approver 为 nil 时会允许执行，这是该组件的明确默认。它不等于已经证明所有产品入口都会缺少 Approver；借鉴时必须核对组装入口。Umi 的受限无人值守模式应该保留“需要批准而无渠道则不执行”，不能移植这个默认。

官方安全文档提出：工作区携带的配置只能收紧用户权限，不能扩大写入根、允许网络或替换宿主程序；项目声明的可执行程序先取得本地用户信任，并绑定声明/文件内容摘要，变化后重新授权。**这是文档声明，本轮未全量审计其配置合并实现。** 对 Umi 以后加载插件、MCP、LSP、技能脚本尤其有用：用户说“读取这个仓库”不代表允许执行仓库自带的钩子。[项目配置安全规则](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/SECURITY.md#project-configuration)

Reasonix 的公开 Windows `Command` 返回未包装命令，`Available()` 返回 false；官方 Guide 也说明 Windows 没有 Bash 沙箱。不能因为项目存在 sandbox 包就认为它解决了 Umi 当前 Windows 命令边界。[Windows 源码](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/sandbox/seatbelt_windows.go)

### 提示词、数据来源和真实权限

三者都需要告诉模型：读到的文件、网页、摘要和工具输出属于资料，不可自行授予权限。Umi 已在 persona、摘要和工作记忆投影中说明这点，工具权限另由宿主检查。但模型遵守资料中的指令仍是实际风险：标签和文字说明可以帮助模型，不能提供确定性防护。

建议每份上下文资料带来源、权限级别、版本、范围和截断信息；宿主授予能力时只接受可信用户操作或已有具体授权。任何外发、插件启动、来源交付都继续经过固定执行通道。不能从网页正文、模型摘要或子任务报告解析“用户已批准”来改变能力。把这类机制纳入可重复的恶意资料测试，比宣称“防提示注入”更准确。

## 5. 如何让 Agent 完成任务

### Harness：持久目标、明确续轮、并发与恢复约束

[`goal-round-driver.drive`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/goal/goal-round-driver/src/index.ts:137) 在当前 Agent 空闲、goal 为 active/armed、没有竞争输入时排一轮；先 flush，再重新核对状态。续轮消息绑定 goalId、revision、round；只有进入模型历史的轮次才消耗额度。到达目标的轮次上限会记录 blocker，挂载插件、恢复会话或 fork 不会自动重新授权后台工作。[驱动说明](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/goal/goal-round-driver/README.md)

[`tool-goal/authority`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/goal/tool-goal/src/authority.ts) 核对调用者是否是当前真实 Agent，并区分顶层真人输入与精确匹配的 goal 续轮。模型不能仅凭自己编出的目标文字取得续轮或变更目标权限。这些身份与版本检查，比不断注入“请继续”更重要。

[`repeat-tool-reminder`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/guard/repeat-tool-reminder/src/index.ts) 对工具名称与完整、规范化参数建立重复链，到阈值后加提醒；被拒绝的调用也计数。它是提醒，不是硬阻止。Umi 可进一步结合结果摘要判断“重复调用但没有新证据”，引导换方法，同时保留预算与用户停止入口。

[`tool-calls`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts) 支持有限并发和独占屏障，结果按模型顺序结算；中断后排空已启动调用，再补未开始调用的结果。未来 Umi 如果并行工具，应先规定资源冲突、写入所有权和完整消息组结算规则，不能直接把顺序循环换成 Promise.all。

### Reasonix：目标契约与宿主证据

官方 [Task Contract](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/docs/TASK_CONTRACT.md) 把请求、交付格式、限制、暂停条件写清楚；Goal 与工具授权分别处理。Goal Guide 描述新证据驱动的进度与结构化状态报告，并保留用户选择的预算。这里是文档描述，本轮未读齐顶层 Goal 实现，不能把它当成已经验证的通用完成保证。[Goal 文档](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/docs/GUIDE.md#goal)

实际读到的 [`CompleteSubtaskTool.Execute`](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/agent/complete_subtask.go) 要求子 Agent 提交结构化结果，验收项引用执行过的命令或路径；没有宿主 evidence ledger 则拒绝提交，之后调用 AdjudicateCompletion 降低没有证据的完成声明。它只注册在子 Agent 工具集。这个机制值得借鉴，但命令确实执行过仍不等于业务结果一定正确，验证命令也必须覆盖所要求的行为。

Umi 当前 `run.completed` 是执行层终态。建议另加目标层：`TaskContract → 验收项 → 已执行证据 → 完成判定`。模型可以提出计划和总结，宿主检查引用的 execution/artifact/changeset 是否存在、成功、属于本任务以及是否在最后修改之后。主观质量由用户或适当评审判断，不为简单问答强制建立复杂 Todo，也不再生成重复总结。

## 6. 上下文构建：保存、检索和活跃窗口分开

### Harness 的可重建请求与先裁剪后摘要

[`agent-loop/invariant`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/core/agent-loop/src/invariant.ts) 将实际请求与日志 deriveMessages、request/header 比较，并检查冻结。Umi 已保存冻结请求与来源指纹，可以延续这一优势，为工具规格版本、模型响应身份、投影策略和来源清单建立一致的重建检查。

[`compaction-tool-result-pruner`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts) 先做不需要模型的有界裁剪，保留头尾、富内容顺序和来源替换记录；[`compaction-basic`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/compaction/compaction-basic/src/index.ts) 在压力满足阈值后裁剪并重测，已经足够小就不用摘要。摘要区间由 [`selectCompactableRange`](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/compaction/compaction-basic/src/region.ts) 选择，不能拆开 assistant 调用与 tool 结果；服务端确认超限则走单独的有界恢复路径。

Umi 已有完整工具消息组、摘要来源、维护指纹和失败后的抽取式回退。可优先补模型无关的旧结果裁剪/外置、分页检索与准确压力指标，之后再考虑额外付费摘要。保守预算阻塞、真实服务端 token 超限、摘要请求自身超限需要分别记录。

### Reasonix 的有界保留与分层记忆

公开 [`compact.go`](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/internal/agent/compact.go) 的 pinnedPrefixLen 只在首轮用户输入足够小时固定保留它；keepIndexes 合并保留策略并补齐工具组，旧摘要进入后续合并区，避免摘要永久堆叠。它提示 Umi：永久保留原文与每轮发送全部原文是两个独立要求。

官方上下文文档将常驻指令、项目/全局事实记忆和会话原话分开；检索事实以低权威、有预算的当前轮补充进入模型，带新鲜度与选择踪迹，项目事实可以覆盖相同主题的全局事实。记忆更新还具有版本与确认规则。**这部分主要依据上游文档，未审计完整记忆存储实现。** Umi 可先建立来源与作用域，采用本地词法检索，再按实际召回质量决定是否需要 embedding。[Context Engine 文档](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/docs/SESSION_MEMORY_RETRIEVAL.md)

### Umi 当前最具体的瓶颈

`validateArchive` 明确禁止归档 user 消息；`ContextManager` 的 protectedInputTokens 包含全部已应用用户原话。用户持续输入大段文本后，单是这部分就可能超过上限；压缩 assistant/tool 无法解决，重复恢复也不会改变请求。这是源码能直接定位的问题。

建议保留 SQLite 原文及哈希，同时让活跃窗口包含：当前原文、与当前任务有关的更正、已核对的要求索引、近期完整工具组、必要运行状态，以及可检索的旧原文引用。长资料转附件并按需读取，要求的原话与引用可随时追回。折叠不能悄悄撤销老要求，也不能把摘要提升为用户新指令。涉及改变 user 消息活跃投影，需要先修订持久契约和 validateArchive 对应验证规则；本轮没有实施。

## 7. 对 Umi 最有价值的开发顺序

| 顺序 | 具体变化 | 必须能验收的场景 |
| --- | --- | --- |
| 1. 有界活跃上下文 | 原文永久存储；活跃引用/要求索引有预算；版本化记录折叠来源；先裁剪旧工具结果再摘要 | 多次长输入仍可继续；最新更正覆盖解释；旧禁令可追回；原文哈希不变；工具组完整；维护期间新输入使旧计划失效 |
| 2. 目标与完成证据 | 在 run 之上建立任务契约和验收项；验证引用 execution/artifact/changeset；区分完成、待核验、部分完成、阻塞 | 模型先回答“完成”但没有操作；副本改好未交付；测试之后再修改；失败工具被总结成成功；简单聊天正常结束 |
| 3. 统一执行 Runtime | 定义实际读/写/网络限制和探测结果；区分工作副本运行、可信宿主执行；策略无法落实则不派发 | 越界写入、读取凭据、网络访问、符号链接/硬链接、后代进程、中途停止、沙箱不可用；分别报告每项约束 |
| 4. 日常能力与可靠恢复 | 浏览器、应用/文档连接器、技能、授权保管、真实副作用回执；未知效果先查后执行 | 提交表单后掉线；同名文档不串目标；授权过期；应用状态变化；跨工作区权限不继承 |
| 5. 效率与扩展 | 稳定工具 schema 和提示前缀；有界索引；按任务选择模型/规划；带写入所有权的有限并发 | 缓存命中/费用/时延实测；简单任务不增加规划请求；并行写冲突；子任务漏报与虚假完成被宿主检查 |

上表是建议路线，不是本轮实施承诺。下一次做第 1 项前应明确 RequirementRef、来源范围、授权来源、投影版本和预算阻塞的契约，使用隔离数据和替身模型跑针对性场景。

## 8. 要完成本地绝大多数日常指令，还缺什么

这里按“Agent 在本机执行与保存状态，模型可以使用远端或本地服务”理解本地。Umi 目前已有文件、命令、历史/记忆、附件和网络搜索；Shell 能启动程序，不代表已经具有可靠的网页操作、应用自动化和文档语义编辑能力。

| 用户任务 | 需要补的能力 | 成功依据 |
| --- | --- | --- |
| 查找、整理、编辑文件 | 本地搜索索引、显式多文件选集、稳定身份、批量冲突检查 | 修改前后清单、范围一致、来源交付回执 |
| 使用网站和桌面应用 | 优先结构化 API/连接器；浏览器与可访问性自动化补覆盖 | 查询实际对象/页面结果；点击、截图和生成文字不能单独证明提交成功 |
| Word/表格/PDF/幻灯片 | 格式专用读写与渲染检查，公式、样式与内容校验 | 可打开的文件、可见布局、数据/公式和导出核验 |
| 跨应用长流程 | 持久目标、步骤依赖、后台作业、停止/恢复、幂等键 | 每步外部对象身份与回执；未知结果不盲目重复 |
| 可持续的个人助理 | 可编辑/撤销的用户记忆、项目作用域、过期事实、最小凭据权限 | 记忆来源和修订可见，授权范围清楚，私人资料不默认外发 |
| 高效而准确 | 任务基准、失败分类、局部验证、缓存与本地检索，按需要选择模型 | 端到端完成率、误报完成率、越权率、恢复成功率、用户介入次数、成本和 P50/P95 时间 |

如果还要求模型推理完全离线，则另外需要本地推理适配器、目标机器资源测量、工具调用/图片/长上下文兼容验证和质量基准；不能只凭模型能启动就认定能替代远端模型完成这些任务。

先建立覆盖个人高频任务的固定验收集：指定 HTML 修改并交付、多个文件整理、表格计算、网站查询/受控提交、应用信息同步、中断恢复。只读和可撤销操作在已授予范围内连续推进；不可逆外部动作保留具体确认。逐项量出端到端成功率，才能回答“绝大多数”是否接近实现。

Umi 现有事件、批准、未知结果核验和来源记录值得保留。优先补活跃上下文、目标验收和执行能力，再逐步拓宽任务覆盖；目前没有证据要求把这套后端整体改成 Cordis 或 Go。
