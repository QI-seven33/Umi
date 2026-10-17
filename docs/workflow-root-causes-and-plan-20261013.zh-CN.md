# Umi 执行通路根因与下一阶段计划

后续实施：本计划一、二项已于2026-10-13落实，见[实施与验收](file-workflow-and-context-20261013.zh-CN.md)；第三项和编译桥优化仍待实施。以下保留实施前研究事实。

核对日期：2026-10-13。本轮只做源码审视、官方资料对照和隔离复现，没有实施下述产品修改。实际源码是 `E:\SOME_SEVEN_PROJECT-57\Umi_v2.0`。Git 多阶段未提交修改保留；研究与复现期间产品源码状态不变，收尾仅新增/更新研究交接文档。没有真实模型 API、生产会话数据库、发布或 Windows 配置操作。

结论：下一阶段应先让普通文件任务有一条完整、低往返的执行通路：有范围的查找与读取 → 同文件原子多处编辑 → 针对要求验证 → 冻结交付 → 明确要求时打开已交付对象 → 正常收尾。沿现有唯一循环、工作副本和适配器实施，先补工具表达和反馈，不新增任务调度平台或大插件体系。

## 一、当前实现与已排除的旧判断

`UmiApplication.send/start → AgentEngine → ContextManager/DeepSeekAdapter → ToolExecutor → 文件/进程/SQLite 适配器 → 持久事件 → DesktopService/Broker/preload → UI`。

上一阶段已修流式小片段单独事务、delta 全状态复制、历史反复扫流式 JSON、preload 错误码丢失、审批/预览对象问题。本轮没有把 388 项历史验收当作今天重新跑过的测试。

自然消息优先、旧操作只核验、任务 active/suspended/cancelled 已实现；当前也没有强制追加一轮模型总结。故“新消息只能 resume 旧操作”“不存在跨 run 任务身份”“循环总要重复总结”均不能再作为当前根因。合法的 task needs_work 提醒仍存在，不应靠删掉验收来缩短任务。

本轮没有发现当前投影再次按历史条数裁剪本轮文件正文：`toolResultViews` 在活跃窗口中保留完整结果，压力维护按完整组处理。反复读取应继续追踪工具粒度、读版本失效及任务策略，而不能把旧截断问题当作全部解释。

## 二、今天复现了哪些问题

| 问题 | 今天的证据 | 判定 |
| --- | --- | --- |
| 同文件后续命中缺失 | 72,195 字节中文 HTML，6 个 `</main>`，包括同一行重复；search_text 只返 1 个位置，totalMatches=1 | 实现使用每文件一次 indexOf，数字实为命中文件数。缺少所有定位、行信息和文件范围，无法支撑结构排查 |
| 模型盲算 UTF-8 起点 | startByte=7 切开字符，返回 PROTOCOL_INVALID | 字节完整性检查正确；问题是缺少行读取和工具提供的可续读定位，不应放宽检查 |
| 自身编辑后强制重读 | read → 第一处 edit 成功 → 同原回执第二处 edit 失败，原源文件未变 | 当前单项编辑改变 hash，旧读版本应被拒绝；工具却不能表达同一原版本的多处修改 |
| 缓存命中与请求膨胀并存 | 20 轮只有 395 字节实际消息正文，派生 system 消息从 1 条变 20 条、1,828B 变 49,546B；请求投影 JSON 44,484B → 97,646B，累计 1,376,421B；实际 DeepSeek 编码请求体 45,785B → 99,384B，旧编码消息前缀保持 | 冻结语义前缀仍保持完整，但状态、来源目录、计数与提示持续追加。高命中率不能说明请求精简 |
| Windows 桥固定开销 | 两条真实隔离命令无人工等待；桥就绪约 1,668/712ms，总流程约 2,875/1,842ms；单独只读 probe 约 1,193/682ms | 每次新 PowerShell 进程都会 Add-Type 编译 C#。正常两条命令没有调用 probe，不能把额外核验次数当成实测 |
| 打开动作与短命令清理冲突 | 直接 Node 启动的分离子进程存活；相同方式经 Umi Job，父进程正常退出后子进程未存活，exitCode=0/jobInactive=true | Job 正常退出也清理子进程。它适合有期限的任务命令，不适合默认承载长期浏览器打开 |

上述是固定模型/真实工具的隔离复现，字节数不是服务端 token 数。没有从生产库还原原任务所有请求，也没有逐秒分解那 21 分钟。日用量截图不是单任务账单；粘贴文本同时包含思考摘要与展开正文，重复文本/“思考”标题不能直接计成重复 API 请求。

