# Umi 核心契约 v1

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


日期：2026-10-04（Asia/Shanghai）。契约覆盖整个重构路线。阶段 2—4 已实现唯一循环、受控资源与交付、宿主命令及上下文维护。实际运行时 schema 以 `packages/protocol/src` 为准，最新范围见 [当前技术说明](current-state.zh-CN.md)。

配套文件：[当前技术说明](current-state.zh-CN.md)、[迁移验收](migration-and-acceptance.md)。内部开发说明和模型可读规则采用中文；字段、枚举、工具名及协议键保留英文。

修订记录：2026-10-04 根据阶段 2 反馈明确历史检索、执行批准修订、窗口维护触发条件、缓存取舍及公开阶段正文的呈现契约；同日登记阶段 2、3A、3B 的实施证据。阶段 4 实施规则见本文末尾；桌面契约仍待阶段 5。

## C00. 基本不变量

1. 一个任务循环、一个模型上下文准备入口、一个事件归约根入口。
2. 用户输入原文、原始模型响应和原始工具结果不可被摘要或语言转换覆盖。
3. 每条模型响应块、工具调用和结果都有明确的模型轮次及执行身份。
4. 批准前不派发；决定、派发意图和结果分别持久化。
5. 断线不等于停止；进程重新启动不等于任务恢复。
6. 未知副作用不自动重试；拒绝、取消、失败和未知是不同结果。
7. 任务完成依据真实执行状态；模型文字不是交付或授权证明。
8. 模型上下文压缩及窗口切换不改变任务或工作环境身份。
9. 在没有 OS 隔离时如实报告宿主执行；cwd、白名单和批准不冒充沙箱。
10. 相同事件无论实时、历史、重放或订阅重连，都得到相同业务投影。

## C01. 身份、归属与并发

| 字段 | 含义 | 生命周期及唯一约束 |
|---|---|---|
| `workspaceId` | 工作区身份 | 同一主要目录与分组的长期标识 |
| `conversationId` | 会话身份 | 隶属工作区；完整多轮交流 |
| `userTurnId` | 用户输入身份 | 一次输入一个 ID；批准与系统提醒不伪装成用户输入 |
| `runId` | 持续任务运行 | 可有多条中途用户输入；恢复保持该 ID |
| `environmentId` | 持久工作环境 | 会话绑定；运行之间复用 |
| `environmentRevision` | 工作副本修订 | 文件改变后增加；与内容哈希配合使用 |
| `modelTurnId` | 逻辑模型调用 | 绑定一个冻结请求；重试不混合不同响应 |
| `modelAttemptId` | 实际网络尝试 | 每次请求单独 ID；记录开始、结束和用量 |
| `providerCallId` | 厂商调用 ID | 原样保留；只在相应响应及协议消息组内配对 |
| `callId` | 内部工具调用 ID | 会话内唯一；与 turn、attempt、providerCallId 建立关联 |
| `executionId` | 一次实际工具执行 | 绑定 callId；核验后重试才创建新执行 ID |
| `approvalId` | 批准请求 | 一个固定对象、范围、版本与决定 |
| `requestId` | 冻结模型请求 | 标识语义与实际协议快照 |
| `commandId` | 外部命令接收身份 | 客户端生成；在接收范围内唯一 |
| `artifactId` | 持久资料身份 | 原始附件、日志、快照等资料引用 |

所有外部入口查验工作区、会话、运行和环境之间的实际关系，不接受调用方任意拼接 ID。

同一环境最多一个活动执行者。任务使用租约和单调 `leaseGeneration`（租约代次）；每次提交和派发检查代次。租约失效只使旧执行者不能继续派发，不足以停止已运行的外部进程；后者必须按 C12 核验。

新会话创建新环境。会话中已有活跃运行时，新消息保存为 steering（补充/纠正）并在模型轮次或工具阶段的安全边界接纳。无活跃运行时创建新运行，绑定现有环境和未交付修改。

待批准状态下的新普通消息可以更新任务要求，但不能作为模糊的批准决定。第一版使用明确批准入口提交 allow/deny，避免模型将“继续看看”解释为写回授权。

## C02. 用户输入与会话设置

输入结构保存 `text` 原文、附件 ID、用户输入时间与所属会话。附件内容作为独立资料保存；界面继续显示附件卡片，模型视图可读取正文或图片。

接收命令先提交消息及 `input.accepted`，再返回接收回执。相同 commandId＋相同内容返回原回执；相同 ID＋不同内容返回 `COMMAND_CONFLICT`。

会话设置由后端持久保存 model、thinking、executionPolicy、uiLocale、answerLocale、reasoningLocale。每次请求记录 effective config（实际生效配置）。界面缓存不能覆盖较新的后端设置版本。

思考档位第一版沿用 off、normal、high，由 DeepSeek Adapter 映射实际支持值。模型 API ID 和展示名称分开；别名解析的已知版本记录来源及核对日期，不声称 API 没有报告的实际部署版本。

设置改变在下一个未派发模型轮次生效；当前网络尝试使用冻结配置。批准策略收紧立即影响尚未派发工具；策略放宽不会自动批准旧的待批准对象。

用户名、头像、主题、折叠等属于个人/界面设置，不自动成为模型提示词。会话活跃时间由实际交流和任务活动决定，订阅心跳不更新活跃时间。

## C03. 统一事件与 cursor

### C03.1 事件信封

```ts
type EventEnvelope<T> = {
  schemaVersion: 1;
  eventId: string;
  streamId: string;          // 第一版等于 conversationId
  logEpoch: string;          // 日志身份，普通恢复和压缩不改变
  sequence: string;          // 十进制正整数字符串，避免 JS 大整数精度丢失
  workspaceId: string;
  conversationId: string;
  runId?: string;
  userTurnId?: string;
  modelTurnId?: string;
  modelAttemptId?: string;
  callId?: string;
  executionId?: string;
  occurredAt: string;        // UTC ISO 8601；界面按用户时区显示
  type: string;
  payload: T;
  producer: "system" | "provider" | "user" | "import";
  idempotencyKey: string;
};
```

各事件使用封闭的 tagged union（带类型标签的联合结构）进行运行时校验，不以任意 type＋任意 JSON 作为正式契约。

事务内按会话分配 sequence；同一 streamId、logEpoch、sequence 唯一。SQLite 内部采用正整数序号，数值比较与分配使用整数语义；传输层转换为十进制字符串，不能按字符串字典序排序。达到数据库整数上限时明确拒绝写入，不回绕。事件时间不决定顺序。idempotencyKey 在同一日志内唯一，相同键的 payload 冲突必须报错。

厂商 `sequence_number`、模型分块索引、消息编号、资料字节范围均不能充当会话 cursor。没有持久化的心跳和诊断信息不推进业务 cursor。

### C03.2 必要事件家族

