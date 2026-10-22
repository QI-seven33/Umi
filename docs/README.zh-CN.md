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

| 入口 | 范围 |
| --- | --- |
| [2026-10-22本地开发包](records/20261022-development-package.zh-CN.md) | 当前源码指纹、安装器载荷、便携exe检查与交付范围 |
| [2026-10-22技能与设置](records/20261022-skills-and-settings.zh-CN.md) | 开关持久化、完整预览、模型按需搜索及常用设置 |
| [更新日志](../CHANGELOG.md) | 已发布版本与Unreleased源码变化 |
| [2026-10-22真实HTML任务与副本授权事实](records/20261022-live-html-and-resource-facts.zh-CN.md) | 真实Flash Normal制作、视觉反馈续改与权限提示小修 |
| [2026-10-22模型自主执行与日志定位](records/20261022-model-autonomy.zh-CN.md) | 可选任务记录、仅思考续作、日志定位、交付回执及边界 |
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
