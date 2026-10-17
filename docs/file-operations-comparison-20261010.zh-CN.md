# Umi 文件增删改查：调用链与参考项目比较

> 2026-10-10。Umi 以当前源码为依据；本地 Harness 为提交 639ed015397290b3745d163aafe02ffee4aa3f84，Git 无本地改动。Reasonix 本轮已取得官方当前 studio 提交 afa05c118365b2744767678c7650bf08c586a0bd 的选定文件源码，目录为 internal/tools/builtin。此前研究引用的旧目录缓存不是本轮当前源码证据。没有运行两个参考项目，不宣称全量审计。

## 后续实现补充：edit_file 已可用

本轮已增加绑定成功 read_file 回执的唯一文本替换工具，并通过 ToolModule 组装；整文件 write_file 仍保留。它只修改获准工作副本，冻结 ChangeSet 与源文件交付依旧独立。新增工具的字节/范围/恢复契约、模块边界及 Umi → MXC 组合实验见 [局部编辑、模块组装与 Umi 适应 MXC](text-edit-modules-mxc-20261010.zh-CN.md)。下文对当时“仅整文件写入”的描述是此前研究时点；Harness/Reasonix 的固定源码对照未在本轮重新审计。

## Umi 操作的是哪一份文件

用户选择的工作区由 ResourceFiles.bindInitial 授予副本编辑范围并物化。额外位置先 discover_resource，再 request_resource；发现只读取定位元数据，资源批准后才读取并复制内容。单文件范围只允许对应相对文件，不能借用其父目录访问其他文件。

物化保存来源基线和托管工作副本。文件工具用 environmentId、mountId、相对路径定位副本；副本修改和源文件写回是两种权限。

```text
用户输入 → DesktopService → UmiApplication → 唯一 AgentEngine
→ ToolRegistry 参数校验 → ToolExecutor.prepare / 批准 / dispatch
→ ResourceFiles + 文件工具 → settle / 真实回执 → 下一轮模型

副本编辑 → build_changeset → 冻结内容与预览
→ deliver_changeset 具体批准 → 冲突核验 → 逐项来源写回与回执
```

## 增、删、改、查分别怎样实现

| 操作 | 工具与行为 | 关键检查 |
| --- | --- | --- |
| 增 | write_file 在副本中写入不存在的相对路径；必要时创建父目录 | 范围可编辑、位置属于当前环境；prepare 保存目标缺失状态；执行再核对 |
| 改 | write_file 用完整 UTF-8 content 替换副本文件；目前没有局部替换/补丁工具 | 派发前后 hash 与对象身份；同目录临时文件写入、fsync、rename，然后回读目标 hash |
| 删副本 | delete_file 通过 unlinkSync 删除副本中的一个普通文件 | 与写入相同的位置、范围及派发前检查；删除来源需要另行交付 |
| 删来源 | ChangeSet 的 delete 项批准交付后，DeliveryFiles.apply 删除真实来源 | 核对原来源与副本，先保存逐项 intent，再删除、观察和提交 receipt；这是永久删除 |
| 回收来源 | recycle_file 经独立批准，固定 Windows 原生桥接移入系统回收站 | 绑定原路径、对象身份、内容；核验原生回收站条目。不是 .trash，也不是 delete_file 的默认行为 |
| 查 | list_resources、list_files、stat_file、read_file、search_text | 限定获准副本及资源范围；read_file 按 UTF-8 字节分页，提供 hash/范围/截断；二进制只返回元数据 |

search_text 检索副本 UTF-8 全文件，返回每个命中文件的首个匹配摘录；它不是完整 ripgrep/正则搜索。当前结构化文件观察上限 4 MiB，write_file content 最多 256000 字符，读取每页最多 64000 字节。大量或特殊文件仍有明确限额。

