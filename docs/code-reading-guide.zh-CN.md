# Umi 代码学习与开发指南

## 2026-10-18：文件预览生命周期

从FilePreview/FrozenFilePreview读取和preview-page同版本拼接进入FileContent；HTML完整后才清理并挂载HtmlPreview，其他格式保持滚动补读。独立Electron验收在verification-file-preview.ts，通过CDP文字框和截图验证真实排版。复现、实现取舍与复跑步骤见[本轮学习说明](html-preview-repair-20261018.zh-CN.md)。

当前补充阅读：[唯一搜索与永久删除审查](search-clean-and-deletion-20261018.zh-CN.md)。从ArchiveSettings → 固定desktop命令 → UmiApplication → ConversationDeletion阅读；重点区分事务事实与目录副作用、共享资料引用、失败补清理和用户源目录。模型工具只有search_web，没有删会话能力；迁移7与ready统一。旧搜索名称及下文旧状态按历史保留。


当前阅读：[2026-10-18 直连搜索与真实验收](web-search-live-20261018.zh-CN.md)。沿 application → registerWebSearch → searchResponseSchema/searchView → WebSearchRepository → memory.accessible/read_artifact 学习“完整存储与有界模型输入分开”；再连到 Fetch/read_webpage。真实预算3/3/6、实际2/2/3，474项全量与便携74项通过；旧搜索包装接口属于历史。


## 2026-10-18：独立网页抓取与完整快照按需读取

已接入 fetch_webpage / read_webpage，保留当前搜索。完整保存上限内提供商返回的 Markdown 为独立 artifact；首次只给 8KiB 摘录和有界目录，本地全文字面查找/UTF-8 续读可追回中部与末尾，工具 data 不藏全文。响应超过4MiB或正文超过2MiB明确失败，不伪装完整；网站提取完整性未知。成功快照按会话归属，窗口维护与重启后仍可查；同轮默认复用、明确刷新新建快照。无新数据库结构、调度器或插件平台，源码/学习注释与上轮未提交改动保留。全量458/458、最终相关71/71及本地便携桌面74/74通过，185运行文件hash与最终源码指纹一致，本地便携已同步。实现、验收和能力边界见[本轮说明](web-fetch-20261018.zh-CN.md)。本轮不提交 Git/远端发布，不调用付费API或操作生产会话。

## 2026-10-17 新增：图标与Windows分发链路

assets/brand/umi-symbol.png保留透明角色；scripts/build-icons.cjs用固定几何白底生成PNG和七尺寸ICO。scripts/build-info.mjs把品牌源图、构建脚本和安装配置纳入指纹。package:windows依次运行既有源码/便携构建和scripts/build-windows.mjs；后者通过electron-builder.yml配置NSIS，并在构建器清理临时载荷前解包核验版本、182个运行文件与exe哈希。发行文件在release/installers中，二进制通过GitHub Releases分发而不进入源码Git。

本轮结果和边界见[版本说明](releases/0.2.0-alpha.1.zh-CN.md)。完整桌面检查中仍会出现已知HTML首帧空白，不能把构建完成或载荷一致写成所有交互问题已解决。


## 2026-10-16 最新：输入区蓝色呼吸与请求卡等宽

运行输入框改为3.2秒蓝色呼吸边缘，只改变透明度；停止/结束后移除，减少动态偏好下为静态蓝边。旧canvas电流组件已移除。权限卡和选项卡不再单独限制620px，宽度、左右留白和18px外圆角共用输入框规则；正文12px、标题13px/500字重，沿用主题UI字体，无额外卡片阴影。宽聊天区820px、右预览展开后的窄区约446px，均与普通输入框实测等宽对齐。

本轮 TypeScript、桌面构建与29项相关UI/分页/问答/交付回归通过；宽窄批准卡/问答卡、真实提交、蓝色呼吸、减少动态及停止状态的桌面检查均通过。完整桌面检查：源码版72/72通过；实际便携版Umi.exe 72/72通过。182个运行文件逐项hash匹配，源码、dist、便携版指纹一致。没有重跑历史439项全量或13项服务契约。

便携版已同步；通过菜单完整退出后重启。说明和学习入口见[输入区调整](composer-breathing-20261016.zh-CN.md)。证据与旧便携备份：E:/Codex/Workspace/output/umi-composer-breathing-20261016。修改前311条记录、3个旧删除保持；本轮仅删除已替代的ElectricBorder.tsx。唯一Agent循环、宿主桥、权限语义及此前布局修正保留，A-01/A-02/A-03仍未处理。旧“电流特效、请求卡最大620px/14px外圆角”属于历史设计。


## 2026-10-15 最新：布局、预览与拖动性能修正

右侧收起按钮位于工作卡片右上角并给标签留位，左按钮保留顶部。聊天与预览顶栏同为48px；完整路径和查看/刷新/打开共用单行。查看和打开方式共用9px菜单，原文代码同样着色，补JSONL/NDJSON。普通HTML保留自然字号，仅固定像素宽度布局适应缩放；静态隔离和既有打开桥不变。右侧空时留白。

窄聊天区保留420px，模型控件可收缩，textarea原生随文字/宽度自适应（最高140px）。拖动通过RAF更新CSS，松手才提交React与存储，关闭拖动宽度过渡并覆盖释放/取消/失焦。修复高权重全局hover与强制圆角冲突；设置/失败操作无灰色浮起，文件入口主题蓝色，移除思考摘要尾部挤成竖排的中断徽标，状态事实仍保留。

本轮 TypeScript 与桌面构建通过，29 项相关 UI/分页/交付回归、13 项桌面服务契约通过；源码真实 Electron 72/72、实际便携版 Umi.exe 72/72 检查通过。183 个运行文件 hash 与构建清单一致，源码、dist、便携版指纹相符。未重跑历史 439 项全量测试。构建时间 2026-10-15T12:30:28.684Z，打包时间 2026-10-15T12:32:13.611Z。

真实拖动观察：36 次指针移动期间 localStorage 写入 0 次、iframe srcdoc 重载 0 次、宽度过渡 0s；松手保存 1 次。聊天区 420px、输入框 388px，按钮无越界，短草稿重排完整。

详见[本轮说明](layout-polish-20261015.zh-CN.md)。证据、307条修改前记录（3条旧删除）与旧便携备份：E:\Codex\Workspace\output\umi-layout-polish-20261015。打包使用Electron npm包自带校验表验证本地缓存，解除重复联网获取清单的阻塞。所有旧改动/学习注释保留；A-01/A-02/A-03仍未修复。此前“左右控制同一顶栏”“路径独立一行”“所有HTML至少1024宽”等描述不再是当前契约。


## 2026-10-15 前轮：双侧栏对齐与纯文件预览

