# Umi 新窗口交接（2026-10-13）

这是当前会话的收尾记录。真实源码是 **E:\SOME_SEVEN_PROJECT-57\Umi_v2.0**，产品名称 **Umi**。本次只整理交接与备份，不继续产品实现，不重新跑历史测试。用户将根据项目最新情况重新调整待办优先级；下文候选路线不是自动实施授权。

## 2026-10-14：桌面验收已整理，批准卡片/技能/插件仅研究

用户反馈跨轮打开和受阻正文收尾的实际体验正常，记录为用户实测反馈。按本轮授权只整理apps/desktop/verification.ts：对齐当前批准标题、10px圆角、欢迎语、蓝色发送按钮、思考菜单和执行环境分类；深色侧栏改为实际背景合成对比度检查；批准等待无输入/停止，停止样式在真实运行中检查；明确点允许本次并核对成功工具回执及来源完整写回，避免把拒绝后的结束误认成交付成功。

本轮核心编译/桌面资源构建及整套隔离真实Electron桌面验收46项通过；失败报告保留，未重跑上一轮439项全量。未改产品UI、工具或权限行为，未用付费API/生产数据库/依赖安装/Windows设置/发布或便携同步。全部旧改动及学习注释保留。

查阅Harness本地639ed015…、Reasonix完整固定4041b48…源码及主流官方资料，确认命令卡缺少具体用途/信息分层；建议后续先卡片意图，再本地skill，随后技能包和窄MCP接入。仅提出契约，未实现或自动授权。执行环境仍为Docker/WSL配置，不是通用插件系统。完整对照、关键源码与验收见[本轮报告](desktop-verification-and-capabilities-20261014.zh-CN.md)；证据 E:\Codex\Workspace\output\umi-desktop-audit-20261014。

## 0. 本轮实施补充：交付后打开与停滞收尾

本文件原收尾之后，用户授权并完成两项小范围修复及UI文案。以[最新实施说明](cross-run-open-and-stall-20261013.zh-CN.md)和handoff首节为准：跨轮打开使用此次具体批准，旧run读取许可不再阻塞；TASK_STALLED仍阻断重复执行，但有一次无工具正文收尾及本地说明兜底；failed/blocked不冒充目标完成；状态文案分开。当前PROMPT_VERSION为umi-persona-16。

本轮439项全量、15项新增专项、核心/桌面构建通过；额外整套Electron验收仍有历史UI断言债务，实际默认应用启动未验收。未发布/同步便携包，源dist已重建。原第5节中的广义循环进展/预算策略、任务信任、网络与其他B/C候选仍需讨论，不因这两项实现自动推进。

## 1. 新窗口从哪里开始

先读根目录 AGENTS.md，再读 docs/handoff.zh-CN.md、docs/current-project-report.zh-CN.md、docs/code-reading-guide.zh-CN.md 和本文件。随后核对 Git 状态与本地 diff；这里有多阶段未提交修改、未跟踪文件及已批准删除，必须全部保留。不要 reset/clean，也不要把累计 diff 当成一个阶段的变更。学习注释是正常源码，应继续维护。

交接快照：**E:\Codex\Workspace\output\umi-new-chat-handoff-20261013**。source/ 保存 Git 非忽略文件，manifest.json 记录 hash、当前基准和删除项；Git 状态、累计/工作树/暂存 diff 独立保存。它是恢复与核对材料，不是开发目录。之前的实现和验收证据仍在各阶段 output 目录，未混进新源码备份。

## 2. 用户已经确定的方向