| 家族 | 事件 | 强制关联和主要内容 |
|---|---|---|
| 输入/设置 | `input.accepted`、`input.applied`、`settings.changed` | userTurnId 或设置版本；原文/资料引用 |
| 运行 | `run.created`、`run.started`、`run.phase_changed`、`run.waiting`、`run.stop_requested`、`run.stopped`、`run.interrupted`、`run.recovery_started`、`run.recovery_required`、`run.resumed`、`run.completed`、`run.failed` | runId、environmentId、理由或结果 |
| 模型 | `model.request_prepared`、`model.attempt_started`、`model.block_started`、`model.delta`、`model.block_completed`、`model.attempt_completed`、`model.attempt_failed`、`message.committed` | turn、attempt、request 或 message ID |
| 工具 | `tool.prepared`、`tool.dispatch_intent`、`tool.started`、`tool.settled`、`tool.reconciled` | callId；派发后有 executionId；实际结果或核验事实 |
| 批准 | `approval.requested`、`approval.decided`、`approval.invalidated` | approvalId、类型、对象 hash、版本、决定 |
| 资源/环境 | `resource.discovered`、`resource.granted`、`resource.revoked`、`resource.materialized`、`environment.revised` | 候选/资源/能力/挂载 ID 与身份 |
| 交付 | `changeset.created`、`delivery.started`、`delivery.item_settled`、`delivery.settled` | 变更集指纹、目标、逐文件结果 |
| 上下文 | `requirements.updated`、`note.recorded`、`context.snapshot_created`、`context.maintenance_settled`、`context.window_changed`、`usage.recorded` | 来源范围、上下文版本、结果与用量 |

所有改变任务判断的事件持久化。Debug 输出、UI 悬停、动画帧和网络 keepalive 使用独立诊断或显示通道。

### C03.3 重放与订阅

cursor 是版本化的 `{streamId, logEpoch, sequence}`。服务端返回固定 watermark（已提交高水位）的快照，再从该位置之后补发。注册订阅与补发使用同一持久日志，避免“取历史后、订阅前”的空隙。

客户端去重后按 sequence 顺序归约；发现缺口先补发，不能先跳过并推进 cursor。持久日志中全部事件都占序号，即使某条事件没有界面块，消费方仍处理其位置。

历史分页使用独立的 message/run page token；cursor 不复用分页位置。快照包含 reducerVersion 和 coveredSequence。模型压缩不删除前端重放日志、不重置 logEpoch。

日志身份不匹配、cursor 超过高水位或版本不可读时，返回明确 reset-required 和一致快照。数据库恢复自较旧备份时更换 logEpoch，不能悄悄继续旧客户端序号。

## C04. 归约、原始消息与界面投影

根入口为纯函数 `reduceConversation(previousState, event)`，内部按事件家族调用子函数。归约不得调用时钟、文件系统、网络或数据库。

运行、轮次、工具、批准、交付和上下文状态由此入口生成。命令处理器仍需验证前置条件；归约不是权限判定器。

界面通过 `projectConversation(state)` 得到 DTO（传输视图）。模型通过 Context Manager 获取经过筛选的输入；两种视图均不改写事实。

完整消息以 immutable message record 保存；`message.committed` 引用 messageId、内容 hash 和对应响应/执行身份。在同一事务内保存消息及关联事件。增量事件用于部分响应和实时显示，完整消息用于协议回放，两者必须满足完成内容一致性检查。完成消息引用用于确认对应 block，不在已积累的 delta 后重复追加全文。

一个完整响应不允许在 run.result、message.text、wire payload 中形成三份可独立修改的权威文本。投影字段只能引用原始记录或作为可重建缓存。

旧记录没有工具结果时，不伪造成功或永久 loading；导入为历史缺失/unknown，并保留数据来源说明。导入事件不进入新任务执行队列。

界面折叠轮次、思考语言展示、相对时间和加载图标通过投影与本地显示状态计算。只有首个实际 reasoning 块到达后显示“正在思考”；此前显示一般运行状态。

## C05. 运行与 Model Turn 生命周期

### C05.1 运行状态

```text
queued → running
running → waiting_permission | waiting_delivery
waiting_* → running（具体决定已提交且前置条件有效）
running/waiting_* → stopping → stopped
非终态 → interrupted → recovering → running | waiting_* | recovery_required
running → completed | failed
```

completed、failed、stopped 是运行终态。恢复 stopped 需要明确 resume 命令，不能因重连自动恢复；恢复同一运行保留终止历史并开启新执行 attempt。终态旧运行的新普通用户消息创建新 run。

waiting 状态可持久挂起，等待批准不消耗模型轮次、持续请求额度或无界轮询预算。断线不改变运行状态。

### C05.2 模型轮次

`modelTurnId` 绑定唯一 requestId。实际网络尝试为 attempt：started→streaming→completed/failed/interrupted。

完整响应由一个已接受的 attempt 提交。失败 attempt 的已展示前缀保留为中断块，不与重试文字串接。UI 按 attempt 归属展示，模型协议回放不发送半截工具参数。

重试同一冻结请求只在没有已执行工具、符合预算及响应恢复规则时进行。新用户要求、工具观察或配置改变产生新请求和新 turn。

正文、思考和工具调用以 blockId 保持实际顺序。delta 带 `{blockId, kind, deltaIndex, text}`；deltaIndex 在块内单调，重复内容通过事件身份去重。流解码器保持 UTF-8 字符完整，不以 HTML 或 JSX 子节点重建原文。

正文增量可实时显示为阶段内容。`final` 是任务级发布身份，只有 C10 完成门槛通过后才标为最终答复。提供方 stop reason 只解释模型结束，不解释任务结束。

交付前出现的无工具答复属于候选阶段答复：保存原始事实，但运行进入交付等待；取得回执后继续模型轮次。模型提示词和完成检查要求最终交付说明在真实回执之后生成，不能靠缓存整段正文掩盖交互问题。

### C05.3 阶段正文与最终正文的展示边界

主循环具有 execute（执行）、waiting（等待）和 finalize（总结）阶段，不建立新的 Agent。阶段转换由真实状态及完成门槛决定，并以 run.phase_changed 或相应开始/等待/恢复事件记录前后阶段；不是只保存在内存的标记。模型进入总结阶段前须完成必要交付或得到明确拒绝；随后请求依据回执生成结果说明。

正文 block 的展示身份为 commentary（公开阶段说明）或 final（最终答复）；它与 reasoning（原始思考）分开。正文角色由系统的阶段与提交事实决定，不通过文本包含“完成”二字推断。任务结束事件引用最终 message/block，不能覆盖所有早前正文。

执行阶段按实际顺序显示公开阶段正文、可展开思考、工具状态和批准卡片。每段正文保存 turn/attempt/block/sequence 归属，实时、历史和重连都使用相同投影；禁止把各轮文字只累加到全局 text 字段。

提示词要求模型在开始较长工作、发现关键问题、改变方法及必要阶段结束时给出简短中文进展。这些是面向用户的结果/行动说明，不是内部计划审批或原始思考翻译。不要求每个工具调用或纯协议轮次机械生成一段话；前端不得编造模型没有输出的进展。

