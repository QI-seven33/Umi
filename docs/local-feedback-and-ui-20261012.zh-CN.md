# Umi 本地反馈与界面对象修复（2026-10-12）

用户授权“立刻修复本地阻塞，让反馈及时、界面对象正确”。本阶段完成流式消费、历史查询、IPC 错误传递、按需正文与对象预览修复，继续沿唯一 AgentEngine 和既有桌面适配器。实施前完整备份 227 个非忽略源码/文档文件及 Git 状态，目录：E:\Codex\Workspace\output\umi-local-feedback-20261012\before。没有 reset/clean，没有删除既有源码文件，保留多阶段修改与学习注释。

实施前契约与根因

1. 小片段、索引、块边界和完整模型响应保持原样，不合并事实或截取本轮正文。短批次只减少事务次数；完成响应前、换块时、正常中断时刷新已收到片段，不把中断文字冒充完整响应。
2. 已缓冲 SSE 帧的 for-await 只让出微任务，不能保证 IPC 和计时器执行。循环按约 8ms 工作预算让出一次宿主事件循环；缓冲按 32ms、64 片段或 8KiB 任一条件刷新。停止仍走优先入口；普通命令保持串行并在处理前让出一次事件循环。
3. model.delta 只复制被改变的块和游标，纯归约保持旧状态不变；适配器内部归约使用私有投影，公共 snapshot 仍深复制，外部修改不能污染仓储。其他事件继续原有归约校验。
4. 重连保持 128 条/512KB 有界批次；hasMore 提示积压时立即拉下一批，闲时 40ms 轮询。会话列表只随新原话和运行终态刷新；工具摘要不读取正文资料，展开后才取全文分页。
5. 不把参数中的 path 当成文件存在证据。成功的 read_file/edit_file/write_file 才提供工作副本入口；失败、拒绝、脚本参数和任务 scratch 都不能冒充工作副本文件。附件 ID、冻结 ChangeSet ID 与工作副本 mount/path 是三种不同身份。
6. 等待批准时只提供批准/拒绝，正文单层滚动，操作按钮固定在正文之外。内部 COMMAND_TIMEOUT 查询指令留在协议与模型事实中；真实错误继续呈现，预览错误在对应对象内提供重试。
7. 工作副本预览随环境 revision 刷新；8KiB 首屏、后续 64KB 连续分页。分页绑定 expectedHash，先核验版本，再校验 UTF-8 起点，避免旧偏移切开新版本字符。冻结变更只展示已有冻结预览，不用当前工作副本冒充；其有界预览会明确提示。附件分页沿固定 API，迟到结果不能覆盖另一对象。标签保留可读宽度并横向滚动，注明附件/冻结类型，切换只滚动标签栏，不移动正文。

真正的长停顿还来自历史查询：messages() 为每条消息寻找 input.applied，原 SQL 会重扫整个会话的事件 JSON，model.delta 越多越慢。新增仅覆盖 input.applied 的 SQLite 局部索引 events_applied_input，原始事实、消息顺序、数据库版本与迁移指纹不变。新库和旧库启动时幂等创建；旧库首次创建需要扫描现有事件，其启动耗时尚未在生产库测量。

另一个实际缺陷是 Electron contextBridge 复制 Error 时丢掉自定义 code。preload 改为抛出普通 name/code/message DTO，界面各错误处理器同步适配。实际桥接测试确认 code 保留，不能只在 UI 正则隐藏原消息来宣称修复。

关键代码

- [StreamBuffer](../packages/agent/src/loop/stream-buffer.ts)：短批次、计时刷新和持久化失败传播。
- [AgentEngine](../packages/agent/src/loop/engine.ts)：帧消费让出宿主、换块/响应/中断刷新；工具派发仍依完整持久响应。
- [SqliteStore](../packages/adapters/src/sqlite/store.ts)：commitModelDeltas 验证租约并原子提交，projectionState 内部只读投影，局部历史索引。
- [reduceConversation](../packages/protocol/src/reducer.ts)：高频 delta 结构共享及 environmentRevision 投影。
- [DesktopService](../apps/desktop/service.ts)：联表核验 call 归属、摘要/正文分离、积压提示。
- [preload](../apps/desktop/preload.ts) 与 [ui-error](../apps/desktop/renderer/src/ui-error.ts)：错误 DTO 与用户提示分工。
- [Timeline](../apps/desktop/renderer/src/Timeline.tsx)：工具正文按需读取，思考展开后才生成正文 DOM，静态 Markdown 复用。
- [FilePreview](../apps/desktop/renderer/src/FilePreview.tsx) 与 [preview-page](../apps/desktop/renderer/src/preview-page.ts)：对象身份、请求合并、版本刷新、连续分页、局部错误。
- [local-feedback 验收](../tests/local-feedback.test.ts)：回滚、不可变投影、缓冲中断、无完整响应时不派发、索引与版本边界。

