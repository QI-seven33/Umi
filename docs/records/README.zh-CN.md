# 技术实现记录索引

本目录按主题索引已实现行为、故障诊断和对应验证。旧记录保留原路径，以维持发布说明、历史记录和本地资料之间的链接。记录中的版本、测试数量及“下一阶段”只代表原文时点。

当前实现先看[技术状态](../current-state.zh-CN.md)、[运行契约](../runtime-contracts.zh-CN.md)和[已知问题](../known-issues.zh-CN.md)。最近汇总见[2026-10-21源码更新](../changes/20261021.zh-CN.md)，已发布行为见[版本说明索引](../releases/README.zh-CN.md)。

## 文件、来源与交付

- [真实HTML任务与跨轮副本事实（2026-10-22）](20261022-live-html-and-resource-facts.zh-CN.md)

- [Umi 有界发现与元数据分页](../file-discovery-20261011.zh-CN.md)
- [Umi 文件任务与必要事实优化](../file-workflow-and-context-20261013.zh-CN.md)
- [Umi 独立成果与具体目标导出](../outputs-export-20261011.zh-CN.md)
- [Umi 任务验收与续作：第一阶段](../task-acceptance-20261011.zh-CN.md)

## 执行、反馈与性能

- [按需任务记录与仅思考响应续作（2026-10-22）](20261022-model-autonomy.zh-CN.md)

- [旧会话投影与文件预览性能修正（2026-10-22）](20261022-history-and-preview-performance.zh-CN.md)

- [流式接收与异常停止修复（2026-10-22）](20261022-streaming-and-failure-guards.zh-CN.md)

- [中立执行 V2：2026-10-11 实施与验收](../neutral-execution-20261011.zh-CN.md)
- [Umi：删减全目录扫描，缩短会话首屏](../streamline-and-session-loading-20261011.zh-CN.md)
- [Umi 本地反馈与界面对象修复（2026-10-12）](../local-feedback-and-ui-20261012.zh-CN.md)
- [Umi：真实缓存低点与增量诊断（2026-10-20）](../cache-outliers-20261020.zh-CN.md)
- [Umi 第一批纠偏：执行连续性与结束答复](../run-continuity-20261021.zh-CN.md)
- [Umi 第二批纠偏：工具输入与宿主文件版本](../tool-contracts-20261021.zh-CN.md)

## 桌面、品牌与分发

- [本地开发包与源码交付（2026-10-22）](20261022-development-package.zh-CN.md)

- [Skill读取、开关持久化与设置界面（2026-10-22）](20261022-skills-and-settings.zh-CN.md)

- [Umi 前端展示与直接答复修复](../ui-refinement-report.md)
- [Umi 附件、交付与桌面交互修复报告](../interaction-refinement-report.md)
- [Umi UI 更新后的问题修复](../ui-corrections-report.md)
- [Umi 新图标适配（2026-10-15）](../brand-assets-20261015.zh-CN.md)
- [Umi 界面打磨与便携包同步（2026-10-15）](../ui-refinement-20261015.zh-CN.md)
- [开发版与发行版的紧凑顶栏](../desktop-titlebar-20261018.zh-CN.md)
- [导航状态与设置主面板统一](../navigation-surfaces-20261018.zh-CN.md)
- [Windows 安装器升级流程审查](../installer-upgrade-review-20261018.zh-CN.md)

## 早期设计与实现基线（历史）

- [Umi 核心契约 v1](../contracts-v1.md)
- [Umi 迁移与验收计划](../migration-and-acceptance.md)
- [Umi 阶段 2：实现与验收报告](../stage-2-report.md)
- [Umi 阶段 3A：受控资源、工作副本与交付](../stage-3a-report.md)
- [Umi 阶段 3B：宿主命令与进程生命周期](../stage-3b-report.md)
- [Umi 阶段 5：桌面对接与预算阻塞恢复](../stage-5-report.md)

早期计划不代表当前产品路线或已完成能力；旧Python代码仅用于同一项目的迁移追溯。原始日志、截图、机器路径和个人资料不随记录分发。第三方API、组件和许可的必要引用属于实现依据，不是应用对照报告。

新技术记录放在本目录，建议命名为`YYYYMMDD-topic.zh-CN.md`；同步本索引，并链接当前规范及相关前序记录。跨功能的源码变化汇总放在`docs/changes/`。完整规则见[文档维护](../documentation-policy.zh-CN.md)。

[返回技术文档](../README.zh-CN.md)
