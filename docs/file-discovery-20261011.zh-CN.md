# Umi 有界发现与元数据分页

实施日期：2026-10-11。这是文件边界路线的第一阶段；创建/替换契约和独立成果交付仍属后续阶段。

## 解决的断点

此前 discover_resource 默认只查目录名称，精确 path 才能定位文件；list_files 先完整读取文件计算 hash，再只返回前 200 项。本阶段新增文件名/扩展名/相对路径发现和可续页元数据列表，保持原有批准、单文件资源、物化和源交付链路。

## 工具契约

```json
{
  "name": "discover_resource",
  "arguments": {
    "root": "E:/资料",
    "kind": "file",
    "match": "extension",
    "query": "md",
    "depth": 2,
    "limit": 20
  }
}
```

root 必须是绝对目录路径，只指定本次元数据搜索范围。kind 为 file/directory/any，默认 directory；match 为 name/extension/relative_path，默认 name。query 是忽略大小写的字面子串，扩展名模式匹配文件后缀，可带前导点；不解释 glob 或正则。relative_path 使用 `/`。扩展名模式必须指定 kind=file 和非空 query。

默认根仍为当前来源、父目录及用户常用目录，新增识别 OneDrive、OneDriveConsumer、OneDriveCommercial 实际根下的 Desktop/Documents。建议已知位置时指定 root，避免默认预算先被附近大目录消耗。没有读取注册表 Known Folder 重定向；组织另行重定向的位置应显式指定 root。

path 表示精确定位一个对象，不能同时使用 root/cursor；精确模式继续忽略 query。文件候选经批准只能物化这一文件。发现本身不授予正文读取或源写入权限；request_resource 仍执行原候选身份/元数据检查、具体批准和工作副本物化。大文件可先发现，其物化仍可能因 4 MiB 等既有限额失败。

范围搜索遍历预算是合计 5000 个目录项、约 1500 ms，depth 默认 2、可选 0–8。深度 0 观察根内直接项，不下钻子目录。单页默认 20、最多 100。coverage 给出各根、visited、limited、complete、限制原因、跳过计数及最多 8 个例子。忽略 .git/node_modules/.venv/__pycache__，发现另外跳过 environments；隐藏普通文件可发现，链接、联接、硬链接及不受支持的路径不跟随。

```json
{
  "name": "list_files",
  "arguments": { "mountId": "mount-…", "prefix": "src", "limit": 100 }
}
```

列表只看已获准工作副本。prefix 可以定位一个文件或子树，默认根；单页默认 100、最多 200。条目含 path/kind/identity/size/modifiedNs/changedNs，**不再含内容 hash**。需要内容版本时用 read_file/stat_file。单文件 mount 无论 prefix 如何都只观察所选对象，不枚举邻居；其他所有工具的范围规则保持。

下一页使用相同查询和 nextCursor，可调整 limit。游标绑定 environment、对象/范围和查询、元数据版本、偏移，不依赖进程内缓存，重启后可以重扫核验再续页。跨对象/查询拒绝，无法解析的游标拒绝；版本变化返回 restart_required、空列表和 null 游标，须去掉 cursor 重新列举。它是读位置，不是能力令牌，修改游标不能增加资源权限。

total 表示**本次覆盖范围里**的匹配数量；totalExact=false 时不能据此推断整个根没有更多对象。truncated 只表示已观察结果还有下一页，不代表遍历完整。cursor 不保存未遍历目录的 frontier，预算耗尽须缩小 root/depth 或 prefix；query 仅筛选结果，不会减少遍历工作量。不存在无限目录扫描或自动跨预算继续。列表预算为 5000 项、深度 16、约 1500 ms。

## 按调用链阅读

```mermaid
flowchart LR
  A[AgentEngine 原循环] --> B[tools.ts 参数校验与 prepare]
  B --> C[ToolExecutor 保存派发事实]
  C --> D[ResourceFiles.discover / listMetadata]
  D --> E[metadataInventory 属性观察]
  E --> F[metadataPage 版本与分页]
  F --> G[候选或文件页及 coverage]
  G --> H[原结果持久化与有界上下文]
```

先读 [tools.ts](../packages/adapters/src/host-files/tools.ts)，看模型参数如何进入已有派发；再读 [resources.ts](../packages/adapters/src/host-files/resources.ts) 的 discover/listMetadata：查询匹配、环境绑定和候选记录留在资源适配器。最后读 [metadata.ts](../packages/adapters/src/host-files/metadata.ts) 的 inventory/page：观察与分页独立于 SQLite、模型和批准。

inventory 使用 opendir 逐项观察，避免一次分配超大目录的全部名称；按普通字符串路径排序。它通过 lstat 获取属性，检查路径祖先，不读取正文。目录在扫描期间发生可检测的属性变化时拒绝发布版本；下一页重新观察版本，拒绝旧顺序。底层同步系统调用只能在调用之间检查时间/取消，1500 ms 是协作式预算，不是操作系统硬超时；观察也不是 OS 原子目录快照或文件沙箱。

分页版本依赖身份、大小、mtime/ctime 等元数据。它服务对象导航，不能替代内容哈希证据。只读恢复会重新观察，可能发现 restart_required，不重做文件写入。

交付仍调用 [paths.ts](../packages/adapters/src/host-files/paths.ts) 的 scan/observe，必须完整覆盖并计算内容 hash；达到内容/条目限制即失败。metadataInventory 没有取代 scanMount、物化或 ChangeSet 基线，不会用部分元数据清单交付文件。宿主命令仍未获得 OS 隔离。

## 本次验收与剩余方向

本轮新增 16 项专项场景；最终相关 11 文件 132/132 通过，类型检查及核心/桌面构建通过。日志位于 E:\Codex\Workspace\output\umi-file-discovery-20261011；历史报告数字不累计。测试使用固定模型、临时 SQLite 和专用临时目录，没有扫描用户生产目录做基准。唯一原有默认目录发现回归只进行原测试的有界元数据搜索。没有真实 API、生产会话库、发布或 Windows 变更。

新增场景覆盖中文/空格/长路径、同名候选、三类字面匹配、默认 OneDrive 根规划、205 项以上分页及重启、四类版本变化、游标错绑、单文件实际批准物化、隐藏/忽略项、联接/硬链接、条目/时间/深度预算、取消、空结果、扫描中目录变化、prefix 子树、真实工具派发/只读恢复，以及有界上下文下长页游标可观察性。源码见 [file-discovery.test.ts](../tests/file-discovery.test.ts)。OneDrive 测试是临时目录/根规划，不是真实云同步、占位文件或账户验收；更极端长路径和巨型目录性能仍待测量。

下一阶段先明确文本新建与整文件替换，继续绑定读回执和冲突观察，再补独立 Artifact/Export；执行隔离方向见 [执行边界探针计划](execution-boundary-plan-20261011.zh-CN.md)。
