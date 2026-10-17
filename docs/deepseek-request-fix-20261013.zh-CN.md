# 2026-10-13：普通问候 HTTP 400 的本地请求规格修复

用户在上一阶段后发送“你好”收到“模型接口返回 HTTP 400”。未读取或修改生产会话数据库，也未调用真实 API，截图没有厂商错误正文。因此不能把模拟验收说成线上已复测；源码中发现并修复了一处足以导致整次请求被拒绝的缺陷。

> 后续用户反馈：测试通过，已完成修复。此为用户对本次 HTTP 400 修复的人工确认；上文保留修复时的本地验收事实，不推断复杂任务完成率或其他功能都已验收。详见[新窗口交接](session-handoff-20261013.zh-CN.md)。

## 已观察到的原因

批量编辑把 edit_file 的参数 schema 改成顶层 Zod union。原 Registry 默认导出 output JSON Schema，产生根 anyOf，没有 type: object。实际默认应用的39个工具里它是唯一非 object 根。模型适配器每次请求都发送整份工具表，问候同样携带该规格，所以工具尚未执行就可能收到 HTTP 400。上一轮 ScriptModel 只模拟模型端口，验证了工具行为，却没有验证厂商接受工具规格，这是一项验收遗漏。

DeepSeek 官方 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) / [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) 给出 object 参数描述；Harness 的 [参数规格编译器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/schema.ts) 也明确采用 object 参数根。这里修复 Umi 的对象输入规格，不切 strict/beta，不删除工具或取消读取证据。

## 修改契约与关键代码

- packages/protocol/src/file-edit.ts：从原单项/批量字段派生一个 object 输入，只把共同字段设为必填；转换时仍以原严格 union 校验和输出两种形态。旧调用形态、同版本和模型可见读取范围、原子批量、未知恢复及独立源交付都保持。混用、缺项、未知键、重复回执必须失败，newText 空字符串仍可删除精确片段。
- packages/agent/src/tools/registry.ts：z.toJSONSchema 使用 io: input，描述模型实际可以提交的参数。default 不再误呈为必填，转换后的执行结果不拿来描述模型参数。直接复用已有字段，不维护另一份手写规格。
- packages/adapters/src/deepseek/adapter.ts：请求准备时检查工具名称唯一/格式以及 object 根；未来无效工具在本地报出名称，不到模型接口才显示模糊的 HTTP 400。
- tests/deepseek-request.test.ts：检查整份应用工具表，沿真实 AgentEngine/DeepSeekAdapter 的注入 transport 完成问候、read_file 和 edit_file 三轮任务；不以 ScriptModel 代替适配器。校验两种形态及拒绝用例。

开发中还发现当前 Zod 的 object.pipe(union) 会漏掉入口的未知字段错误，因而使用 transform 内独立解析并保留入口 strict，新增拒绝测试覆盖这个问题。没有修改依赖。

## 本轮验收与边界

核心 TypeScript 构建、桌面构建通过。最终全量424项通过（full-tests.log），请求/适配器专项9项通过（request-tests.log）。模拟 transport 验证39个 object 根、问候一轮、读改三轮成功，工作副本准确修改而源文件未直接写入；这是本地接口契约验收，仍未向真实 DeepSeek 发送请求。

证据和修改前3个源码文件备份：E:\Codex\Workspace\output\umi-deepseek-400-20261013。保留全部已有未提交修改和学习注释；未 reset/clean、发布、同步便携包、改 Windows、安装依赖或操作生产会话数据库。完整退出源码版 Umi 后重新启动新 dist；关闭窗口仅隐藏，便携包仍是独立旧 dist。