Job 实验不证明原浏览器必定被杀：浏览器也可能委托现有进程或外部服务。确定的缺口是，模型目前缺少独立、可回执的原生文件打开能力。桌面 UI 的 open_file/open_export 实际调用 showItemInFolder，含义是打开所在位置，不是打开文件；脚本退出和打印 opened 都不是窗口呈现证据。

粘贴记录还显示，模型在判断视觉问题已修复后，为一处不改变显示的可选标签规范化反复权衡，准备再读、再写、再交付。这是收尾范围漂移的直接文本证据，但不足以量化它独自耗费多少时间和费用。

## 三、参考项目值得学什么，不能照搬什么

版本固定如下：

- Reasonix 当前默认分支 studio，提交 `4041b48a8ead93876aac9122e4634fa1a412595a`。两次 Git HTTPS 克隆失败，改用官方 GitHub API 获取 34 个关键文件及 MIT 许可；快照位于 `E:\Codex\Workspace\reference\DeepSeek-Reasonix`，有 SOURCE-SNAPSHOT.json，明确不是完整 Git checkout。
- 用户本地 Harness 是 `639ed015397290b3745d163aafe02ffee4aa3f84`；官方 master 为 `d743267388641bc76f17c45ce8b4c231aed1d32c`。关键新版本另存本研究目录，没有 pull/切换用户的 Harness 仓库。

