# Umi 文件任务与必要事实优化

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


实施日期：2026-10-13。落实上一阶段计划的一、二项；不是 Git 的两次提交。仓库多阶段未提交修改及学习注释保留，没有把旧阶段修改混进新提交。实施前备份、差异和证据位于 E:\Codex\Workspace\output\umi-file-tools-context-20261013。没有真实付费 API、生产数据库、发布/便携同步、依赖安装或 Windows 配置修改。

## 契约与精度

提速来自减少无效往返和重复派生状态。沿唯一 AgentEngine 和现有文件/模型/持久化适配器；工作副本编辑与源交付仍是独立权限。未知旧操作只核验，不重放。没有新增硬步骤上限或强制低思考档，真实失败仍可继续定位、修复和必要验证。

### 文件查找与读取

search_text 增加 path 或 prefix（互斥），单文件不遍历相邻文件；字面搜索枚举所有出现位置，包括重叠和同行多次。totalMatches 是出现次数，matchedLines 是命中起始行数，matchedFiles 是文件数。返回真实 UTF-8 匹配位置、hash、1-based 行号与 read_file 建议。nextCursor 绑定查询、范围、挂载与观察版本，续页范围或内容变化拒绝混合。

元数据扫描沿用 5000 项/16 层/1500ms 的预算；正文搜索限定单文件 4 MiB、总 32 MiB、2500ms 和 10000 命中。跳过目录、二进制、不支持编码、超预算均在 coverage 中说明，totalExact=false 时计数是下界。nextCursor 只翻已覆盖结果；覆盖不完整需缩小范围，空结果不能证明全目录不存在。每次续页重新核验有界覆盖，首版不是持久全文索引。

read_file 可用 startLine/lineCount（1-based，默认200行）或原 startByte；行号和字节起点互斥。byteLength 是返回上限，行模式默认64000，字节模式默认8192。返回 text 是原始字节内容，保留 BOM、CRLF 与中文 emoji；实际范围仍以 startByte/endByte 为准，长行只在连续 UTF-8 分页边界停止。lineSelection.rangeComplete 说明选定行窗口是否完整；truncated/nextStartByte 指整个文件剩余正文，不能把“行窗口完整”当作“整文件已读”。expectedHash 在解释起点之前验证，续页无需模型盲算中文字节。

搜索摘录和 UI 预览不是编辑读证据；完整反馈给模型的成功 read_file 回执才是。未反馈、错误文件/会话/对象、部分隐藏范围不能编辑。

### 同文件原子批量编辑

旧 edit_file 的 readExecutionId/oldText/newText 保持兼容；新形态使用 readExecutionIds/edits/expectedReadHash，互斥，最多32项和64个读取回执。全部定位针对同一原版本，oldText 精确、全文件唯一，允许多个连续可见范围共同覆盖片段。片段互不重叠，不模糊匹配、不自动 replace_all。

所有项先定位和诊断，任一失败整批不写。全部通过后按原字节位置一次拼接、一次原子写、一次副本修订与回读。原文件只校验一次 UTF-8，批量定位不反复分配整份替换结果。结果给各项索引/位置和前后 hash；失败给结构化 code/diagnostics。no-op 和落盘前取消不改变对象、mtime 或修订。

批量 snapshot schemaVersion=2 保存原回执引用与每项字节定位；旧 version=1 保留解析、派发和恢复。中断后核验 desiredHash/原对象；已完成不重写、未执行不补执行、第三方变化保持 unknown。批量成功后若要再编辑，须读取当前新版本，不自动把旧回执升级成模型已见的新原文。单文件原子不冒充跨文件事务。

## 必要事实、缓存与任务收尾

固定系统头、工具表、冻结请求和完整活跃工具组保持稳定。新增 facts.ts 按域投影资源、环境、未决执行、附件、任务验收、窗口、原话定位与笔记。域的 hash 未变就不追加，变化时只追加该域的权威值；null 表示移除。factHashes/factPolicy 保存在 context metrics，可跨重启沿用；策略版本变化明确重建前缀，新窗口重新提供完整必要状态。

不再每轮把最近32个已结算工具、历史来源目录、工具/消息/附件计数及固定说明注入模型。这些来源与统计仍由原消息、回执、清单和按需工具保留，不裁原历史或刚读正文。撤销、未知执行、最新用户更正和任务证据变化必须更新。派生快照导致的压力仍本地刷新，完整工具组/当前读取仍受保护，不增加付费摘要调用。

PERSONA 精简重复工具参数说明，保留来源、否决、可见范围、版本和交付边界。强调针对要求与风险验证：真实失败继续，明确要求完成且有关验证通过后收尾，可选规范化不自动再改再交付。它是模型策略改进，固定模型测试不能证明真实模型必定走最短路径；任务验收/needs_work 与原有执行预算仍保留。

### 可定位的诊断

