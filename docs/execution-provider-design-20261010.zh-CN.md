# Umi：执行器接口、能力模块与局部编辑草案

> 2026-10-10。后续已落地 LegacyWindowsProcessPort、应用注入、内置 ToolModule 与 edit_file；实际 Umi → MXC 固定 CMD 模块链路及实现范围见 [局部编辑、模块组装与 Umi 适应 MXC](text-edit-modules-mxc-20261010.zh-CN.md)。本文后续中立 provider/计划回执、通用 MXC 产品执行器和动态插件平台仍是未实施设计；局部编辑章节保留实现前契约背景。配套：[当前开发状态与研究归档](development-status.zh-CN.md)。

## 2026-10-11 实施补充

中立 Plan/Locator/Observation V2、原 provider 选择、窄证据端口、可选 providerModules 和事件持久化已经实施，见 [中立执行协议本轮实施记录](neutral-execution-20261011.zh-CN.md) 与 [当前开发状态与研究归档](development-status.zh-CN.md)。本轮不提供通用 MXC adapter；gated 字段预留但现阶段明确拒绝，因为可信 V2 ready/recheck/release 尚未实现。下文名称与接口是实现前草案，当前字段/调用以源码和本轮记录为准。

## 当前调用链与耦合

UmiApplication → ToolRegistry → 唯一 AgentEngine/ToolExecutor → CommandTools → CommandPreparation + ProcessRepository + WindowsProcessRunner。批准、派发与恢复已经集中，不应新增另一套 MXC 工具循环。