只要实际正文分片已产生，就提交并发布对应 block，不等待整轮模型响应结束。最终身份在系统完成门槛通过后确认；提前宣称完成的模型文字仍属于阶段内容，保留原始记录，并由循环纠正。阻塞时明确显示等待批准，不继续生成最终总结。

成功结束后，思考、工具和阶段说明可收纳为一个可展开的“执行过程”，展开仍保持原顺序，最终正文独立显示。失败、中断和待批准不能被统一标记为“已完成”。折叠是 UI 状态，不删除事件或原文，也不向模型隐藏执行事实。

## C06. 模型适配与原始思考

模型端口分成准备与执行：`prepareRequest(semanticRequest)` 返回冻结的实际协议请求，`stream(preparedRequest, signal)` 返回响应块及结束状态。

固定 requestId 的快照包括 adapterId、adapterVersion、protocol、endpointProfileId、模型 API ID、完整实际请求内容、工具规格、有效输出上限、思考档位、上下文版本、来源范围和内容 hash。API key、认证头和敏感 token 不进入快照或事件。

认证由适配器在发送时取得；失败重试可刷新凭据，但不能暗中改变语义请求。提供方返回的模型 ID 另存，不能覆盖原请求 ID。

DeepSeek Chat Completions 的原始 `reasoning_content`、`content`、`tool_calls`、finish reason 和 usage 分开记录。思考内容原样保存；不做翻译、摘要或修辞改写后再回传。

带工具请求中的历史思考按当前协议要求完整回传。压缩整个已结束消息组可以改变模型视图，但所有保留响应必须仍满足原始思考与工具配对要求；是否被端点接受须通过真实 API 门槛验证。

临时推理变量和 Agent 内部暂存可以不持久发送；提供方要求回传的原始思考不属于可任意丢弃的暂存。

Replay state（提供方回放状态）带 adapterId、版本和适用模型身份。跨适配器时不发送不透明签名或私有状态，转换由目标适配器明确完成并记录降级；本版不实现第二提供方。

完整工具调用参数必须通过注册规格校验。JSON 不完整或调用被输出上限截断时，记录失败并请模型修复；不以 `{}` 或猜测参数执行本地副作用。

厂商内置工具采用独立能力适配，不通过改 base URL 假定可移植。搜索保留查询、来源、工具状态和错误；没有证据时不能把普通模型文本标为已联网。

搜索内部请求使用独立 request 身份并计入用量，其响应显示在所属 tool block 中，不与主模型 turn 或事件 cursor 混合。

## C07. 上下文、记忆、语言和缓存

### C07.1 唯一准备入口

`ContextManager.prepare` 的输入是不可变会话事实、最新运行状态、有效要求、环境/资源版本、工具规格及模型预算。输出是冻结的 semantic request、上下文版本、来源清单和估算统计；经适配器编码并持久化后才发送。

建议输入顺序：

```text
稳定人格、职责和工具规则
→ 较早阶段摘要及其来源
→ 当前有效要求与必要用户原文
→ 近期完整响应/工具消息组
→ 有来源的环境、权限、任务快照
→ 本轮按需资料和新用户输入
```

首次创建上下文版本时完成有记录的组装，随后优先追加真实输入、模型响应、工具结果和变化快照。快照只有有效内容改变时才追加；不能每轮生成新时间戳破坏整个稳定前缀。

始终完整保存用户原文；模型输入可以按预算投影。临时语言提醒、系统快照、摘要不计为新的真实用户轮次。

### C07.2 要求与笔记

要求记录含 requirementId、原始 messageId/字节范围、原文或引用、状态和 supersedes（替代关系）。模型可提出提取候选，系统不能把模型自述当作用户撤销要求。

有效的细致要求优先保护。当前用户输入、未结算工具组和安全/权限事实不得被静默裁掉。预算不够时使用可读取原文、分段处理或明确的上下文维护失败状态，不发送谎称完整的截断内容。

模型笔记包含：判断、证据、已验证结论、失败尝试、否决方案及原因、下一步。每项指向消息、资料或工具结果；标明 inference（推断）与 observation（观察）。计划可变化，系统状态不能被笔记覆盖。

历史查询第一版支持按 ID/范围读取、有限文本搜索及资料片段读取，带授权、来源、截断说明与预算。未证明需要之前不引入向量数据库或复杂检索框架。

阶段 2 即实现同会话 `search_history` 与 `read_history`：前者返回匹配的 messageId、时间、原文片段、范围和总匹配/截断信息；后者按 ID/范围读取原文。禁止以当前请求的摘要作为搜索数据源。查询只覆盖当前有权访问的会话，输出有界，真实工具结果纳入后续模型上下文。两小时前等时间查询以保存的 UTC 时间筛选，显示时才转换用户时区。要求账本的完整策略在阶段 4 扩展，但原文找回能力不推迟。

### C07.3 预算与维护

`inputCeiling = contextWindow - actualMaxOutputTokens - safetyHeadroom`。保留预算和实际 API 输出参数必须一致。完整编码后的工具、消息、思考和多模态内容都计入估算；图像无法准确估算时标明估算来源和余量。

初始工程默认值建议：off 输出上限 8,192；normal 32,768；high 65,536 token。它们是可调整的产品预算，不是模型官方最大输出。有效模型容量以能力目录的版本和实际端点核对为依据。

初始压缩压力阈值可沿用输入预算的 75%，目标约 50%，并保护近期完整消息组。这些数值通过案例调整，不作为跨模型固定规律。

摘要事务记录覆盖范围、源消息指纹、摘要模型和用量。源会话在生成过程中发生改变时废弃候选；只有校验成功且有效减少预算后提交新版本。相同源指纹失败/无效后限制重复维护尝试。

工具长结果完整存入 artifact；模型获得相关片段、来源、总长度和读取入口。普通头尾截取只能作为显式降级，不能让中间错误或配置永久不可找回。

压缩只作用于已结束完整组。当前模型尝试或未结算工具组不能被切开。硬上限不足时停止新模型派发，保留原始数据并返回可恢复原因。

切换活跃窗口创建新 contextVersion；保留 run、environment、批准和执行状态。系统重新核实最新状态并引用旧历史。窗口切换重新组装活跃请求，旧历史仍可检索；它不同于仅把旧消息替换成摘要，也不能通过切换窗口清除要求或批准事实。

触发规则：达到预算压力阈值时先尝试有界的常规维护；维护失败或无有效收益，且下一请求超过 inputCeiling 时，系统可在完整消息组结束的安全边界尝试重建活跃窗口。重建仍超预算或丢失必要事实时阻止派发，不无限重建。

阶段 4 提供 `request_context_reset`（请求上下文窗口重建）工具，模型可说明理由、需要保留的资料引用和笔记。系统校验并记录请求；该工具消息组结算后才执行维护，模型不能直接删除历史、改变任务身份或授权。模型主动请求与系统预算触发均记录来源、理由、前后版本和预算结果。阶段 2 先建立版本及预算基础，不宣称已实现此工具。

### C07.4 语言与缓存