左右收起按钮共用同一顶栏，修复此前独立定位造成的错位；头像与主体位置保留。右侧没有打开文件时完全留白，移除成果首页、计数、说明和首页按钮。文件标签采用随包内置的彩色 vscode-icons 原版图标；上方只保留路径、原文/预览、重新加载、打开方式。默认预览：代码语法着色、Markdown 排版、HTML 静态隔离页、图片按比例显示。内层卡片、版本/hash/大小信息和手动分页条移除，长文件随滚动续读；长行折行、细纵向滚动条。

文件身份、同版本连续分页、目标 hash 刷新和原有打开桥保留。冻结页展示 after（删除项展示 before）；原文/预览是同一内容的呈现方式。HTML 不执行脚本或访问宿主桥/外部资源；PDF/Office 等二进制解析能力没有扩展。系统默认打开仅针对已有交付回执，工作副本仍可在文件夹中显示，没有新增 Shell 打开入口。

本轮 TypeScript 编译与桌面构建通过，29 项相关 UI/分页/交付回归通过；源码真实 Electron 63/63、实际便携版 Umi.exe 63/63 检查通过。181 个运行文件的 hash 与构建清单匹配，源码指纹与源码、dist、便携版一致。本轮没有重跑上一轮 439 项全量测试。构建时间 2026-10-15T11:05:50.464Z，便携版打包时间 2026-10-15T11:07:05.264Z。

说明与学习入口见[文件预览调整](file-preview-20261015.zh-CN.md)。证据、修改前272记录和上个便携版备份在 E:\Codex\Workspace\output\umi-file-preview-20261015。此前十二项界面说明和439/56项记录为历史证据；其中“右按钮保持旧坐标、右侧成果首页、三态差异/版本折叠”已被本次用户要求覆盖。审计 A-01/A-02/A-03 仍待单独选择处理。


前阶段学习：[2026-10-12 自然消息与缓存](natural-turn-and-cache-20261012.zh-CN.md)。沿 application.send/start → engine.run 应用新原话 → recovery/executor.inspect 观察原执行 → tasks.observation/transition 核验原提交与任务关系 → manager.project 的 carry → request-admission/Broker → ProcessArchiveBudget/分页工具 阅读。本阶段保留唯一循环与工作副本，详细测试见 tests/natural-turn.test.ts。下文旧阶段路线按日期保留。


当前补充阅读：[2026-10-12 工具反馈与停止契约](tool-feedback-and-stop-20261012.zh-CN.md)。结合实际修改，按 bounded.freshToolIds → manager 保护最新组 → tools/result 去重 → store.modelReceivedToolResult → read-evidence → application.requestStop → worker command-queue → executor yield / runner probe 学习；保留下面既有学习注释与历史路线。


> 配套：[当前架构与开发报告](current-project-report.zh-CN.md)。目标：沿真实调用链解释行为，知道改动应该落在哪一层。





## 2026-10-15 前一轮：界面十二项打磨与便携版同步

按用户新要求移除左上/欢迎区产品图形与文字品牌，左侧收起按钮独立置顶，新对话/工作区上移；头像底部位置和右侧控制坐标保持。欢迎区hello采用离线可变字体的压力效果；运行输入框为契合原圆角和#2e7feb的低强度电流，隐藏/离屏停止，减少动态偏好下静止。

批准卡与问答卡收窄至最大620px、14px圆角，字体/间距收紧；长命令保留可展开完整描述。问答逐问显示、返回/下一问/自定义回答/最后统一提交，卡片正文无内部滚动。变化列表去掉悬停阴影和侧边操作标签，真实失败命令标红；右侧去掉重复新建工作区，标签紧凑，差异红删绿增、冻结版本折叠，连续分页/成功交付后打开保留。消息操作区提供复制、赞踩、重新组织和更多；赞踩仅本机，重新组织先填草稿，不自动重跑工具。设置页统一无阴影并收紧卡片。

本轮最终439核心全量、29项相关UI回归、源码56项和实际release/Umi-win32-x64/Umi.exe的56项真实Electron检查均通过。首次并发438通过/1项等待超时、独立31项通过及后续全量439通过的日志均保留；没有修改该核心超时测试。原便携版确认为10月5日旧产物，已保存旧exe/dist后重新打包，148运行文件逐项hash及源码指纹一致。新增dist/umi-build.json与release/umi-release.json，打包前拒绝过期源码/产物，打包后核验；以后更新便携版运行npm run package:desktop，npm run dev只更新源码版。

实现/学习入口、12项对照、参考来源、验收和限制见[本轮说明](ui-refinement-20261015.zh-CN.md)。证据/本轮前262记录（含3个旧删除项）与旧便携备份：E:\Codex\Workspace\output\umi-ui-refinement-20261015。未修改唯一Agent循环、工具/权限策略、生产会话、Windows设置或调用付费API，全部旧改动与学习注释保留。此前审计A-01/A-02/A-03仍未修复，后续按小范围另选。

本轮已按用户第11项同步指定便携版。使用前菜单完整退出旧Umi再启动新exe，关窗只隐藏。以下同日早先与历史记录不代表当前界面或发布状态。

## 2026-10-15 较早：24/96图标与普通Umi文字（历史，页内品牌现已移除）

用户自行将侧栏/欢迎图标调为24/96 CSS px，本轮原样保留。欢迎区移除“一万年太久太久 太久太久 只争朝夕”，仅保留用户当前标题“今天打算做些什么呢？”，改用Segoe UI Variable Text / Microsoft YaHei UI，24px、400字重；无工作区时原有必要连接/选择提示仍保留。左上角图标旁新增普通文本Umi，Segoe UI、18px、400字重、8px间距，随主题变色，不恢复图片字标。

统一图标入口：页面侧栏/欢迎区共用现有512透明PNG；Windows窗口改用同来源七尺寸ICO，构建复制ICO并作为网页favicon；Windows打包配置继续读取同一public/umi.ico。ICO重新由当前PNG导出，内容与既有同源ICO一致；未更改图形/透明白色角色。未重新发布或同步便携包，也未改Windows图标缓存/快捷方式。

本轮常规编译、桌面构建、50项隔离真实Electron检查和diff检查通过；核对24/96尺寸、单句/字重/字体、普通品牌文本无按钮遮挡、浅深主题及ICO七尺寸与PNG逐项匹配，并查看两张截图。未重跑此前439项核心全量。未改Agent/工具/权限/生产数据或调用付费API，全部旧修改和学习注释保留。

证据与本轮前备份：E:\Codex\Workspace\output\umi-brand-finish-20261015。源码dist已更新，需从菜单完整退出再启动源码版；关窗只隐藏。此前全面审计及A-01/A-02/A-03仍按原记录保留，未在本轮修复。

## 2026-10-15 当前：单图标与全面源码审计

按用户新要求，侧栏与欢迎区改用同一512×512透明单图标，显示盒48/128 CSS px，移除Umi字形与深色文字遮罩；原横版资源保留为历史材料但不再构建复制/加载。已查看浅深主题截图。

