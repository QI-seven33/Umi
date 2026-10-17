# Umi 文本创建与整文件替换：契约和源码阅读

日期：2026-10-11。本轮是文件路线第二阶段。此前发现/分页和任务验收已落地；当前修改着重闭合“明确对象 → 已读版本 → 写入 → 回读 → 可恢复反馈”，没有新增循环、迁移、UI 或插件框架。

## 为什么保留一个 write_file

模型仍使用原工具名，通过 mode 表达意图，避免再增加一个可绕过读取保护的覆盖工具。create 为默认值，只能新建；replace 必须显式指定并提供 readExecutionId、expectedReadHash。参数校验和宿主校验同时生效：模型传来的哈希本身不是权限，宿主要查真实工具与已保存回执。

| 操作 | 前提 | 结果与权限 |
| --- | --- | --- |
| write_file / create | 批准的可编辑挂载、路径不存在、合法 UTF-8 文本 | wx 独占新建；可创建父目录；已有/晚到文件不覆盖 |
| write_file / replace | 同会话同环境真实成功的完整 read_file；位置、哈希、对象身份匹配 | 派发后再次核验；整文件替换；相同内容 no-op |
| edit_file | 同样真实读回执；oldText 位于实际读取范围且唯一命中 | 精确字节替换；不修改无关字节 |
| deliver_changeset | 冻结具体来源/变更集并得到独立批准 | 核验后写回真实来源；副本成功不代表交付成功 |

新调用未指定 mode 时不再覆盖已有文件。旧已经派发的 write_file 若无 fileWrite 快照，恢复仍按原冻结位置/目标哈希只观察；不会按新规则再执行一遍。旧尚未派发的覆盖请求需要改为完整读取后显式 replace。文件删除/回收和来源交付的契约未扩大。

## 跟着一次实际调用阅读

1. [file-write.ts](../packages/protocol/src/file-write.ts)：纯参数与冻结快照 schema。create 不接受替换回执；replace 缺回执/哈希直接拒绝。content 上限 256000 个 JavaScript 字符，不是字节限额。
2. [tools.ts](../packages/adapters/src/host-files/tools.ts) 调用 registerTextWrite，仍由原 umi.files 模块提供工具。[executor.ts](../packages/agent/src/tools/executor.ts) 继续负责准备、授权事实、派发及结算。
3. [text-write.ts](../packages/adapters/src/host-files/text-write.ts) 的 prepare 先走 mountContext，检查当前可编辑范围、挂载绑定与路径。replace 再调用 [read-evidence.ts](../packages/adapters/src/host-files/read-evidence.ts) 的 requireTextRead，核对真实成功 read_file、会话/环境、输入位置、读取上下文与结果，不靠模型自报。
4. prepare 检查完整读取、当前哈希/身份，以及回执 text 是否还原相同 UTF-8 字节；保存 mode、原执行身份、读结果引用、before/desired hash 与 noOp。
5. execute 重新准备并比较冻结上下文，落盘前再观察。create 调用 [paths.ts](../packages/adapters/src/host-files/paths.ts) 的 createExclusive；replace 复用 atomicWrite 的暂存、fsync、版本复查和同目录 rename。写后回读目标哈希才给成功回执。
6. reconcile 不调用 execute，也不重新创建文件。目标符合 desired hash 则核验当前目标状态；仍是 before hash/identity 则确认原状态；其他字节/对象/路径不确定则 unknown。目标字节一致不证明原操作者身份，回执对此有明确说明。

requireTextRead 是一个小的共享校验函数：局部和完整修改使用同一规则，证据端口只读，不取得 SQL 写入口或批准能力。文本意图、文件落盘和循环编排仍分别归属各自文件；这是实际变化点的拆分。

## 边界与已知限制

