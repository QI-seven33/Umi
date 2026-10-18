# 搜索入口整理、永久删除与变更审查（2026-10-18）

## 结论与范围

旧搜索没有继续保留的独立产品价值。本轮将唯一入口统一为 search_web，移除旧工具名/模块名兼容保留；继续直连 DeepSeek Search，配合 fetch_webpage 和 read_webpage/read_artifact。归档页新增永久删除，侧栏原来实际执行归档的“删除会话”改为“归档会话”。

用户明确允许舍弃测试历史。默认库7条会话已备份重置，当前会话/资料计数均为0，库版本7。全局API配置、头像/主题等浏览器偏好及用户源目录未改动。源文件、实际交付和导出文件不纳入会话删除。全部既有源码/学习注释保留，不提交/推送Git、不更新远端版本或Setup安装器。

## 为什么可以移除旧搜索

上轮已经替换旧实现，仓库没有两套并行工作的搜索引擎；留下的是 deepseek_server_web_search 名称。本轮运行时、提示词、UI、SQLite快照归属、验证脚本和测试均使用 search_web，不注册旧别名或旧接口回退。模块名为 umi.web-search。

| 对比 | 旧模型包装搜索 | 当前唯一搜索 |
| --- | --- | --- |
| 请求链 | Anthropic兼容messages → 额外Flash生成 → 内置搜索 | POST /v1/tools/search → 结构化结果 |
| 答案组织 | 额外模型先生成答案，主Agent再处理 | 主Agent直接读来源/摘要，按需抓正文后答复 |
| 次数控制 | 内部搜索次数不够透明 | 一次工具调用对应一次Search请求，无自动付费重试 |
| 内容 | 生成文本与来源 | 有界摘要、完整搜索快照、明确截断与补读 |
| 兼容需求 | 旧会话可能引用旧名称 | 用户允许舍弃测试历史，本轮不保留兼容层 |