学习入口：[文件工具](../packages/adapters/src/host-files/tools.ts#L177)、[safeFile/observe](../packages/adapters/src/host-files/paths.ts#L56)、[atomicWrite](../packages/adapters/src/host-files/paths.ts#L149)、[交付](../packages/adapters/src/host-files/delivery.ts#L221)、[回收工具](../packages/adapters/src/host-files/recycle.ts#L140)。write_scratch 是另一个托管临时区验证工具，需要批准，不交付到用户项目。

## 批准、冲突和恢复

ToolExecutor 在副作用前保存 dispatch，批准绑定请求参数、环境和定位；等待批准后重新准备，条件改变使旧批准失效。safeFile 拒绝路径穿越、链接/硬链接和特殊对象，并核对根身份。

ChangeSet 将来源 baseline 与副本 after 比较，冻结 create/modify/delete 内容。交付时还核对来源与副本；多文件按项记录 intent/receipt。中断后的 reconcile 核验原执行，不盲目再写。副本目标符合 desired hash 时只能证明目标状态，不能因此证明原执行来源。

这些检查没有提供全文件系统锁或多文件原子事务。来源的并发变化通常会变成冲突，但仍存在检查与实际系统调用之间的竞争窗口；部分交付保留，不会自动全量回滚。宿主命令仍没有 OS 文件/网络沙箱，不能把副本范围规则当成 run_command/run_shell 的隔离保证。

## 与 DeepSeek Harness 比较

Harness 的模型工具调用 ctx.fs，具体宿主实现由 fs-local 或 fs-sandbox 提供。标准套件包含 read/write/edit/read_image；str_replace_editor 另提供查看、新建和精确替换。此套件本身未提供独立删除整文件/系统回收站工具，Shell 删除属于命令策略路径。

fs-local 直接修改真实目标。启用 fs-observation-policy 时，已有文件覆盖绑定此前观察到的版本；未读目标仅尝试 createIfAbsent，edit 没有读取记录则拒绝。局部 edit 默认要求唯一字面匹配，可显式 replace_all。提供目标锁、原子写入、换行处理；realpath 派生身份使路径别名共享版本保护。独立 fs-sandbox 对写入落实 read-only/workspace-write 等路径策略，源码明确它不是运行不可信代码的内核隔离。

该保护取决于实际插件组装：没有 observation-policy 时底层调用可无条件修改；fs-local 的 cwd 只是相对路径基准。原子落盘也不等于没有外部并发保存的竞争窗口。本轮没有重新执行上游测试。

对应本地源码：[tool-fs](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/tool-fs/src/index.ts)、[观察策略](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-observation-policy/src/index.ts)、[LocalFileSystem](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-local/src/index.ts)、[路径策略](E:/Deepseek-Harness/dsh-learn/deepseek-harness/packages/fs/fs-sandbox/src/index.ts)。

## 与 Reasonix 比较

当前选定源码中，write_file/edit_file/multi_edit/move_file 直接操作工作目录目标，必要时通过 host overlay 更新未保存编辑器缓冲；并非 Umi 的副本与二次交付流程。

read_file 按行分页并支持编码探测；写入保持原编码，落盘路径使用原子覆盖。edit_file 共享实际执行与 Preview 的转换逻辑：优先字面唯一匹配，允许有限的换行/缩进等 fuzzy 匹配，并生成实际匹配与替换的回执；不能仅依据工具 Description 的“exact”判断它绝不模糊匹配。[读取源码](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/readfile.go)、[编辑实现](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/encoding_helpers.go)、[预览](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/preview.go)

FileViews 可防止 write_file 覆盖与上次读取/写入不同的内容，但没见过的文件不会因此拒绝覆盖；nil FileViews 不做跟踪。ConfineWriters 按 run 注入允许根，并保护会话库；空根模板本身不限制位置，因此仍需核对组装入口。move_file 检查源/目标端点，目标不得已有另一个文件；跨设备采用复制后删除。delete_range/delete_symbol 删除内容范围或符号，不等于删除整个文件。[写入](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/writefile.go)、[版本跟踪](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/fileviews.go)、[路径约束](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/confine.go)、[移动](https://github.com/esengine/DeepSeek-Reasonix/blob/afa05c118365b2744767678c7650bf08c586a0bd/internal/tools/builtin/movefile.go)

本轮仅核对选定文件工具。没有据旧研究中的 Windows 沙箱结论推断这个新提交，也未全量核对所有产品入口的授权、Shell 删除或恢复实现。

## 对 Umi 的具体启发

| 项目 | Umi | Harness / Reasonix 可借鉴处 |
| --- | --- | --- |
| 文件修改目标 | 托管副本，来源交付独立批准 | 直接工作目录编辑更贴近常规代码开发；Umi 若加入直改模式，需独立明确权限契约 |
| 小范围修改 | 当前整文件 write_file | 局部 edit/multi_edit 能减少模型输入输出、保留无关代码和注释；优先提供唯一精确匹配并输出实际 diff |
| 防覆盖 | prepare/dispatch 的目标快照与来源交付 baseline | 增加“模型上次读到的版本”保护：当前 Umi 没有要求已有副本必须先读，也没有绑定上次 read_file 的 hash |
| 交付恢复 | 冻结 ChangeSet、逐项 intent/receipt、unknown 核验 | 保留此链路；上游预览、工具成功正文或原子写入不能替代 Umi 的来源交付证据 |
| 读取效率 | 字节分页、普通文本搜索 | 可增加行分页、精确编辑与流式搜索；按同一任务测量质量与费用后再选择 |

例如：修一个 HTML 的两行 CSS，Umi 当前可能读文件后生成整份新文本到副本，再批准交付。合适的后续改进是让模型提供唯一 old_text/new_text，加 read hash 防陈旧编辑，仍沿用现有副本、ChangeSet 与恢复链路。该改进尚未实施，本轮只开发有界上下文。