read_file 的单次 byteLength 最大 64000。整文件替换当前要求一份完整回执；不把若干片段拼接后冒充完整观察，也不把 hash 当成模型已经看到全部文本。超过该预算使用分段读取和 edit_file；二进制、显式目录操作及独立成果接口尚未在本轮实现。UTF-8 BOM、CRLF、中文按传入内容精确编码；完整替换不自动合并未包含内容。NUL 和不完整 Unicode 明确拒绝。

createExclusive 的 wx 原子占用名称，已有文件不会被截断；整个正文写入不是原子事务。创建父目录后发生故障可能留下目录，落盘中断可能留下部分文件；不能断言所有失败都零副作用。未知结果由原恢复规则核验，不自动删掉可见部分文件。

路径/联接/硬链接/根身份有应用层检查，但检查与系统调用之间仍存在竞态。atomicWrite 的版本检查也不是 OS 原子 CAS。宿主命令能访问当前用户有权访问的目录与网络；上述文件工具契约不约束任意 Shell 副作用。后续边界计划应如实区分它们。

## 本轮验证

新增 [text-write.test.ts](../tests/text-write.test.ts) 的 24 项专项场景；首轮与局部编辑合跑 42/42；补充桌面模型场景后，最终相关 16 文件 207/207。覆盖新建不覆盖、派发后文件/路径变化与取消，真实完整读后的 BOM/CRLF/中文/no-op，缺失/错位置/错哈希/过期/换对象/部分/二进制/跨会话回执，非法文本，以及 create/replace 在 tool.started/tool.settled 提交失败后的只观察恢复。部分文件与旧冻结上下文也有恢复核验。

[桌面内部验收模型](../apps/desktop/verification-model.ts) 同样迁移为真实读取和显式替换；长变更集结果在有界窗口中截断时，经 read_history 取回头部定位再申请交付。新增离线贯通场景核验来源在批准前不变、批准后才写回；没有启动真实 UI。原资源、单文件授权、源交付、崩溃工作进程与任务验收测试使用 [file-write-fixtures.ts](../tests/file-write-fixtures.ts) 发出真实 read_file → replace 调用，没有伪造回执。批量替换多了一轮读取，但批准仍只有来源交付的一次；初次失败是旧请求次数断言未更新，已改为实际流程并重跑通过。

类型检查、核心和桌面构建通过。所有数据在临时目录/测试 SQLite；没有调用真实模型、操作生产会话、启动产品或重新发布。学习注释、原已有修改及前端/CSS 保留。完整工作备份和证据位于 E:\Codex\Workspace\output\umi-text-write-20261011；历史案例数量没有计入本轮重新验收。

## 参考取舍与下一阶段

Harness 本地固定提交 639ed015397290b3745d163aafe02ffee4aa3f84 的观察插件，对不存在对象施加 createIfAbsent，对已观察对象施加 replaceIfVersion；没有观察时阻止 edit。它把意图、观察策略和提供方守卫分开。Umi 借鉴这部分，但读取保护是内置默认规则，不依赖用户加载观察插件。[本地策略源码](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-observation-policy/src/index.ts)

Reasonix 当前官方工具契约同时提供 read/edit/write 和 bash，把构建、测试与 Git 交给命令，把直接文件操作交给文件工具；write_file 描述仍允许覆盖，不能据此推断全部替换都绑定读取。[官方工具契约](https://github.com/esengine/DeepSeek-Reasonix/blob/studio/docs/TOOL_CONTRACT.md)

Kimi Work 公开说明区分一般自动操作与修改/覆盖/运行代码批准，适合借鉴清晰的授权反馈；公开文档不足以证明其内部 Windows OS 隔离。[官方权限说明](https://www.kimi.ai/zh-hans/help/kimi-work/kimi-work-faq)

下一阶段优先独立 Artifact/Export：用户可在 Umi 自有成果空间先生成、预览，再批准导出具体目标；不必为生成一份文件先授予整个来源目录编辑权限。执行方向以本地效率和可靠观察为主，Docker/WSL2 保持可选；详细契约与验收见 [执行边界计划](execution-boundary-plan-20261011.zh-CN.md)。
