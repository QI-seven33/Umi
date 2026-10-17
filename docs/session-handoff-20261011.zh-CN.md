# Umi 新对话交接：减负后的下一步

交接日期：2026-10-11。本文用于接续开发，本次只整理交接和备份，没有新增产品实现或重跑测试。真实源码是 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0；产品名 Umi。

## 用户最新方向（优先于旧阶段计划）

用户指出 Umi 越来越重，流程繁琐，打开会话超过一秒。接下来优先让模型聪明、工具顺畅、能完成实际任务。全目录指纹不能提供 OS 隔离，已从命令链移除；不恢复它作为每次命令的默认前置。Windows OS 沙箱不作核心前提，不重启 MXC。插件化用于合适的执行/能力边界，不扩展成庞大生态。安装器、缓存留存是未完成事项，但不是所有任务的必经流程。

直接操作用户工作区可以是有价值的选择；目前仍使用受控资源副本 + 独立来源交付。直接工作区模式和显式宿主信任范围尚未实现，也未获 blanket 自动执行授权。重大重构/功能删除先列契约与影响再与用户讨论；不要把下一步研究误写成已完成。

## 当前实现与下一步缺口

| 链路 | 已有事实 | 仍缺什么 |
| --- | --- | --- |
| 模型上下文 | bounded-v1、完整历史/来源、工具组、要求/笔记追回 | 真实复杂任务召回和完成率测量；不是证明模型更聪明 |
| 任务/续作 | 持久检查点、原话来源、验收证据、新输入核对和恢复 | 主观质量/目标覆盖、实际任务完成率；run.completed 不是目标完成 |
| 文件 | 有界发现/分页，读取绑定唯一替换/整文件替换，独立成果和具体导出 | 直接工作区路径仍需契约；物化/成果大小等限制仍存在 |
| 命令 | root-identity，真实程序与具体批准，Job/output/receipt，未知不重放 | 逐命令批准仍繁琐；明确宿主信任范围未实现，无 OS 文件/网络隔离 |
| 网络/准备 | 准备检查可选，宿主本无网络沙箱；回环 HTTP 已验证 | 外网/代理/服务未验证；不能宣称自由联网全部可用 |
| 会话/UI | 一次快照复用、只查询 user 原话；首屏近期8条，历史展开/跳转/锚点；成果/准备UI | 完整快照仍随历史增长；冷重放、utility/main/IPC和用户实际长会话延迟仍待定位 |

命令不保证全目录内容冻结；command_exit 只证明同一指定执行退出0且Job inactive/gate已释放，当前文件/交付由独立 file_hash/delivery/export_receipt 核验。编辑后测试应在编辑后运行；尚无自动时间依赖推理。旧 cwdFingerprint/回执与 process_fingerprints 迁移表为历史兼容保留，不是仍在扫描。其他上下文/准备来源指纹不能一概删除。

## 实际证据和边界

上一轮 umi-streamline-20261011：7个相关测试文件去重107/107（新增2项）；其后2文件36项和最终desktop13项复测均通过。核心与桌面构建通过；保存验证报告final-preservation.json：212份改前文件，25份已有文件修改、1份文档新增，无删除、意外改动或学习注释丢失。本次交接没有将这些数量视为新验收。

临时20轮约399KiB完整快照样本：热快照中位29.0→1.3ms，首次正文服务端renderToStaticMarkup 517.4→235.8ms，冷快照75.3→49.3ms。只有临时样本；并发测试测量波动已单独记录。服务端渲染不等于Electron真实启动/布局/绘制，不证明用户的一秒延迟完全解决。浏览器夹具验证历史展开、锚点、早期跳转、新消息保留窗口，截图及日志在该证据目录。

没有真实模型API、生产数据库、产品启动、依赖安装、发布、Windows更改或Git提交。源码dist已构建，便携包拥有独立dist，未重发就不会自动获得改动；如需验收现有产品启动另安排，不擅自开生产会话。

## 建议的新对话开场顺序

1. 核对源码、Git和本地diff，按本次用户方向覆盖旧报告的未来计划。简述 input→IPC→UmiApplication→AgentEngine/ToolExecutor→adapter/SQLite→Timeline。
2. 先做小范围任务/延迟基线：资料检索并生成文件；修改小项目并测试交付。记录批准次数、有效工具调用、失败反馈、首屏和任务耗时。付费模型验证单独按当次授权安排。
3. 列直接工作区与显式宿主信任范围的具体契约：选择范围、具体读版本保护、允许操作、取消/未知恢复和交付反馈；明确宿主命令实际拥有的文件/网络权限。与用户讨论后再改，不擅自删除副本/ChangeSet体系。
4. 依据失败样本补最少工具或反馈；浏览/下载、项目运行入口可能更值得补，不先加自动安装器或清理框架。保持唯一循环、固定桌面桥和窄适配器。

## 源码阅读入口与参考

- 本轮实现：[减负与加载调用链](streamline-and-session-loading-20261011.zh-CN.md)。命令prepare.ts/tools.ts、文件task-evidence.ts、SQLite store.ts、DesktopService.snapshot、Timeline/ConversationMap是重点。
- 前一轮研究/UI：[本地执行、安装、留存与成果UI](local-workflow-and-ui-20261011.zh-CN.md)。Harness本地提交639ed015397290b3745d163aafe02ffee4aa3f84；Reasonix研究固定studio提交24e000b19581a69ac53664f27a6b6317cace9d29。别把研究来源当今天最新版，也别把它们描述为毫无保护，必要时重新查官方源码。
- 本地Harness：E:\Deepseek-Harness\dsh-learn\deepseek-harness；Reasonix：https://github.com/esengine/DeepSeek-Reasonix。
- Node工具：E:\Codex\Workspace\output\umi-execution-port-20261010\runtime\node-v24.21.0-win-x64\node.exe。根package要求 >=24.11.0 <25；npm使用该运行时PATH。不能更改Windows。

## 备份与Git保护

最新交接：E:\Codex\Workspace\output\umi-new-chat-handoff-20261011。before/与manifest-before.json保存交接前受Git管理及非忽略未跟踪源码；before.diff/before-status.txt/git-state.json记录Git状态。本次交接后的完整源码在source/和manifest-final.json，具体交接变动/核对在handoff-verification.json。忽略的运行数据库、凭据、node_modules/dist/release不复制。

上一轮实现证据：E:\Codex\Workspace\output\umi-streamline-20261011；前一轮UI：E:\Codex\Workspace\output\umi-local-workflow-ui-20261011；最初备份：E:\Codex\Workspace\output\umi-handoff-20261010。当前仓库有多阶段未提交/未跟踪修改，整个Git diff不能归为本轮。保留全部学习注释，不reset/clean、不在发布中转目录开发。本次只动交接文档。
