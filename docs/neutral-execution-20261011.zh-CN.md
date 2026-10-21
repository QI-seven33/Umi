# 中立执行 V2：2026-10-11 实施与验收

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


## 本轮范围与原始状态

修改前读取 AGENTS、交接、项目报告、阅读指南，保存 Git 状态、完整 diff 及 175 个 tracked/非忽略文件的 SHA/字节备份。实际源码在 E:\SOME_SEVEN_PROJECT-57\Umi_v2.0；保留已存在的排版、学习注释、资源/上下文/编辑/端口变更。没有在发布中转目录开发。

本轮新增可选 providerModules 组装、中立 Plan/Locator/Observation 运行时 schema、唯一工具执行器的复用、窄的证据端口和持久事件。默认 Windows V1 命令没有切换，SDK 不进产品 package/lock；本轮不是通用 MXC adapter 发布。关联概念和阅读链见 [当前技术说明](current-state.zh-CN.md)。

## 实施前约定与实际契约

- 计划绑定执行/租约、provider/version/implementationHash、能力、程序/依赖/工作目录身份哈希、显式环境、资源映射、策略、限额。新可选 ExecutionContext.execution 参与原批准哈希。等待后复核与派发后准备差异均阻止启动。
- 承载中立计划的派发在 SQLite 层强制具体批准，核对 executionId/leaseGeneration 并禁止混用 V1 process。原 Windows 名称/快照检查保留。
- 模块只注入准备端口与 provider；协调层使用每次执行绑定的 ExecutionEvidencePort。provider 不获得 SQL 或批准写入口，执行效果仍经唯一 AgentEngine/ToolExecutor。
- 证据用 artifact + execution.planned/located/completed/reconciled 事件及纯 reducer.providerExecutions 投影保存。artifact 与事件同事务，不新增 SQL 表/迁移，不改历史事件。旧 envelope/ExecutionContext V1 保留，新 nested 计划版本为 2；降级不保证。
- 首次启动先保存原计划，再调 start；locator 含原执行和计划/provider 归属，不能覆盖不同 token。创建与定位保存之间仍有窗口，没有定位保持 unknown。
- 回执分开启动、退出、进程树清理、容器清理、文件效果，按冻结限额检查 UTF-8 输出；wrong identity/hash/超限证据不接受。既有明确事实不允许撤销。
- 原 provider/版本/实现匹配时才 reconcile 原 token；缺失不重跑、不自动换默认后端。完整持久回执可直接核验；未知清理可追加新事件，首次回执不删除。
- prepare 能力声明 unknown/rejected 不满足强制策略。V2 gated 仅预留字段，尚无共享可信 release，当前一律拒绝 gated；不能因声称支持就启动。

## 本轮验收

最终类型检查、核心构建和桌面构建通过。最终 13 个相关测试文件 168/168，通过的新增 16 项已包含在其中。范围：execution-provider、process-port、process、core、desktop、cli、tool-modules、text-edit、bounded-context、context、resources、single-file-resources、resource-recovery。未全量重验、未进行 UI 视觉验收；桌面构建不等于发布。

| 新场景组 | 实测行为 |
| --- | --- |
| 正常执行 | auto 仍等具体批准；派发/计划先于启动；定位、退出分离，来源不变，无 Windows V1 伪造记录 |
| 依赖与能力 | 批准后程序变动使批准失效、零启动；未知网络强制策略在准备阶段拒绝 |
| 跨应用重启 | 原回执丢失或清理未知时，关闭再新建 UmiApplication 后只 reconcile 原 locator，start 总数仍为 1 |
| 原实现选择 | provider 缺失、版本变化、实现摘要变化都保持 unknown，不调用替代实现 |
| 证据错误 | 无定位、错定位、错 planHash、UTF-8 总输出超限均不接受为成功，未重跑 |
| 状态与授权 | 未启动却普通退出的观察非法；工具定义绕过批准时被派发层阻止；等待中取消零启动 |
| 门控缺口 | provider 声称 gated 可用也无法通过当前选择阶段 |

早期测试脚本曾用错 stop/resume 的参数，并缺少 readArtifact 泛型；修正后重新构建/验收。首次 13 项后扩展到最终 16 项；中间测试数量不累加。全部结果仅涉及独立临时会话及替身 provider，不能当作真实 MXC 安全验证。

## 本轮 MXC 探索

独立 SDK 1.0.0，Node 24.21.0 便携环境。公开 probe/getPlatformSupport 无工作负载启动：对现有输出根的请求返回 WRITE_DAC 不可用；改用正常宿主新建自有目录取得 appcontainer-dacl、needsDaclAugmentation=true。保留两份 JSON，不将第一个失败抹掉。本机无 BaseContainer API、BFS 未编译、IsolationSession 不可用；平台列出的 Hyperlight 未试跑。

适应映射保持文件/网络/UI/门控 unknown、one-shot 恢复 unsupported；中立 registry 返回 POLICY_UNSUPPORTED，启动计数为 0。不是要求 MXC 兼容 Windows Job；是识别 Umi 的映射权限、策略证据和持久执行定位还需完善。2026-10-10 固定 CMD 与 Node 0xC0000142 是历史证据，本轮没有重新运行它们。

只读 Windows 注册表核对与此前一致，版本/功能未修改，没有 host-prep、DACL 修改、CLI dry-run、真实 API、生产会话库操作、产品窗口、便携打包、发布或 Git 提交。当前官网与搜索缓存的资料差异详见学习文档，不照抄旧主分支资料。

## 剩余限制与下一切口

准备器与 provider 仍是可信宿主实现；hash/能力声明不认证恶意第三方代码。即时启动最后复核与真实效果之间不是 OS 原子操作。provider 必须处理取消、locator 写入失败与清理；启动阶段传超时/取消 signal，不能保证所有实现都会终止。恢复传入核心取消信号，本轮没有单独增加恢复超时或强制中断机制。

输出在返回回执时按总 UTF-8 字节拒绝超限；尚无中立的在线背压、逐段持久归档或自动 kill。准备器不应隐藏 ACL/镜像效果。没有通用 MXC 产品 adapter、SDK lifecycle/container exec 定位、动态插件下载/卸载、provider close 生命周期或可信 V2 gate；这些按独立契约推进。

下一步优先实现 MXC 的窄准备/策略映射 adapter 与实测能力矩阵，解决程序运行依赖和 owned resource 映射前提，然后设计可靠的创建/定位关联。跨后端接口已经可用，但开放真实模型任意命令前必须完成所声称的边界与恢复验收。

本轮原始 diff、before 备份、测试/构建日志、只读探针、最终保留检查均在 E:\Codex\Workspace\output\umi-provider-neutral-20261011；不进入产品依赖或发布包。