稳定提示词当前以中文维护。UI 语言、最终回复语言和思考偏好分别配置；跟随系统语言只作为用户选项。代码、路径、URL、协议键和日志保留原文。

语言切换不改写历史思考或工具结果。需要变更基础提示词时记录版本；不借追加系统消息假定所有协议支持相同覆盖语义。

DeepSeek 缓存自动管理、尽力而为。稳定工具规格、历史顺序和提示词有利于命中；日期、运行 ID、随机路径等放入有来源的动态快照。模型、语言、工具或压缩版本变化可以有意改变缓存前缀。

正确性优先于缓存：用户纠正要求、旧摘要遗漏/误解要求、真实环境或权限变化、提供方协议修复、必要的资料恢复与预算重建，都允许牺牲命中率。不得为了维持前缀而沿用失效状态、漏传必要 reasoning 或隐藏新要求。将缓存下降原因与相关请求版本关联，不把合法前缀变化视为功能故障。

记录 prompt input、output、reasoning、cache hit/miss、延迟和维护成本。字段缺失显示 unknown，不填成 0。缓存比例不作为唯一目标，比较总用量、成本、完成率和要求保留情况。

历史用量记录是该次请求的事实；当前上下文估算是派生结果。前端显示当前估算/上次实测来源、所属请求及模型，不以浏览器缓存冒充最新实测。

### C07.5 不可信内容

外部文件、网页、日志和用户引用的第三方指令是资料，不升级为系统规则。资料保留来源标识。工具授权和请求冻结由系统校验，不能靠提示词阻止所有注入。

模型笔记、摘要中的“用户已批准”“工具成功”只作为文字；判定仍读取实际批准和执行记录。

## C08. 资源、能力和工作集

发现返回 candidateId、规范路径、名称、类型、有限元数据、发现范围和时间。明确路径优先校验；名称搜索有时间、条目数、深度和结果上限，返回 scanComplete/limitReached。找不到时可改用其他范围或查找实现，不假装整个磁盘已搜完。

候选暂存也持久化，重启后能恢复对应批准请求；候选 ID 不能由模型伪造路径绑定。元数据发现不会授予读取正文、复制或写回能力。

系统排除凭据根和高敏感系统区域；默认允许在用户可访问的常用目录及配置范围内发现元数据。权限不足、未知重解析路径和受保护根返回明确原因。

能力含 capabilityId、resourceId、规范来源身份、允许操作、run/conversation/environment 范围、有效期、批准来源和撤销版本。

| 操作 | 授权语义 |
|---|---|
| `source.read` | 读取实际来源及物化 |
| `copy.read` | 读取当前工作副本中的获准资料 |
| `copy.edit` | 修改当前工作副本 |
| `source.deliver` | 固定变更集的一次写回，绑定独立交付批准 |
| `source.recycle` | 对具体源文件进行原生回收，绑定该对象与版本 |

初始工作区选择是持久的用户操作证据，可产生主要资源的读取/物化和副本编辑依据。外部资源默认批准范围是当前运行；已合法形成的副本和资料按会话保留，继续读取源目录须有当前有效能力。

环境中的 WorkingSet（工作集）记录挂载来源、baseline、copy、授权版本和可写性。旧目录来源能力到期不自动覆盖未交付副本。撤销后阻止新的源访问和主动资料获取；已经发送给模型的信息不能宣称撤回。

多资源物化保持 sourceId 映射，不把相同相对路径的文件互相覆盖。每项资源有独立根目录、基线及内容 hash。重启后通过持久身份重建，不依赖内存候选字典。

五级操作是系统内部能力，不对应五个必须逐一弹出的按钮。初始工作区的普通副本读取/编辑沿已授予能力继续。新增资源批准卡片用中文说明具体来源、用途及“读取资料”或“在工作副本中修改”；一次请求可包含必要的 source.read/copy.read/copy.edit 范围，禁止包含未披露的源目录写回。

源文件交付单独显示目标和固定变更范围；系统回收单独显示具体对象；宿主执行显示具体命令、工作目录及宿主执行范围。它们仍使用一个批准组件，用户统一操作“允许/拒绝”，技术能力键作为可展开细节。合并展示不合并不同副作用的批准事实，不把访问批准当成交付批准。

## C09. 结构化文件与宿主命令

### C09.1 文件工具

模型使用 resourceId＋相对路径或系统颁发的 fileRef；不能直接选择任意绝对路径绕过授权。

运行时拒绝 NUL、路径穿越、盘符相对路径、未授权 UNC 路径和 Windows 特殊文件路径。以最终目标/父目录检查 reparse point（重解析点）、junction 和符号链接；执行前再次核实根与目标身份。

物化采用独立复制，不采用硬链接。结构化写入对多硬链接目标拒绝或先安全建立独立文件身份；不能修改源目录的硬链接别名。读取二进制或编码不支持时返回类型/编码信息，不能伪造文本。

文件修改完成后记录新内容 hash 和 environmentRevision。测试、资料与临时文件保存于 task 区，默认不进入项目交付变更集。

### C09.2 命令执行

结构：program、argv、cwdRef、environmentId、environmentRevision、leaseGeneration、环境变量白名单、输入资料引用、scriptHashes、timeout、输出限制、运行时 ID。Shell 模式额外保存 shell ID、完整脚本文本和脚本 hash。

批准绑定 requestHash、environmentId、environmentRevision、工作目录、参数、脚本版本和范围。命令改变、脚本改变、环境修订改变或能力失效时重新判定，不能复用旧 allow。即使入口脚本未变，工作副本依赖文件发生变化也使原批准失效。

权限判定、等待和派发由同一环境调度者管理；等待批准期间不放行另一 run 修改该环境。工具启动前，在当前有效 leaseGeneration 下核对 revision 和受控工作区的相关内容指纹，提交派发意图后保持调度独占。可写宿主进程未结算/清理或核验前不派发该环境的新写入操作。

environmentRevision 是受管理修改的版本，不能单独发现用户、外部程序或已批准宿主代码的越权修改。相关清单/指纹变化需要先对账并更新 revision；无法确认进程和文件状态时进入恢复核验。该设计防止受管理并发与失效批准，但仍不宣称在无 OS 隔离时消除所有 TOCTOU（检查与使用之间的竞态）。

默认优先直接启动明确程序；PowerShell 采用无 profile 的受控入口，CMD 用于明确兼容需求。复合命令、嵌套调用、解释器内联代码、项目构建/测试均按实际代码执行能力评估，不能只看第一个单词。

宿主环境缺少 OS 文件/网络隔离时，测试、构建、任意 Shell 需要明确的 host-code-execution 批准。第一版批准默认为该具体执行；以后仅在经过验证的隔离环境或明确用户授权范围内复用。

自动模式自动放行已授权的受控文件和可信低风险操作；不会取消宿主代码执行、外部交付和敏感系统操作的独立批准。ask 模式对新增权限及代码执行询问，已获准副本内的普通文件操作按现有能力继续。

