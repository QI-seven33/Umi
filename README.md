# Umi

基于 **TypeScript + Electron + React** 的 Windows 桌面 Agent。默认使用 DeepSeek，支持流式任务过程、文件工作副本、具体批准、变更集交付、宿主命令和长任务上下文维护。

当前主分支已由旧 Python 后端迁移到唯一 TypeScript Agent 核心。旧实现保留在 Git 历史中；产品名始终是 **Umi**。

## 从这里了解项目

- **[当前项目详解与开发路线](docs/current-project-report.zh-CN.md)**：架构、执行链路、数据、权限、上下文、问题和后续优先级。
- **[代码学习与开发指南](docs/code-reading-guide.zh-CN.md)**：按文件阅读、调用链练习、修改入口和调试方法。
- [核心契约](docs/contracts-v1.md)、[架构设计](docs/architecture-v1.md)、[迁移与验收](docs/migration-and-acceptance.md)：早期决策与基线。

历史阶段报告描述当时状态；后续已增加图片附件等能力。当前状态以最新报告和源码为准。本地原始截图/日志 `docs/evidence/` 不随本次源码发布。

## 开发运行

要求 Node.js **`>=24.11.0 <25`**，依赖由 package-lock.json 固定。当前只有根 package，没有 pnpm/npm workspaces。

```powershell
npm ci --no-audit --no-fund
npm run typecheck
npm run dev
```

在设置中填写自己的 DeepSeek API Key，或在启动前配置 `DEEPSEEK_API_KEY`。`.env.example` 仅是模板；桌面入口不会自动读取任意 `.env`，使用环境变量或桌面设置。

关闭窗口只隐藏，任务继续；菜单 **Umi → 退出 Umi** 才会关闭执行器。重启会核验持久状态，不自动续跑。

便携 Umi 已打开时，开发入口的第二实例可能只唤回旧窗口。先退出旧实例，再启动开发版。dist 与 release 的资源目录不同，构建源码不会自动更新旧便携包。

### 无 Key 演示

```powershell
npm run demo
```

使用确定性模型替身和产品同一循环，在独立临时环境中运行。

### 无界面入口

```powershell
npm run build
node --env-file=.env dist/apps/headless/src/cli.js --data .umi
```

CLI 每行接收一条 JSON 命令，不需要 Python 服务。

```json
{"type":"create","workspace":"E:/Projects/example"}
{"type":"send","conversationId":"会话 ID","commandId":"本次输入的唯一 ID","text":"请检查这个项目。"}
{"type":"approve","conversationId":"会话 ID","approvalId":"批准 ID","decision":"allow"}
{"type":"stop","conversationId":"会话 ID","runId":"运行 ID"}
{"type":"recovery","conversationId":"会话 ID","runId":"运行 ID"}
{"type":"resume","conversationId":"会话 ID","runId":"运行 ID"}
{"type":"shutdown"}
```

工作区必须存在。同一输入回执重试时使用原 commandId，不要用新 ID 重复发任务。

## 目录

```text
apps/headless/src/       应用组装、CLI、生命周期
apps/desktop/            Electron、IPC、Agent worker、React 页面
packages/protocol/src/   Zod 契约、事件、纯归约
packages/agent/src/      唯一循环、上下文、工具和持久化端口
packages/adapters/src/   DeepSeek、SQLite、宿主文件/进程
tests/                   协议、恢复、故障注入和 UI 逻辑验证
scripts/                 构建、打包、真实 API 与桌面验证
docs/                    设计、学习指南、阶段报告
```

## 能力和边界

- **文件**：获准资源后编辑副本，再冻结 ChangeSet；真实写回需要具体交付批准。当前单文件路径转成父目录资源，可能触发目录物化限额，是优先待修问题。
- **命令**：每次需具体批准，绑定程序、脚本和环境，Windows Job 管理普通进程树。**没有宿主文件/网络 OS 沙箱**，cwd 只是起点。
- **恢复**：先核验原执行，不盲目重复未知写入；预算未变时拒绝无效恢复。恢复反馈待完善。
- **上下文**：默认配置窗口 1M，保护用户原话，按完整工具组维护。估算和实际用量分开；极长用户原文累计仍可能阻塞。
- **附件**：每条最多 8 个，每个最多 1 MB；支持文本和常见图片，图片最长边 4096。Flash 路由支持图像，Pro 路由不支持。PDF/Office 二进制解析未实现。
- **模型**：路由为 `deepseek-flash`、`deepseek-v4-pro`；UI 版本名称是静态标签，不是本次实际响应证明。Off/Normal/High 由适配器映射参数。
- **插件**：Docker/WSL 目前提供配置和检查，调用仍走宿主批准；没有通用加载器或专用隔离 Runtime。
- **数据**：SQLite schema 5。密钥、会话、工作副本和本机证据不提交到 Git。

详见[当前项目报告](docs/current-project-report.zh-CN.md)。长任务质量、费用、恢复体验和生产发布仍需持续验证。

## 构建与验证

```powershell
npm run typecheck
npm run build:desktop
npm test
npm run verify:desktop
npm run package:desktop
```

便携输出 release/Umi-win32-x64/Umi.exe，需要整个目录。Electron 下载按其安装配置进行；网络受限时可在自己的环境配置镜像。

测试包含真实进程/文件检查，部分能力要求 Windows；桌面验证使用独立目录和模型替身。真实 DeepSeek 验收会产生费用，不是普通构建的默认步骤：

```powershell
node --env-file=.env dist/scripts/verify-deepseek.js
node --env-file=.env dist/scripts/verify-files.js
node --env-file=.env dist/scripts/verify-process.js
node --env-file=.env dist/scripts/verify-context.js
```

## 后续重点

1. 单文件/选定范围资源的发现、授权、物化和恢复闭环。
2. 资源限制原因、恢复核验结果和进度展示。
3. 重复输入来源追踪、同一运行多消息的展示修正。
4. 有预算的活跃原文保护、长期检索和长任务评测。
5. 样式/组件整理、完整国际化和可重现发布。

仓库未新增项目许可证；后续对外分发前由项目所有者明确授权方式，并核对第三方依赖和组件的适用许可。
