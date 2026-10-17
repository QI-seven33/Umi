# Umi 路线讨论与隔离任务审视（2026-10-12）

用户已明确：保留工作副本；希望 Umi 的工作文件放在用户选定目录；交付目标可另外指定；消息续作应自然；减少审批疲劳；Windows 本地个人助手优先，避免庞大平台。本次核对源码、官方资料并执行隔离测试，**没有改变产品运行逻辑、权限或数据分配**。未调用真实付费 API、操作生产数据库或发布。所有临时测试目录已清理，证据保留在 `E:\Codex\Workspace\output\umi-route-review-20261012`。

## 1. 实际文件分配，与用户希望的差别

当前桌面 `main.ts` 默认使用 `app.getPath('userData')/Umi`，Agent 数据在其 `agent` 子目录；截图对应 `%APPDATA%\umi\Umi\agent`。源码路径核对，没有读取生产目录。`--data` 可以改整套桌面数据位置，尚不是每个工作区单独选择缓存目录的 UI。

| 角色 | 当前实现 | 差别/限制 |
| --- | --- | --- |
| 桌面“工作区” | 保存 `workspaces.source_root`，作为初始任务来源 | 名称容易让人误以为这是缓存根；实际不是 |
| 工作副本 | 每会话一个 environment，`agent/environments/<id>/working/<mountId>` | 目前由应用数据根分配，不在用户另选的工作目录 |
| 工作文件 | `task/scratch`、`task/artifacts`、`task/research`、`task/logs`；成果在 `task/artifacts/outputs` | 当前创建列表没有 `task/cache`，不能按 DeepSeek 的表格把它当作已实现 |
| 项目修改交付 | 选定副本文件 → 冻结 ChangeSet → 批准 → 写回绑定来源 | `build_changeset.paths` 可以选文件，省略则枚举变化；新增构建文件并非全都自动排除 |
| 独立成果 | `create_output/capture_output` → `export_outputs` 到具体绝对文件路径 | 可由用户描述或保存对话框选择；父目录需存在，默认重名不覆盖。项目整体另存到其他目录尚无同等入口 |

初始来源复制时排除 `.git`、`node_modules`、`.venv`、`__pycache__` 和托管数据目录，拒绝不合格路径。副本避免普通文件工具直接污染来源，但这**不是源目录的 OS 只读设置**。获批任意宿主代码可访问副本之外；本次仅在临时目录验证了这一事实。

建议固定三个产品概念：**Umi 工作目录、任务来源、交付目标**。例如工作目录 `E:\Umi-work`，项目来源 `E:\Projects\A`，成果目标 `D:\Deliveries\A`。工作副本继续保留；用户选择的工作目录下用会话子目录存副本与工作文件。全局设置/会话索引的去向、旧会话迁移、工作目录被移动/删除后的表现需要先明确；不静默迁移、不直接写源、不增加第二循环。交付按选定文件生成清单，构建缓存不默认混入成果；依赖缺失应清楚反馈，不把安装器设为任务前置。

关键入口：`SqliteStore.createConversation`、`ResourceFiles.bindInitial/materialize`、`DeliveryFiles.build`、`OutputFiles.prepareExport`。

## 2. 网络与批准：官方对照和建议纠正

**结构化网络工具**是在 Umi 内提供明确的“搜索/读取网址”工具，参数有 URL，回执有最终 URL、HTTP 状态、内容类型、范围或资料 ID。**宿主代码联网**是批准模型运行 Node/PowerShell/Python 等程序，由程序发请求。脚本常能显示网址，但程序及依赖还可能发起其他连接；没有 OS 网络约束时，授权描述不能限制实际目的地。两条路可以同时存在，不需要先建设网络平台。

Umi 已有 `deepseek_server_web_search`，目前没有通用网页读取工具；它是付费提供商能力，本次未调用。公开网页读取可以作为一个窄适配器加入现有工具模块，不再包一层 Agent。先做 GET 文本阅读、限时、有限响应、资料分页；网页内容不能授予权限。上传、提交表单和带账户操作另列行为，避免把它们混进“阅读网址”。宿主联网仍是已授权代码的能力，不能宣称关闭网页工具就关闭了宿主网络。

本次官方资料核对：