本轮常规编译/桌面构建、439项核心全量、48项隔离真实Electron检查及diff检查通过。额外未使用声明检查25条（产品1、测试24），与常规编译结果分开记录。隔离探针确认三个未修复问题：writer.starting遗留会持续阻止启动；TASK_LIMIT仍只有状态原因而无独立正文；数据库实际迁移6但CLI/worker/ready仍报告5。重复无进展TASK_STALLED正文和跨轮打开已实现、用户实测正常，不重新列为未实现。

完整架构/调用链、问题证据与修复契约、权限/宿主网络边界、持久化/上下文/UI/构建审查及六步学习路线见[全面审计与学习报告](full-project-audit-20261015.zh-CN.md)。证据与改动前备份：E:\Codex\Workspace\output\umi-full-audit-20261015。候选修复、卡片具体意图、统计、skill/插件、工作根/URL/备份/DTO/CSS等未在本轮实施，下一轮按小范围另选。

保留全部旧改动、未跟踪源码与学习注释，无reset/clean/提交、付费API、生产数据库、Windows设置或发布/便携同步。源码dist已重建，需菜单完整退出再启动；关闭窗口只隐藏。以下同日及早期节为历史记录，当前以本节及审计报告为准。

## 2026-10-13 收尾交接：用户确认修复，下一轮待办重新商议

用户已反馈 HTTP 400 修复后测试通过并确认完成。本轮只整理交接/源码快照，不新增产品逻辑，不重跑上一轮424项测试。最新[新窗口交接](session-handoff-20261013.zh-CN.md)归纳已实现功能、工作资源实际分配、验收限制和第5节待商榷清单；[开场提示](next-session-prompt.zh-CN.md)已更新。备份 E:\Codex\Workspace\output\umi-new-chat-handoff-20261013，source/ 与 manifest.json 保存全部 Git 非忽略源码/文档、hash、删除项和状态/diff。

自然消息优先、分页日志、批量编辑与阶段A已经实现；权限自定义输入暂缓，独立问答支持选项/自定义回答；工作副本路线保持。Windows桥缓存、任务测量/进展策略、宿主任务信任、URL读取、自选工作根和B/C降耦合等为未实施候选，由用户按最新情况调整，不构成全部自动实施授权。默认应用启动、生产延迟/真实复杂任务仍未专项验收；未发布/同步便携包。历史节中的“未实现”按该阶段日期理解。

## 2026-10-13：问候 HTTP 400 的请求规格修复

发现 edit_file 批量参数顶层 union 被 Registry 默认导出为 anyOf，无 object 根；整份工具表随问候发送，能导致接口在执行工具前拒绝请求。现在复用原字段派生 object 输入，执行仍严格校验单项/批量；Registry 导出 input JSON Schema，适配器在本地检查工具根和名称。避免当前 Zod pipe(union) 丢弃入口未知字段错误，使用独立 transform 解析，保持编辑证据与原子批量约束。

本轮实际424项全量、请求/适配器9项及核心/桌面构建通过。真实循环+适配器的本地模拟 transport 验证完整39工具表、问候和读后批量编辑；本阶段未自动调用真实API或读取生产数据库；随后用户已反馈测试通过，确认该修复完成，不扩展为其他任务的验收。备份/证据 E:\Codex\Workspace\output\umi-deepseek-400-20261013。见[原因、关键代码与验收](deepseek-request-fix-20261013.zh-CN.md)。保留全部旧修改与学习注释，未发布/同步便携包；完整退出后重启源码 dist。

## 2026-10-13 当前：阶段 A 问答、冻结审阅和打开（已实现）

按用户更正，权限等待暂不加自定义输入，保留允许/拒绝、无停止控件及独立扩展插槽。新增 ask_user_question：1–3问、每问2–6选项与自定义回答；持久问题/用户回答、等待不请求模型、无60秒超时但响应停止/新输入，迟到回答失效，回答不代表批准。桌面底部独立问答卡与JSON CLI回答入口沿唯一循环。

冻结文件 before/after/diff 完整连续分页、严格 UTF-8 范围；工作预览仅目标 hash 变化重置，附件/冻结身份保留。桌面打开已交付文档/HTML工具与按钮核对当前许可、回执、来源/hash/身份，通过固定主进程 shell.openPath 打开；Agent仍具体批准，document_open 已接入原任务签收，仅证明系统接收指定当前交付版本的打开请求，来源版本变化使旧证据失效；不证明页面呈现，未知不重放。可选配置改称执行环境。

本轮最终421项全量、收尾28项和阶段补充8项、核心/桌面构建通过；隔离真实renderer验证自定义填写/提交、权限无输入/停止、冻结分页与无关修订不重置，视觉遮挡已修复。打开前核验失败/系统明确拒绝是失败，不阻塞后续任务；回执未知不重放。长HTML真实工具链与模拟系统打开端口通过，尚未实际启动默认应用验收；没有真实API、生产数据库、发布/便携同步、Windows/依赖修改，所有旧修改与学习注释保留。备份/证据 E:\Codex\Workspace\output\umi-stage-a-20261013（238个审查前文件）。见[契约、代码与验收限制](stage-a-user-questions-and-review-20261013.zh-CN.md)。完整退出源码版后重启新dist。

## 2026-10-13 本次：项目审查与小范围整改（已实现）

暂停后续原生打开/桥缓存阶段，对当前入口、Git 改动、循环、适配器和真实 renderer 审查。修复同文件修改后复读仍被 TASK_STALLED 误判、交付详情只读重试、未实现 auto 的误导展示与默认工具名称；附件准备端口注入组合层，移除 agent 反向依赖；删除确认无引用的 JellyRadio/样式/time 三文件及对应生成文件，清理产品未使用声明。全部旧修改与学习注释保存于审查前备份。

本轮实际413项全量、核心/桌面构建通过；产品 unused-locals 诊断0，测试仍24。隔离浏览器验证批准范围失败后同ID重试与执行选项说明；不代表生产性能或真实模型完成率。当前主要缺口：审批替换输入器、冻结大文件全文/差异不足、全环境修订过度刷新预览、任务收尾打开缺失；store/资源接口、前端 DTO/长 JSX 与三层 CSS 需增量降耦合。工作副本与唯一循环保留，任务内宿主信任尚未实现。

见[完整审查、关键代码与整改顺序](project-audit-20261013.zh-CN.md)。证据/239文件审查前备份：E:\Codex\Workspace\output\umi-project-audit-20261013。没有真实API/生产数据库/发布/便携同步/Windows或依赖修改，没有Git提交或reset/clean。重建源码dist后需完整退出再启动。

## 2026-10-13 当前：文件工具与必要事实优化（已实现）

