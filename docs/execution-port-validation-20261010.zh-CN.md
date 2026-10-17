# Umi：Windows 执行端口与 MXC 兼容验证

> 2026-10-10 后续推进。用户允许升级 Node，禁止改动 Windows 版本。本记录区分产品实现、宿主试验与尚未验收的机制。

## 本轮结论

最小旧 Windows 执行端口与应用注入点已落地。默认命令执行、V1 事件/回执、批准和恢复逻辑不变。MXC 尚未成为产品后端，也未加入 package.json 或锁文件。

在当前 Windows 23H2 / 22631.5189 上，正常宿主中的 CMD 工作负载已取得实际执行证据；Node 工作负载在两种 API 下均以 0xC0000142 退出，测试正文未开始。不能从局部 CMD 成功推断通用 Node/npm/Agent 工作负载适用，也不能据退出码定位具体 DLL 或断定 NUL 是根因。

没有升级 Windows、启用/关闭系统功能、安装驱动或执行 prepare-system-drive / prepare-null-device。试验只给明确的自有夹具路径配置临时 DACL，并核对观察路径的恢复；没有无隔离重跑受约束工作负载。

## 产品契约与阅读顺序

1. [UmiApplication](../apps/headless/src/application.ts)：options.processRunner 注入 LegacyWindowsProcessPort；未传时仍由 CommandTools 选择 WindowsProcessRunner。headless 与桌面仍共享一个 AgentEngine。
2. [port.ts](../packages/adapters/src/host-process/port.ts)：明确 run / probe 与回调。owner 绑定原桥接身份；ready 时子进程必须仍挂起，只有 Promise 成功后才能释放。probe 使用 PID + birth，身份不符不得杀进程，无法核验返回 inaccessible。
3. [CommandTools](../packages/adapters/src/host-process/tools.ts)：批准、租约、目录/入口指纹复核、计划/释放事实、输出和回执仍保存在原仓储。它依赖端口类型，而非要求一个具体 runner 类。
4. [WindowsProcessRunner](../packages/adapters/src/host-process/runner.ts)：显式实现端口，保持原桥接运行与回收逻辑。[frames.ts](../packages/adapters/src/host-process/frames.ts) 移出原来的 Zod 帧校验；schema 内容逐字比较一致，NativeExit 从原 schema 推导并保留 runner 的类型重导出。
5. [process-port.test.ts](../tests/process-port.test.ts)：仅替换原生边界，仍经过真正的应用、循环和测试 SQLite 仓储，检查注入后授权/释放/恢复顺序。

端口刻意保留 Windows V1 的 bridge、PID birth、Job 和门控语义。它还不是跨后端 ExecutionProvider，不能接上 MXC 后伪造 ready 或 jobInactive。注入实现是可信宿主代码；TypeScript 接口不会隔离恶意插件。新 provider 仍需独立、可辨识的计划/回执版本与持久化定位。

## Node 与宿主版本

官方 Node 24.21.0 Windows x64 ZIP 下载到独立试验目录，SHA256 与官方 SHASUMS256.txt 一致：158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541。该版本满足仓库 >=24.11.0 <25 要求；本轮类型检查、构建和测试使用这个便携运行时，未覆盖 E:\Vue\nodejs 或修改全局 PATH。

运行时：E:\Codex\Workspace\output\umi-execution-port-20261010\runtime\node-v24.21.0-win-x64。只读 ELECTRON_RUN_AS_NODE 验证确认，当前 Electron 44.5.1 内置 Node 也是 24.21.0；没有启动 Umi 页面或升级 Electron。主机开发用 Node 与 Electron 内置 Node 是不同的运行时，升级前者不会自动改变后者。

