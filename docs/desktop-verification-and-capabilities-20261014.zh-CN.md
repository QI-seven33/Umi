# Umi 桌面验收整理与批准卡片、技能、插件研究

日期：2026-10-14。真实源码：E:\SOME_SEVEN_PROJECT-57\Umi_v2.0。

本轮已整理桌面验收脚本，整套真实 Electron 验收46项通过，核心编译与桌面资源构建通过。用户另已反馈跨轮打开、无进展正文收尾的实际体验正常；这是用户实测反馈，与本轮固定模型的自动验收分别记录。

批准卡片、skill、插件部分为研究和候选契约，本轮没有改变产品卡片、权限策略、工具规格或设置页面，没有实现技能/插件加载器。

## 1. 桌面验收脚本是什么，本轮改了什么

`apps/desktop/verification.ts` 自动操作真实 Umi renderer，经固定 preload、IPC、broker、utility process 调用真实核心、SQLite 和工具。模型由私有验收参数替换为固定本地模型，因此可以稳定复现交互且不产生模型费用。入口 `scripts/verify-desktop.mjs` 每次创建独立临时数据目录，使用源码版 Electron；没有触碰生产会话。

“断言”是脚本中的检查条件。例如按钮应叫“允许本次”、批准前源文件不能改变。界面迭代后，旧标题、旧颜色和已删除组件仍留在检查中，会使正确的当前界面被判为失败；另外，过弱的检查也可能把拒绝后的正常结束当成交付成功。

| 原检查 | 本轮整理后的检查 | 保留的验收目的 |
| --- | --- | --- |
| 等待旧文字“需要你的批准” | 检查操作批准卡、当前标题、允许/拒绝按钮 | 页面重载后仍能重建同一批准等待 |
| 工作区入口12px圆角 | 当前已接受的10px圆角 | 紧凑、统一的控件边界 |
| 固定欢迎语“今天想完成什么？” | 当前已接受的标题、正文和Umi图像 | 欢迎内容完整呈现 |
| 发送按钮黑底 | 当前蓝底白字，仍检查圆形及悬停不变 | 发送控件视觉一致，无阴影/位移动画 |
| 已删除的Jelly Radio类名 | 真实radiogroup和三个选项；点High，核对持久设置和重开后的选中状态 | 选择真的保存，样式检查不对空数组放行 |
| 设置分类“插件” | 当前“执行环境” | Docker/WSL含义与已接受界面一致 |
| 深色侧栏必须显示黑字 | 在明确solid降级外壳中合成实际祖先背景，检查文字对比度≥4.5 | 保留可读性检查，适应当前透明叠色样式 |
| 批准等待期间寻找停止按钮 | 批准卡核对无自定义输入、无停止；停止按钮移到真正运行中的任务检查 | 两种状态对应各自真实控件 |
| 点击批准区第一个按钮，并仅检查run结束 | 明确点击`.approval-allow`；核对成功交付工具回执及源文件完整内容 | 交付成功必须有实际效果 |
| 所有轮询超时只有同一句错误 | 在等待开始处保留调用栈，并保存错误stack | 失败能定位到具体检查 |

交付样本在创建工作副本前写入独立来源目录。批准前明确检查“交付前原文”未变；批准后必须与300次重复的完整新正文一致。没有通过删检查或改产品CSS使脚本通过。

关键文件：[桌面验收](../apps/desktop/verification.ts)、[私有固定模型](../apps/desktop/verification-model.ts)、[启动脚本](../scripts/verify-desktop.mjs)。本轮只修改第一份代码文件。

## 2. 为什么Umi的批准卡片看起来每次差不多

本轮主要分析“请求执行权限”的批准卡片。`ask_user_question` 是独立问题卡，负责选项与自定义回答；用户意见与执行批准仍应分别处理。

普通批准卡直接呈现持久化的 `approval.description`，交付卡则额外读取冻结的真实目标目录和文件清单。这种做法能保持授权与对象一致，但信息顺序不利于快速理解。

源码中有四种不同情况：

1. `request_resource` 已有模型填写的 `purpose`，并明确展示读取/副本修改、文件或目录范围、来源写回另需交付确认。因此不能说所有卡片都没有用途。
2. `run_command` / `run_shell` 常以“我需要执行此次宿主命令，用于当前任务”开头。程序、真实argv/完整脚本、工作目录、范围、超时、输出归档和批准绑定规则混在一大段；普通命令缺少专门说明“为什么此时运行它”的字段。带preparation回执的命令已有准备目的与网络/安装脚本声明。
3. `open_delivered_file` 已指出具体文件、默认应用、当前版本核验和本次授权范围。这类操作主要需要更清楚的信息分层。
4. `deliver_changeset` / `export_outputs` 已有具体写回或新建目标与范围。交付卡已有冻结文件预览，不能用模型概述替代这些事实。

