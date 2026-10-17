# Umi：局部编辑、工具模块与对 MXC 的适应

> 2026-10-10。本轮在实际 Umi 源码实施，基于修改前 168 个文件的字节指纹和已有 diff 保留学习注释与其他改动。产品默认执行器仍是 legacy Windows；MXC SDK 只存在于独立实验目录。本文件陈述本轮实测，历史验收数量不相加。

## 已实现的链路

UmiApplication → installToolModules → ToolRegistry → 唯一 AgentEngine/ToolExecutor → 工具模块的 prepare/execute/reconcile。模块不创建自己的 Agent 循环。

文件链路是获准资源 → 托管副本 → read_file 原始回执 → edit_file → 副本字节核验 → 冻结 ChangeSet → 独立交付批准 → 来源文件。编辑副本权限与交付权限保持分离。

## edit_file 的具体契约

参数为 mountId、path、readExecutionId、expectedReadHash、oldText、newText。宿主从只读 FileReadEvidencePort 取得原工具、会话、上下文和结果。需要原工具与结果均成功、来自同一会话/环境/挂载/路径，原上下文也绑定该执行 ID、哈希和文件对象身份；不能拿模型随手写的哈希代替读取证明。

prepare 再检查当前资源范围、挂载身份、文件身份与字节。oldText 在全文件必须恰好出现一次，并完整落在该回执实际返回的 startByte/endByte 中；整文件哈希相同也不授权修改没有读到的片段。读后内容变化、相同字节但对象被替换、零命中、多命中、错位置、旧回执缺少绑定信息均明确失败，要求重新读取。普通 read_file 的旧恢复结果仍可展示，但不满足新编辑证明。

仅支持严格 UTF-8、无 NUL、最大 4 MiB 文件。oldText 非空，两个片段各最多 64000 UTF-8 字节；不隐式创建、不模糊匹配、不批量替换。按精确字节匹配，CRLF 与 LF 不互换，无关原始字节、BOM、学习注释等不重编码。oldText=newText 返回 no-op，不写文件、不更换对象身份、不增加环境修订。

冻结上下文保存读取结果引用、目标字节位置/长度、预期结果哈希。execute 复核冻结计划，沿用安全路径和原子落盘，写前增加原文件状态检查，写后回读。取消在落盘前生效。宿主外部恶意进程仍可能在最终检查与 rename 之间竞争；这是字节版本核验，不是 OS 文件沙箱或文件系统 compare-and-swap。

恢复只观察原挂载目标：满足冻结预期字节则报告 desired-state-verified，明确不证明由原执行产生；仍为原读取版本则报告未完成且不重跑；第三种状态保持 unknown。即使 newText 含 oldText，也不会再次替换造成重复效果。

read_file 数据新增对象 identity/readExecutionId；ExecutionContext V1 新增可选 fileReadExecutionId/fileEdit，旧记录仍可解码，没有 SQL 迁移或历史事件改写。新记录向旧程序降级不作保证。persona 现在引导已有文本优先 read_file → edit_file；write_file 的整文件写入能力仍存在，本轮没有把读取绑定升级成所有写入的全局强制规则。

## 模块化完成到哪里

ToolModule 声明 id/version/requires 和 create。安装先检查缺失依赖、循环和模块身份，再创建全部定义，检查已有/批次内工具重名后一次发布；失败不会留下半套工具。toolModules 清单只读。history、scratch、memory、attachments、files、file-edit、recycle、commands、可选 search 及桌面执行配置查询均通过显式模块工厂组装。

file-edit 依赖 umi.files，并通过闭包取得 ResourceFiles 与 FileReadEvidencePort。新增模块可以通过 UmiApplication.options.toolModules 加入，不能以重名替换内置模块。仍存在公开注册表及较宽的旧资源对象依赖；这只是第一层组装解耦，没有完成所有服务端口细分、生命周期卸载、依赖版本匹配或动态外部插件管理。

模块注册不等于安全边界。运行在宿主内的模块代码是可信代码；接口要求 create 只组装定义，但不是对任意代码副作用的技术隔离。effect、approvalRequired 和恢复实现也由可信定义提供。第三方不可信插件若未来引入，需要独立进程与明确能力授权。批准、事实写入与恢复顺序继续由唯一可信核心负责。

## Umi 适应 MXC：本轮真正验证了什么

实验脚本位于 E:\Codex\Workspace\output\umi-text-edit-modules-20261010\probe-umi-adaptation.mjs。它引用真实编译的 UmiApplication/ToolModule 和公开 MXC SDK 1.0.0，用 ScriptModel 提出请求，在全新临时 SQLite 会话中注册一个固定 CMD 模块。它不是产品通用命令工具，也没有加入 Umi 依赖锁文件。

实验计划固定 provider/version、原生程序及脚本字节哈希、资源根、环境白名单、策略和超时；作为参数 planHash 和冻结 runtimeId 进入现有具体批准/派发机制。原程序和脚本来自仅供实验的目录；SDK 的 DACL 状态目录仅在本进程环境中指向夹具，不运行 host-prep。请求明确 processcontainer、可写 Umi 副本、只读实验 bin、拒绝实验来源、网络默认禁止和禁用 UI。这些是请求字段，不代表各字段已全部完成隔离验收。