| 参考 | 可借鉴 | Umi 的取舍 |
| --- | --- | --- |
| [Reasonix multi_edit](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/tools/builtin/multiedit.go) | 同文件整批在内存完成，任一步失败不落盘，一次报告多项失败 | 它的每步针对前一步结果，并可能使用 fuzzy/replace_all。Umi 首版选择同一原版本的精确、互不重叠替换，不照搬模糊匹配或自动全替换 |
| [Reasonix read_file](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/tools/builtin/readfile.go) / [grep](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/tools/builtin/grep.go) | 行读取、定位、覆盖提示，搜索可缩小到文件/目录并报告不完整结果 | 匹配行数不等于字面出现次数。Umi 必须区分 occurrences、matchedLines、matchedFiles，包含单行多个命中的测试 |
| [Reasonix host_context](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/runtime/agent/host_context.go) / [cache_shape](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/runtime/agent/cache_shape.go) / [context_breakdown](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/internal/runtime/agent/context_breakdown.go) | 宿主派生尾部与可复用历史分开，诊断实际 body chain 和输入类别 | 其派生尾部每次重投影，不留历史。Umi 已有完整冻结前缀，首选必要事实变化才追加，不直接每轮重排尾部造成另一种缓存代价 |
| [Harness 状态注入](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/context/tmux-context/src/index.ts) | 实际状态未变不重新注入；固定前缀与动态信息分工 | 用于 Umi 的挂载、未决执行、任务进度等必要事实；不每轮重列来源目录、全部近期工具和固定提示 |
| [Harness 读取](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/fs/tool-fs/src/read-render.ts) / [观察策略](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/fs/fs-observation-policy/src/index.ts) | 行窗口、provider 边界、读后版本保护分离 | 实际有长行字符裁剪。不能把“用了 Harness”说成每个读取范围天然完整；保留 Umi 模型可见范围保护与真实字节分页 |
| [Claude Code 工作循环](https://code.claude.com/docs/en/how-claude-code-works) / [最佳实践](https://code.claude.com/docs/en/best-practices) | 必要的探索、动作和可运行验证；限定实际要求，避免追逐可选整理 | 不照搬 Goal/Stop hook/多代理平台作为普通任务的必经流程；用有限样本检验提示，不能只靠新增禁令 |
| [Cursor 工具](https://cursor.com/docs/agent/overview) | 文件查找、读取、编辑、终端各有直接工具表达 | 借鉴组合通路，不根据公开页面推断其内部存储、Windows 隔离或精确缓存实现 |

Reasonix 的编辑成功会更新其 FileViews；不能因此让 Umi 自动接受旧 readExecutionId。Umi 的版本、范围、冻结请求可见证据契约不同。首先用批量编辑减少不必要版本变化；对自身修改推进读取证据的通用 lineage 机制，留作独立研究，避免再加一套大账本。

DeepSeek 的“本轮结果完整、工具自己分页、content/data 去重、实际可见范围”建议有价值，前三项及可见证据已经实施，应保持。把所有相关应用说成绝不裁长行、把缓存命中当效率指标、把当前 Reasonix 当极小模板，都不准确。Reasonix 现在也有复杂上下文、可选能力、MCP 与桌面操作；只取窄机制。

Windows 边界也应准确：当前 [Reasonix 指南](https://github.com/esengine/DeepSeek-Reasonix/blob/4041b48a8ead93876aac9122e4634fa1a412595a/docs/GUIDE.zh-CN.md) 明确 Windows 的 Bash OS 沙箱为 off，文件工具在进程内约束，获准 shell 不隔离其他用户可读文件。其文档相邻段落的通用 enforce/fail-closed 描述不能代替 Windows 特例。[Claude 权限](https://code.claude.com/docs/en/permissions) 的范围规则与审批模式也不是 Windows OS 隔离保证。Umi 保留副本和真实权限描述，不把沙箱或安装器当这轮前提。

## 四、推荐修改计划：三个小提交与一个独立优化

### 提交 1：正常文件工具足以完成同文件多处任务

修改位置：`packages/adapters/src/host-files/tools.ts`、`resources.ts`、`text-edit.ts`、`read-evidence.ts`，以及 `packages/protocol/src/file-edit.ts`。复用 fileEditModule 和既有持久准备/结算/核验；不另建循环。

具体契约：

1. search_text 增加文件/路径范围，默认仍是字面查询；返回实际命中位置、1-based 行号、对齐读取建议、文件 hash、覆盖范围与下一页。单文件范围不扫描整个挂载。总出现次数、命中行、命中文件分开；未完整扫描时给下界/unknown，不伪造精确总数。游标绑定查询、范围和观察版本；版本变化拒绝混合结果。首版不要求安装 rg，不急加正则与代码索引平台。
2. read_file 增加 1-based 行窗口选择，保留现有字节接口。行选择与字节选择不能冲突；返回的 text 仍是原始 UTF-8/换行，字节范围真实、正文完整。超长行走明确的连续字节续读，不砍中间。nextStartByte 由工具给出；指定 hash 后在起点解析前核验版本，模型无需自己算中文字符偏移。
3. 保留 edit_file 名称与旧单项参数，新增同文件 edits 形态及同版本读取回执集合，二者互斥。每项 oldText 精确唯一、完全落在已反馈的读取范围中；所有定位针对同一原版本，范围不重叠。不提供 fuzzy/自动全替换。模型传文本，工具计算实际偏移。
4. 任一项过期、未命中、歧义、重叠、越可见范围或超限，整批不写并给可操作的逐项诊断；全部通过后一次原子写入、一次版本推进、写后核验。保留 CRLF/BOM 与源目录只读。单文件原子不冒充跨文件事务。
5. 新冻结编辑快照要有明确版本，旧 schemaVersion=1 的准备和核验保持兼容；unknown 原执行只核验，不重放。工具规格发布时明确一次缓存前缀变化，不每轮换工具表。UI 补 edit_file 的名称及一次批量变更摘要。

验收：约 93KB 的中文/emoji/CRLF HTML，6 处结构错误（包括同一行多命中、64KB 后命中、巨长行）。两页真实读取足够覆盖目标，一次六项编辑完成；第三项故意失败时文件字节完全不变；用户读后改文件则整批拒绝；重叠和隐藏范围不能编辑；源目录未批准前不变，旧编辑恢复不重复写。另跑小项目读改测试和日常文件样本。固定模型证明通路，不证明真实模型必然选择最短路线。

### 提交 2：必要事实按变化追加，按用户要求收尾

修改位置：`context/manager.ts`、`context/projection.ts`、`loop/engine.ts` 的 facts 构造、`context/prompts.ts` 及持久请求诊断字段。原始消息、完整工具组、完整当前读取和事实归档均保留。

具体契约：

1. 固定头部、工具规格保持稳定。挂载/未决执行/目标与验收/用户更正等按域计算必要事实；同一事实未改变就不重注入，改变时发小的权威域快照。不要把 messageCount、最新目录计数或全工具清单变化当作重发整段宿主事实的理由。
2. 来源索引不每轮重发；新用户要求/新的可追回资料给必要新增定位，全文目录可按需工具读取。权限撤销、未知执行和旧操作取消不能被省略；新窗口必须有当前完整必要状态，不能靠过期历史复活事实。
3. 已冻结请求内部不改写；策略升级或真正压力维护在明确窗口边界重建，记录原因。派生状态造成的压力继续本地维护，不能裁本轮结果、删原历史或为它额外调用摘要模型。
4. 精简 PERSONA 中与工具契约重复的长说明。所有明确要求已完成且有关验证通过时收尾；可选规范化不自动触发第二次修改/交付。有实际失败或未完要求时继续，不按固定轮数强行停止，也不删掉 task needs_work 保护。
5. 为单个请求序列记录角色分项 bytes/估算、实际模型与 reasoning_effort、请求与响应时间、服务端 hit/miss/output、工具阶段耗时、人工审批等待。本地估算和服务端统计分开；以最新已应用原话关联 request，taskId 存在时辅助汇总。统计不进入模型提示，不再制造可变前缀。

验收：同样 20 轮稳定业务事实，必要域快照不累积 20 份；真实新增消息和当前工具正文完整，冻结前缀依然保持。实际挂载/用户要求/未决执行变化能马上正确反馈，撤销信息不会留成当前权限；重启/维护后配对、范围、版本与最新要求仍一致。明确不把故障前重读/旧操作自动执行回来。

### 提交 3：可靠打开已交付 HTML，接通任务最后一步

这个新增跨进程宿主动作需要先讨论，建议首版只覆盖明确要求打开的、已批准交付的 HTML。

模型通过已交付对象引用定位，使用 ChangeSet/逐项交付回执、逻辑路径、实际目标 hash 与对象身份，不接收任意绝对路径、脚本、exe 或 URL。权限可以在具体交付批准中一并描述“写回后请求打开这些 HTML”，保持一个可审阅决定；实际交付与打开是独立事实。打开失败不伪造交付回滚，也不报告整项任务全成功。

独立 DesktopOpenPort 由受控 worker → Broker → main 动作桥调用原生文件打开；主进程仍不建 Agent 循环或读生产 SQL。交付后目标版本变化、拒绝/部分失败的项不能打开。无桌面能力的 headless 运行环境没有此能力时诚实返回不可用，不退回通用 Shell 绕过。

回执只证明系统接受了打开请求，不证明窗口可见/网页排版正确。首版不建通用电脑操作/浏览器平台，不把短命令 Job 的正常清理删掉来保住浏览器。

验收：固定 93KB HTML 的读→批量修→有关副本验证→冻结→一次交付批准→目标版本核验→独立打开请求→答复。拒绝交付、内容过期、越范围和同名其他对象均不能打开；回执错误留作未完成事项；原生动作不隶属命令 Job。假端口验协议和授权，隔离实际主处理器验桥；真实默认浏览器测试按当次范围安排。

### 独立优化：按固定源码 hash 缓存 Windows 桥编译产物

优先考虑首次编译后缓存固定辅助 DLL，或构建期带小辅助程序；每个命令仍独立 Job、独立快照与批准、ready/go 前持久事实。不是常驻高权限任意执行器。缓存目录归 Umi 管理，校验源码/产物版本与身份，不能把编译缓存当用户代码批准。源码程序具体 hash 核验保留，重复计算再单独定位。

验收冷热启动、更新失效、取消、停止、unknown 核验与拒绝 go；分别测准备、桥就绪、实际子程序、回执。不承诺这项单独解决 21 分钟，也不把本次两个样本说成生产 p95。可以在提交 1/2 后另做，不阻塞文件通路。

## 五、最小范围与后续决定

推荐先落提交 1、再落提交 2，以单文件六处修改的可见成果作为阶段里程碑，再接提交 3，闭合“修好后打开”的要求。保持工作副本；授权过的副本正常读改不增加逐文件批准；减少 Shell 兜底、合并同一文件修改和一次冻结交付，先降低审批次数。任务内宿主信任、工作资源根由用户选择、结构化网页读取是独立契约，不用来拖住这一阶段。

不采用全目录指纹、强制安装器、OS 沙箱前置、新任务调度器、全量插件移植、每轮动态工具列表或硬限步骤。高难任务仍可深入验证，低思考档也不一刀切强制：当前 normal 实际编码为 low、high 为 high，与 [DeepSeek 努力度文档](https://api-docs.deepseek.com/guides/thinking_mode/) 对应；选择应在任务边界用实际质量/费用样本评估。思考工具链的 reasoning_content 继续遵守提供方契约。

[DeepSeek 缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)说明复用对应已持久化前缀；它没有替 Umi 缩短工具链、减少输出思考或人工等待。下一次实际 API 验收需要明确当次授权，按单任务采集结果；不能由固定模型断言完成率、费用或用户任务必然几分钟结束。

证据：本目录 probes.json、edit-receipts.json、probes.mjs、reasonix-reference.json、harness-reference.json、selected-diff-before.txt、git-status-before.txt。合计复现查找/读取/编辑/上下文/Windows 执行与子进程行为，没有产品逻辑变更。
