# Umi 文件发现、写入与交付：源码排查及下一步

核对日期：2026-10-11。第一阶段有界发现与元数据分页已实施，新增 16 项专项场景、最终相关 11 文件 132/132 通过；类型检查和核心/桌面构建通过。当前契约与证据见 [学习文档](file-discovery-20261011.zh-CN.md)。第二阶段创建/替换契约也已实施，本轮新增 24 项，相关 16 文件 207/207 通过，类型检查及核心/桌面构建通过，见 [文本写入学习文档](text-write-20261011.zh-CN.md)。以下表格保留实施前排查快照，第三至第四阶段仍属后续计划；不声称重现用户生产会话全部问题。

## 实施前链路排查快照

`discover_resource → request_resource → 托管工作副本 → read/edit/write → build_changeset → deliver_changeset` 是外部资源修改链路。发现只是元数据候选，申请批准后才取得范围；副本修改和真实来源交付是不同权限。command/cwd/Windows Job 不构成 OS 文件或网络沙箱。

| 环节 | 源码事实 | 对任务的影响 |
| --- | --- | --- |
| 发现 | resources.discover 的默认模式只递归目录名称，深度 2、最多 2000 个目录/20 候选/约 1.5 秒；精确 path 支持普通文件和目录 | 按文件名/扩展名找资料可能没有候选；无候选不等于不存在，用户已指出的问题有明确实现依据 |
| 列举 | list_files 先完整 scanMount，再取 limit（最多 200），返回 total/truncated，没有 offset/cursor | 大目录只能看到首批；缩小 prefix 可缓解，但不能保证遍历所有匹配文件；清单还会读取内容计算哈希 |
| 物化 | 忽略 .git/node_modules/.venv/__pycache__；单文件 4 MiB、总量 32 MiB、5000 项、深度 16 等限额 | 大项目、办公文件及依赖可能超限；工作副本不是源目录完整复制，测试前不能假定依赖已经具备 |
| 编辑 | edit_file 绑定成功读回执、哈希和唯一字面片段；write_file 整文件写入，准备/派发间检查现状，但不绑定先前阅读 | 局部编辑有保护；整文件重写仍可能把模型没读到的内容替换掉。它有派发时版本检查，不应被说成完全无检查 |
| 文件类型 | 文件路径工具支持普通文件，结构化写入为 UTF-8 文本；atomicWrite 能创建父目录 | 不是不能新建文件；缺的是显式目录管理、二进制/大文件路径，以及明确的新建与替换契约 |
| 源交付 | 固定 ChangeSet、具体批准、逐项 intent/receipt、冲突检测及只核验恢复 | 已有可靠基础；仍需面向用户清楚展示源目标、部分完成、冲突及剩余项，不能用副本成功冒充源修改成功 |
| 新成果交付 | write_file 依赖 mount；write_scratch 只写 task/scratch 且走批准；task/artifacts 目录存在，但无统一 create/preview/export 工具 | “生成一份文件给我”与“修改已有源文件”需要不同流程；不能迫使所有成果先申请整个源目录编辑权限 |
| 宿主命令 | 批准后能访问当前用户可访问的 cwd 外文件/网络 | 结构化文件边界不能约束命令产生的全部副作用；扩大自动执行前仍需真实隔离或明确宿主风险范围 |

学习入口：[resources.ts](../packages/adapters/src/host-files/resources.ts)、[tools.ts](../packages/adapters/src/host-files/tools.ts)、[paths.ts](../packages/adapters/src/host-files/paths.ts)、[text-edit.ts](../packages/adapters/src/host-files/text-edit.ts)、[delivery.ts](../packages/adapters/src/host-files/delivery.ts)。本轮批准/拒绝交付及组合验收证明副本与源交付契约能工作，不证明 UI、路径发现和所有现实任务已无问题。

## 参考项目与适合借鉴的部分