- 做 Windows 下普通用户、开发者都能本地使用的个人 Agent，重视任务完成能力、精度与速度。参考 Harness/Reasonix，但不要照抄其平台、模糊编辑、安全宣称或权限表。
- **工作副本是主路线。** 用户希望以后能选 Umi 工作目录存放工作资料，来源和实际交付位置可分别指定；直接源目录编辑不再作为默认候选。工作目录可选、资源迁移和交付体验仍需商议。
- 沿唯一 AgentEngine 与现有适配器，职责窄、可读、易扩展；只在实际边界插件化。重大增删重构先讨论具体契约和验收。
- 不以 OS 沙箱、安装器、Docker/WSL2、留存平台或庞大插件生态作为普通任务前置。MXC 已退役；Docker/WSL2 配置是可选执行环境，目前不是自动托管 provider 或隔离保证。
- 新原话先交给模型判断是继续、切换、提问还是新任务，**不能先执行旧操作**。旧未知执行只按需要核验，不自动重跑；停止不等于取消用户目标。没有另起任务调度器的要求。
- **权限等待只允许/拒绝，不提供自定义输入，不显示中断按钮，保留未来扩展。** Agent 问用户澄清是独立问答卡：选项与自定义回答；回答不是执行批准。不要再恢复“审批时输入”的旧方案。
- UI 干净、紧凑、统一圆角；不要重新增加主会话运行时调试面板或给 Agent 的内部 COMMAND_TIMEOUT 指令提示。
- 真实/付费 API、生产会话数据库、重新发布/便携包同步、Windows 修改都按新一轮任务范围安排，不因这份交接自动授权。

## 3. 当前调用链与资源实际分配

桌面 renderer → 固定 preload → main/Broker → utility worker/DesktopService → UmiApplication → 唯一 AgentEngine → ContextManager / ToolExecutor → 模型、SQLite、文件、进程适配器。

send 保存并应用最新原话，闭合旧工具组的中断事实，先请求模型判断；它不接旧 resume 来重跑准备动作。inspect_tool_execution 在模型需要时读取原执行/回执，未知状态仍会限制新的副作用。已有 taskId 可跨 run，set_task_state 可根据最新原话挂起、取消、恢复；本轮答复结束与整个用户任务验收分开。

桌面托管 dataRoot 通常在 AppData 下的 Umi agent 区域，实际以启动配置为准。每会话环境在 dataRoot/environments/<environmentId>/；工作副本在 working/<mountId>/；任务资料现有 **task/scratch、task/artifacts、task/research、task/logs** 四类。不要把计划中的 task/cache 当成已经存在。真实来源目录与工作副本分开，结构化读改针对获准 mount/path，冻结 ChangeSet 交付回源或通过成果导出到获准目标。批准的任意宿主代码仍可能访问副本外真实文件和网络，路径描述、Job、cwd 不是 OS 文件/网络隔离。

## 4. 已完成内容：不要再按旧待办重做

| 内容 | 当前实现与保留的边界 |
| --- | --- |
| 工具反馈与读取证据 | 当前窗口工具正文完整，工具承诺的读取/追回范围不被投影均分或首尾砍；旧完整消息组可维护，原历史保留。工具观察范围和模型实际收到范围分开，替换/编辑验证实际可见内容和当前版本 |
| 长日志 | 预览与脱敏归档预算分开，归档最多64 MiB，read_process_output 连续 UTF-8 分页。超过归档上限的正文仍不能追回，不能说无限日志已支持 |
| 自然消息与停止 | 去掉恢复按钮依赖，新要求优先，过期批准取消，旧未知操作不重跑；停止独立有界控制入口，流式消费让出事件循环。生产尾部时延尚未量化 |
| 本地反馈与文件对象 | SSE 小批持久化、delta 结构共享、历史局部索引、积压及时拉取、摘要/展开正文分离，错误 code 经 Electron 桥保留；附件/副本/冻结对象有不同身份，失败的 path 不冒充文件 |
| 搜索/读取/修改 | search_text 所有字面出现与版本游标；read_file 行/字节真实分页；edit_file 同原版本原子批量，任一失败整批不写；读取证据、hash、对象身份、无关字节和独立交付继续校验 |
| 缓存与上下文 | 必要事实按域变化追加，冻结编码前缀保持；服务端 hit/miss 与本地字节估算分开。命中率高不能证明请求少、21分钟问题解决或模型任务必然完成 |
| 项目审查整改 | 同版本重复读取与修改后的新事实区分；交付批准详情支持只读重试；未实现 auto 选项禁用并说明；附件准备注入组合层；删除确认无引用的 JellyRadio.tsx/CSS、utils/time.ts 及相应生成物，保留备份和学习注释 |
| 阶段 A | ask_user_question 1–3问、各2–6选项和自定义回答，持久回答/迟到失效；等待不发模型请求，无60秒问答超时，响应停止/新原话。冻结 before/after/diff 连续分页；工作预览仅目标 hash 变化重置；设置改为执行环境 |
| 已交付文件打开 | open_delivered_file 及手动按钮核对来源、成功交付、当前许可/hash/身份，通过私有原生桥到 shell.openPath；Agent 仍具体批准。document_open 签收只证明系统接受指定当前文件打开请求，不证明页面显示/排版。明确失败与未知分开，未知不自动再打开。默认应用实际启动尚未专项验收 |
| HTTP 400 修复 | edit_file 顶层 union 导出缺少 object 根，工具表随问候发送。现在从原字段派生 object 输入，Registry 使用 io: input，执行保持严格单项/批量校验；适配器提前检查规格。当前 Zod pipe(union) 会漏入口未知键，已用独立 transform 解析并测试拒绝情况。**用户在修复后反馈测试通过，确认修复完成** |

