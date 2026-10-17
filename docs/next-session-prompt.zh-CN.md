# 新窗口开场提示

当前状态先见[输入区蓝色呼吸与卡片等宽](composer-breathing-20261016.zh-CN.md)，再见[最新布局与性能修正](layout-polish-20261015.zh-CN.md)和[前轮文件预览调整](file-preview-20261015.zh-CN.md)和[前轮界面与发布说明](ui-refinement-20261015.zh-CN.md)、[全面审计](full-project-audit-20261015.zh-CN.md)和[交接](handoff.zh-CN.md)。旧计划不构成自动实施授权。

```text
2026-10-17最新：0.2.0-alpha.1 Windows预发布，安装器和完整便携zip在release/installers，发布入口https://github.com/QI-seven33/Umi/releases/tag/v0.2.0-alpha.1。图标改为圆角白底；公共README/贡献/安全/授权/第三方许可及模板、Windows CI已整理。本轮类型检查和构建通过，439/439核心测试通过（测试文件并发度2）；源码桌面72/72通过；实际便携exe 64/72检查已通过，随后因已知HTML可见排版断言失败而结束，余下8项未执行。安装器实际嵌入载荷解包后182个运行文件逐项hash通过，载荷exe与便携exe相同。安装/卸载交互和注册表/快捷方式行为没有在本机额外执行验收；安装文件未代码签名。历史A-01/A-02/A-03和HTML偶发空白尚未修复。
2026-10-16最新：输入框电流已替换为3.2秒蓝色呼吸；批准/问答卡与输入框共用宽度、边距、18px外圆角，正文12px/标题13px。本轮 TypeScript、桌面构建与29项相关UI/分页/问答/交付回归通过；宽窄批准卡/问答卡、真实提交、蓝色呼吸、减少动态及停止状态的桌面检查均通过。完整桌面检查：源码版72/72通过；实际便携版Umi.exe 72/72通过。182个运行文件逐项hash匹配，源码、dist、便携版指纹一致。没有重跑历史439项全量或13项服务契约。完整复核曾反复出现HTML子页空白，延长等待/聚焦均不足以彻底解释，已留证；不要声称此预览问题已修复。旧620px卡片上限为历史契约，不要恢复。
继续开发和学习Umi。真实源码 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0，产品名称Umi。
先读根AGENTS，再读docs/handoff.zh-CN.md、docs/current-project-report.zh-CN.md、docs/code-reading-guide.zh-CN.md、docs/layout-polish-20261015.zh-CN.md、docs/file-preview-20261015.zh-CN.md、docs/ui-refinement-20261015.zh-CN.md与docs/full-project-audit-20261015.zh-CN.md。旧session-handoff是历史背景。
核对Git状态/diff，保留多阶段未提交/未跟踪源码与学习注释，不reset/clean，不在备份/发布目录开发。本轮前快照 E:\Codex\Workspace\output\umi-layout-polish-20261015\before；审计证据仍在umi-full-audit-20261015。
当前界面无页内产品图标，hello压力效果/蓝色电流保留。左控制顶部、右控制在工作卡片右上角并避让标签，横线同高48px。右侧空时留白，彩色文件标签，完整路径与查看/刷新/打开同一行，查看与打开共用菜单；原文代码着色和JSONL已补。普通HTML自然字号，固定像素宽度才缩放；静态隔离不执行内容脚本。输入区保留420px并随宽度重排/原生textarea自适应。拖动RAF写CSS、松手一次存储，不逐指针重绘主树/写存储；全局hover/强制圆角冲突已修，设置/失败/文件行无多余浮起，文件入口蓝色，中断徽标不竖排。旧卡片/消息能力保留。
最新布局轮29相关UI+13桌面服务契约、源码72和便携版72项真实Electron通过，183运行文件hash一致。拖动36次移动无存储写入/HTML重载，松手保存一次。历史439全量、各56/63项不是本轮重验。
用户已授权并已更新 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0\release\Umi-win32-x64；旧exe/dist在本轮previous-release备份。build:desktop写dist/umi-build.json，package:desktop先构建再打包，拒绝过期源码/产物、验证包内文件，写umi-release.json。不要再按旧交接说便携版未同步。源码dev与便携包仍分开；菜单完整退出再启动，关窗只隐藏。
唯一Agent循环保持。已实现自然新输入优先、任务跨run/挂起/取消/恢复、旧未知只核验不重跑、搜索/行与UTF-8分页/同版本同文件原子批量编辑、事实变化追加/稳定前缀、独立ask_user_question、冻结分页/跨轮打开、TASK_STALLED正文；用户实测跨轮打开与停滞收尾正常。权限卡允许/拒绝，无自定义回答/停止；问答答案不是批准。
审计已复现但未修复A-01启动writer.starting残留阻塞、A-02 TASK_LIMIT独立正文缺失、A-03迁移6但ready仍5。不要误写成所有受阻结尾都未修。先选窄契约与验收，不盲删活锁，不重复收费收尾，不降低未知/唯一写者保证。
坚持工作副本；来源/托管资料/交付分开，多文件源交付逐项提交可部分成功。普通任务scratch/artifacts/research/logs，preparation按需task/cache；自选工作根未实现。宿主命令无OS文件/网络沙箱，Job/cwd不是隔离；Docker/WSL仅可选执行环境，任务内信任/结构化URL/skill/通用插件仍待讨论。日志64MiB归档上限后缀不可追回，document_open仅证明系统接收。
卡片意图、任务统计/桥冷暖、循环策略、技能/插件、工作根/URL、DTO/同步/资源接口/CSS与备份留存仍为候选。按用户本轮要求选小范围，重大增删重构先讨论。真实/付费API、生产会话、Windows修改及后续发布按当轮安排，不自动扩展授权。第三方参考不是Umi已实现事实。
```
