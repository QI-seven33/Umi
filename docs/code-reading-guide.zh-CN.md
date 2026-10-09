# Umi 代码学习与开发指南

> 配套：[当前架构与开发报告](current-project-report.zh-CN.md)。目标：沿真实调用链解释行为，知道改动应该落在哪一层。

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

完成标准：解释“副本已修改，来源未变”如何成立。再解释单文件为什么变成父目录，以及修复必须贯穿哪些契约。

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

用专用小测试目录练习，记录资源批准和交付批准分别授权什么。当前单文件粒度限制见主报告。

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
