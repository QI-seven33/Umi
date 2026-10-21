# Umi：删减全目录扫描，缩短会话首屏

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


2026-10-11。本轮从实际源码和临时样本判断。全目录指纹能发现内容漂移，却无法约束宿主程序访问目录外文件或网络。把它放在每条命令等待批准、派发、释放、退出和验收路径，会放大依赖目录规模和等待开销。它对版本冻结有用途，但当前命令并不承诺对冻结输入的隔离执行，因此移除这项全局检查。

## 契约取舍

| 对象 | 现在核验什么 | 能说明什么 |
| --- | --- | --- |
| run_command/run_shell | cwd 根位置/身份、真实程序 hash、具体 argv/script/env、原批准和 lease | 哪个请求在什么根下被批准；执行时使用目录当前内容 |
| read_file → edit_file / write_file replace | 实际读取范围/内容 hash/对象身份和唯一片段 | 具体目标版本过期时拒绝覆盖，不扫描其他文件 |
| command_exit | 同一个指定执行退出 0、Job inactive、gateReleased | 执行事实；不是当前目录全部没变，也不是用户任务完成 |
| file_hash / delivery / export_receipt | 具体文件现状、来源交付或原导出目标 | 各自的当前证据，不能互相替代 |
| 可选 preparation | 有界清单、显式输入、入口/依赖目录元数据 | 所选观察仍当前；不是整个依赖树 hash 或可运行证明 |

普通文件/依赖变化不再触发同一命令重新批准，33 MiB 依赖文件不再被命令扫描限额拒绝；根被替换仍阻止挂起进程释放。宿主命令可以访问子目录中的链接对象；结构化文件工具和 cwd 根路径仍拒绝链接逃逸。删掉递归检查意味着放弃依赖树完整内容冻结，不能继续宣称命令只操作被扫描的范围。资源物化、编辑和成果导出的大小限额并未一起取消。

网络原本没有 OS 禁用。本轮用临时 HTTP 服务和真实 Node fetch 验证：批准前无请求，批准后得到响应，无准备检查。只测回环地址，不证明外网、代理、证书或特定 API 可用。普通宿主命令仍逐次具体批准；没有悄悄启用全自动信任范围。修改模型指引是避免强制准备流程，不授予额外权限。

## 沿修改读代码

命令链：ToolExecutor → CommandPreparation.prepare → WindowsProcessPort → ready 再核验 → gate release → Job/output/exit receipt。prepare.ts 删除 fingerprint.walk 和 trackFingerprint 调用，用 rootIdentity；tools.ts 删除退出/恢复扫描，保留原批准和进程恢复，不重放未知副作用。程序本体 hash 仍保留；可执行文件缓存由文件身份/大小/时间戳失效，派发/释放仍 fresh 核验。preflight.ts 的 commandObservation 如实标记根观察。task-evidence.ts 的命令证据不再比较 cwdAfter。

历史兼容：protocol 的 cwdFingerprint 可选，旧字段/回执仍可读，cwdObservation 只标记新快照；没有删除历史 process_fingerprints 表或改迁移。旧待批准命令的上下文改变会要求重新批准，旧已派发执行仍核验原执行，不能拿新策略重跑。其他 memory/preparation 指纹不是全目录内容扫描，保留各自来源校验。

会话链：App 的 snapshot 请求 → DesktopService.snapshot → Store.snapshot/userMessages → contextStatistics/runtimeFacts → Timeline。此前桌面调用 model messages 后再筛 user，会读取完整 assistant/tool artifact 并重复查序号；现在 SQL 只取用户原话与接收事件序号，仍核验原 payload。一次状态副本复用于同一次响应的上下文统计和资源反馈，模型历史仍按 input.applied 排序。

Timeline 起初只渲染近期 8 条用户消息对应的 Markdown/DOM，点击更早消息每次扩展 8 条；加载前记下可见消息位置，加载后补偿滚动。历史刻度保持完整，导航对象先进入渲染窗口再滚动。firstVisible 保留已展开范围，新消息不会丢掉正在阅读的首条消息。切会话通过 key 重置窗口。没有减少 SQLite 历史、工具组、快照正文或模型上下文。

## 实际验收与性能范围

相关 7 文件最终共 107 项通过，其中新增 2 项：历史按需渲染/导航且模型历史完整、回环 HTTP 真实访问。已有场景改为验收根替换阻止释放、普通文件变动无需二次批准、大依赖可执行及 command_exit 的执行事实语义；原文件漂移验收仍阻塞。最后 process/desktop 2 文件 36 项另复测。核心及桌面构建通过；浏览器临时夹具验证初始 8/12 条、加载后原第 5 条 top 保持 158.2px、历史第 1 条展开跳转、新一轮保留第 5 条并显示第 13 条。

临时 20 轮、约 399 KiB 完整快照、固定模型 Markdown 样本的单次测量：

| 指标 | 修改前 | 修改后单独复测 |
| --- | ---: | ---: |
| 冷快照（含 reducer 重放） | 75.3ms | 49.3ms |
| 热快照中位（5 次） | 29.0ms | 1.3ms |
| 首次正文 renderToStaticMarkup | 517.4ms | 235.8ms |
| 首屏 HTML | 425043 B | 171074 B |

并发进程测试时后测的冷快照104ms/正文500ms，不作为改善证据；独立测量也只有一个样本，不是统计保证。服务端渲染并不等同 Electron 的页面挂载/布局/绘制。完整快照 IPC 仍随历史增长，冷重放仍扫描日志，utility/main/IPC 启动和用户生产会话尚未测量，不能宣称所有一秒延迟已消除。没有为数据好看裁剪原始历史或操作生产库。

## 后续顺序

先安排少量真实任务类型的固定模型/临时文件样本：检索资料并生成交付文件；修改小项目并测试交付。记录批准次数、有效工具调用、失败恢复、首屏和任务耗时，再把付费模型验证单独安排。缺少网页读取/下载反馈时补最少的能力入口，沿现有循环与适配器，不先搭生态。

直接工作区模式与显式宿主信任范围值得下一轮列契约讨论：文件工具可直接操作用户选择范围，具体版本检查继续保留；宿主执行的授权需如实说明实际可访问权限。来源副本交付模式可保留为选择，不应迫使所有开发任务复制整个项目。两项均未实施，本轮未删除资源/成果链。OS 沙箱、全自动安装器和缓存治理按实际需求安排，不能把它们变成 Agent 能力前提。

证据/改前备份/本轮 diff：E:\Codex\Workspace\output\umi-streamline-20261011。没有真实 API、生产会话数据库、应用启动、依赖安装、发布或 Windows 修改，用户学习注释保留。