证据：[批准卡](../apps/desktop/renderer/src/ApprovalCard.tsx)、[命令批准说明](../packages/adapters/src/host-process/tools.ts#L308)、[资源访问用途](../packages/adapters/src/host-files/tools.ts#L107)、[打开说明](../packages/adapters/src/host-files/delivered-open.ts#L70)、[批准生成入口](../packages/agent/src/tools/executor.ts)。

我的判断：这个问题值得改，但首先应改变信息结构和普通命令的用途表达。增加图标、泛化风险徽章或再加一段“用于完成当前任务”，解决不了真实意图不清的问题。

## 3. 其他Agent如何展示请求

本地源码固定版本：Harness `639ed015397290b3745d163aafe02ffee4aa3f84`，本轮核对本地HEAD与干净状态；Reasonix使用此前获取的完整固定源码 `4041b48a8ead93876aac9122e4634fa1a412595a`。它们的行为是这些版本的源码事实，不代表今天远端最新版本。未启动、安装或执行第三方程序。

| 对象 | 经核对的展示方式 | 对Umi有价值的部分 | 取舍 |
| --- | --- | --- | --- |
| DeepSeek Harness | ApprovalPanel展示请求方理由，按callId关联现有调用；ApprovalCommand从真实argsRaw提取command显示；允许一次/拒绝 | 理由与实际操作并排，展示依据来自同一调用 | 通用详情这里只识别command字段，其他工具仍需专门呈现；理由本身也可能泛化 |
| Reasonix Studio | 独立tool、subject、需要确认的原因；内核决定是否显示会话/持久授权；特殊操作额外说明批准后还会发生什么 | 操作对象、原因、授权效力清楚；前端只展示宿主真正支持的选项 | 它的Auto不是Umi现成能力；源码中的扩展/钩子可以运行宿主代码，不能把卡片存在当作全面隔离证据 |
| Claude Code | 官方示例同时展示“运行测试”的说明、真实npm命令、需要批准原因及授权选项；只有能说明完整效力时才提供可复用授权 | 简短用途与完整命令同时保留；授权选项说明持续范围 | 各工具授权寿命不同；本轮不照搬其批准输入框或长期授权 |
| Cursor | 文件读取批准展示完整路径与询问原因；MCP默认询问，可展开查看参数 | 用户可核对本次目标和参数 | Auto-review等行为依赖其执行模式与实现，不能直接移植为Umi能力 |
| Codex | 官方区分执行权限边界和批准策略；可将需要批准的请求交由Auto-review，桌面显示审核状态等信息 | 清楚说明请求涉及哪项额外权限，并如实显示处理状态 | 本轮依官方文档核对机制，没有操作Codex产品界面来证明全部视觉细节；独立审核会增加模型请求 |
| Gemini CLI | Shell参数有真实command和用于确认的简短description；skill激活确认会说明名称、用途、被开放的资源目录 | 简短意图与实际权限范围共同呈现 | skill激活具有自己的读取授权语义，不等于允许所有后续脚本执行 |

官方依据：[Claude批准提示](https://code.claude.com/docs/en/permissions)、[Cursor执行模式](https://cursor.com/docs/agent/security/run-modes)、[Cursor MCP批准](https://cursor.com/docs/mcp)、[Codex批准与Auto-review](https://learn.chatgpt.com/docs/agent-approvals-security)、[Gemini Shell参数](https://geminicli.com/docs/tools/shell/)、[Gemini技能激活](https://geminicli.com/docs/cli/skills/)。均已读取对应官方页面；不使用第三方评测来证明产品机制。

本地关键源码：[Harness批准面板](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/client/ui-approval/src/client/ApprovalPanel.tsx)、[Harness命令关联](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/client/ui-chat/src/client/chat/ApprovalCommand.tsx)、[Reasonix批准卡](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/desktop/frontend-next/src/ui/cards/ApprovalCard.tsx)、[Reasonix批准传输字段](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/internal/contract/eventwire/approval.go)。

## 4. 批准卡片的小范围候选契约（未实施）

建议保留紧凑卡片与允许/拒绝两个操作，首屏按以下顺序呈现：

| 字段 | 内容来源 | 例子 |
| --- | --- | --- |
| 本次动作 | 宿主准备后的工具与对象 | 打开已交付报告 / 运行项目构建 / 写回2个文件 |
| 用途 | 模型对当前要求的简短解释，标明其来源 | 检查刚才改动能否生成桌面资源 |
| 对象和直接影响 | 现有冻结执行上下文与回执 | 具体文件；工作目录；写回目标；默认应用 |
| 本次授权 | 现有真实权限规则 | 仅此打开 / 仅此命令 / 仅此冻结变更集 |
| 完整详情 | 相同请求的程序+argv/脚本，或冻结文件审阅 | 可展开、完整连续查看；与真正执行内容一致 |

命令卡可表达为：

> 运行桌面构建
>
> 用途：检查刚才的改动能否生成桌面资源（模型说明）。
>
> 工作目录：本任务工作副本。程序与参数：可展开完整查看。
>
> 授权：只执行这一条命令。宿主命令当前可以访问用户可访问的文件和网络。

这是文案示例，不是对任意脚本行为的自动证明。`npm test`也可能运行自定义脚本，不能仅凭命令名显示“只读”或“完全安全”；模型用途不能覆盖真实目标、拒绝规则或版本核验。

如果实施：新增的普通命令用途应走既有object工具参数、持久化与批准绑定；不额外调用模型生成卡片摘要，不由renderer再请求模型。用途变化不能复活用户已拒绝的等价命令。批准对象、参数、路径或环境变化仍按现有规则重新批准。旧批准事件可继续显示已有description，不为了美化卡片重写历史。

结构化展示先只承载必要事实，不引入一套泛化风险评分平台。长期固定说明可折叠；删除、写回来源、外部应用启动等此次直接影响应在首屏可见。未来任务级信任需要独立契约，本轮没有添加“始终允许”按钮。

## 5. 主流技能与插件设置的做法

skill可理解为“可按需调用的做事说明书”，包含步骤、参考资料、模板和可选脚本。插件是可安装的能力包，可能带skill，也可能增加MCP工具或执行代码。安装、启用、连接成功、操作授权应分别记录。

| 对象 | skill管理和装载 | 插件/外部工具管理 | 可借鉴点 |
| --- | --- | --- | --- |
| Harness固定源码 | 提供方目录，明确同名优先级；摘要先列出、skill工具按需加载；区分modelInvocable/userInvocable；目录变化失效 | Cordis插件组合；插件清单区分Host阶段、Client同步；安装/启用/兼容性与构建脚本批准有独立状态 | 功能来源、可调用方式和真正生效状态分开；加载记录可重放 |
| Reasonix固定源码 | 项目/自定义/全局/内置来源；模型先看摘要，run_skill或斜杠调用；设置显示来源、调用方式与启用开关 | 安装前plan，显示新增skill、钩子、MCP、进程等；copy模式摘要绑定内容；更新显示新增可执行内容 | 安装前展示具体新增能力；更新、启用和作用范围可见 |
| Codex/ChatGPT | skill封装重复工作指导与资源；插件安装后将能力加入新聊天 | 独立Plugins目录与Installed管理；外部服务可能另需认证；经Codex宿主运行时仍受宿主策略约束 | 插件安装与服务连接、服务操作授权分开 |
| Claude Code Desktop | 输入框斜杠/加号选择技能；按需加载 | 插件浏览、启用/停用/卸载；可有用户、项目、本地作用域 | 调用入口和管理入口各自明确 |
| Cursor | Customize → Skills显示发现的技能；项目/插件技能列在相应区域 | Marketplace或Customize管理；支持可移植Agent Plugins与Cursor专用格式 | 技能仍可查看来源；包格式兼容不等于所有扩展行为通用 |
| Gemini CLI | 多来源技能发现，提供技能开关与加载；激活时显示读取目录授权 | extensions列表、安装、更新与工作区开关；扩展可贡献策略，但allow/yolo配置会被忽略 | 扩展不能自己批准调用；作用域与生效时点应有明确说明 |

官方依据：[OpenAI技能和插件](https://learn.chatgpt.com/docs/skills-and-plugins)、[OpenAI插件管理及权限](https://learn.chatgpt.com/docs/plugins)、[Claude Desktop扩展](https://code.claude.com/docs/en/desktop)、[Claude技能语义](https://code.claude.com/docs/en/skills)、[Cursor技能管理](https://cursor.com/docs/skills)、[Cursor插件](https://cursor.com/help/customization/plugins)、[Gemini扩展格式与策略](https://geminicli.com/docs/extensions/reference/)。

各家在权限上有实质差异。Claude Code的`allowed-tools`可以在技能调用当轮提供批准，正文持续存在而该批准在下一条用户消息时清除；这不是通用标准下所有宿主的必然行为。Gemini的扩展策略拒绝自带allow/yolo。建议Umi第一版保留宿主批准权，导入格式兼容字段时明确哪些生效、哪些不支持，不默默承诺技能自带权限。[Claude说明](https://code.claude.com/docs/en/skills)、[Gemini说明](https://geminicli.com/docs/extensions/reference/)

Reasonix在调用skill时会把references/*.md折入正文，并列出scripts。对Umi更合适的是按需读取参考资料，避免每次使用一个技能就把所有参考资料塞进上下文。Harness的摘要目录及加载事件、Reasonix的目录变化才追加提示，都与Umi已有稳定前缀/变化事实方向相容；无需第二条Agent循环。

本地关键源码：[Harness技能注册](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/skill/skill/src/index.ts)、[Harness技能加载/目录](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/skill/tool-skill/src/index.ts)、[Harness设置插件清单](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx)、[Harness安装构建批准](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/boot/plugin-manager/src/build-approval.ts)、[Reasonix技能说明](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/docs/SKILLS.md)、[Reasonix技能源码](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/internal/ext/skill/skill.go)、[Reasonix设置](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/desktop/frontend-next/src/ui/Settings.tsx)、[Reasonix安装预览](E:/Codex/Workspace/output/umi-permissions-research-20261013/reasonix-full-source/DeepSeek-Reasonix-4041b48a8ead93876aac9122e4634fa1a412595a/desktop/frontend-next/src/ui/AddPlugin.tsx)。

## 6. Umi未来的skill：建议先做到哪些

当前Umi有固定工具注册和工具模块、Docker/WSL配置查询；没有通用SKILL.md发现/管理、skill加载记录、外部MCP插件注册或安装器。当前设置分类“执行环境”与真正插件应保留不同含义。[当前执行环境入口](../apps/desktop/plugins.ts)、[当前设置](../apps/desktop/renderer/src/features/settings/SettingsPage.tsx)

建议先做本地技能的闭环，首批用“HTML简报”“项目阅读”“文档整理”等2—3个真实任务验证收益。兼容Agent Skills核心目录 `SKILL.md + references/scripts/assets`，不自动实现其他客户端的动态命令插值、fork、hooks等扩展语义。标准推荐摘要、正文、资源逐步装载；`allowed-tools`仍是实验字段。[Agent Skills规范](https://agentskills.io/specification)

候选边界：

- 目录来源仅包括随包技能、用户明确添加的技能根、当前已授权工作副本中的项目技能。项目发现不顺带获取未授权来源目录；普通附件/HTML中的指令不会因存在文字而自动成为skill。
- 列表显示名称、用途、来源、启用状态、自动/仅手动调用方式和正文入口。同名优先级必须明确，并显示被覆盖的来源；插件技能使用命名空间。
- 模型先收到简短稳定目录，再通过一个窄的加载工具取正文。相对资源按该技能根解析，越界链接不能扩张读取范围；参考文件按需读。用户点名走同一加载入口与唯一循环。
- 用宿主加载事实记录技能ID、来源、内容hash、调用方式、当前输入/执行关联；不由模型自报“已读取”。重放使用当时已加载内容，不能用今天文件替换历史。
- 新目录摘要只在目录或启用事实变化时追加。关闭后阻止再次加载并通知当前能力状态，已载入正文仍保留在原历史；不得宣称关闭会抹掉模型已经看到的文字。
- 脚本由现有命令适配器执行，来源交付由原ChangeSet流程处理。第一版skill文件的allowed-tools、正文或所谓authority字段不提供宿主额外批准。
- 第一版开关在下一次请求准备边界生效，不突然替换已冻结的模型请求和批准。以后支持更即时撤销时，需要一起定义派发前检查与未知结果行为。

这些是拟议契约，没有新增实现。还需在实施前确定个人技能存储目录、项目技能覆盖优先级、默认自动调用方式及列表入口；不要求先迁移全部工作数据根。

## 7. Umi未来的插件：建议分两层推进

第一层是本地技能包：导入一个目录即可获得一组技能、模板和参考资料。先完成“预览内容 → 保存明确版本 → 启用/停用 → 下次请求使用 → 移除”的流程，可以验证命名空间、来源与升级语义，无需插件市场。

第二层再接外部工具，优先选一个真实需求的MCP服务。插件打包可参考可移植Agent Plugins核心：`plugin.json`、skills、`mcp.json`；权限、安装方式和客户端扩展仍由各客户端负责。Umi应声明实际支持的组件，导入含不支持hook/自定义UI/任意宿主扩展代码的包时明确显示这些组件不可用。[Agent Plugins规范入口](https://agent-plugins.org/)

至少需要以下状态和契约：

| 项目 | 应让用户看到/宿主做到的内容 |
| --- | --- |
| 安装预览 | 来源、版本、即将新增的技能和工具；若需启动进程或连接URL，展示实际命令/地址；需要凭据时展示字段名，不展示秘密值 |
| 安装与启动 | 单纯读取技能文件与启动第三方进程是不同操作；stdio服务即使没有工具调用也可能运行代码，不能把风险只放在首次工具调用 |
| 可用状态 | 已导入、已启用、未连接、认证需要更新、已连接、工具可用、错误；已有故障不伪装成空列表 |
| 调用入口 | 工具进入现有registry/executor、object根规格、批准/派发/结果事实与上下文投影；外部工具名称带命名空间，不暴露任意IPC给renderer |
| 外部权限 | MCP的readOnly/destructive等提示不能作为权威授权；远端实际处理仍依赖服务和账户权限。本地stdio服务目前也不会自动获得OS隔离 |
| 变化与生效 | 请求冻结后不改其中工具规格；新请求准备时使用新版本。禁用拒绝新派发；已派发/未知调用按原证据核验，不重放 |
| 更新与删除 | 展示新增可执行能力和范围变化；更新批准绑定所预览版本；不默认执行安装脚本，不默认自动更新；卸载本地包与撤销服务账户连接分别处理 |

Harness的Cordis组合、Client热同步、兼容性豁免与完整安装平台适合它的体量。Reasonix的可执行扩展/钩子也有较大的宿主信任面。对Umi，近期只需技能包和一个窄MCP适配器；直接把任意Node模块放入主进程的插件方式会绕开当前工具执行边界，不建议作为第一版。

网络/认证工具、宿主命令授权与插件启动策略需要分别定义。插件设置页面本身解决不了命令的网络范围，也不提供OS沙箱；用户想减少批准次数时，应继续按独立任务信任契约讨论。

## 8. 推荐的后续顺序与小范围验收

本轮桌面验收整理已完成。研究后的推荐顺序是：

1. **批准卡片说明当前意图。** 一次只改普通命令用途+卡片信息层次，复用现有真实详情。验收应覆盖资源读/副本改、命令、打开、交付、导出；检查两条命令能看懂不同用途，实际对象与批准一致，长脚本完整可查看。继续保留允许/拒绝和独立问题卡。
2. **本地skill加载与管理。** 单一加载工具、来源与开关、按需资源、真实加载历史。验收手动/模型触发、同名来源、禁用、正文更新/重启重放、不支持字段说明；使用2—3个实际任务评估效果和上下文成本。
3. **本地技能包导入，随后一个具体MCP需求。** 先有明确安装预览和生效状态，再决定账户连接、进程生命周期和外部调用恢复契约。不提前铺市场、任意宿主扩展或大规模热插拔框架。

第一项改善每天的可理解性；第二项增加可复用做事方式；第三项扩大能力来源。上面的顺序是本轮建议，需用户另行决定是否实施。任务信任、URL读取及其他待商榷项继续保留，不因本报告自动获得实施授权。

## 9. 本轮验证与证据

- 核心TypeScript编译通过，桌面资源构建通过。
- 最终真实Electron桌面验收46项通过，独立数据目录为 `C:\Users\sevan\AppData\Local\Temp\umi-desktop-verification-QmmtyA`，包含事件重放、批准交付、真实Node/Windows Job命令、隐藏窗口继续、worker崩溃恢复、停止、附件、预算阻塞等。
- 深色侧栏solid降级下测得文字对比度7.57，超过验收阈值4.5；这不宣称已测量所有Windows壁纸下的原生Mica对比度。
- 前两次验收各完成24项后分别暴露过时的深色文字断言、这次新增内嵌表达式的转义错误；修正后最终全套通过。失败报告保留，未把失败运行算为通过。
- 本轮未重跑439项核心全量；上一轮439项是历史证据。本轮未改核心产品行为，仅执行相关整套桌面验收、构建和diff检查。
- 用户已反馈跨轮打开、受阻正文实际体验正常。本轮自动桌面验收没有重新证明所有默认应用或实际模型组合。
- 源码dist已重建，未发布或同步便携包；未用付费API、生产数据库、安装依赖、修改Windows设置或执行第三方插件。
- 所有多阶段旧修改、未跟踪文件和学习注释保留，无Git提交/reset/clean。修改前副本、失败/成功报告、截图、修改差异和来源清单保存在 E:\Codex\Workspace\output\umi-desktop-audit-20261014。

资料来自2026-10-14访问的官方页面和上述固定源码。网页内容随产品更新而变化，本轮不把第三方产品能力或建议当作Umi已实现事实。