本次验证

| 负载/指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 2048 片段 + 192158 字节历史，消费耗时 | 4056ms | 349ms |
| 同负载首次计时器响应 | 4056ms | 14ms |
| 同负载 renderer 归约 128 条 p95 | 21.2ms | 0.19ms |
| 同负载事件循环额外延迟 p95 | 未测 | 12.5ms |

前后使用相同原片段和历史量，修复后 32 个短事务保存全部 2048 个独立事件。前后证据分别是 umi-manual-task-audit-20261012/probe.json 与本阶段 performance.json。不是模型网络或真实用户任务耗时。

完整隔离套件 388 项通过；收尾 UI/附件/预览调整后相关 29 项再通过。包含 11 文件小项目读改→真实 Node 测试、17120 字节日常中文文件分页/局部修改/历史追回；均不调用真实模型。核心编译和桌面构建通过。

实际生产 renderer/preload/Broker/队列/Service/AgentEngine 在隐藏 Electron 离屏窗口中验收，复制生产 worker 仅替换固定模型端口，使用最小测试主处理器和独立数据库。24 轮历史之后 20 次压力流：已收到文字到 DOM 可见 p50/p95 为 71/98ms，实际点击停止到回执 p95 为 72ms，到界面停止终态 p95 为 174ms；renderer 计时器额外延迟 p95 为 2.2ms。没有真实 API、生产主处理器或原始生产会话，因此不能称为生产 p95。

对象专项另测 2 次压力流，并检查：审批等待无停止按钮/单层滚动/决定固定；工具折叠仅读摘要，展开约 105ms；8KiB 文件首屏约 50ms；15 万字节正文分页能看到末尾，真实 edit_file 后预览自动刷新；人为延迟旧文件请求 180ms 后切换另一文件不串内容；两个同名附件各自显示原文；冻结变更独立显示且不提供当前副本位置；拒绝交付后源文件仍为原文；实际 UI 设置失败路径不弹内部 commandId 提示。界面无 console error，并检查实际审批/预览截图。5 个预览标签均保持 144px 宽，活动标签可见，横向滚动且冻结类型提示正确；同名附件专项按实际附件 ID 验证，不把 DOM 序号当作身份。

证据目录：E:\Codex\Workspace\output\umi-local-feedback-20261012。主要文件：full-tests-final.txt、ui-tests-final.txt、performance.json、desktop-probe.json（20 次）、desktop-objects.json（对象专项）、approval.png、preview.png、stage-changes.json。失败的诊断运行留在证据目录中，最终通过结果另有独立文件；早期归因“渲染停顿”经 CPU 采样纠正为后台历史查询，renderer 当时主要在 idle 等待。

边界与下一步

正常完成与主动停止会刷新已观察文字；突然强杀进程/断电可能丢失尚在内存的约 32ms 流式显示片段，原始完整模型响应仅在真正收齐后归档。这些片段不作为工具派发或任务完成依据；未增加自动重放未知操作。

本阶段不解决模型反复读取/过多验证的整个任务策略、多处文本编辑、长期派生快照大小或桌面文件打开能力。单文件任务 21 分钟及日用约 200 万 token 的全部根因/收益仍需下一阶段样本验证，不能用本地计时推导真实任务成本下降。没有改变工具权限、工作副本/冻结交付、付费范围或模型缓存语义前缀；没有增加宿主免审批信任或沙箱前提。

源码 dist 已重建；通过 Umi 退出菜单完整退出后重启才能加载。没有重新发布、同步便携包、调用真实 API、读取或修改生产数据库、修改 Windows 配置。