按用户授权完成计划一、二项：search_text 返回所有字面出现、行/字节定位、文件范围和版本游标；read_file 支持真实行窗口与 UTF-8 连续分页；edit_file 新增同原版本的原子批量修改，失败整批不写，旧参数/快照/恢复保持。读取版本、模型实际可见范围、工作副本和源交付批准仍保留。

必要事实按域变化才追加，冻结编码前缀及完整当前工具组保持；停止/撤销/未决事实和新原话仍及时更新，不删原历史。精简重复工具说明，要求针对实际目标验证和收尾，保留高难任务探索及 needs_work。请求分项字节/模型/思考档和耗时诊断不进入提示；审批决定等待与轮询时间分开。

本次最终409项全量、核心/桌面构建通过；92428B HTML 两页→一次六项修改→一次批准交付，6次固定模型请求。真实 Node 小项目测试、日常文件、失败/崩溃恢复与自然消息/停止再次验收。20轮实际编码体 44241→45638B，派生快照1条，旧编码前缀完整；是本地固定样本，不是计费/生产性能/真实模型完成率。备份和证据 E:\Codex\Workspace\output\umi-file-tools-context-20261013；[契约、关键代码与限制](file-workflow-and-context-20261013.zh-CN.md)。

只落实一、二项；原生打开和桥编译缓存仍未实现。未调用真实API/生产数据库，未重新发布、便携同步、改Windows或依赖。仓库原多阶段未提交修改与学习注释保留，没有将它们混入Git提交。完整退出后启动源码版本使用新dist。

## 2026-10-13 研究与下一阶段计划（实施前记录）

本轮核对实际源码及 Git，保留全部多阶段修改，只有研究文档更新，没有产品逻辑变化。用固定模型/临时副本复现：同文件 6 次命中 search_text 只返 1 次；单项编辑成功后旧读取回执不能继续改第二处；20 轮消息正文合计 395B，实际 API 编码体从 45785B 长到 99384B，但旧消息前缀完整。Windows 桥每次 Add-Type，执行桥就绪约 0.7–1.7 秒；Job 正常结束也清理分离子进程，不适合作为打开浏览器的可靠通路。以上不能精确归因原 21 分钟或日总 token。

推荐三小提交：①搜索/行读取/同版本原子多处编辑；②必要事实按变化追加、单任务真实统计与按用户要求收尾；③独立已交付 HTML 打开动作，具体交付批准可一并描述。编译桥按固定源码 hash 缓存另做。仍保留工作副本、版本/模型可见范围、旧未知操作只核验；不引入新调度器、全目录指纹、沙箱/安装前提或硬限步骤。具体契约与验收见[根因与计划](workflow-root-causes-and-plan-20261013.zh-CN.md)。

Reasonix studio 固定 4041b48…，Git 克隆失败后以官方 API 取关键源码，位于 E:\Codex\Workspace\reference\DeepSeek-Reasonix（34 文件快照，非完整 checkout）；Harness 本地 639ed015… 与官方 master d743267… 分别核对，未修改本地 Harness 仓库。只借鉴窄机制，不照搬模糊编辑、派生尾部重排或大平台。研究证据 E:\Codex\Workspace\output\umi-workflow-research-20261013。未用真实模型 API、生产数据库、发布或 Windows 配置；上阶段的 388 项验收不是今天重跑。

## 2026-10-12 当前：本地反馈和界面对象修复（已实现）

按用户授权修复本地阻塞：流式片段短批次原子落盘，保留原片段/索引/块边界；循环定期让出宿主，高频 delta 不再深复制全会话；历史 input.applied 局部索引避免每条消息反复扫描所有流式事件。有界事件积压即时追赶，工具正文展开后读取，普通命令串行/停止优先保持。Electron 错误改为普通 DTO 保留 code，内部 commandId 提示不进入用户横幅。

审批等待不显示停止控件，正文单层滚动、决定按钮固定。预览区区分工作副本/冻结变更/附件，首屏 8KiB、连续分页绑定 hash，副本版本变化刷新，迟到请求不串对象；同名附件、冻结交付与拒绝后源文未变已验收。工作副本、源文件批准、未知执行只核验及完整原始历史契约保留。

本次完整 388 项、收尾相关 29 项、核心/桌面构建通过。相同 2048 片段 + 192KiB 历史消费从 4056ms 降到 349ms；20 次隔离实际 Electron UI 的已收文字显示 p95 98ms、点击停止回执 p95 72ms，另做对象专项。固定模型、测试主处理器和独立数据库，不是生产 p95/真实任务费用证据。备份与证据：E:\Codex\Workspace\output\umi-local-feedback-20261012；[契约、关键代码和限制](local-feedback-and-ui-20261012.zh-CN.md)。

未重新发布/同步便携包，未用真实 API、生产数据库或修改 Windows。完整退出后重启源码版本加载新 dist。任务反复读取、过多验证、多处编辑、派生快照控制及文件打开仍是后续阶段，本节不把之前的方向讨论当作实现授权。


## 2026-10-11 当前：删减命令扫描与会话加载开销

命令不再递归读取/哈希整个 cwd，也不记录新 process_fingerprints；改为绑定目录根、真实程序、参数和原批准。普通内容变化不重新批准，根被替换仍阻止释放；具体文件编辑、来源交付与未知恢复保留原核验。inspect_execution/preparation 是可选观察，常规测试/构建不用先走准备流程。宿主本来没有网络沙箱，已用回环 HTTP 验证批准后可联网；外网/代理/服务可用性未测。command_exit 只证明指定执行退出 0，当前文件状态须由 file_hash 等独立证明，不能宣称整个项目没变。

桌面快照只查询用户原话并复用一次状态投影；正文首屏渲染近期 8 条用户消息，可加载更早消息、历史刻度展开跳转，新消息保留当前窗口与阅读位置。原始历史、完整工具组及模型上下文不裁剪。临时 20 轮样本：热快照中位约 29→1.3ms，首次正文服务端渲染约 517→236ms，冷快照约 75→49ms；不代表生产 Electron 全链路延迟已经修复，IPC/utility 启动及实际长会话仍待实测。