本地 Harness 固定提交 639ed015397290b3745d163aafe02ffee4aa3f84，读取 tool-todo、tool-fs、fs-observation-policy 和 workspace-changes 选定源码/说明；未运行它、调用模型或改它的文件。

- Harness 的文件工具调用 ctx.fs 的提供方接口，观察策略通过事件施加版本/不存在守卫；Shell 是另一能力。借鉴“工具意图、对象观察、策略、后端”分开，保留 Umi 的强制默认策略，不做可随意卸载的安全插件。[文件策略源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/fs/fs-observation-policy/src/index.ts)
- Harness 的 todo 是持久全列表替换，completed 由模型填写；它适合展示进度，不等同客观验收。变更展示还有 Git/大小/重启覆盖条件，不能把所有 Shell 副作用都视为已记录。[本地文件策略](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-observation-policy/src/index.ts)、[本地变更记录说明](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/deliverables/workspace-changes/README.md)

本轮只读获取 Reasonix 官方 studio 提交 9d63534b05a9309a77036befcb000e5f0b35ee0f 的任务契约、工具契约、task_contract.go 与 complete_step_e2e_test.go，下载元数据在项目外 research/retrieval.json。它已有结构化文件工具、步骤签收与宿主证据账本，不是单纯直接操作命令行。task_contract.go 从项目检查、已捕获测试与计划派生验收，并拒绝无依据放松；可借鉴稳定验收来源，而非照搬整个架构。[任务契约源码](https://github.com/esengine/DeepSeek-Reasonix/blob/9d63534b05a9309a77036befcb000e5f0b35ee0f/internal/runtime/agent/task_contract.go)、[工具契约](https://github.com/esengine/DeepSeek-Reasonix/blob/9d63534b05a9309a77036befcb000e5f0b35ee0f/docs/TOOL_CONTRACT.md)

Kimi Work 官方说明目标模式使用稳定的成功标准持续比较现状，用户可中断和更正；其权限文档区分常规动作与修改/覆盖/运行代码等批准。适合借鉴目标锚点与清晰交付体验。公开资料不足以确认它内部文件能力的隔离实现，不能据此宣称它有某种 Windows 沙箱。[目标模式](https://www.kimi.ai/zh-hans/help/kimi-work/goal-mode)、[权限说明](https://www.kimi.ai/zh-hans/help/kimi-work/kimi-work-faq)

Kimi Code 公开 SetTodoList 实现持久 todo 与查询，它是可参考的代码，不是 Kimi Work 全部私有实现的证明。[SetTodoList](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/tools/todo/__init__.py)

共同启发是让模型顺畅地操作明确对象，并提供可靠观察和交付反馈；“直接操作源目录”不是效率的唯一来源。Umi 暂时保留副本架构，先解决发现和产物路径的断点。是否增加可选的源目录直接编辑模式需要单独讨论，不在本轮偷偷改变。

## 分阶段实施顺序与验收

### 1. 已实施：有界文件发现和可翻页列举

已增加 root/kind/match/depth/limit/cursor，支持文件名、扩展名和相对路径字面匹配；精确 path 保持单对象定位，单文件批准不扩大。list_files 已拆元数据观察与原完整内容清单，稳定排序分页，跨查询拒绝，重启重扫可续页，变化返回 restart_required。当前覆盖预算 5000 项/约 1.5 秒；元数据不等于内容哈希或 OS 沙箱。

本轮 16 项专项场景覆盖中文/空格/长路径、同名、205 项以上、忽略/隐藏项、OneDrive 实际根规划、联接/硬链接、预算/取消、空结果、版本变化、扫描中变化、prefix、单文件批准物化、只读恢复和有界上下文游标反馈。全部专项使用临时目录；OneDrive 不是云同步实测。游标只翻页已覆盖结果，不保存未遍历 frontier，预算耗尽须缩小范围。

### 2. 已实施：将创建与替换意图分开

write_file 默认 create：通过 wx 独占创建，不覆盖现有或晚到文件；显式 replace：成功完整读取、哈希和对象身份均需匹配。局部 edit_file 保持原契约，两者共用 requireTextRead 只读端口。新建可在批准根内创建父目录，显式目录管理、二进制/大文件成果与 Artifact/Export 留到后续，不把权限一并扩大。

24 项专项覆盖默认新建、旧参数不能覆盖、新建冲突、派发后变化/联接/取消、真实读取后的 BOM/CRLF/中文及 no-op、错哈希/位置/跨会话、同字节换对象、部分/二进制读取、非法 Unicode、四个派发后/写后提交故障恢复以及旧冻结上下文核验。相关资源批准、交付及任务证据已迁移到真实 read_file → replace 流程，最终 207/207 通过。

完整读取单次上限 64000 字节；部分读取不能授权整文件替换。wx 只保证名称不覆盖，写入中断仍可留下部分文件。应用层路径复查与替换检查不是 OS 原子 CAS；恢复不能确定时保持 unknown，不自动删掉或重写目标。

### 3. 已实施初版：独立成果与具体导出

create_output 保存自有文本，capture_output 从 task/artifacts 收录普通文件并复制冻结；list_outputs 持久元数据分页，read_output 按当前 hash 核验并分页预览。export_outputs 冻结具体成果/目标/父目录身份，具体批准后不覆盖导出，intent/receipt 复用现有 artifacts 表。部分完成、取消和未知逐项反馈；重启与 inspect_export 只观察原目标，不重放。

原项目修改继续使用 ChangeSet，新成果使用 Export；权限保持分开。export_receipt 已加入任务验收，生成不能冒充交付；新输入后使用 inspect_export 产生当前证据。桌面固定 list/preview/inspect/open_export 接口已接入，定位实际已核验文件；专用 renderer 卡片/按钮和 Office/PDF 渲染未实现。

本阶段新增 32 项，最终相关 7 个测试文件 117/117 通过，类型检查与核心/桌面构建通过。覆盖二进制、长文本分页、重名/晚到、跨会话、拒绝后重建重排、部分/取消、意图/写后/回执中断、目标漂移和任务续作。使用固定模型及临时数据，不证明真实模型任务完成率。

单文件 4 MiB、单批 16 MiB/20 项；导出父目录必须已存在，默认不覆盖，替换导出/目录管理/删除权限未加入。mime 不证明格式；独占名称不保证正文原子，未知不删除/重写。总留存配额未实现。源码与调用链见 [成果与导出学习文档](outputs-export-20261011.zh-CN.md)。

### 4. 补齐本地执行反馈，保留可选隔离后端

已增加执行准备有界观察、真实回执绑定和具体批准的准备声明，默认会话任务缓存；本阶段 191/191 相关测试，见 [学习文档](execution-preparation-20261011.zh-CN.md)。未新增自动安装器或证明大型项目可构建：完整 cwd 指纹仍限制大依赖树，下一步先评估此断点，再贯通输出观察与取消恢复。run_command/run_shell 明确在当前用户权限下执行；cwd、Job、提示词和工具白名单不能限制所有文件与网络副作用。文件权限拒绝不能通过 Shell 绕过；提示词规则不构成系统强制边界。

Docker/WSL2 作为有能力开发者可选的后端方向，由用户准备环境；只在真实替换执行的位置复用现有端口。默认 WSL 驱动器映射/Windows 互操作和 Docker 可写挂载均不能当作任务范围隔离证明。后端需给出映射、网络、取消/重启和输出回执证据，无法满足时拒绝该后端请求，不静默回退宿主。

AppContainer/LPAC 保留研究参考，退出当前优先开发序列；MXC 不恢复，Windows 不修改。暂不引入万能 FileService、权限 DSL、动态插件市场或多 Agent 调度。Artifact/Export 与依赖准备完成后，以实际日常任务/编码任务的成功率、批准次数、准备耗时和恢复成本决定进一步投入。详细顺序和验收见 [执行边界计划](execution-boundary-plan-20261011.zh-CN.md)。
