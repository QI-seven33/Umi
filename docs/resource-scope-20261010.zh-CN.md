# Umi 单文件资源、物化失败与恢复反馈

> 日期：2026-10-10。源码实现与本轮隔离验证记录；产品名称为 Umi。

## 1. 行为变化与契约

以前 `discover_resource(path=某个文件)` 将目标提升到父目录，物化扫描该目录。现在精确文件路径产生单文件候选，批准、副本、执行定位和交付保持这一范围；目录候选继续使用原目录行为。没有提高 4 MiB 单文件、32 MiB 目录总量或 5000 项限额。

| 对象/入口 | 本轮契约 |
| --- | --- |
| Candidate.scope / Mount.scope | `directory` 或 `file`；单文件含文件名、父目录身份、文件身份、大小、mtimeNs 和 ctimeNs 快照 |
| 发现 | 不读正文；精确路径返回 found/not_found/rejected/unavailable；默认仅搜索目录名称，no_candidates 不证明文件不存在 |
| 批准/派发 | 单文件 `ExecutionContext.resourceScope` 保存相同范围；来源 location 使用真实父目录和所选相对文件名 |
| 复制 | 批准后只观察、读取和复制所选文件；复制前后核验元数据与内容；计划在托管目录创建前持久化 |
| 副本工具 | read/stat/write/delete/list/search 和文件预览遵守单文件范围；旁支文件不进入列表、搜索与自动交付 |
| ChangeSet | 单文件范围冻结在 `resourceScope`；构建、准备、恢复交付都检查范围，不能交付同目录其他文件 |
| 回收站 | 沿用独立具体批准；选定文件资源只能定位该文件 |
| 失败 | `resource.materialization_failed.failure` 保存 scan/copy/reconcile 阶段及 not-started/partial-or-unknown；保留具体限额与异常原因 |
| 恢复 | 检查条件仅只读；已派发操作先 reconcile，禁止盲目重新复制；核验结果进入 tool.reconciled 投影与时间线 |

等待批准后文件变化时，ToolExecutor 每次准备前重新加载工具记录，使原批准明确失效；不使用等待前的旧 approval_id。拒绝按同一物理文件身份保存，不能靠改变文件内容、用途或路径大小写绕过拒绝。

批准前只保存元数据快照，不存在已授权读取的内容 hash。批准后扫描得到的内容 hash 进入不可变物化计划和基线；源文件交付检查基线内容与身份，用户的新修改不会被覆盖。元数据核验没有文件锁或 OS 沙箱的含义。

## 2. 持久化与兼容

新增迁移 **6**：`resource_scopes(resource_id, scope)` 及不可修改/删除保护。版本 1–5 的 SQL 原文与指纹保持不变；旧候选没有范围行时解释为目录。旧事件、原文、artifact、执行快照和目录物化计划无需重写。

只为单文件向执行快照、计划、ChangeSet 与发现事件追加范围。缺少范围的旧快照仍解释为目录，避免改变历史批准的 request hash。目录挂载继续通过原物理根、身份和逻辑相对路径定位。

生产会话数据库本轮没有打开或迁移。新程序正常启动打开自己的数据库时会执行版本 6 升级；旧程序不认识版本 6，不能直接用它打开已升级的库。迁移测试使用专用临时数据库。

## 3. 学习调用链

```text
discover_resource → ResourceFiles.discover
  → metadata-only scope → ResourceRepository.candidate → resource.discovered
request_resource → ToolExecutor.prepare / requestApproval
  → ResourceFiles.resourceContext → 批准绑定范围与环境
  → 重新加载工具与核验候选 → dispatch
  → scanSource（单文件只 observe 一个路径）
  → beginMaterialization → mkdir / bindMaterializationRoot
  → saveBlob / atomicWrite → 再核验来源 → addMount
write_file → mountContext / assertPath → 副本前置条件 → atomicWrite / 回读
build_changeset → scanMount → scope 检查 → 保存冻结内容
deliver_changeset → 单独批准 → 来源与副本核验 → 每项意图 / 写回 / 回执
```