| 实际场景 | 本轮证据 |
| --- | --- |
| auto 策略下固定宿主命令 | nativeCalls 在批准前为 0；保存具体批准及 dispatch_intent 后才 spawn |
| MXC 与 Umi 副本组合 | CMD 写 MXC-ready，退出码 0；核验副本字节后 read_file、edit_file 均成功，最终为 MXC-edited + CRLF |
| 来源与 ACL | 来源字节未变化；观测的来源/文件、bin/程序/脚本、副本根/文件共七个 ACL 前后相同，DACL 状态目录为空 |
| 批准等待中脚本漂移 | 原批准 valid=0，工具 failed，nativeCalls 总数仍为 1 |
| 证据语义 | process_executions 中没有伪造 Windows bridge/Job 记录；工具结果记录 SDK 退出与文件效果核验 |

实际 tier 为 appcontainer-dacl。Node 使用前轮校验的便携 24.21.0，未改全局安装；Windows 版本/功能不变。首轮实验已经完成第一条链路，但脚本多留一条文本回复导致第二场景没有提出工具请求，超时；保留其夹具/日志，修正脚本后在新的 umi-adaptation-fixture-2 完整通过。不可把首轮超时解释成产品或 MXC 启动失败。

实验说明 Umi 的模块组装、通用工具授权、副本和结果记录可以承接 MXC 的一次固定工作负载。现有 LegacyWindowsProcessPort 仍带 bridge/PID/Job 语义，不能拿它当 MXC 的中立端口。这个实验直接使用工具生命周期，没有伪造 V1 原生回执。

该模块没有持久化 native locator；reconcile 明确 unknown 且不重跑。本轮没有进行网络连接拒绝、路径别名越界、子进程树清理、超时取消、不同 provider 恢复、进程崩溃或启动门控验收。来源未变化不是来源访问拒绝的完整证据，ACL 恢复也只涵盖观测路径。前轮 Node 工作负载 0xC0000142 仍未解决，不能因为 CMD 可运行就称“MXC 已通用适用”。

## 下一阶段：先让 Umi 的执行协议接纳真实后端

建议先做中立 ExecutionPlan/ExecutionLocator/ExecutionReceipt，再接通用 MXC 命令模块。核心保留执行身份、授权和恢复规则，Windows 与 MXC 各自实现真实后端生命周期。

1. 新增可辨识版本的计划：providerId/providerVersion、规范化程序/依赖身份、工作目录/资源绑定、显式环境、策略 hash、输出/超时上限。能力声明逐项区分 enforced/rejected/unknown；不支持强制策略即拒绝，不静默降级。
2. 中立持久 locator 和事件：先保存计划与派发事实，再启动；创建后尽早保存原执行定位。创建与保存之间仍有崩溃窗口，必须具体设计可关联身份、启动门控或保守 unknown，不能用补写 ready 掩盖。保留 V1 解码/旧 Windows 恢复，不改历史事实。
3. 分开进程退出、取消、子树/容器清理、文件效果与任务验收。结果不统一捏造 jobInactive=true；恢复只回原 provider/version/locator，缺失 provider 或无法定位时 unknown，不切到默认后端重跑。
4. 进一步细分命令计划、运行、证据持久化的窄端口；ToolModule 组装声明依赖，但授权与事件事务仍是可信核心。模型、记忆、搜索、文件、执行器分别扩展，不提供可任意改全局状态的万能 Context。
5. 每个后端分别验证访问边界、网络、输出、凭据白名单、取消清理和断点恢复，记录同任务耗时；随后再做动态插件来源信任与隔离。不能凭“万物皆插件”推断安全或性能已解决。

中立协议需要独立列出实现前契约和验收，再动产品进程持久化；本轮尚未实施。较长期的用户任务完成能力还依赖明确目标与验收证据、失败后改计划、要求追回质量、可用工具覆盖和实测完成率，插件化本身不能替代这些。

## 阅读与验证

先读 packages/protocol/src/file-edit.ts，再读 host-files/read-evidence.ts 与 text-edit.ts，最后沿 application.ts → modules.ts → ToolExecutor 理解真实调用。思考三个问题：为何仅传 expectedReadHash 不够？为何整文件哈希相同仍检查读取范围？为何恢复不能重跑同一次替换？tests/text-edit.test.ts 中错证明、截断范围、newText 含 oldText 的断点场景分别回答它们。

本轮 npm run typecheck、npm run build、npm run build:desktop 通过；新增文本编辑 19 项、模块组装 5 项，共 24/24，通过后相关 13 个文件 155/155 全通过（24 已包含，不能重复相加）。范围覆盖编辑、模块、资源/单文件/恢复、核心、桌面服务/CLI、有界上下文/预算、旧进程及端口。未执行全套测试或桌面视觉验收；构建不是便携包发布。

备份、前后字节验证、测试日志、失败/成功实验夹具和 JSON 位于 E:\Codex\Workspace\output\umi-text-edit-modules-20261010。本轮不调用真实模型 API，不操作生产会话库，不启动产品窗口、不发布、不提交 Git。renderer/CSS、package/lock、SQL 迁移和旧 process 协议均保留本轮开始时字节。