当前 PROMPT_VERSION 为 umi-persona-15。工具规格变化后前缀重建有合理原因，不应为追求 hit 人为保留错误规格、丢新事实、丢 reasoning_content 或删真实历史。默认连续模型轮次仍是24，任务进展策略不是已全面解决。

## 5. 待商榷与待验收清单（可由用户重新排序）

| 候选事项 | 现状、取舍与实施前应明确的契约 |
| --- | --- |
| B：Windows 桥冷/热启动 | Add-Type/辅助桥启动开销尚在。讨论按固定源码/版本缓存 DLL 或构建期固定小程序；每命令独立 Job、ready/go、快照和授权保留，不改成常驻任意执行器。测缓存版本失效、取消、停止、未知恢复及启动各段耗时 |
| B：任务级速度与精度测量 | 已有请求/工具/审批诊断，尚缺清晰的任务汇总与完整生产桌面延迟证据。讨论展示位置与采集粒度，避免主会话调试 UI；有效读取、重试、请求数、实际 token/缓存、人工等待分别统计，p50是中位数，p95是95%请求不超过的耗时。先隔离长会话/拥堵测试，真实模型小规模预算另定 |
| B：循环进展与收尾 | 部分误判已修，其他固定轮次/重复限制仍可能影响高难任务。讨论按角色、版本、新事实识别进展及给用户表达预算/停滞，不直接删掉全部限制。未知不重放、明确拒绝不重复索取批准、原验收不可降低仍保留 |
| 任务内宿主信任 | 当前仍具体批准，auto 未实现。设计范围、程序类别、有效期、撤销、停止/换目标/退出时规则及提示；减少测试/构建审批疲劳。授权描述不能承诺限制宿主代码文件/网络访问，项目内容不能自行扩大信任 |
| 结构化网页读取 | 已有可选 deepseek_server_web_search，尚无通用 URL 获取/正文分页主通路。解释：固定工具由 Umi 请求指定 URL 并返回状态/类型/范围；宿主脚本则自行发请求，目前无法强制拦截。讨论 URL/跳转、敏感请求、下载、正文/归档/分页及失败反馈，不假称宿主联网已被隔离 |
| 用户可选工作资源根与交付体验 | 当前托管根不随用户选择改变；源、副本、任务资料、依赖缓存、成果和交付目标需清楚区分。讨论新旧会话绑定、空间/迁移、文件选择与防混入临时资料，保留工作副本和具体交付。不要重新推进直接源编辑 |
| C：增量降耦合 | store/PersistencePort 跨多域，资源模块职责多；App/DTO/会话同步与预览状态、三层CSS需按热点逐个提取，补错误边界/可访问性。不是一轮大重写，保留事件/事务原子边界和旧恢复契约 |
| C：存储与说明债务 | 完整上下文/实际请求逐轮保存有重复前缀，未来量化后考虑可无损重建的引用或压缩。旧说明含阶段术语、历史文档和测试未用声明待整理。不得裁原历史、改写原事实或因静态不可达删私有验收入口 |
| 规则、视觉验收及留存 | 项目规则加载需可信来源/作用路径/刷新契约；HTML文本/打开回执都不证明排版。浏览器/视觉验收先讨论小范围。活跃引用/孤立文件清理与TTL按实际磁盘问题再做，不建立庞大治理平台 |
| 其他 UI 待审 | 成果首页与工作文件清单/“+”语义、任务还缺哪步的简洁表达；归档长按及模态焦点约束、重复等待提示。按最新界面确认后改，旧审查已解决的冻结预览/刷新/打开缺口不能再次照搬 |

