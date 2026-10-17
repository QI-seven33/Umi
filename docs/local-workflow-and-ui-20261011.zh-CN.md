# Umi 本地执行：大依赖、安装、留存与成果界面

日期：2026-10-11。本文区分本轮实现、外部源码事实和后续方案。真实源码仍在 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0；本轮备份与证据在 E:\Codex\Workspace\output\umi-local-workflow-ui-20261011。未操作生产数据库、调用真实模型、安装依赖、启动产品、重新发布或修改 Windows。

## 本轮实际完成

桌面右侧工作区首页增加任务成果列表，每页 10 项；点击名称重新核验成果 hash 并读取最多 64000 字节文本，可读取下一段。二进制默认仅显示元数据和限制，不把 MIME 声明当作文件内容证明。同名成果以 outputId 分开，名称不作为身份。列表仍只查询冻结元数据，不扫描正文；只有成果创建执行状态变化、翻页或手动刷新才更新列表，普通正文流式事件不会触发查询。

“请求导出”核验该会话的成果，然后由主进程显示系统保存对话框。这里选择的是目标位置，**尚未保存文件**。取消不生成请求；选中后将含准确 outputId/target 的请求加入当前输入草稿，保留原输入。用户发送后沿唯一 AgentEngine → ToolExecutor → 具体导出批准 → intent/receipt 执行。没有另建复制入口，也没有绕过批准。本轮仍依赖模型理解并调用导出工具；尚非无需模型的直接保存功能，界面用“请求导出”表达这个区别。

最近 10 条已结算导出记录可展开。inspect_export 只观察原目标；界面区分原执行状态与这次核验状态。目标核验成功后可在 Explorer 定位，open_export 会再次核验再定位；目标后来改变时撤掉旧结果并显示错误，不能依靠旧绿色回执继续宣称交付有效。没有覆盖/删除/重试按钮。准备检查也显示在首页和工具详情，明确标记为历史观察，不代表当前就绪或 OS 隔离。

列表、预览和准备查询分别处理迟到响应；切换会话会卸载旧面板。加载/错误/空列表/截断文本/未知导出各有反馈。新控件使用现有颜色和 control-radius，展开没有额外投影；没有新 UI 依赖或全局重设计。

## 为什么大依赖仍然会阻塞 Umi

inspect_execution 只浅观察清单、输入文件和依赖目录，因此它便宜，但**真正命令准备**仍调用 host-process/prepare.ts 的 fingerprint(root)：递归整个 cwd，核验文件身份、链接并读内容计算指纹。预算是 20000 项、总 128 MiB、单文件 32 MiB、5 秒、深度 24。node_modules/.venv 仍参与扫描；即使 npm 已安装成功，下一次构建也可能在启动前被这个预算拦住。Windows 链接与包管理器结构还可能触发路径检查。

这是 Umi 当前把“整个 cwd 的内容新鲜度”和“命令执行批准”绑定的设计成本；它不是 Windows 必须如此，也不是依赖目录越大就越危险。cwd 指纹从来没有限制进程运行后的文件或网络访问，因此增大扫描限额不能提供 OS 沙箱。当前依赖目录存在的观察同样不证明所有包完整或脚本安全。本轮保留旧契约，未直接跳过依赖或扩大预算。

## Harness：关注具体对象，执行器与策略分开

核对本地源码 E:\Deepseek-Harness\dsh-learn\deepseek-harness，HEAD `639ed015397290b3745d163aafe02ffee4aa3f84`。本轮未运行或修改它。

| 方面 | 本轮查看的真实实现 | 对 Umi 的启发 |
| --- | --- | --- |
| 文件观察 | packages/fs/fs-observation-policy/src/index.ts 按 session owner + targetKey 记录存在/缺失；编辑要求已观察版本，写入导出 createIfAbsent/replaceIfVersion 意图，由提供方做原子检查 | 比较“模型要改的具体文件”，不必把所有依赖当作编辑输入；Umi 的读回执绑定替换方向一致 |
| 大依赖与变化捕获 | tool-str-replace-editor/src/index.ts 的两级列表排除隐藏项、node_modules 和 Python 缓存；workspace-changes/src/capture.ts 只捕获被文件工具修改的对象，超限返回 oversized | 列表排除不等于 Shell 的安全隔离；文件级快照不是所有命令副作用回滚。不要把过滤依赖直接当成安全证明 |
| Windows 执行限制 | sandbox-local/src/index.ts 与 sandbox-windows-acl 提供实际受限令牌写入/删除限制，报告 partial；读侧未完全约束，硬链接等有明确限制 | Harness 的 Windows 实现比 Umi 多一层真实 OS 机制，不能说它完全靠提示词。本轮不引入它或修改 ACL；保留可选执行器接口即可 |
| 安装 | boot/plugin-manager 有 registry/git/tarball/local spec、请求锁、兼容检查、pendingBuilds、取消与清单/锁文件恢复 | 这是 profile 插件安装管理，不是任意项目依赖万能安装器；恢复清单不能撤销已执行脚本副作用。Umi 可以借鉴阶段回执，不必复制插件生态 |
| 留存 | spill-local 默认 cleanupPeriodDays=30，0 关闭；一次启动扫描按时间清理自有普通文件，严格识别根/会话目录，不跟随链接；长期运行不持续扫描 | “有界模型输出”与“磁盘留存”分开治理。Umi 的验收成果仍有引用关系，不能照搬临时 spill 的到期删除规则 |