旧工具附带的“生成答案”由主Agent承担，因此新链路可替代旧工具的产品职责；不声称新旧排名、召回或文本逐项相同。新API查询限1～128个Unicode字符；长需求应由Agent提炼检索词，超长参数明确拒绝，不静默截词，必要时分次查询。Umi默认5条/最多10条，need_content=false。[官方Search](https://api-docs.deepseek.com/zh-cn/api/search/)。

之前的完整存档、有界输入、网页8KiB预览、64000字节续读及2MiB正文上限保留，见[网页读取](web-fetch-20261018.zh-CN.md)和[前轮真实API验收](web-search-live-20261018.zh-CN.md)。历史报告保留原时点，并非运行时兼容代码；本轮未额外调用真实API。

## 永久删除的范围

侧栏选择“归档会话”，再到设置 → 归档，可恢复或删除。删除先显示范围确认，默认焦点在取消；取消不改数据库。确认后防止重复提交，显示真实完成或清理待完成状态。

| 对象 | 处理 |
| --- | --- |
| 消息、事件、运行、请求、批准、附件、上下文 | 一个SQLite事务按会话/环境归属删除 |
| 搜索/网页快照、模型响应、日志等artifact | 回收本次关联且没有其他持久引用的资料 |
| 共享资料与导出意图/回执 | 保留其他会话的直接/间接引用，计算ID回执按执行ID识别 |
| 托管工作副本、任务临时文件、会话内成果 | 仅清理 dataRoot/environments/<environmentId>，核对位置与根身份 |
| 用户源文件、已交付文件、已导出文件 | 保留，不回滚实际交付 |
| 草稿、待发请求、赞踩反馈 | 成功后仅清理指定会话条目 |
| 工作区记录 | 没有其他会话引用才删除；不删除source_root目录 |

活跃任务、尚未结束的本机循环和未知副作用阻止删除。即使归档标记异常也不能绕过后端核验。固定桌面命令 delete_conversation 只接收会话ID、confirm=true，不接收路径、SQL或程序参数；不注册为模型工具。上下文维护仍保留原始历史，不能以删除代替窗口压缩。

## 数据库与目录的一致性

SQLite事务无法和目录删除一起原子提交，因此增加窄表 conversation_deletions，只记录环境ID、固定目录、身份、时间和最近错误码，不存会话正文。

~~~mermaid
flowchart TD
  A[明确确认] --> B[归档 状态 目录与归属核验]
  B --> C[事务删除会话事实并登记目录清理项]
  C -->|失败| R[回滚 不移除目录]
  C -->|提交| D[按固定位置和根身份清理托管目录]
  D -->|成功| E[移除清理项]
  D -->|占用或身份异常| F[明确提示待清理 下次启动核验后重试]
~~~

文件占用时会话记录已删除，UI明确说明部分托管文件未清理，不假装磁盘清理完成。重试仍核验目录身份和工作区来源引用；异常时保留清理项。目前没有新增后台清理面板，持续占用/身份变化可能需要人工处理。

外键保持开启，按依赖顺序删除，提交前执行foreign_key_check；不批量撤掉不可变触发器。[SQLite外键](https://www.sqlite.org/foreignkeys.html)。迁移1～6的SQL/指纹保持；迁移7只允许已登记整会话删除的所属环境清理resource_scopes，普通单独删除仍拒绝。消息、事件、资料及能力范围不可改写规则保留。

引用还存在JSON、字符串化工具回执及对象键中，本轮按引用图保留仍在使用的资料，迭代读取行，不向渲染器传全文。其他会话存在时只回收本次候选；最后一条会话删除时回收无持久根引用的孤立资料。新增资料生产者必须保存可追踪引用，计算ID定位也需登记根引用规则并增加保留测试。

## 破坏性行为与后续开发审查

- 不只隐藏列表：消息、附件、网页快照和私有副本纳入实际删除。
- 不先删目录：模拟事务失败验证完整回滚，工作副本仍在。
- 不混用来源与副本：只接受固定环境位置；根被换成目录联接时拒绝，内部联接删除不跟随外部目标；仍被工作区作为来源的托管目录拒绝删除。
- 不盲删全局资料：其他会话共享引用、对象键引用、计算ID导出回执有保留测试。
- 不扩大Agent权限：未新增Shell、任意文件/SQL接口、模型删会话能力或第二套循环。
- 不改写旧迁移：新增7，迁移/CLI/worker/ready统一DATABASE_VERSION，修复旧审计A-03。
- 不以DOM存在代替界面可用：截图发现确认框曾被设置页遮挡，已修正层级并增加实际点击命中、取消焦点和截图断言。

这是产品层永久删除，不是取证级安全擦除，不保证SQLite文件立即缩小；外部备份不随之删除。受损资料hash/外键检查失败会回滚，不自动跳过。目录检查减少误删，不声称存在OS文件沙箱。资料回收成本随引用与资料规模增长，将来大数据可考虑明确归属索引；本轮没有为此引入通用存储平台或大调度器。

## 默认测试库重置

仅处理核对过的默认库：重置前7条会话、7个环境、736个artifact，状态只有completed/failed/stopped，没有存活写者。确认writer.lock不存在、源/目标限定同一用户数据目录后，同盘将agent改名为agent-test-backup-20261018，再创建迁移7空库；没有恢复或重放旧操作。

备份在原agent同级，是本次测试重置的离线材料，不是普通永久删除功能自动产生的第二份历史。当前产品列表与新库为空，源码输出目录的学习证据保留。全局配置、浏览器偏好和源目录/交付文件未移走；会话级设置随旧会话退出当前库。test-data-reset.json只记录路径/计数，不含正文或凭据。

## 学习入口

1. [conversation-deletion.ts](../packages/adapters/src/sqlite/conversation-deletion.ts)：删除范围、引用保留、事务与文件系统边界。
2. [迁移7](../packages/adapters/src/sqlite/conversation-deletion-schema.ts)、[版本常量](../packages/protocol/src/database.ts)、[store.ts](../packages/adapters/src/sqlite/store.ts)：迁移、缓存失效和启动补清理。
3. [application.ts](../apps/headless/src/application.ts) → [service.ts](../apps/desktop/service.ts) → [desktop.ts](../packages/protocol/src/desktop.ts)：固定管理入口沿原worker链路。
4. [ArchiveSettings.tsx](../apps/desktop/renderer/src/features/settings/ArchiveSettings.tsx)、[conversationStorage.ts](../apps/desktop/renderer/src/features/settings/conversationStorage.ts)：确认/取消/待清理及本机会话数据清理。
5. [删除测试](../tests/conversation-deletion.test.ts)：10项针对性覆盖；[桌面验证](../apps/desktop/verification.ts)新增4项真实流程。
6. [search.ts](../packages/adapters/src/deepseek-search/search.ts)、[web-search.ts](../packages/agent/src/tools/web-search.ts)、[memory.ts](../packages/adapters/src/sqlite/memory.ts)：一个搜索入口及快照归属。

证据、修改前源码与学习注释备份、旧便携包及日志：E:/Codex/Workspace/output/umi-search-clean-delete-20261018。上轮真实API证据独立保留，不冒充本轮付费复验。

## 最终验证与本地构建

最终类型检查、编译、桌面构建通过，核心全量484/484通过（文件并发2，约154秒）。此前483项全量与25项客户端/删除相关检查也通过；最终全量已包含新增的10项删除测试及对象键引用保留。没有删减旧断言，仅把旧搜索请求契约和升级版本预期改为当前实现。

完整桌面验收有明确的失败和最终结果：
- 初次源码版69/77通过后，在既有“HTML应完成可见排版”断言失败；剩余8项没有执行。
- 初次便携版70/78通过后同样被该HTML断言阻断。失败日志、DOM快照和截图均保留。
- 截图审查修正新确认框层级并补实际命中断言后，最终实际便携Umi.exe完成78/78；删除的确认、取消、目录消失和客户端草稿/反馈清理4项均通过，确认框截图已经人工查看。
- HTML预览代码本轮未修改，前两次失败说明已知首帧问题仍存在，不能据最终绿色宣称已修复。

191个运行文件与构建清单逐项hash匹配；源码、dist、便携版指纹为150d151778235afc73005eaebbb49e6bb2d5d48a8ecb93b4b9a8a1e12e3a4d44。构建时间2026-10-18T04:58:21.153Z，便携打包时间2026-10-18T04:59:06.484Z。入口release/Umi-win32-x64/Umi.exe；通过菜单完整退出旧Umi后启动，关闭窗口只是隐藏。

Setup安装器和GitHub发布保留原版，Git HEAD未变化；本轮未调用真实API。备份和重置只针对用户已明确允许舍弃的默认测试资料，不是恢复/付费调用的永久授权。