建议新窗口先读这些候选，结合用户最新反馈选择一个小契约。旧 A/B/C 和“提交一/二/三”是历史顺序：一/二及阶段 A 已实现，桥缓存、阶段 B/C未开展；用户尚未授权把这份候选表全部落地。

## 6. 验收事实与限制

- 最近产品修复实际跑过 **424项全量通过**、请求/适配器专项9项通过、核心/桌面构建通过，证据在 umi-deepseek-400-20261013/full-tests.log 和 request-tests.log。这是上一轮验收，本交接不重复宣称“今天重新测试”。
- 用户刚反馈“测试通过，已完成修复”，这是 HTTP 400 修复后的人工反馈；不要把它推断成问答、真实默认浏览器启动、外网访问或四类复杂任务都已验证。
- 阶段 A 的421项、审查413项、文件/上下文409项都是各阶段历史数量，不相加，也不拿数量证明任务完成率。阶段 A 的视觉截图来自真实 renderer + 模拟 bridge，并非生产性能。
- 保留四类后续完整样本：日常文件读改/交付/打开，小项目读改测试，跨文件失败修复，停止/换目标/重启核验。已有固定样本不能证明真实模型自主完成率。先前21分钟和日总约200万 token 尚未被单任务数据精确分摊。
- 最新 dist 已重建，未重新发布，便携包未同步。源码版通过菜单完整退出再启动；关闭窗口仅隐藏，第二实例可能只是唤回旧进程。不要把源码包和便携包的行为混淆。

## 7. 代码与证据索引

| 主题 | 入口 |
| --- | --- |
| 自然消息、任务关系与日志 | docs/natural-turn-and-cache-20261012.zh-CN.md；application.ts、engine.ts、tools/recovery.ts、tasks.ts、host-process/log-policy.ts |
| 有效反馈/停止/桌面对象 | docs/tool-feedback-and-stop-20261012.zh-CN.md、docs/local-feedback-and-ui-20261012.zh-CN.md；command-queue.ts、request-admission.ts、stream-buffer.ts、FilePreview.tsx |
| 文件与稳定必要事实 | docs/file-workflow-and-context-20261013.zh-CN.md；file-edit.ts、text-edit.ts、text-search.ts、context/facts.ts |
| 审查及未来 B/C | docs/project-audit-20261013.zh-CN.md（历史缺口按后续实现校正） |
| 问答、冻结审阅与原生打开 | docs/stage-a-user-questions-and-review-20261013.zh-CN.md；questions.ts、QuestionCard.tsx、FrozenFilePreview.tsx、delivered-open.ts、native-open-client.ts、task-evidence.ts |
| HTTP 400 与格式验收 | docs/deepseek-request-fix-20261013.zh-CN.md；registry.ts、deepseek/adapter.ts、tests/deepseek-request.test.ts |

阶段证据均在 E:\Codex\Workspace\output\ 下：umi-file-tools-context-20261013、umi-project-audit-20261013、umi-stage-a-20261013、umi-deepseek-400-20261013；较早 umi-natural-turn-20261012、umi-local-feedback-20261012、umi-workflow-research-20261013 等保留，具体名称以文档和本地列表为准。

Harness 本地 E:\Deepseek-Harness\dsh-learn\deepseek-harness，已研究的本地版本639ed015…与上次官方master d743267…须分开；上游可能已变化，未来研究重新核对。Reasonix 参考 E:\Codex\Workspace\reference\DeepSeek-Reasonix，是固定 studio 4041b48a8ead93876aac9122e4634fa1a412595a 的34个文件快照，非完整 Git checkout；仓库 https://github.com/esengine/DeepSeek-Reasonix。可以查官方资料，但第三方建议不自动成为 Umi 需求或已验证事实。

Node 要求 >=24.11.0 <25，已有运行时 E:\Codex\Workspace\output\umi-execution-port-20261010\runtime\node-v24.21.0-win-x64\node.exe。沿根脚本/锁文件构建，不擅自安装升级依赖。新窗口先简洁说明最新调用链、明确哪些缺口仍存在，再与用户确认当轮范围并列具体验收，结合实际修改讲关键代码。
