# Umi 独立成果与具体目标导出

日期：2026-10-11。本阶段实现文件路线第三步的后端契约，以及固定桌面调用入口。产品仍是 Umi；源码开发目录为 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0。

## 为什么增加这条链

修改已有项目时，Umi 先物化来源到工作副本，通过读取回执保护修改，再用具体 ChangeSet 批准交付。这个流程仍适用。

但“给我生成一份报告”不必先申请来源目录编辑权限。现在模型可以在 Umi 自有目录生成成果，核验及分页读取，再申请把具体字节导出到具体文件。模型说“已完成”、内部创建成功和用户目录里确有交付文件，是三种不同事实。

没有新增 Agent 循环、通用文件服务或动态插件系统。`umi.outputs` 是现有 ToolModule 下的一组内置工具，依赖明确的文件适配器和窄回执账本；原授权、派发与恢复仍由 ToolExecutor 管理。

## 这次的工具契约

| 工具 | 输入与行为 | 权限及结果 |
| --- | --- | --- |
| create_output | name、content、可选 mime；创建有效 UTF-8 文本，不改旧成果 | 自有目录自动创建；返回 outputId/name/mime/hash/size/relativePath，尚未交付 |
| capture_output | path 相对 task/artifacts；将已有普通文件复制冻结，支持二进制 | 只能收录当前会话自有目录，不能用任意来源路径；拒绝联接/硬链接和超限内容 |
| list_outputs | offset/limit；按创建记录分页列当前会话成功成果 | 只读冻结元数据；不遍历文件正文，不证明当前字节仍完整；可跨运行及重启使用 |
| read_output | outputId、字节范围、auto/base64 | 每次核验完整成果 hash，再返回有界预览；二进制默认只给元数据，显式 base64 才返回字节 |
| export_outputs | 1—20 项 outputId + 本地绝对目标文件路径 | 冻结成果、目标和父目录身份，具体批准后逐项独占创建；目标存在默认拒绝，不覆盖 |
| inspect_export | 原 export_outputs 的 executionId | 只读核验原目标；逐项返回当前状态，不补导出；可作为新一轮任务的当前证据 |

逻辑 name 不决定实际内部存储位置。每份成果保存到 `task/artifacts/outputs/<创建执行 ID>.bin`；重复显示名称不会覆盖原成果。修改报告需生成新成果，导出仍明确选择 outputId 和目标。

文本输入最多 256000 个 JavaScript 字符；成果单文件最多 4 MiB，单批导出最多 16 MiB/20 项。read_output 默认 8192 字节，单次最多 64000 字节；list_outputs 默认 10 项、最多 20 项。文本预览保留 BOM/CRLF，起点必须在 UTF-8 字符边界，末端可截到完整字符。超过预览预算的成果仍能分页阅读和完整导出。

capture_output 从自有目录复制冻结后，原生成文件再变动不会改变成果。要生成办公文档、PDF 或图片，需要现有明确批准的代码执行先在 task/artifacts 产出文件，再 capture_output；本轮没有新增文档生成引擎。mime 是调用方声明，不证明格式有效。二进制没有 PDF/Office 的可视化预览。

## 从真实调用链阅读

1. [outputs 协议](../packages/protocol/src/outputs.ts)：先看 create/capture/read/export 的严格输入 schema 和 OutputSnapshot。协议只描述意图及冻结事实，没有宿主 IO。
2. [应用组装](../apps/headless/src/application.ts)：搜索 `umi.outputs`；它创建 OutputRepository、OutputFiles，通过既有模块机制注册工具。唯一 AgentEngine 不变。
3. [ToolExecutor](../packages/agent/src/tools/executor.ts)：prepare 冻结环境/输入 → 请求具体批准 → dispatch 保存授权事实 → execute。工具返回 unknown 时，恢复走 reconcile，不能当普通失败重放。
4. [OutputFiles](../packages/adapters/src/host-files/outputs.ts)：按 prepareCreate → create → descriptor/bytes → read → prepareExport → export → recoverExport/inspectExport 阅读。它同时检查实际工具记录、会话、冻结快照、成功回执和当前文件，不能拿别的会话 outputId 导出。
5. [OutputRepository](../packages/adapters/src/sqlite/outputs.ts)：只有不可变 intent/receipt 的 read/save，复用既有 artifacts 表。成果正文在自有文件目录，数据库保存内容 hash 与定位；没有新增 SQL 迁移或第二套事件流。
6. [SqliteStore.dispatch](../packages/adapters/src/sqlite/store.ts)：export_outputs 或 export 快照必须具有有效的具体 allow 批准。即便工具记录 effect 被改成普通副本写入，派发层也不能放行。
7. [任务证据](../packages/adapters/src/host-files/task-evidence.ts) 和 [任务仓库](../packages/adapters/src/sqlite/tasks.ts)：export_receipt 根据原导出的逐项目标、预期 hash 和当前观察核验。只是生成成果不能满足交付标准。