每个冻结 context artifact 的 diagnostics 保存最新已应用 userMessageId、可见 taskIds、请求模型/思考档、编码体字节、工具规格字节与实际编码消息的角色分项 bytes/本地估算。它们不进入模型提示。服务端 usage.recorded 继续通过 requestId 保存 hit/miss/output，缺失不当作零，估算不冒充计费。

model.attempt_measured 按 request/attempt 记录核心消费第一帧、首条思考、首条正文和到完整响应/中断的时长，重试分开。tool.measured 记录准备、轮询睡眠、execute 和本次工具入口总时长；执行核验/其他持久化开销可由总量与已有事件观察，不伪称全部阶段都已独立测出。停止后的同代执行者可追加诊断，不能释放工具或旧批准。

approvalDecisionWaits 用既有 approval.requested/decided/invalidated 的持久时间算决定等待，包含批准卡显示、用户考虑和决定提交；不能把后台轮询睡眠当作人工等待，系统时钟倒退时返回未知。现有 process.planned/ready/started/exited 和工具身份可继续定位 Windows 桥。没有新建自动读生产库或每次刷新扫所有流式事件的诊断 UI。

## 实际调用链与关键代码

1. tools.ts 的 read_file 参数 → ResourceFiles.read 行定位/版本核验；text-search.ts 负责有界字面搜索及游标，不承担批准或编辑。
2. file-edit.ts 约束输入和 v1/v2 快照 → read-evidence.requireTextRead 确认冻结请求中的完整可见回执 → FileEditTools.prepare/replacement 统一原版本定位 → executor 保存派发 → execute 最后重核验并 atomicWrite → settle 推进修订。交付仍走 DeliveryFiles。
3. engine.facts 提供必要状态 → facts.factDomains/factUpdates 对比域 → manager.project 沿用 carry 并追加改变的域 → DeepSeekAdapter.prepare → persistRequest 冻结语义/编码与独立诊断 → 模型/工具测量事件。副作用依旧在适配器，主进程和 UI 不获得文件/SQL/Shell 新入口。

建议阅读顺序：packages/protocol/src/file-edit.ts → packages/adapters/src/host-files/text-search.ts → resources.ts 的 read → text-edit.ts 的 replacement/prepare/execute/reconcile → packages/agent/src/context/facts.ts → manager.ts 的 project → engine.ts 的请求冻结/测量 → loop/request-diagnostics.ts → tests/file-workflow.test.ts。UI 只补 edit_file 的名称；批量结果已有一次修改摘要，没有新运行时面板。

## 本次验收

最终409项全量测试通过（本轮新增21项）；核心类型检查/编译和桌面资源构建通过。固定模型、测试数据库和专用临时目录，包含实际本地 Node/Windows 进程，不调用模型 API。

- 92428B 中文/emoji/BOM/CRLF HTML：2次读取、1次六处编辑、1次具体交付批准，6次模型请求完成到答复。批量副本只推进一次修订，批准前真实来源未变，批准后字节满足预期。该样本核验结构修改与交付，不证明浏览器视觉；打开文件是未实施第三项。
- 第三项不存在、歧义、重叠、内容过期、同字节对象替换、隐藏范围、缺页、未反馈模型全部拒绝；失败/取消/no-op 不产生半批修改；连续两页可共同覆盖跨页片段。
- v1/v2 的 started/settled 提交故障，恢复只核验、不重放；第三方未知状态和会话隔离回归保留。
- 日常中文文件两处更正后按行回读；小项目一次两处运算修复后真实 Node 两项测试通过。原有11文件读改测试、17120B日常分页追回、长日志/停止/自然续作回归再次运行。
- 实际生产工具规格和 DeepSeekAdapter.prepare，20轮相同业务事实，原始消息正文从81B增至395B：派生快照保持1条995B，编码体 44241B → 45638B（增长1397B）；此前45785B → 99384B。全部旧编码消息前缀完整。工具规格和固定提示在本阶段有一次版本更新；此比较是本地字节与通路证据，不是服务端token、收费或生产命中率。

最终证据 final-acceptance.log、desktop-build-final.log、context-comparison.json、changes-from-before.json；早期失败日志保留，不能当成最终验收。早期并发执行原生桥时有等待超时；受控测试并发4后通过，没有调大夹具等待或产品超时来掩盖。

## 剩余范围

已交付 HTML 的原生打开、固定源码桥编译缓存仍未实施；任务内宿主信任、用户工作资源根与结构化网页读取仍是独立契约。未恢复全目录指纹、强制安装器、OS沙箱前置、新调度器或大插件框架。真实模型的任务精度、往返选择、费用与生产停止/流式延迟仍需之后获准的实际样本，不由本次固定模型推断。

另外核对 [DeepSeek 当前 Tool Calls 文档](https://api-docs.deepseek.com/guides/tool_calls/)：提供方支持 anyOf，strict 是单独的 Beta 模式；Umi 此次不启用 strict/Beta 或改变适配器协议。编码测试不冒充服务器实际受理测试。

使用源码版本时，通过退出菜单完整退出再启动，加载已构建 dist；关闭窗口只是隐藏。便携包仍未同步。