Git 操作按效果区分：状态/差异、工作副本历史、联网拉取、外部推送、破坏性重置分别判定。Git 配置、过滤器、hooks、凭据助手及项目脚本可能引入间接代码执行；第一版使用隔离配置并限制相关入口，不能把 `git *` 作为整体低风险白名单。

API key 不进入工具环境。只继承必要 PATH、系统变量及经允许的参数；日志按规则隐藏敏感凭据，同时保留结果核验所需资料。

hash 校验与批准有助于绑定具体内容，但没有 OS 隔离时不能消除全部磁盘竞态或限制被批准代码的行为。运行时报告实际保护能力，不夸大脚本 hash 的保证。

## C10. 变更集、交付与完成

变更集由基线与当前副本生成，包含 changeSetId、revision、environmentRevision、来源映射、目标相对路径、操作、baselineHash、desiredHash 和整体 fingerprint。

检测变化不读取用户界面的勾选状态决定任务。Agent 为目标选择本次必要变更，系统提供具体范围的 allow/deny 卡片；第一版不要求用户逐个选择实现文件。

交付批准绑定完整 fingerprint、目标身份、操作和内容。批准后源文件/副本变化导致原批准失效；必须重新生成和批准，不能悄悄把新增文件加入旧范围。

写回前对来源根及每项目标重新校验，比较 baselineHash。创建操作要求目标缺失；目标已是 desiredHash 时可核验为 already-satisfied，不重复写入，也不捏造原操作已确定执行。

逐文件实施使用同目录暂存和替换等平台可用方法，并保留结果/失败证据。SQLite 与磁盘操作不是一个事务；每项提交边界按 C11、C12 记录，部分失败保留逐项状态。

移入回收站使用独立原生入口，原生 API 成功及目标消失作为核验依据，无法确定时记录 unknown，不创建自定义 `.trash`。阶段 3A 的固定变更集 delete 是披露且获准后的永久删除；回收工具与交付删除不能互相冒充。不支持原生回收的环境返回能力缺失。

完成门槛：没有未接纳输入、未结算调用、待批准请求或未经解释的未知结果；任务要求的交付有已核验回执。拒绝交付后可以完成解释性回复，但 outcome 必须标记 delivery-declined，不能显示已交付。

模型认为完成而系统仍有必要交付时，保存阶段答复，进入 waiting_delivery；处理决定并回填后再生成最终交付说明。

运行有非必要临时文件不阻止完成；必要修改与 scratch 的分类由实际路径、来源与任务关联决定，不能仅由文件扩展名判断。

## C11. SQLite 与事务性持久化

### C11.1 渐进式表结构

以下列出目标表责任及已实施名称，按阶段建立所需表，不预建尚未使用的业务表。阶段 3A 的 schema 版本为 2，阶段 3B 为 3，阶段 4 为 4，迁移指纹基于实际 SQL 原文。

| 阶段 | 表 | 关键约束与责任 |
|---|---|---|
| 2 | `workspaces`、`conversations` | 工作区/会话关系、环境引用、设置版本 |
| 2 | `environments`、`runs` | 持久环境身份、修订、物理位置绑定及版本、运行状态、租约代次；限制一个环境的活动写入者 |
| 2 | `events` | `(conversationId, logEpoch, sequence)` 主键，eventId 及幂等键唯一 |
| 2 | `messages` | messageId 主键；引用提交事件；原始 payload/hash 不可变 |
| 2 | `model_requests` | requestId/turn 唯一、冻结快照引用、有效配置；attempt 事实由事件记录 |
| 2 | `tool_executions` | executionId 主键；call/turn/attempt 归属；environmentId 外键、派发时 environmentRevision、executionContextRef；状态及核验事实 |
| 2 | `approval_requests` | approvalId 主键、requestHash、对象版本、决定、当前有效性 |
| 2 | `artifacts`、`context_snapshots` | 内容 hash、资料路径/类型；上下文版本、来源及实际请求引用 |
| 3A 已实现 | `resource_candidates`、`resources`、`capabilities`、`resource_denials` | 固定来源身份、本次运行/会话能力、批准来源、拒绝等价重试 |
| 3A 已实现 | `mounts`、`materializations` | 来源与具体副本映射、基线资料、复制前计划及首次根身份绑定 |
| 3A 已实现 | `changesets`、`delivery_items` | 固定变更资料、原执行归属、逐文件意图、同目录暂存定位及核验回执 |
| 3B 已实现 | `process_executions`、`process_outputs`、`process_fingerprints` | 原工具执行的不可变命令快照、桥接/目标身份及退出回执、有序输出资料、目录漂移对账；复用同一连接和原会话游标 |
| 4 已实现 | `memory_entries`、`context_maintenance` | 来源笔记和候选绑定原 executionId；不可变维护计划、指纹与窗口版本；摘要清单及原始响应/用量资料沿原事件归约 |
| 各阶段 | `schema_migrations` | 迁移编号、应用版本、成功时间及 checksum |

工具执行记录的环境引用统一采用逻辑 environmentId，不能用物理目录路径充当该字段。所有阶段沿用同一记录格式；工具请求的具体目标另用受校验的区域/挂载引用和相对路径表达。

executionContextRef 指向派发时不可变的执行定位快照，保存在现有 artifacts 中，含 runtimeId、环境位置绑定版本、相关根/挂载身份、目标相对路径及核验指纹。environmentId 表示“属于哪个环境”，快照表示“当时实际在哪里、对哪个对象执行”；二者共同支持恢复，单独保存环境 ID 不足以核验磁盘副作用。

定位采用有 schemaVersion 的结构化记录，不使用自由文本。文件相关执行的 locations 按对象保存 environmentId、rootRef 和 relativePath；relativePath 始终相对于 rootRef 指定的那个根，不相对于进程 cwd 或整个环境目录。复制/移动可以涉及多个对象，不能强制每次执行只有一个位置。

rootRef 为运行时校验的带标签结构：task 类型含 area（scratch/artifacts/research/logs）与绑定版本；mount 类型含 mountId、area（working/baseline）与绑定版本；源目录对象采用 source 类型的 resourceId 与绑定版本，并遵守独立源访问/交付权限。mountId 在固定映射中指向 environment、resource 和该次物化的具体根，不能仅以“working”或文件名区分资源。标签及路径基准在阶段 2 的实际协议中固定，阶段 3A 启用挂载实现，不改写旧 task 记录。

派发快照保存操作前条件（例如原内容 hash 或确认不存在）及可预先确定的期望效果（例如 desiredHash）；实际操作后观测放在 tool.settled 或 tool.reconciled 的结果资料中，含内容/对象状态与核验时间。不能在派发前要求已知“操作后的实际 hash”，也不能在崩溃后把预期 hash 伪装成已观测结果。

内容 hash 只证明所核验内容相同，不单独证明文件身份或操作由本次工具完成。位置绑定、平台可用对象身份、前置条件、回执与效果共同支持判定。新建文件即使已满足 desiredHash，也按 C10/C12 标为已满足或对应核验等级，不捏造执行来源。非文件工具无需虚构文件定位或内容 hash。JSON 使用运行时 schema 校验；身份与关系仍遵守表外键和关联校验，不把整个执行记录都塞入无约束 JSON。