来源：[Node 官方版本](https://nodejs.org/fr/blog/release/v24.21.0)、[MXC SDK 兼容说明](https://github.com/microsoft/mxc/blob/main/sdk/node/README.md)。SDK 1.0.0 仍使用上一轮的独立安装位置，未新增产品依赖。

## 实际 MXC 试验

使用公开 @microsoft/mxc-sdk/v1，固定 processcontainer 后端，禁止网络默认出入与 hostLoopback，禁止 UI，显式环境白名单且 inheritDefaultEnvironment=false。发现的实际 tier 为 appcontainer-dacl。

| 工作负载/API | 实测 | 能证明的范围 |
| --- | --- | --- |
| Node 固定夹具 / spawn | API 返回进程与 wait 结果；exit=-1073741502（0xC0000142），无输出、无 started 标记 | Node 版本检查已通过，应用正文未开始 |
| 同类 Node / run | 同一退出码，正文未开始 | 批量入口不能解决当前 Node 启动问题 |
| 自有 CMD 副本 / spawn | echo 标记，exit=0 | 当前层级能执行这个 CMD 样本并取得标准输出 |
| CMD 文件与 stdin 场景 | 获准目录生成 effect；参考原文进入 stdout；参考写入及 outside 读写未成功；两处哨兵 hash 不变；stdin 正文回显；dummy secret 未继承 | 这些固定路径、命令和环境的行为得到观察 |
| CMD 忙循环 / timeout | timedOut=true，exit=-1，wait 后原根 PID 不存在 | 根进程超时终止得到验证 |
| CMD 忙循环 / kill | timedOut=false，exit=-1，wait 后原根 PID 不存在 | 根进程取消得到验证 |

正常宿主六次试验中，四个 CMD 工作负载返回预期结果，两个 Node 工作负载失败；这不是六项完整安全验收。所有正常宿主试验中，列出的夹具/系统路径 SDDL 与受保护哨兵前后相同，DACL 状态目录没有残留文件。观察范围不等于整机 ACL 审计；根 PID 不存在不等于已验收任意子进程树。

补充发现：明确环境必须包含 LOCALAPPDATA。初次缺少该项时 spawn/run 均在 SDK 校验处拒绝；不能为了省事继承全部宿主环境。首次 ACL 读取因 Windows PowerShell 模块加载限制返回空对象，原报告标为 invalid，排除其权限比较结果。修复后改用可用的 PowerShell 7，并在读取失败/缺项时停止试验。比较 SDDL 按路径键值进行，不能依赖哈希表 JSON 键顺序。

Codex 自身受限进程中的尝试另报 CreateAppContainerProfile 0x80070002；随后正常宿主进程能返回上述结果。因此受限进程里的错误不能直接描述成 Umi 普通用户环境同样失败。这里的正常宿主调用只是创建明确受约束的 MXC 子进程，不是降级成普通 CMD/Node 执行。

剩余：网络请求实际阻止、路径别名/reparse、输出上限、子进程树清理、崩溃后 ACL/容器恢复、原执行持久化定位、provider 版本变化、批准后依赖变化与启动门控，均未完成 MXC 产品验收。当前 SDK 调用成功与任务成功是两个判断。

## 本轮产品验收与保留修改

- 类型检查和桌面构建通过；未打开产品窗口、重新打包或发布。
- 五个新增端口测试全部通过：批准前/拒绝后无 runner 调用、真实派发与门控顺序、ready 后文件漂移阻止效果、回执丢失核验而不重跑、身份无法核验保持 unknown。
- 应用组装相关四个测试文件共 28/28 通过（含上述五个）；现有 process.test.ts 的 22 项真实 Windows 场景也在本轮通过。合计 50 个不同测试，未执行全量测试。首次新增测试有一项把现有状态 unknown 误写为 outcome_unknown，修正断言后五项全部通过，产品恢复逻辑未改。
- 本轮之前 164 个文件建立内容基线及备份；三处现有后端的学习注释保留，帧 schema 原样移出，renderer/CSS 40 个文件全部原样。最终保留核对见 preservation.json。未更改迁移 SQL、协议 V1、package/lock。
- 全部模型来自 ScriptModel，数据库为专用临时夹具；没有真实 API 或生产会话数据库操作。

证据：E:\Codex\Workspace\output\umi-execution-port-20261010。包括基线/旧 diff、官方版本校验、各阶段试验、修正后的证据断言、测试日志、最终保留核对与 Windows 前后版本。

## 后续顺序

最小注入接口阶段完成。按此前选择，下一项独立开发 readExecutionId / expectedReadHash 绑定的唯一文本替换工具，继续走副本与独立交付权限。MXC 保留为候选后端；Node 启动失败与其余隔离/恢复契约另行排查，不能把本轮 CMD 场景替代完整验收，也不需要为了它升级 Windows。