本轮相关 7 文件最终共 107 项通过（新增 2 项；最终命令/会话 2 文件 36 项另复测），核心/桌面构建通过；临时浏览器验证历史展开、滚动锚点、跳转与追加消息。没有真实 API、生产数据库、产品启动、依赖安装、发布或 Windows 修改。备份/日志：E:\Codex\Workspace\output\umi-streamline-20261011。后续优先常规任务能力与完成率/延迟样本，再讨论工作区直接编辑和显式宿主信任范围；不把 OS 沙箱、自动安装器或留存框架当能力前置。学习入口：[删减与加载调用链](streamline-and-session-loading-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：成果/准备 UI 与本地执行研究

本轮补右侧首页成果分页、核验预览、系统选址后生成导出请求、原目标只读核验/文件位置，以及固定字段的准备检查摘要。请求导出仍需发送给唯一 Agent 并确认原批准，选址本身不保存文件；准备报告明确为历史观察，非就绪或隔离证明。正文增量不刷新成果列表，会话切换隔离迟到响应。新增 UI 沿用现有紧凑圆角风格，没有新增依赖。

本轮相关 5 个测试文件 85/85 通过（新增 5 项），类型检查、核心和桌面构建通过；临时浏览器夹具验证交互及视觉，不代表 Electron/生产端到端验收。没有真实 API、生产数据库、产品启动、发布、依赖安装或 Windows 修改。备份/差异/日志在 E:\Codex\Workspace\output\umi-local-workflow-ui-20261011。旧数量只代表各自阶段。

核对本地 Harness 与固定版本 Reasonix 后，OS 沙箱不列入核心当前路线；下一阶段先解开全 cwd 内容指纹与大依赖执行的耦合，再做具体项目准备安装计划和按引用/使用权管理的缓存留存。大依赖限制、自动安装器、总配额/清理仍未实现，不能把研究方案当作已完成能力。学习入口：[本地执行、安装、留存与成果 UI](local-workflow-and-ui-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：执行准备观察与具体命令绑定

增加 inspect_execution 只读观察选定目录的工具入口、清单、指定副本输入和依赖目录，直接返回模型可引用的 inspectionExecutionId；不启动程序、不安装或联网。run_command/run_shell 可用 preparation 绑定真实成功检查回执，批准/派发/挂起释放前重查；漂移或未观察输入拒绝原命令。批准说明准备目的、完整命令、联网/安装脚本声明及会话任务缓存。任务缓存可复用，准备阶段不预先创建；同 run 拒绝不能换检查回执重复申请。新增 artifacts cwd，命令生成文件后沿既有 capture_output/Export 交付。

本阶段新增 31 项专项；最终相关 11 个测试文件 191/191 通过，类型检查、核心与桌面构建通过。固定模型、临时目录/测试 SQLite，部分场景真实运行本地 Node/Windows 进程；没有联网安装、真实模型 API、生产数据库、产品启动、发布或 Windows 修改。学习注释和前端/CSS 保留；备份、差异与日志在 E:\Codex\Workspace\output\umi-preparation-20261011。下面旧阶段数量按历史归属保留。

观察不是可运行证明：外部版本未执行则未知，依赖目录存在不代表完整；Node 锁只做根记录核对，Python/其他包管理器/workspaces 仍需审阅。准备网络/安装脚本字段及缓存变量不构成 OS 强制范围；普通命令继续具体宿主批准。当前完整命令 cwd 指纹仍有 20000 项/128 MiB/单文件 32 MiB 等限制，大依赖树可能阻塞后续构建，本轮明确验出并保留，未用浅观察偷换内容保护。没有自动安装器、专用准备 UI 或缓存总配额。

学习入口：[执行准备调用链与限制](execution-preparation-20261011.zh-CN.md)。后续优先研究依赖树规模与执行复查的实际断点，再贯通长命令输出、取消/恢复和任务成果验收；涉及弱化检查或扩大自动宿主执行先协商。目标保持普通用户和开发者的本地任务助手，Docker/WSL2 为可选后端，MXC 退役，不为生态扩大核心。

## 2026-10-11 历史阶段：独立成果、具体导出与只读续作核验

文件路线第三阶段的后端契约已实施：create_output 独立创建 UTF-8 成果，capture_output 将 task/artifacts 下的普通文件（含二进制）复制冻结；list_outputs 只读元数据分页，read_output 核验完整 hash 后有界预览。export_outputs 绑定具体成果、绝对目标和父目录身份，批准后逐项独占创建、不覆盖，保存不可变 intent/receipt。生成成功与实际交付分开；部分失败/取消保留逐项结果，未知与重启只观察、不补写。inspect_export 提供新一轮任务的当前只读证据，export_receipt 加入任务验收。

本阶段新增 32 项专项场景；最终相关 7 个测试文件 117/117 通过，类型检查、核心和桌面构建通过。固定模型、临时目录与测试 SQLite，无真实 API、生产会话库、产品启动、发布或 Windows 修改。学习注释与前端/CSS 保留；备份、差异及日志在 E:\Codex\Workspace\output\umi-outputs-20261011。下面数量按旧阶段保留，不是本次重新验收。

成果单文件 4 MiB、批次 16 MiB/20 项，文本输入 256000 字符，预览单次 64000 字节。mime 为声明；二进制默认元数据，显式 base64 可读取范围，无 Office/PDF 渲染。导出父目录须已存在，不提供覆盖、目录管理或删除。wx 不保证正文事务原子，路径复查不是 OS 沙箱；成果总留存配额/清理未实现。桌面固定 list/preview/inspect/open_export 接口已加入，open_export 核验后仅在 Explorer 定位；没有新增 renderer 成果卡片或按钮。

学习入口：[独立成果与导出](outputs-export-20261011.zh-CN.md)。下一阶段补依赖准备与执行分离，再贯通命令输出和成果验收；可选 Docker/WSL2 后端不构成当前产品实现。MXC 保持退役，不修改 Windows、不新建庞大插件框架。见 [执行计划](execution-boundary-plan-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：文本创建与读取绑定替换

文件路线第二阶段已实施：write_file 默认 mode=create，仅新建且独占名称、不覆盖；mode=replace 必须绑定当前会话成功的完整 read_file 回执、哈希及对象身份。edit_file 继续处理实际已读范围内的唯一片段，两种修改共用只读证据校验。派发后再次检查；无变化不落盘，崩溃恢复只观察冻结目标，不重复写入。旧参数未指定 mode 的调用现在只能新建，这是有意的契约收紧；旧已派发执行仍可按原冻结目标核验。

本轮新增 24 项专项场景；最终相关 16 个测试文件 207/207 通过，类型检查、核心和桌面构建通过。固定模型、临时目录与测试 SQLite，无真实 API、生产会话库、产品启动、发布或 Windows 修改。前端与学习注释保留；备份、差异及日志在 E:\Codex\Workspace\output\umi-text-write-20261011。下面旧阶段数量保留历史归属。

完整读取单次最多 64000 字节；超过该预算不能整文件替换，应分段 read_file + edit_file。create 的独占名称不意味着整个正文事务原子：中断可留下部分文件，恢复未知时不清除或重放。应用层路径与替换复查仍不是 OS 沙箱或原子 CAS。修改副本和交付来源仍为不同权限。

学习入口：[文本创建与替换](text-write-20261011.zh-CN.md)。下一阶段先补独立 Artifact/Export 成果链，再围绕本地宿主执行的批准、依赖准备、输出核验和效率补缺。Docker/WSL2 是开发者可选后端方向，尚无产品实现；不把 AppContainer/LPAC 探针作为主线前提，也不新增庞大插件框架。具体边界与验收见 [执行计划](execution-boundary-plan-20261011.zh-CN.md)。

## 2026-10-11 历史阶段：有界文件发现与元数据分页

文件边界路线第一阶段已实现：discover_resource 支持指定根下的文件名/扩展名/相对路径字面匹配，结果含覆盖范围、预算、跳过原因与分页游标；单文件候选仍经具体批准后仅物化该文件。list_files 改为不读取正文的元数据分页，游标绑定对象、查询与元数据版本，重启可续页，目录变化明确要求重新列举。

list_files 条目不再返回内容 hash；需要内容版本使用 read_file/stat_file。cursor 只翻页预算内已观察结果，不延续未遍历目录；totalExact=false 时须缩小 root/depth 或 prefix。原完整扫描、内容限额、批准和 ChangeSet 交付规则保持。尚未实现新建/整文件替换的分离契约、独立成果导出或 OS 执行隔离。

本轮新增 16 项专项场景，最终相关 11 个测试文件 132/132 通过；类型检查、核心与桌面构建通过。固定模型、临时目录与临时 SQLite 验证，无真实 API、生产会话库、产品启动或发布；Windows 未修改。备份与日志位于 E:\Codex\Workspace\output\umi-file-discovery-20261011。

学习调用链与限制见 [发现与分页](file-discovery-20261011.zh-CN.md)；后续隔离候选及正反向探针矩阵见 [执行边界计划](execution-boundary-plan-20261011.zh-CN.md)。本机 Home 系列不把 Windows Sandbox 作为默认路线；AppContainer/LPAC 仅列待验证候选，尚无原生可行性结论。下一阶段为创建/替换意图，再补 Artifact/Export。

## 2026-10-11 历史阶段：任务验收与续作第一阶段

新增原话绑定的持久任务检查点、固定验收项、证据核验与跨 run 续作。file_hash / command_exit / delivery 分开验证，结束前只读复核当前产物；run.completed 仍仅表示运行结束，另保存 acceptance 报告。无进展时有界反馈，停止后不自行重启，未知副作用恢复不重放。验收报告和结束事件同事务提交；仅最终提交失败可恢复，派发失败契约不变。

模型提出的验收项不保证覆盖完整用户目标；主观质量、任务范围调整/关闭、真实模型完成率和无人值守调度尚未完成。没有 UI 重设计或操作系统沙箱。文件发现默认只查目录名、列举无分页及新成果交付缺口已确认，形成下一阶段计划，本轮未改这些工具的权限。

本轮实际新增 21 项专项场景；相关 13 个测试文件 165/165 通过，类型检查和核心/桌面构建通过。使用固定模型/进程替身和临时数据，不使用真实 API、生产会话库，不启动产品或发布；Windows 未修改。

学习与源码链见 [任务验收与续作](task-acceptance-20261011.zh-CN.md)；源码排查、Harness/Reasonix/Kimi Work 来源和实施顺序见 [文件与执行边界计划](file-boundaries-plan-20261011.zh-CN.md)。完整备份及日志位于 E:\Codex\Workspace\output\umi-task-acceptance-20261011。下面数量保留对应历史阶段归属。

## 2026-10-11 历史阶段：MXC 清理与基础设施盘点

MXC 专用实现、测试和编译产物已退役，专项学习文档、SDK 与实验集中归档到项目外；不再继续原生桌面探索。通用工具模块、Windows 执行端口、批准/证据/恢复接口保留，默认 Windows V1 行为不变。当前源码没有 MXC 依赖或启动入口。

有界上下文已落地当前 bounded-v1 契约；任务完成与续作、执行边界、日常能力与效率均已有部分实现，但独立目标验收、持久任务续作、OS 沙箱与完成率/效率基准尚未完成。下一步优先任务验收与续作，不将 run.completed 当作用户目标已验证。

本轮实际类型检查、核心/桌面构建和相关 12 文件 154/154 通过；未增加测试或执行 MXC 实验，未重验历史数量。Windows、生产会话、真实 API、发布和 Git 提交未操作。

当前能力、缺口和六条源码阅读链见 [开发状态与阅读入口](development-status.zh-CN.md)。旧阶段数量保留历史归属，不计为本轮检查；退役资料与清理前备份位于 E:\Codex\Workspace\output\umi-mxc-cleanup-20261011。

## 2026-10-10：有界上下文阅读入口

有界活跃上下文已经实施。建议按以下顺序读，先分清“永久原始历史”和“当前模型投影”：

1. [bounded.ts](../packages/agent/src/context/bounded.ts)：原话字节定位、最多 12 个活跃来源、短旧输入保护、长工具结果摘录。文字匹配用于定位，不是授权判定。
2. [ContextManager](../packages/agent/src/context/manager.ts)：project 纯投影 → prepareTurn 压力判断 → 按完整消息组退休 → 本地/模型维护 → 重新预算。
3. [MemoryRepository](../packages/adapters/src/sqlite/memory.ts)：计划先持久化，finish 核验源指纹与窗口版本，事务生成索引清单和 window_committed；load 核对清单与原文。
4. [记忆工具](../packages/agent/src/tools/memory.ts)：list_user_requirements 定位已应用输入；read_history/search_history 读取永久原文。未展示不意味着要求已撤销。
5. [AgentEngine](../packages/agent/src/loop/engine.ts)：构建 ContextFacts 与原始 payload 的 sourceHash，取得维护后投影，冻结实际请求并进入原有模型循环。

具体契约、13 项新增测试与限制见 [有界上下文记录](bounded-context-20261010.zh-CN.md)。接着读 [文件增删改查](file-operations-comparison-20261010.zh-CN.md)，沿 ToolExecutor → ResourceFiles → 工作副本 → ChangeSet → DeliveryFiles 理解文件权限与恢复。下面旧研究的“下一步有界上下文”是当时建议，现在以本补充为准。

## 2026-10-10：后端阅读排版与参考项目研究

后端 TypeScript 已整理换行与缩进，学习注释保留；本轮不改变运行行为，renderer/CSS、测试与验证脚本未格式化。具体阅读链、格式化验证及 Harness/Reasonix 对照见 [后端阅读整理与 Agent 机制研究](agent-harness-comparison-20261010.zh-CN.md)。研究建议与已实现功能分别说明，下一步优先考虑有界活跃上下文与任务完成证据。

## 1. 先建立心智模型

把 Umi 看成五个步骤：**接收要求 → 构建请求 → 模型提出下一步 → 系统执行并记录 → 页面展示事实**。

React 负责界面，Electron 负责通道，AgentEngine 负责循环，适配器连接外部能力，SqliteStore 保存事实。先理解分工，再读具体实现。

## 2. 启动和定位

在仓库根目录，使用符合 package.json 的 Node 24 环境：

```powershell
node --version
npm ci --no-audit --no-fund
npm run typecheck
npm run dev
```

`npm ci` 按锁文件安装，也执行 Electron 等依赖的安装脚本。在桌面设置配置自己的 Key；没有 Key 可先看 UI 或执行 `npm run demo`。demo 会构建并使用独立临时环境，模型是替身，核心仍是产品同一份代码。

两个常见误会：关窗口只是隐藏，退出执行器使用菜单“退出 Umi”；便携版已运行时，`npm run dev` 的第二实例可能只是唤回旧窗口。源码 dist 与 release 的资源是不同文件树，改源码不会自动更新旧便携目录。

## 3. 推荐阅读路线

每一轮带着问题读，完成后用自己的话复述答案，不要求一次理解全部代码。

### 第 1 轮：程序从哪里启动

| 顺序 | 文件 | 重点 |
| --- | --- | --- |
| 1 | [package.json](../package.json) | dev/build/test/package 各自执行什么 |
| 2 | [main.ts](../apps/desktop/main.ts) | 窗口、IPC、目录选择、配置与退出 |
| 3 | [preload.ts](../apps/desktop/preload.ts) | window.umi 暴露的固定能力 |
| 4 | [broker.ts](../apps/desktop/broker.ts) | fork、ready、实例、请求标识与超时 |
| 5 | [agent-worker.ts](../apps/desktop/agent-worker.ts) | 同一 UmiApplication 的组装入口 |
| 6 | [service.ts](../apps/desktop/service.ts) | 命令映射、snapshot 和 events |

完成标准：画出点击发送到核心接收的进程边界，解释 renderer sandbox 为什么不是宿主命令的文件沙箱。

### 第 2 轮：任务为什么继续或完成

1. [application.ts](../apps/headless/src/application.ts)：读 send/start/approve/stop/resume/close。
2. [engine.ts](../packages/agent/src/loop/engine.ts)：读恢复前置、while、模型流、工具结算和结束条件。
3. [ports.ts](../packages/agent/src/ports.ts)：理解 ModelPort 和 PreparedRequest。
4. [persistence.ts](../packages/agent/src/persistence.ts)：理解核心如何声明持久化需求。

带着问题：为什么有工具结果后继续？用户新输入如何加入正在运行的任务？为什么正文非空仍不一定能结束？

完成标准：能定位工具未结算、停止、配额不足、流中断、预算超限分别进入哪个分支。

### 第 3 轮：协议与真实请求

1. [model.ts](../packages/protocol/src/model.ts)：Settings、WireMessage、ExecutionContext、validatePairs。
2. [events.ts](../packages/protocol/src/events.ts)：事件种类及其身份约束。
3. [reducer.ts](../packages/protocol/src/reducer.ts)：事件如何变成 ConversationState。
4. [adapter.ts](../packages/adapters/src/deepseek/adapter.ts)：prepare 与 stream。
5. [sse.ts](../packages/adapters/src/deepseek/sse.ts)：字节流怎样变成完整事件。

重点：类型不能验证 JSON；工具调用/结果必须配对；delta 不是完整响应；失败重试需要新的 attempt 身份。

### 第 4 轮：工具与文件交付

1. [registry.ts](../packages/agent/src/tools/registry.ts)：注册、规格排序、参数解析。
2. [executor.ts](../packages/agent/src/tools/executor.ts)：prepare、批准、dispatch、execute、reconcile、settle。
3. [resources.ts](../packages/adapters/src/host-files/resources.ts)：发现、资源、物化与恢复。
4. [tools.ts](../packages/adapters/src/host-files/tools.ts)：各工具的 schema/effect。
5. [paths.ts](../packages/adapters/src/host-files/paths.ts)：路径、链接、身份、指纹和原子写入。
6. [delivery.ts](../packages/adapters/src/host-files/delivery.ts)：冻结、预览、意图与回执。

完成标准：解释“副本已修改，来源未变”如何成立。再解释父目录作为物理根与单文件授权范围的区别，以及 scope 如何贯穿批准、复制计划、挂载和交付。

### 第 5 轮：持久化与恢复

读 [store.ts](../packages/adapters/src/sqlite/store.ts) 的构造和 acceptInput/claim/dispatch/settle/decideApproval，再读各 schema/repository。

先判断事务保护什么：同 commandId 不重复接收；旧 generation 不能写；批准绑定同一请求；原文不被改写。然后读对应 recovery 测试和 crash worker，观察在哪个边界强制退出、重启核验什么。函数返回正确不能单独证明跨进程恢复正确。

### 第 6 轮：上下文与长任务

| 文件 | 要回答的问题 |
| --- | --- |
| [prompts.ts](../packages/agent/src/context/prompts.ts) | persona 怎样要求自然进展与真实结果 |
| [estimate.ts](../packages/agent/src/context/estimate.ts) | 为什么估算不是实测 token |
| [projection.ts](../packages/agent/src/context/projection.ts) | 工具组、来源、原文保护、片段降级 |
| [manager.ts](../packages/agent/src/context/manager.ts) | 何时维护、维护什么、怎样提交或失败 |
| [tools/memory.ts](../packages/agent/src/tools/memory.ts) | 笔记、要求候选、主动 reset |
| [sqlite/memory.ts](../packages/adapters/src/sqlite/memory.ts) | 来源校验、窗口版本与事务 |

完成标准：写出一轮请求的排列，标出稳定/变化内容，说明为何摘要成功仍可能超预算。

### 第 7 轮：界面与行为

按 [main.tsx](../apps/desktop/renderer/src/main.tsx) → [App.tsx](../apps/desktop/renderer/src/App.tsx) → [transport.ts](../apps/desktop/renderer/src/transport.ts) → [Timeline.tsx](../apps/desktop/renderer/src/Timeline.tsx) → [Composer.tsx](../apps/desktop/renderer/src/features/work/components/Composer.tsx) 阅读。

看游标、messageId 合并、CommandGate、待发送回执、pending approvals、最终正文和恢复按钮，再读 CSS。先区分“事实没产生”和“有事实但没展示”。

## 4. 四条调用链练习

### A：普通问候

```text
Composer.onSubmit → App.send / CommandGate / receipt
→ window.umi.request(send)
→ main IPC → broker → worker → DesktopService.handle
→ UmiApplication.send → acceptInput → start
→ AgentEngine.run → ContextManager → DeepSeekAdapter
→ persistResponse → run.completed
→ events → applyBatch → reduceConversation → Timeline
```

纯聊天出现多余挂载报告时，先检查实际模型请求里的 persona/state 和正文来源，不要先归因于 CSS。

### B：修改并交付文件

```text
discover_resource → request_resource
→ prepare / requestApproval / run.waiting
→ ApprovalCard → approve → decideApproval
→ materialize → read_file / write_file
→ build_changeset → deliver_changeset
→ 冻结预览 / 具体批准 / 来源冲突核验
→ delivery_items 回执 → 模型说明结果
```

用专用小测试目录练习，记录资源批准和交付批准分别授权什么。单文件范围已在 2026-10-10 实施；具体阅读 resource-scope.ts、ResourceFiles.scanSource/scanMount/assertPath 与 DeliveryFiles.checkScope，验收见 [本轮开发记录](resource-scope-20261010.zh-CN.md)。

### C：物化失败后的恢复

```text
执行失败 → unknown → run.recovery_required
→ recovery 检查（只读）→ resume
→ claim 新 generation → 原工具 reconcile
→ failed / succeeded / unknown
→ 可结算则继续模型；否则保持阻塞
```

reconcile 检查原执行，不是无条件重做。核验失败后模型发起的新工具请求，须与原执行恢复区分。

### D：上下文维护

```text
prepareTurn → 压力检查 / 主动 reset
→ 选择完整消息组 → 保存维护计划
→ 生成有来源摘要
→ 校验来源、窗口版本、预算收益
→ finishMaintenance / 新窗口
→ 编码并保存实际执行请求
```

维护也可能请求模型，费用应单列；只数主循环轮次不能得到总 API 调用数。

## 5. 修改入口速查

| 想改什么 | 首先定位 | 同时检查 |
| --- | --- | --- |
| 回复语气 | context/prompts.ts | prompt 版本、请求快照、直接完成路径 |
| 模型参数 | deepseek/adapter.ts | Settings、预算和协议验收 |
| 模型菜单 | features/work/models.ts | 标签不是实际路由或版本证明 |
| 新思考档位 | protocol/model、ContextManager、adapter、菜单 | 输出预留、参数映射、旧设置兼容 |
| 资源粒度 | protocol/resources、host-files、sqlite/resources | 批准、物化、交付、恢复和迁移 |
| 新工具 | Registry 的注册函数 | schema/effect/prepare/execute/reconcile |
| 命令 | host-process、process schema/repository | 批准后变化、停止、进程身份、未知退出 |
| 恢复界面 | Timeline、inspectRecovery | 前端不能直接结算执行 |
| 复制/发送/卡片 | Timeline、Composer、ApprovalCard、surface.css | 深浅色、hover、键盘、等待状态 |
| 设置 | settings schema、SettingsPage | 会话设置/机器配置分开，当前请求冻结 |
| 数据库字段 | 新迁移 | checksum、旧记录、升级和重放 |
| 文档解析 | attachments、SQLite images、adapter | 大小、格式、归属、预算和预览 |

## 6. 如何考虑一个新工具

ToolDefinition 的核心字段是：

```text
name / description / schema / effect
prepare(args, environment, executionId) → ExecutionContext
approvalRequired / approvalDescription（按需要）
execute(args, context, conversationId, signal) → ToolResult
reconcile(args, context, conversationId, signal) → ToolResult
```

prepare 校验归属并绑定位置；execute 按绑定对象执行；reconcile 核验原效果。只读操作可能安全重读，但写入不能照搬同一恢复方式。

新增写入、资源或宿主代码工具时，明确批准与中断核验。不能为了省弹窗把有副作用的工具标成 read。工具 schema 进入模型请求，调整它会影响参数、缓存稳定性以及旧执行解释。

## 7. 按证据调试

### 页面看起来没变化

确认开发 dist 还是便携包；确认静态资源已加载；再检查 computed style。样式顺序为 global → desktop → surface，后者或更高 specificity 可以覆盖你修改的 width。

### 模型说完成但文件没变

区分副本与来源，检查 ChangeSet、批准与 delivery_items。模型正文不是磁盘结果证明，不要在没有回执时把界面改成“交付成功”。

### 发出后像是卡住

区分 IPC 回执超时、等待批准、模型流、工具执行、资源失败、预算阻塞和执行器退出。回执超时先查原 commandId，不生成新 ID 重发。

### 怀疑前端或后端

检查 snapshot/state 是否有对应消息块、工具和批准。有事实而显示错误时查 reducer/transport/activity/Timeline；无事实则查应用命令、持久事件和执行结果。

### 数据库诊断

使用独立只读连接与 `PRAGMA query_only=ON`，按会话/运行限定范围。先看事件类型、时间、状态和错误码，再按需读 artifact；不要把整库或密钥配置上传 Issue。

```sql
SELECT id, status, generation, model_turns
FROM runs WHERE conversation_id = ?;

SELECT sequence, payload
FROM events WHERE conversation_id = ? ORDER BY sequence;

SELECT id, name, state, context_ref, result_ref, approval_id
FROM tool_executions WHERE run_id = ?;
```

这些是诊断示意，不能通过手工改 status 来冒充恢复。

## 8. 测试怎么读

| 类别 | 文件示例 | 价值 |
| --- | --- | --- |
| 协议/循环 | adapter、core、boundaries | 流解析、幂等、批准、配对 |
| 文件/交付 | resources、resource-recovery | 来源冲突、挂载归属、交付核验 |
| 物化 | materialization-recovery、crash worker | 复制中断后的计划与核验 |
| 进程 | process、command-recovery | 释放、停止、输出、退出 |
| 上下文 | context、context-recovery | 消息组、维护事务、原文保护 |
| 预算 | budget-block | 无变化不重复 API，变化后再核验 |
| 桌面/UI | desktop、interaction、ui-flow | 核心接入、附件、展示顺序 |

文件位于 tests，主要案例使用 `.test.ts`。常用命令：

```powershell
npm run typecheck
npm run build
node --test dist/tests/core.test.js
npm test
npm run verify:desktop
```

部分检查要求 Windows、真实进程或 Electron。真实 API 脚本会产生费用，要先阅读脚本并准备独立资料目录。本文不声称本次重跑了这些测试。

## 9. 学习练习与提交方式

1. 改一个局部文案，确认当前应用确实加载了该源码。
2. 跟踪一次问候，画请求和事件返回路径。
3. 在专用目录完成副本修改与交付。
4. 阅读故障注入测试，解释为什么恢复不能重跑未知写入。
5. 参与单文件资源契约改造，先列验收，再实现；不从放宽限额开始。

提交按契约/迁移、执行逻辑、前端、验证/文档划分。说明行为变化、事实依据和复核方法，方便定位回归。

### 自测问题

- renderer 为什么不能直接调用 fs？
- commandId、correlationId、generation 分别解决什么？
- 工具什么时候是 unknown，而不是 failed？
- 为什么副本可连续编辑，源文件交付仍需批准？
- 预算阻塞与模型 API 配额不足有什么区别？
- 为什么工具消息组不能只压缩一半？
- 为什么静态模型标签不证明实际响应版本？
- 怎么判断 UI 漏显示，还是后端没有产生结果？

能沿源码回答这些问题，就掌握了继续开发 Umi 的主要框架。