阶段演进优先保持已有标签语义；确需改变记录含义时增加 schemaVersion 和明确兼容解码器/迁移，不能承诺永远不需要数据迁移。

环境位置变化必须有版本化事实及身份核验。恢复未知执行时使用当时快照核对真实对象，不能仅查询当前环境路径后把旧操作解释为作用于新目录。旧位置缺失或无法确认对象时保留 unknown 并阻止盲目重试；已经提交的成功结果保留为历史事实，不因临时资料清理改写成未执行。

状态表是可重建索引/当前快照，与相关事件在同一事务更新；不能由其他入口直接修改。批准范围和回执可以读索引，但恢复必须能验证事件来源和版本一致性。

阶段 2 的有界 JSON 资料直接作为不可变内容存入 artifacts 表，并按 hash 核验；完整 provider response 通过 model.attempt_completed.responseRef 关联实际 attempt。后续大文件和日志按 C11.2 接内容文件存储，不在阶段 2 预建第二套资料仓储。

identity、状态、版本、关联 ID 等使用显式列、CHECK、UNIQUE、FOREIGN KEY。复杂内容存校验过的版本化 JSON 或 artifact，不能仅用任意 JSON 绕过关系约束。foreign_keys 必须开启；采用 WAL 和适当 busy timeout，实际性能在阶段 2 验证。

### C11.2 事务边界

| 边界 | 同一事务提交内容 | 提交后动作 |
|---|---|---|
| 用户输入 | 原文/附件引用、input.accepted、队列/运行记录 | 返回接收回执 |
| 模型请求 | 冻结 request、context/version、turn/attempt 开始事件 | 调用模型 |
| 响应增量批次 | 归属明确的 delta 事件 | 对外发布该批次 |
| 完整模型响应 | 不可变消息、完成事件、准备工具、状态快照 | 进入权限判定/下一轮 |
| 请求批准 | approval 请求、run.waiting、事件 | 发布卡片 |
| 批准决定 | 决定、有效范围、状态及事件 | 唤醒原运行 |
| 工具派发 | execution、dispatch intent、预算预留 | 执行副作用 |
| 工具结算 | 完整结果消息/资料引用、tool.settled、状态 | 回填模型及发布 UI |
| 交付项目 | 派发/结算事件及逐项回执 | 进入下一项或报告结果 |
| 停止 | stop_requested、状态、待执行抑制 | 取消及清理 |

持久化失败时停止新副作用。事件先提交再发布，网络丢失可重放。消息/工具/状态的相关批次失败时整体回滚。

大资料先写应用管理目录中的临时文件，校验并提交为 immutable blob（不可变内容文件），数据库引用成功后才可模型使用。崩溃产生的无引用资料通过受控清理回收；清理不会操作用户源目录。

原始数据库与资料有保留策略，删除会话不立即绕过正在运行任务的停止和清理边界。本文不建立“删除数据库记录就撤回已发送模型内容”的错误保证。

## C12. 恢复与未知副作用

| 持久状态 | 恢复处理 |
|---|---|
| 用户输入已接收，尚未派发模型 | 恢复同一队列项和环境，避免重复创建消息 |
| 模型请求已准备，尚未发送或发送状态未知 | 保留 request；依重试预算处理，可能重复计费必须如实记录 |
| 部分模型响应 | 保留已提交前缀及中断身份；完整工具参数未提交则不执行 |
| 批准请求已提交，没有决定 | 恢复原卡片并保持阻塞，不重新生成宽泛请求 |
| 批准已提交，未记录派发 | 重验对象及范围，通过后继续原调用 |
| 有派发意图，无结果 | 视作可能已执行；使用效果专用核验 |
| 写回后结果未提交 | 校验目标内容，记录已满足/冲突/未知；不盲目覆盖 |
| 进程可能仍在运行 | 检查启动时间、可执行文件、任务令牌和进程组；不能只用 PID |
| 工具结果已提交，界面没收到 | 重放事件，绝不重新执行工具 |
| 停止已提交，清理未完成 | 完成清理或标记未知，不能自动继续任务 |
| 交付部分成功 | 按逐项回执核验，保持原变更版本并处理剩余项 |

核验等级：`no-effect`（确认未产生效果）、`desired-state-verified`（目标状态已核验）、`receipt-verified`（有可信回执）、`unknown`。核验结果是新事件，不改写当时未知的历史。

恢复时先取得环境独占权、核验工作副本清单与资源身份、处理未知效果，再准备模型上下文。只重放已知事实到模型；完整原始事件不全部入模。

用户拒绝后回填明确 denied 工具结果，Agent 可以换方法。相同对象、相同目的重复请求受限；改变操作范围时必须生成新请求并说明实际变化，不能绕过拒绝执行等价副作用。

显式停止后不自动恢复。界面断线只解除订阅，不调用停止。配额耗尽/限流采用有限重试及可恢复原因；没有外部状态变化时不无限自动续跑。

## C13. 进程通信与桌面边界

Envelope 包含 protocolVersion、messageId、correlationId、kind（command/ack/result/event/error）、有效归属和 payload。所有进程入口运行时校验，不依赖 TS interface。

就绪握手：主进程启动 Agent，等待 ready（协议版本、实例 ID、数据库版本、可用能力）。不兼容或恢复检查失败时提供明确状态，禁止将 spawn 事件当成 ready。

ack 表示命令持久接收；result 表示命令阶段结果。长任务持续状态通过事件提供，不让一个 Promise 从开始悬挂到任务结束。

启动、接收和查询设置有限超时；超时查询原 commandId 的接收状态。丢失 ack 不创建新 commandId 再次写回。退出后旧实例的迟到消息通过 instanceId 拒绝。

订阅采用 C03 cursor。慢消费者缓冲有上限；达到上限时要求从持久日志重连，不静默丢事件。主进程不再写第二份业务日志。

preload 只暴露有限调用。文件选择由主进程返回经过校验的选择证据；预览/打开本地位置使用 fileRef 或资源 ID，经 Agent 查验后交给主进程。渲染器不能提交任意系统路径让主进程直接打开。

原生回收站操作由执行器产生固定请求，再由有权限的 HostActions 实现；主进程不能因为 renderer 发来 `trash(path)` 就执行。

子进程崩溃后主进程按单实例规则重启 Agent，由恢复入口处理业务状态。关闭窗口、关闭应用、主动停止三种操作按产品明确规则区分，不共享一个取消信号。

## C14. 错误、版本与实现完成标准

对外错误有 code、中文 message、retryable、scope、detailsRef：`PROTOCOL_INVALID`、`COMMAND_CONFLICT`、`CURSOR_INVALID`、`PERMISSION_DENIED`、`APPROVAL_STALE`、`RESOURCE_CHANGED`、`CONTEXT_BUDGET_EXCEEDED`、`PROVIDER_QUOTA`、`TOOL_OUTCOME_UNKNOWN`、`DELIVERY_CONFLICT`、`PERSISTENCE_FAILED`、`UNSUPPORTED_CAPABILITY`。