以上是所读模块的事实，未把局部目录过滤扩大成 Harness 所有执行模式都不会扫描依赖的保证。

## Reasonix：不同对象有不同生命周期

本轮 GitHub `studio` 树 SHA `24e000b19581a69ac53664f27a6b6317cace9d29`，下载只读研究文件保存在本轮证据目录。以下链接固定这个版本，避免未来默认分支变化后混淆结论。

- [sandbox.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/safety/sandbox/sandbox.go) 与 [protects_windows.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/safety/sandbox/protects_windows.go)：普通 Bash 在 Windows 没有 OS sandbox，产品设定解析为 off；要求 enforce 而后端不可用时拒绝，不默默无隔离执行。macOS/Linux 有自己的机制。这只说明普通 Bash，不推论它所有原生工具都没有其他 Windows 限制。
- [shellrun/runner.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/tools/shellrun/runner.go)：接收已经审定的 argv/Dir/Env/Timeout，运行前台进程并给结构化退出结果；组合输出限 10 MiB，保留尾部 64 KiB，实时进展也限 64 KiB。所读 runner 没有 Umi 式 cwd 全树内容指纹；这不等于证明其他权限层不存在检查。
- [shell_proof.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/safety/sandbox/shell_proof.go)：按 Shell 可执行文件字节验证启动探测缓存，7 天 TTL、最多 16 个证明；这个证明只避免重复启动探测，不能证明沙箱安全。工具链可用性与目录内容保护可以分开。
- [sessiontemp/manager.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/state/sessiontemp/manager.go)：会话临时目录有 owner/lease 和跨进程锁，活跃命令使用期间不能清掉；换代后待租约释放回收，24 小时陈旧清理处理遗留。这比仅按目录 mtime 删除更适合命令缓存/临时区。
- [orphan_outputs.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/state/sessionstore/orphan_outputs.go)：会话正文消失后回收孤立 spill，保留 1 小时宽限；无会话的 scratch spill 另行老化回收。[auto_archive.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/state/sessionstore/auto_archive.go) 的非活跃归档避开 pinned/leased/mid-turn/subagent 等对象，只改变目录状态。归档、临时回收、持久删除是不同动作。
- [installsource/apply.go](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/internal/ext/installsource/apply.go)：有技能/MCP/插件来源安装应用过程、具体目标检查和部分失败恢复；链接技能仍限制来源范围，批准不能变成任意宿主文件入口。它不等于任意项目的 npm/pip 安装器。
- [Studio shell boundaries](https://github.com/esengine/DeepSeek-Reasonix/blob/24e000b19581a69ac53664f27a6b6317cace9d29/docs/STUDIO_SHELL_BOUNDARIES.md)：renderer 管展示，main 管 OS 能力，内核独占持久意图/业务状态。Umi 的系统选址 → Agent 内核执行沿同样的职责分工。

安装还需区分 **产品安装**：Reasonix README 提供 Studio 安装包入口及 CLI setup；Umi 当前 package-desktop.mjs 使用 Electron packager 生成目录，未见自动安装/卸载/更新器。本轮没有发布或增加产品安装器。项目依赖安装、插件安装、产品分发分别立项，别让一个“安装”按钮承担三个生命周期。

## 下一阶段建议与需要明确的取舍

1. **大依赖优先。** 将命令批准对象、具体输入新鲜度与全目录变化观察拆开。候选契约：程序/解释器 hash、cwd 根身份、所选清单与锁文件、显式输入继续核验；批准说明宿主权限和依赖覆盖情况。依赖目录以显式策略作为 opaque 对象，只观察根身份和元数据，不宣称依赖内容全量未变。源码文件工具仍保留逐文件读回执保护。不要为每种包管理器复制一套执行循环，也不要默认排除所有隐藏目录。
2. **观察覆盖必须可解释。** 若采用上述候选，完整 cwd 不变的旧承诺将改变，必须在批准/回执中说明哪些对象按内容检查、哪些仅按身份/元数据检查。先构建复现：超过 20000 项、总 128 MiB、单个大依赖、真实 pnpm 链接布局、依赖根替换、清单漂移、输入漂移、普通源码改动、取消与恢复。允许执行不等于安全隔离，也不等于成功完成测试。这一契约尚未实施，不能把本文方案当作当前能力。
3. **项目准备安装计划。** 在已有 inspect_execution 和 preparation 上增加一个小的计划层：识别锁和包管理器，明确命令/来源/联网/生命周期脚本/cwd/cache，展示计划，由同一 ToolExecutor 执行；安装后重新检查并运行实际构建/测试。默认不全局安装、不管理员执行、不自动改锁，不自动 fallback 到别的包管理器。先支持一条常见路径，其他环境给可恢复诊断。普通用户无需手写重复参数，但仍清楚批准了什么。系统 Node/Python 安装属于另一个有供应链验证与卸载要求的能力。
4. **留存先可观察，再可清理。** 先增加有界磁盘统计与分类：可重建下载缓存、临时进程日志、工作副本、用户成果、验收/恢复证据、对话历史。引用仍在的成果与 intent/receipt 不按 TTL 删除；活跃/等待批准/未知/恢复中的执行持有使用权。后续清理只接受 Umi 自有对象 ID 与冻结清理计划，核验根身份、不跟随链接，分项回执，先可恢复归档/垃圾区。缓存配额与历史永久删除不能共用策略。最初实现可以很小，不需要平台式资源管理框架。
5. **交付效率。** 当前导出按钮仍生成模型请求。后续可评估内核显式“用户导出意图”，复用批准与 OutputFiles 的真实派发/恢复，避免为确定性复制额外调用模型；不可让 renderer 直接写盘，或创建没有用户输入事实的伪造模型工具调用。

优先顺序：大依赖复查契约 → 常用项目安装计划 → 缓存统计/清理 → 长命令观察与取消/恢复 → 任务完成和续作体验。Docker/WSL2 只作为将来可选提供方，OS 沙箱与 MXC 不进入当前核心开发路线。

## 关键阅读调用链

- `OutputsPanel.tsx` 负责展示和有界请求，`App.tsx` 的首页挂载它，按会话 ID 重建；输入草稿仍由原 App 管理。
- 列表：window.umi.request → preload 固定 request → main 来源/协议校验 → broker/utility → DesktopService → OutputFiles.list。
- 预览：同一路径的 preview_output → OutputFiles.read → descriptor/bytes hash 校验 → 有界 UTF-8 片段。名字只用于展示。
- 选址：chooseOutputTarget → preload 固定 umi:output-target → main 调 preview_output 验证归属及当前字节 → 系统对话框 → 返回目标 → 加入用户草稿。这里没有写文件副作用。
- 真正导出：发送用户输入 → 原 AgentEngine → export_outputs.prepare → 批准 → 派发 → 独占创建和逐项 intent/receipt。查看记录走 inspect_export，打开位置走 open_export 再核验。
- 准备反馈：原 inspect_execution 结果 → tool_detail 固定 inspection 投影，限定根路径/问题数量和文字长度 → InspectionSummary。未暴露任意 artifact 读取或任意 SQL。

## 本轮验收证据与限制

最终相关 5 个测试文件 **85/85** 通过，其中新增 outputs-ui.test.ts **5 项**。使用 ScriptModel、临时目录与测试 SQLite；覆盖空会话说明、检查报告转义/观察语义、精确导出对象、真实检查投影/跨会话拒绝/普通 data 不外泄，旧文件预览身份，以及现有成果/准备/桌面/UI 流程回归。类型检查与核心/桌面构建通过。

临时浏览器夹具加载真实 OutputsPanel 和三层现有 CSS，桥接使用固定假回执：检查同名成果、分页、文本/二进制预览、取消选址、草稿生成、内容失败清掉旧预览、原目标核验变 unknown 撤掉位置按钮、慢会话切换等。截图与说明保存在本轮证据目录。它不是实际 Electron 系统对话框或生产端到端验收；本轮未启动产品。外部项目只读研究，未在此机验证它们的沙箱、安装或清理运行效果。

大依赖内容复查、自动安装器、留存配额/清理仍未实现；准备 UI 是历史报告摘要，成果仍限制单文件 4 MiB/批次 16 MiB，导出父目录须已存在且不覆盖。过去 191/117 等数量保留为历史，不属于本轮 85 项结果。