| 当前位置 | 实际耦合 | 拆分方向 |
| --- | --- | --- |
| [UmiApplication](../apps/headless/src/application.ts#L32) | 应用组装选择宿主工具；已新增 legacy Windows runner 注入，尚无中立 provider | 明确组装入口，测试、headless 和桌面使用同一注入接口 |
| [CommandTools](../packages/adapters/src/host-process/tools.ts#L29) | runner 依赖 legacy 端口并默认具体实现；ready 仍认识 bridge/child PID，结果仍认识 Job | 工具编排依赖执行端口，宿主实现与语义转换留在适配器 |
| [CommandPreparation](../packages/adapters/src/host-process/prepare.ts#L25) | Windows 引号、入口身份、桥接代码 hash | 各 provider 解析宿主定位；公共层冻结请求、策略和定位摘要 |
| [进程协议](../packages/protocol/src/process.ts#L96) | V1 snapshot/receipt 强绑定 bridgeHash、PID birth、jobInactive、gateReleased | 保留 V1 解码；需要中立语义时新增可辨识版本，不改旧事件事实 |
| [ProcessRepository](../packages/adapters/src/sqlite/processes.ts#L14) | Windows 进程表和执行归属检查 | 旧路径继续恢复；新 provider 保存自身可核验 locator 与证据引用 |

模型、工具、执行实现、持久化与 UI 是不同扩展点，不能用一个可随意修改全局对象的 plugin Context 代替明确依赖。

## 第一步：接口小切口

已将旧 Windows runner 所需接口显式定义为 LegacyWindowsProcessPort，并允许 UmiApplication 通过 options.processRunner 注入；默认仍使用现实现。原生帧 schema 移到 frames.ts，运行时校验不变。详见 [实施与实际验收](execution-port-validation-20261010.zh-CN.md)。该接口携带旧 V1 snapshot/回调，必须明确它尚未中立，不能直接将 MXC 塞入并伪造 bridge/PID/Job 回执。

真正接 MXC 前，确定中立的 ExecutionPlan 与回执版本。公共层只保存：执行身份、providerId/providerVersion、规范化工作负载定位、环境与资源版本、批准绑定、策略与策略 hash、输入来源、超时/输出上限。MXC SDK 类型、Windows C argv 编码和 native handle 不穿过公共协议。

可以采用以下职责形状；名称、类型和方法尚未落地：

```ts
interface ExecutionProvider {
  readonly descriptor: { id: string; version: string };
  inspect(signal: AbortSignal): Promise<RuntimeCapabilities>;
  validate(intent: ExecutionIntent, capabilities: RuntimeCapabilities): Validation;
  start(plan: ExecutionPlan, sink: ExecutionEventSink,
        signal: AbortSignal): Promise<ExecutionOutcome>;
  reconcile(plan: ExecutionPlan, locator: ExecutionLocator,
            signal: AbortSignal): Promise<ExecutionVerification>;
  close(): Promise<void>;
}
```

inspect 是有界发现；validate 必须是纯判断/转换，不借 CLI dry-run 准备宿主权限。若某后端需要 ACL、配置目录、容器或镜像准备，那是单独有记录的效果操作，不能隐藏在参数 prepare 中。start 只能消费已经冻结、授权并保存派发事实的计划。locator 是可持久化的 provider 专属恢复定位，含执行身份和类型，禁止只用一个 PID 或内存对象；其实际核验由原 provider 完成。

## 契约变化：必须在实现前明确

1. **能力声明具体化。** 声明实际 backend/tier、对各策略字段的处理（enforced/rejected/unknown）、流式输出、stdin、超时、取消、进程树清理、恢复和是否需要宿主准备。能力发现不等于实际启动验证。ignored 字段不能满足请求中的强制要求。
2. **批准绑定策略。** 绑定 provider/version、规范化策略 hash、映射根与文件身份、网络姿态、工作负载及其依赖定位。批准等待后变化继续使原批准失效；模型请求不能扩大策略。
3. **启动时序。** 当前 Windows 桥接支持挂起后 ready/recheck/release，MXC 公共 spawn 没有因此自动具备相同门控。先核对 API，决定如何保留执行前检查或明确修改契约；不能先启动再伪造 ready/released 事件。需要当前门控却无法提供的 provider 拒绝选择。
4. **中立结果证据。** 分开退出结果、停止/子树清理、容器清理与文件效果。没有 Job 便不能编造 jobInactive=true，exitCode=0 也不能代替任务完成。无法核验保持 unknown。
5. **按原实现恢复。** 新记录保存 provider/version 与 locator，恢复回到原实现；provider 缺失或不兼容时明确中断。不能用当前默认 provider 重新执行旧命令。数据库和事件新增版本前先确定向后解码及迁移策略。
6. **隔离要求不能静默减弱。** MXC 创建失败、能力未知或字段不受支持时拒绝该隔离请求；普通宿主运行若保留，应是用户可辨认、单独批准的执行模式，不能自动降级。
7. **信任范围。** AgentEngine、批准、SQLite 与模型凭据留在可信宿主；先隔离生成脚本/命令。MXC 不会自动保护宿主里的文件工具。环境显式白名单，不能把宿主 API Key 全量继承进去。

旧 DACL 层级有宿主权限准备与恢复成本；现代后端也需按具体字段验证。每个阶段/后端都必须真实履行所声称的策略，而不是统一打一个 sandbox=true 标签。

## 如何借鉴 Harness 的模块组装

本地 Harness 的 tool-fs 注入 tools/fs/systemPrompt，文件系统实现与观察策略分别提供服务/监听决策。这种明确服务依赖、替换实现和独立验证的划分值得借鉴。[工具模块](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/tool-fs/src/index.ts:19)、[观察策略](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-observation-policy/src/index.ts:98)

Umi 先从内置模块工厂开始：模块声明 id/version/requires/provides，安装时仅接收所需端口，返回资源释放函数。应用启动检查缺失依赖、重复工具名和冲突服务；默认组装仍是显式配置。使用窄的能力接口，不把 SqliteStore、完整配置、任意文件系统和密钥一起传给每个模块。

模型、文件、命令、搜索等能力可以替换；批准判定、事实保存和恢复顺序保持唯一可信入口，模块不能通过注册接口跳过它们。运行于同一宿主的第三方插件代码仍是可信代码，不因“插件”名称就获得隔离。外部插件的下载、版本/来源信任、升级、卸载和独立进程隔离应另作任务；本次不建设动态插件平台。

## MXC 实际执行验收清单（尚未执行）

- 原 Windows 注入路径保持参数、批准变更、挂起门控、停止与原恢复行为；替身 provider 验证选择和缺失依赖。
- 获准目录可写，参考目录可读不可写，未获准路径和路径别名越界拒绝；同时核对外部哨兵的内容与 ACL。
- 网络按所选后端请求实际阻止；若后端不支持该策略，启动前明确失败。
- 流式输出与 stdin、输出上限、凭据不继承、超时/取消/子进程清理得到真实结果。
- 批准后策略、provider、依赖内容或资源映射变化，原批准失效；没有作用后才补批准。
- 崩溃发生在计划、创建、启动、效果与回执之间时，原执行可以核验；不能重跑来补“成功”。
- provider 缺失、旧版本恢复、隔离层级降级、ACL/容器清理失败均保持可解释状态。
- 记录冷/热启动耗时、取消延迟与同任务总耗时，不能只凭插件化推断性能改善。

## 局部编辑仍然继续：独立任务的契约

建议在上述最小注入接口之后实施单文件 edit_file，不等待 MXC 全部验收。目标是减少模型整文件生成，并阻止依据陈旧读取修改副本。

建议参数：mountId、相对 path、readExecutionId、expectedReadHash、非空 oldText、newText。宿主核对成功读回执属于当前会话、同挂载/文件和读取版本，不能只相信模型提供的 hash。准备与执行阶段继续检查当前内容/对象身份/资源范围；oldText 必须恰好出现一次，不提供 fuzzy、replace_all、跨文件 patch 或隐式创建。

精确匹配须说明换行语义；原文件 UTF-8/BOM/CRLF 等无关字节应保留。不支持的编码、二进制或超限明确拒绝。没有变化时返回 no-op，实际写入沿用副本安全路径与原子落盘，输出 before/after hash 和有界修改证据。交付仍冻结 ChangeSet 并独立批准。恢复只核验原执行，不盲目再次替换。

验收包括：唯一命中、多行与中文、保留学习注释及换行、零/多次命中、无读回执/错会话/错位置、读后外部修改、对象替换、单文件范围越界、取消、无变化、写后中断与来源交付。这里列的是下一任务场景，不是今天的测试通过数量。