错误分类依据实际来源，不能用所有异常都叫“工具失败”。未知执行结果不能通过 error 文案变成确认未执行。

事件协议、数据库 schema、上下文策略、提示词和适配器分别有版本。旧事件通过明确解码器读入；无法理解的事件阻止状态推进并返回兼容性原因，不被静默丢弃。

功能完成必须同时满足：实际入口可调用、关键事实可持久化、重放一致、故障边界验证通过、迁移文档记录证据。仅有接口、Mock 或 Markdown 设计不能标为已实现。

## 阶段 3A 实施对齐说明（2026-10-04）

- C01/C08：初始用户选择授权会话范围的 read/edit；外部资源批准限定 run。read 覆盖来源物化与副本读取，edit 额外覆盖副本修改；源交付/回收仍是具体执行批准。获准副本编辑自动执行，不延续 scratch 每次写入都批准的测试策略。ask/auto 当前都保留外部新增及源副作用批准；无限授权与撤销管理入口未实现。
- C06/C11：基线以不可变 manifest 和内容 hash 资料实现，没有物理 baseline 目录。working 的 rootRef 指向具体 mount；旧 task/scratch 定位保持。物化前保存计划，创建根后首次绑定对象身份；半成品恢复不重新复制。source/mount 绑定含物理身份；内容相同不单独证明执行来源。
- C10/C12：变更集不可改写，源内容与对象身份在批准后再次核验；逐项意图和回执共享原执行身份。未知效果依原快照核验，不重派发。delete 交付是永久删除；回收使用独立 Windows 原生桥接。来源刷新、合并、完整元数据镜像及多文件原子回滚未实现。
- C03/C05/C07：新增资源和交付事实沿用同一会话游标与纯归约。模型上下文增加可信挂载/失败/排除范围视图，未塞入全量事件日志。上下文压缩、要求清单及长期历史索引仍待阶段 4。
- C09/C13：原生回收桥接只运行固定程序与固定脚本，结构化参数来自已核验源对象；子进程不继承 API 凭据。它不是通用宿主命令能力或 OS 沙箱。Electron 宿主动作及受限 IPC 接口仍待桌面阶段实现。

具体函数、边界、验收及尚未实现事项见 [阶段 3A 报告](stage-3a-report.md)。上述声明区分当前实现与本文其余目标能力，不能把目标设计当作现有产品行为。

## 阶段 3B 实施对齐说明（2026-10-04）

- C09：`run_command/run_shell` 统一经过 ToolExecutor；所有宿主命令具体批准，包括 auto 模式及 Git 检查。批准绑定完整执行快照及目录内容，依赖变化使原批准失效。
- C11：schema 3 保存进程计划、桥接所有者、挂起目标、释放意图、有序脱敏输出和回执。先保存 owner 再允许创建目标，先保存 release 意图再释放目标；仍由同一连接和会话游标提交。
- C12：重启核对 PID + 原生创建时间，在同一句柄验证身份后终止。未知退出不重跑、不把文件存在当成执行成功；清理不明保持阻塞，可追加核验资料而不改写旧回执。
- C13：当前仅 Windows Job 管理普通进程树，无 OS 文件/网络隔离。外部服务/WMI 代启动的进程可能超出 Job；批准不是安全隔离。Docker/WSL 插件、Electron IPC 仍未实施。
- C07：进程输出给模型的是有界脱敏摘录与可按范围读取的来源；不把全部原始进程事件塞入模型。完整消息组压缩和长任务记忆仍在阶段 4。

实际函数、限额及验收见 [阶段 3B 报告](stage-3b-report.md)。

## 阶段 4 实施补充（2026-10-04）

C03/C04：实际事件名称以 protocol 运行时 schema 为准。新增 memory.recorded、context.maintenance_started/response/usage/failed、context.window_committed；原设想 requirements.updated、note.recorded、maintenance_settled 未另建平行事件。

C07：唯一异步入口为 ContextManager.prepareTurn，纯 prepare 用于投影。全部已应用用户原话保留；模型要求提取和 supersedes 为候选，不撤销原文。模型记忆观察须逐字引用单一来源，其余为有来源的模型记录。完整工具组退休，保留原始 reasoning；75% 压力、约 50% 目标、最近 6 个完整 assistant 组保护。主动 request_context_reset 在工具组结算后执行。维护输入和输出有界，源指纹变化废弃候选；硬预算失败以明示片段降级或可恢复中断结束。一次 run 最多 4 条维护记录，同版本/来源/模式不重复收费请求。

C09：宿主批准由 dispatch 强制验证工具/run/hash/allow，CommandTools 在释放前再次核验。未扩大授权范围，cwd 和 Job 不冒充 OS 沙箱。

C11/C12：schema 4 仅新增 memory_entries 与 context_maintenance，维护计划、原始响应、清单与 usage 复用 artifacts，窗口提交沿原事务和纯归约。启动只对账 started 维护，不自动续跑；已记录笔记依原 executionId 核验，不重复新增。原有历史、事件游标和执行定位不改写。

实际文件、字段、函数、验收范围与剩余限制见 [当前技术说明](current-state.zh-CN.md)。桌面 UI 与 IPC 仍属阶段 5。


## 阶段 5 实施对齐（2026-10-04）

C03/C05/C13：Electron utility process 组装唯一 UmiApplication，页面使用同一事件 schema、会话游标和 reduceConversation。运行时校验、就绪确认、实例身份、超时、待处理上限和失败退避已实现。传输为有界 IPC pull，未增加 HTTP/SSE 服务。

C07/C12：新增 context.budget_blocked/cleared，预算原因与指纹持久化。相同超限条件下恢复不推进世代或调用模型；条件改善后恢复仍重检，下一请求通过才清除阻塞。完整用户原文超过模型上限时仍保持阻塞，没有静默折叠。

C11：schema 5 仅新增会话显示与附件绑定数据，不新增平行事件、工具或 Agent 状态。旧事实、迁移指纹和执行定位保持。

C08/C09/C13：既有资源、交付和宿主命令授权保持；渲染器隔离不冒充命令 OS 沙箱。Docker 与 WSL 分别配置和检查，模型使用原具体批准命令入口；未建立容器 Runtime 或管理子系统。

A38—A41/A44：已验实时/历史、持久设置、IPC 与实例边界、窗口隐藏/退出/停止区别、实际打包 Node/SQLite、分轮展示与完成折叠。界面使用 input.accepted 顺序，模型上下文使用 input.applied 顺序。

具体函数、证据和未实现范围见 [阶段 5 报告](stage-5-report.md)。


## 2026-10-10 C07/C12：bounded-v1 活跃投影契约

本补充更新此前“全部已应用用户原话保留于活跃请求”和“一次 run 最多四条维护记录”的行为；永久原始历史与授权事实继续保留。实际版本字段与校验以 protocol/MemoryRepository 为准。