父目录仍是路径核验的物理根，但授权范围不再等于这个根中的全部文件。`resourceId` 绑定来源与权限，`mountId + relativePath` 绑定具体副本；显示名称相同不会串目标。共享的逻辑路径 schema 提取到 `file-path.ts`，避免 model/resources/scope 之间形成初始化循环。

失败后：没有物化计划说明复制尚未开始，request_resource 直接 failed；有计划则保守 unknown，恢复只核验已保存副本与 blob。完整副本可发布挂载，未完成副本明确 failed 并保留原资料。模型之后提出的新资源请求属于新 execution，不是原执行的自动重试。

## 4. 本轮验收证据

最终执行 `npm run typecheck`、`npm run build:desktop`；均通过。主回归 9 个测试文件 **95/95 通过**；上下文迁移、批准派发和宿主批准相关筛选回归 **7/7 通过**。不是全套测试重验，也没有真实模型 API 调用。

新增 `tests/single-file-resources.test.ts` 共 **17 项**，全部通过：

| 场景 | 核验依据 |
| --- | --- |
| 大目录中的小 HTML | 邻近 >4 MiB 文件与 junction 不参与复制；完成副本编辑和独立交付批准 |
| 同名文件/多个资源 | 独立 resourceId、mountId、来源内容；Windows 路径大小写复用同一对象候选 |
| 范围越界 | 其他路径的读取/编辑/删除/ChangeSet/回收站被拒绝；副本旁支文件不进入列表或搜索 |
| 批准后变化 | 内容、恢复原 mtime、对象替换、文件移动/消失导致准备失败、批准失效，无新增能力或挂载 |
| 限额 | 文件/目录超 4 MiB 时保存具体限额、scan/not-started，工具直接 failed |
| 来源冲突 | 等待交付批准时用户编辑来源；工具失败，delivery_items 为空，保留用户内容 |
| 实际进程退出 | file-partial 在物化根已绑定但尚未复制时退出；file-complete 在内容/blob 完整但挂载未发布时退出 |
| 重启恢复 | 来源后来修改不触发再复制；原副本身份保持；原 execution 仅有一次 dispatch；核验结果及事件重放一致 |
| 停止 | 根绑定后停止，保留 copy/partial-or-unknown；恢复不重新复制 |
| 旧库升级 | 版本 5 目录挂载、消息、事件和旧迁移指纹原样保留 |
| 初始工作区失败 | 复制第二个文件前注入异常，保存 copy 阶段与具体原因，不误报扫描前失败 |

初轮检查有失败，修正后重验：新增批准变化用例发现旧工具对象漏记批准失效；3 个 UI 断言要求批准卡片在 Timeline，但当前实现已放到输入区。使用 HEAD 的原 Timeline 在隔离测试中复现了同样 3 个失败，再更新断言，保留当前界面布局和标题。最后新增边界还发现初始异常原因丢失和 Windows 大小写候选重复，均已修复后重验。

本地原始记录：`E:\Codex\Workspace\output\umi-resource-20261010\final-tests.log`、`approval-regressions.log`；本轮开始的 diff 和文件字节指纹同目录保存。它们不随仓库上传。未启动产品窗口、未操作生产数据库、未重新打便携包或发布；UI 证据为 React 静态渲染与现有流程测试，尚未做桌面视觉验收。

## 5. 剩余范围

- 本轮支持单文件与旧目录范围，尚未新增任意多文件选集/子树范围。
- 部分副本保留；没有新增一键重新复制/清理动作。恢复核验后，新的复制仍是新请求，不能把原 unknown 写入当成直接重跑。
- 单文件 atomicWrite 内部暂存文件的每个 OS 写入边界没有单独故障注入；本轮实际退出覆盖根绑定和复制完成/挂载发布前两个边界，旧目录/交付恢复案例也已回归。
- 重复输入的操作来源、同 run 多输入片段的总耗时重复、长上下文预算与模型版本证据留待下一轮。
- 保留初始工作区的失败事实；之后单文件成功不等于初始整个目录已成功物化。
