# Umi 技术文档

本目录公开维护当前技术规范、已实现变化、工程验证和版本说明。当前源码以规范为准；带日期和阶段编号的记录只描述对应时点。

## 当前规范

| 文档 | 范围 |
| --- | --- |
| [当前技术状态](current-state.zh-CN.md) | 技术栈、进程、模块、数据、模型、工具与能力边界 |
| [运行契约](runtime-contracts.zh-CN.md) | 输入、执行、授权、版本、恢复、历史与交付约束 |
| [已知问题](known-issues.zh-CN.md) | 未解决问题和真实验证缺口 |
| [Windows构建与发布](windows-release.zh-CN.md) | 构建、打包、安装验收和发布的区别 |

## 变化与历史

当前0.3.0的交付与升级说明见[版本说明](releases/0.3.0.zh-CN.md)。下方带日期的“未发布”记录描述各阶段时点，相关改动已纳入0.3.0，不代表仍缺少这些实现。

- [提交前事实链与无OS沙箱边界审查（2026-10-24）](records/20261024-facts-and-unsandboxed-boundaries.zh-CN.md)：批准/派发/计划持久化、冷重放、无害原生命令边界验证与剩余限制。

- [流片段范围存储与投影保留（2026-10-24，未发布）](records/20261024-stream-ranges-and-projection-retention.zh-CN.md)：DB12新批次物理行减少、完整逻辑历史、内存保留及实际文件任务对照。

- [2026-10-24查询热路径与整文件恢复契约](records/20261024-stability-hot-paths.zh-CN.md)：DB11六个查询索引、最新待应用输入定位、A/B恢复实际验收及删除剩余延迟。

- [2026-10-23事件正文分块与直改边界修复](records/20261023-event-blocks-and-direct-boundaries.zh-CN.md)：DB10增量格式、无损身份/游标、故障恢复和真实离线存储对照。

- [2026-10-23任务内命令许可与删除热路径](records/20261023-task-command-permissions-and-deletion.zh-CN.md)：自动模式首版来源/失效、原生释放前检查、删除热路径与剩余同步阻塞。

- [2026-10-23自然语言恢复与回复可读性](records/20261023-natural-restore-and-readable-responses.zh-CN.md)：会话内版本工具、工作区授权菜单、蓝色文件预览和中文重点格式。

- [2026-10-23连续恢复与工作区管理修复](records/20261023-restore-and-workspace-management.zh-CN.md)：DB9完成凭据、授权广播、真实规模测量与剩余阻塞。

- [2026-10-23目录直接编辑与可撤销工作区授权](records/20261023-direct-files.zh-CN.md)：未发布开发源码，生命周期、写前恢复内容、旧记录兼容及真实验收范围。

| 入口 | 范围 |
| --- | --- |
| [Umi 0.3.0](releases/0.3.0.zh-CN.md) | 直接编辑、恢复、任务命令许可、DB12与本版交付验收 |
| [Umi 0.2.1](releases/0.2.1.zh-CN.md) | Windows下载、相对0.2.0的变化及发布验收 |
| [2026-10-22本地开发包](records/20261022-development-package.zh-CN.md) | 当前源码指纹、安装器载荷、便携exe检查与交付范围 |
| [2026-10-22技能与设置](records/20261022-skills-and-settings.zh-CN.md) | 开关持久化、完整预览、模型按需搜索及常用设置 |
| [更新日志](../CHANGELOG.md) | 已发布版本与Unreleased源码变化 |
| [2026-10-22真实HTML任务与副本授权事实](records/20261022-live-html-and-resource-facts.zh-CN.md) | 真实Flash Normal制作、视觉反馈续改与权限提示小修 |
| [2026-10-22模型自主执行与日志定位](records/20261022-model-autonomy.zh-CN.md) | 可选任务记录、仅思考续作、日志定位、交付回执及边界 |
| [2026-10-22启动与历史读取修复](records/20261022-startup-and-projection-cache.zh-CN.md) | 派生投影缓存、分段重建、并行启动与真实性能验收（未发布） |
| [2026-10-22启动与会话读取诊断](records/20261022-startup-diagnosis.zh-CN.md) | 真实录屏、只读测量、隔离三进程计时与尚未实施的修复方向 |
| [2026-10-22旧会话与预览性能](records/20261022-history-and-preview-performance.zh-CN.md) | 局部复制、预览请求及真实历史只读测量的范围 |
| [2026-10-22流式与异常停止修复](records/20261022-streaming-and-failure-guards.zh-CN.md) | 接收与归档、失败反馈、输出容量和设置 |
| [2026-10-21源码更新](changes/20261021.zh-CN.md) | 本轮已实现功能、实际验证和剩余范围 |
| [技术实现记录索引](records/README.zh-CN.md) | 文件/交付、执行/性能、桌面/分发及早期设计记录 |
| [已发布版本说明](releases/README.zh-CN.md) | 对应版本的下载、变化及验证边界 |

历史记录中的旧字段、路径、测试数量和后续计划不覆盖当前规范。必要的第三方API、依赖和许可引用保留；独立的学习、个人交接、应用对照及探索报告仅在维护者本地保存。源文件中的学习注释继续作为源码维护。

## 维护与贡献

- [文档分类与维护规则](documentation-policy.zh-CN.md)：新文档放置、混合稿处理和链接连续性。
- [贡献指南](../CONTRIBUTING.md)、[社区行为约定](../CODE_OF_CONDUCT.md)、[安全报告](../SECURITY.md)。
- [项目首页](../README.md)：产品介绍、下载和源码启动。