| 产品 | 可核对的当前行为 | 对 DeepSeek 表格的纠正 |
| --- | --- | --- |
| [Claude Code 权限](https://code.claude.com/docs/en/permissions) | WebFetch/WebSearch 有工具权限；命令/域名可保存规则，文件修改可会话允许；还有 Auto 审查模式 | 不都是一次或仅本会话批准；Auto 不是等同于全信任 |
| [Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing) | 沙箱约束 shell 子树；原生 Windows 命令不带该沙箱，可选 WSL2 | “Bash 联网走沙箱”缺平台与启用条件 |
| [Cursor Run Modes](https://cursor.com/docs/agent/security/run-modes) | Auto-review、Allowlist、Run Everything；审查不被描述为安全边界 | “终端联网不拦”不是当前统一事实；需结合模式/平台 |
| [Cursor Windows 实现说明](https://cursor.com/blog/agent-sandboxing) | Windows 沙箱采用 WSL2，明确原生通用开发工具隔离较难 | 不应拿它证明 Umi 已具备等效隔离 |
| [Codex 官方权限](https://learn.chatgpt.com/docs/permissions)及[批准说明](https://learn.chatgpt.com/docs/agent-approvals-security) | 文件/网络权限与批准政策分开；有自动执行与更广权限选择，新权限 profile 仍在演进 | `auto/suggest` 不足以描述当前产品；不能把执行政策与技术限制合成一档 |
| [Reasonix 当前模式](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/docs/TOOL_APPROVAL_MODES.md) | Ask / Auto / Yolo；Ask 提供单次/会话/持久选择；Auto 减少日常提示但保留明确 ask/deny 等规则 | 不是 `read-only/workspace-write/danger-full-access` 三档 |

建议 Umi 先提供两个易懂执行选择：现有“询问执行”与用户主动选择的“本任务信任宿主命令”。后一种允许当前连续任务的命令、测试和构建，不每次提示；记录是谁何时授予，停止/完成/关闭模式后撤销。新任务可再次选择。源交付和成果导出保持具体入口，拒绝不得换参数绕过。**没有沙箱时，宿主信任可能读写机器上用户可访问的文件并联网；程序类别/工作副本只是授权描述，不能保证代码不越界。** 也不能保证脚本绕不过专用交付批准。不要通过脚本关键词或再建全目录指纹来假装约束任意代码。

目前不建议复制 Cursor 的云端审查器或 Reasonix 的整个 Guard。先验证可撤销的明确授权能否降低实际批准次数，再决定是否需要更多模式。权限存于 Umi 自己的配置/数据库；项目文档、脚本、网页不能自己启用信任。Reasonix 的[项目配置规则](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/SECURITY.md)“项目只能收紧不能扩大用户权限”值得采用。

## 3. 消息续作、长日志与 Reasonix 的可借鉴范围

用户消息应进入唯一现有循环。不能简单用包含“继续”的字符串触发旧命令重放：新消息可能是在改要求、询问状态或换任务。新的要求优先；已完成事实保留，未派发的旧计划不可先执行。

本次明确区分：

- 原话已应用、无未知操作，正常停止后，新消息已能创建并完成新 run。
- interrupted/recovery_required 保留 active run；当前新消息被保存，但 `send` 不启动 recovery。现有 `resume` 可核验后将两条原话一起交给模型。
- 原话刚保存尚未应用即停止，下一 run 可启动，但 `TaskRepository.complete` 被旧 run 的未应用原话挡住，报 `TASK_STALE`。必须处理已结束 run 的输入归属，而不是删历史。

拟定续作验收：普通新消息启动；异常任务先核验原派发身份，绝不重放未知命令；新输入优先于旧待执行计划；更改要求不会执行旧批准；重复 commandId 不重启；停止前未应用的原话保留且不阻塞以后结束；“继续任务”按钮在这些成立后移除。核验不了的效果要明确说明、阻止重复修改，不让输入静默挂起。具体恢复策略在实施前讨论，沿既有 `send/start/resume/ToolExecutor`。

Reasonix 官方 studio 本次固定提交 `fba020d9bb2bee7d80b9649be2860b9ead11a9e0`，比上一轮 `4a0b3888…` 已前进；只核对选定路径，不作全仓审计：

- [tool_output_spill.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/runtime/agent/tool_output_spill.go)：超长非分页结果写会话旁文件，返回指针；识别分页/追回目标避免递归溢出。仍有窗口截取与失败兜底，不能概括“永远无损”。Umi 保留承诺字节范围的严格完整性。
- [jobs/artifacts.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/tools/jobs/artifacts.go)和[jobs.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/tools/jobs/jobs.go)：内存保留小尾部，输出同时流入日志文件；元数据区分 complete/error。Umi 可以用已有 executionId/output 端口实现，不需要任务调度平台。预览上限、归档磁盘上限分开；达到归档上限或写盘失败须明确 incomplete，已保存范围仍可分页。
- [interrupted_recovery.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/runtime/agent/interrupted_recovery.go)：给新用户消息附宿主核验的中断事实，新消息优先，无关问题不强制恢复。适合 Umi 的自然续作方向。
- [todo.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/tools/builtin/todo.go)：列表与稳定步骤 ID 便于显示进度；完成证据还有别的宿主模块。Reasonix 也有 delegation、Guard、安装/更新等实现，不能当作只有 todo 的小系统。Umi 已有任务签收，先不再新增一套。
- [orphan_outputs.go](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/state/sessionstore/orphan_outputs.go)：会话不存在且宽限一小时后清理孤立输出；不能据此宣称所有 spill 固定 30 天、所有临时固定 24 小时。这两个统一 TTL 本次未建立源码依据，暂不采用。
- [Windows shell 实现](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/internal/safety/sandbox/seatbelt_windows.go)仍无 OS Bash sandbox，有效产品设置 off；内部 enforce 调用不可伪称 wrapped。不是整款 Windows Agent 都停止执行。其[恢复/安装文档](https://github.com/esengine/DeepSeek-Reasonix/blob/fba020d9bb2bee7d80b9649be2860b9ead11a9e0/docs/RECOVERY.md)明确存在桌面安装器；自动安装项目依赖是另一个问题，本次未据此断言。

## 4. 本次隔离证据与下一步的可见成果

`task-probes.mjs` / `task-probes.log` 共 6 项通过，其中缺陷样本断言当前缺口，**不表示缺口修好了**。固定模型决定工具调用，实际产品循环/文件/SQLite/Windows 命令执行，没有付费模型自主任务质量结论。

| 样本 | 实测结果 |
| --- | --- |
| 中文 CSV 筛选 → 新成果 → 外部交付 | 实际文件匹配，来源不变，1 次导出批准；实际 task 四个目录不含 cache |
| 跨文件失败测试修复 | 原测试退出 1，修改两个副本文件后退出 0；同类测试前后要批准 2 次 |
| 大模块局部改动 | 总 194,126 字节，读取 2,000 字节窗口后修改；其他正文/中文学习注释原样保留，来源不变 |
| 长日志定位 | 实际观察 264,018 字节，默认归档仅 65,536 字节，末尾关键标记无法追回 |
| 两类续作 | interrupted 消息不自动启动、queued 原话停止后 TASK_STALE 复现；已应用原话的干净停止分支可完成新任务 |
| 公共 HTTPS 与宿主文件能力 | 经一次批准的 Node 命令 GET 官方公开文档：HTTP 200、9,303 字节；能在副本之外的测试临时目录新建文件；生产数据未触碰 |

p50 是中位数；p95 是按耗时排序后，95% 的样本不超过的值。用户真正关心两个时间：**停止意图被接收**和**执行清理结束**，它们应分开。不是要求收集用户生产数据才能开发。

`desktop-probe.json`：隐藏 Electron、真实应用 renderer/preload/Broker/worker、隔离主进程处理器；3 次 worker 启动共 60 次停止，其中 57 次热样本接收 p50=4.0ms、p95=5.5ms，状态清理 p50=9.4ms、p95=14.1ms；首次样本接收 3.6–6.7ms。第一组含 45 轮真实离线历史。使用页面 bridge 发请求，未计入人工点击或 React 停止控件重新绘制；模拟模型，不是命令树/生产 p95，也未加载完整生产 main.ts。不存在完整生产链已验收的结论。

拥堵样本确实发现 `AgentBroker.request` 在 32 个 pending 时会拒绝 stop，返回 `BACKPRESSURE`。上一轮 worker 优先入口没有覆盖这一层。下一修复须给 stop 单独有限通道或保留容量，普通请求仍有背压；取消任务不可被轮询占满。证据是本次真实 Broker/worker，不是仅静态推测。

建议按可交付的用户体验排顺序，每段都先用离线与真实工具验收，付费质量测试另定范围：

| 阶段 | 用户能直接感受到的成果 | 具体验收 |
| --- | --- | --- |
| 下一小阶段 | 发消息即可续作；停止在拥堵时也能送达；长日志关键内容能找回 | 上述两类续作缺口变为成功；不重放未知操作，不执行过期批准；32 pending 下停止可接收；264KiB 中尾关键标记可分页取回，磁盘失败/到限明确 |
| 随后 | 当前任务信任一次，反复测试不反复问；直接网址可读 | 修改两文件→测试→调整→测试只需一次任务命令信任；关闭/停止后失效；项目/网页不能扩大授权；URL 失败/跳转/分页给有效回执；保留询问模式 |
| 再随后 | 用户能选 Umi 工作目录，来源和交付位置独立 | 新会话副本与工作文件确在所选目录；源未交付前不变；明确文件清单导出其他目标；旧会话可继续，不把缓存混入成果 |

不继续规划新调度器、庞大插件生态、自动依赖安装器或通用留存平台。工作副本已经确认是主路线，直接源目录编辑不再是候选开发方向。留存先依现有会话归属解决活跃引用与孤立文件，后续出现实际磁盘问题再加窄清理。现阶段的进展以这些用户可操作的完整任务为标准，而不是测试总数或框架数量。