- 最新已应用用户消息不得归档；旧用户消息仅在显式 bounded-v1 计划中可按完整消息组退出活跃窗口。旧无版本清单仍禁止归档用户原话。错源哈希、未知版本、最新输入和半工具组拒绝提交。
- 新窗口清单保存全部折叠用户来源的 messageId、原始 payload 哈希、projectionSequence、UTF-8 字节数和原话片段。重载需与原记录重新核对；模型摘要不构成要求、授权或成功事实。
- 活跃原话索引最多 12 项，每项最多五个字节摘录；短旧原话额外保留最多六项、合计最多 4096 字节且不超过输入预算的 8%。工具长结果只缩短模型投影，保留调用与结果完整分组及 raw reasoning，原始结果不改写。所有投影开销仍进入最终预算。
- list_user_requirements 同会话只读分页定位全部已应用输入；search_history/read_history 读取原始记录。折叠、未展示或摘录不能自动撤销要求。旧语义限制仍需追回原文后判断，宿主权限独立检查。
- 新退休组包含用户消息时使用本地确定性索引及抽取，不请求摘要模型；其他维护继续使用已有模型摘要路径。同 run 最多四次模型维护请求，本地无费用维护不占此计数。源指纹变化、lease 失效或取消不得发布过期候选；原来的状态/版本/环境和恢复事务约束继续适用。
- 最新输入及明确保留内容自身超限仍明示阻塞，不静默剪裁。UTF-8 保守估算不是实测 token；有界投影不保证语义召回或任务完成。
- 不新增表或修改历史 SQL。新代码兼容旧清单，旧程序读取新归档用户原话清单不作保证；降级需要显式数据兼容安排。

实现与本轮检查见 [当前技术说明](current-state.zh-CN.md)。本轮 93/93 相关测试通过（新增 13 项包含其中），并通过类型检查与桌面构建；没有真实模型、生产会话库或发布验收。

## 2026-10-11 当前文本写入补充

write_file 默认 mode=create，仅新建；wx 独占名称，目标已存在或晚到时不覆盖。mode=replace 必须绑定当前会话同环境成功的完整 read_file 执行回执、哈希和对象身份；完整读取单次最多 64000 字节，部分读取不授权整文件替换。edit_file 继续处理实际读取范围内的唯一片段，两者共享只读证据校验。

派发后再次核验位置/版本，no-op 不落盘；写后回读才结算成功。新建中断可能留部分文件/父目录，恢复只观察原冻结目标，不删除或重放；旧已经派发且没有 fileWrite 快照的执行仍只核验原目标状态。应用层路径与替换复查不是 OS 沙箱或原子 CAS；源交付继续独立批准。详见 [当前技术说明](current-state.zh-CN.md)。

## 2026-10-11 独立成果与导出补充

create_output/capture_output 仅在当前会话 Umi 自有成果范围创建冻结文件；outputId 绑定实际成功创建执行/快照/回执。list_outputs 只列元数据，read_output 核验字节后有界返回；二进制默认元数据，显式 base64，mime 只是声明。

export_outputs 冻结具体成果及本地绝对目标、父目录身份，批准前无导出副作用；dispatch 强制原请求 allow/hash，不能靠变更 effect 绕过。批准后的晚到目标不覆盖；逐项 intent/receipt 不可改写，批次可部分完成。unknown/重启只核验原目标，不重放或清理。新输入后 inspect_export 提供只读当前证据，export_receipt 与生成证据严格区分。

固定桌面 list/preview/inspect/open_export 不向页面开放任意文件路径或执行；open_export 核验原目标后仅定位文件。本轮不新增表/迁移、renderer 控件、覆盖/删除权限或 OS 沙箱。预算、竞态及留存限制和本次 117/117 检查见 [技术记录](outputs-export-20261011.zh-CN.md)。

## 2026-10-11 历史执行准备补充（cwd 指纹已被下文修订）

inspect_execution 不运行工具或安装，返回有界观察和真实 inspectionExecutionId；located/observed 不是就绪或版本验证。preparation 可绑定当前会话同 cwd 的成功检查，清单/入口/选定输入漂移及不完整观察拒绝。具体批准展示完整命令、准备目的、联网/脚本声明和任务缓存；缓存祖先安全复查，无准备前建目录。声明和缓存变量不构成强制宿主网络/文件隔离。同 run 拒绝不能更换检查回执/描述重复申请。

原实际程序 hash/cwd 完整指纹/派发强制批准/挂起复查/Job/回执恢复保持。准备完成后需重新观察和实际测试，不拿退出 0 当用户目标完成。cwd 增加 artifacts，旧调用/快照继续兼容；没有新 SQL 迁移或 UI 控件。大依赖树受既有完整指纹预算限制，本次验出并保留，不用浅元数据替代内容保护。场景、学习链及实际 191/191 检查见 [当前技术说明](current-state.zh-CN.md)。

## 2026-10-11 Desktop output UI

The fixed chooseOutputTarget bridge validates the same-conversation output through preview_output before showing a native save dialog. Selecting a path only appends a user-editable export request to the current draft; cancellation has no write or send effect. Sending uses the existing AgentEngine/ToolExecutor/approval/intent/receipt path. It does not add a renderer filesystem write API or direct user export dispatcher. tool_detail exposes a bounded, fixed inspection projection for successful inspect_execution only; other tool result data remains unavailable through that view. List metadata is not current byte proof; preview verifies bytes, inspect_export observes original targets, and open_export rechecks before revealing the location. Preparation summaries describe historical observation, not readiness or OS confinement.

## 2026-10-11 命令观察与桌面加载简化

新命令快照使用 cwdObservation=root-identity，cwdFingerprint 仅为读取旧快照保留。prepare/dispatch/ready 不再递归哈希 cwd；退出回执 cwdAfter/inspectionError 为 null，不声称已扫描文件效果。旧派发操作仍按旧事实恢复，旧待批准请求刷新上下文后需重新批准；不改历史 SQL、artifact 或 process_fingerprints 表。根/程序/完整请求 hash、原 allow、lease 与未知恢复保持。普通文件变化不再重批；链接依赖子树可由宿主执行访问，根路径及结构化文件工具仍拒绝链接逃逸；这并非 OS 文件/网络限制。

command_exit 核验同一执行真实退出 0、gate 已释放且 Job inactive，并保留原任务的参数/来源/最新输入约束；不再核验整个 cwd 当前内容。它不代替当前 file_hash、delivery 或 export_receipt。修改后测试须在修改后执行，未新增自动时间依赖推理。inspect_execution/preparation 可选，显式绑定的清单/输入仍需复查；联网声明不是网络开关。

DesktopService 查询用户原话并复用一次 reducer 状态；模型消息完整组与 applied 排序不变。Timeline 首屏近期 8 条用户消息，按需展开和导航，未渲染不等于删除或模型上下文归档。性能证据与范围见 [阶段技术记录](streamline-and-session-loading-20261011.zh-CN.md)。