create 的完整流程：模型提出文本 → schema 验证 → 计算 UTF-8 hash 并冻结内部位置 → 派发记录 → 独占创建 → 回读验证 → tool.settled 回执。outputId 直接关联实际创建执行，列表从成功记录索引，避免另外维护一份易漂移的可变成果清单。

export 的完整流程：解析已成功创建的成果 → 核验当前字节 → 检查具体目标不存在及父目录身份 → 冻结计划/展示批准 → dispatch 强制批准 → 每项重新核验 → 保存 intent → 独占写入 → 回读 hash → 保存 receipt → 结算整体工具。相同运行中，拒绝过的同目标/同字节集合不能通过重建成果或调整批次顺序再次申请。

## 部分完成与恢复为何这样设计

| 逐项状态 | 实际含义 |
| --- | --- |
| written | 本次导出已写入、回读符合冻结字节，原回执已保存 |
| verified | 恢复或 inspect_export 时，当前目标符合原意图；已有身份回执时还需身份一致。表示当前状态，不断言原操作者 |
| conflict | 本次确认目标冲突或其他落盘前失败；保留原拒绝事实，即使目标后来变化也不自动导出 |
| not_started | 没有逐项意图，或意图后当前没有目标且没有写入回执；取消后的后续项亦如此，不补写 |
| unknown | 有意图后的异常、目标漂移、同字节换对象或无法可靠观察；需要继续核验，不能自动重试 |

导出不是整个批次事务。第一份成功、第二份遇到晚到文件时，第一份保留且逐项说明，不能清掉已交付文件来伪装“完全失败”。取消也保留已交付项，后续项不开始。intent/写后/回执后中断重启，只核验原冻结目标；不会重建、删掉或覆盖文件。

独占创建使用既有 wx 路径，保证不覆盖已存在名称，但不能保证正文事务原子：中断可能留下部分文件。部分内容不能作为成功交付，恢复保留 unknown。父目录、链接及对象检查仍有宿主竞态窗口，不是 OS 沙箱或原子 CAS。

## 任务续作与桌面入口

新增验收类型 `export_receipt`，输入具体 target + expectedHash 列表。验收需完整匹配导出集合，并重新核验当前目标。`create_output` 成功不能作为导出证据，部分导出不能算全部标准通过，后续目标漂移会使原核验失效。

新用户输入仍使上一轮工具证据过期；没有放宽这个约束。模型应使用 inspect_export 产生本轮只读核验回执，再把该执行 ID 作为检查点的证据。跨运行续作因此可以确认旧交付，而不重复写文件。

[桌面协议](../packages/protocol/src/desktop.ts) 与 [DesktopService](../apps/desktop/service.ts) 提供固定 list_outputs、preview_output、inspect_export、open_export。open_export 只接受已知导出执行 ID 和项索引，不接受页面任意目标路径；当前目标核验通过才返回路径。[主进程](../apps/desktop/main.ts) 使用 showItemInFolder 定位实际文件，不执行该文件。

本轮没有修改 renderer/CSS，没有新增可见成果卡片、预览按钮或导出选择器。现阶段模型可调用工具，具体批准沿已有批准卡片显示；桌面固定接口已就位，专用 UI 还需后续接入。因此“有后端预览与定位接口”不能说成已完成 Office/PDF 预览体验。

## 本次验收和保留的限制

[32 项专项测试](../tests/outputs.test.ts) 覆盖：BOM/CRLF/中文、长文本/UTF-8 边界、二进制冻结及分页、越界/硬链接/超限、跨会话及成果漂移、具体批准、已存在/晚到/内部数据目录/重复/相对目标/缺失父目录/联接、拒绝后重建重排、部分交付、取消、三处导出中断恢复、创建结算故障、回执提交故障、目标内容及身份变化、派发批准守卫、元数据分页、生成与实际交付验收、新输入后的只读续作核验。

最终相关 7 个测试文件共 **117/117** 通过，类型检查、核心构建与桌面构建通过。使用固定模型、临时文件与测试 SQLite；没有真实模型调用、生产会话库、产品启动、发布、Windows 修改或 Git 提交。本次数量不代表重跑所有历史测试，也不代表真实模型任务完成率。备份、diff、日志与保留核对位于 E:\Codex\Workspace\output\umi-outputs-20261011。

目标父目录目前必须已存在；没有覆盖导出、目录管理或删除权限。单文件和单批预算有界，但成果总留存配额/清理策略未实现；后续需在不删除已引用成果的前提下单独设计。应用层路径防护不约束批准后任意宿主命令的全部副作用。工作副本 → 来源 ChangeSet、独立成果 → 指定目标 Export 保持各自权限，不能相互冒充。

下一阶段按 [执行边界计划](execution-boundary-plan-20261011.zh-CN.md) 补依赖准备与执行分离：先观察实际 runtime/工具链及工作副本缺失，再明确是否需要准备、联网和批准，随后贯通命令输出与当前成果验收。Docker/WSL2 保留开发者可选后端方向，MXC 继续退役；不为插件化提前扩大核心架构。
