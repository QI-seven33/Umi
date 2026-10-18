# Umi

<img src="apps/desktop/renderer/public/umi-logo.png" width="80" height="80" alt="Umi 应用图标">

**面向本地文件、项目与研究任务的 Windows AI 工作代理。**

Umi 把自然语言目标连接到实际工作：理解要求、查找资料、处理文件、运行命令、检查结果，再把成果交给你。你可以在同一会话里继续、补充或调整任务，并在需要时回答问题、决定具体操作权限、审阅文件变更。

项目以 **单一 Agent 循环、持久事件与可核验的执行结果** 为核心。桌面界面和无界面入口共享同一套 TypeScript 应用层；文件、命令、上下文和交付围绕这条链路协作。

[下载](https://github.com/QI-seven33/Umi/releases) · [快速开始](#快速开始) · [开发与验证](#开发与验证) · [更新记录](CHANGELOG.md) · [报告问题](https://github.com/QI-seven33/Umi/issues)

> Umi 仍处于实验性 alpha 阶段。当前 Windows 预发布为 [0.2.0-alpha.3](https://github.com/QI-seven33/Umi/releases/tag/v0.2.0-alpha.3)；`main` 可能包含后续未发布改动，安装包以各版本说明为准。当前模型与联网服务使用 DeepSeek API，需要自己的凭据；本地运行不代表离线模型推理。

## Umi 可以做什么

### 文件与项目工作

发现任务相关的文件与目录，在选定范围内取得读取或编辑权限，将来源纳入托管工作副本。支持内容检索、按行或字节读取、创建文件、基于已读版本的精确替换及原子批量编辑。处理过程保留来源与版本，方便检查变化和继续工作。

### 联网检索与资料研究

搜索公开网页、读取网页正文，并保存搜索回执与网页快照。模型先接收有界摘录，再按需定位、查找或连续补读完整存档，减少一次性灌入长资料。会话中的资料和历史可以检索，研究过程能够回到具体来源。

### 命令执行与结果检查

为需要程序或工具配合的任务准备执行请求，呈现具体操作供批准，并保存命令状态、退出结果与输出记录。运行可以停止；中断或结果不确定时先核验既有执行，避免把重试当成已经完成的工作。

### 多轮任务与上下文维护

在自然对话中继续任务、纠正方向或提出新要求，使用独立的选项问答补充信息。上下文按预算组织，保留工具调用与结果配对，并通过历史检索、记忆和按需读取延续长任务。上下文摘要与原始记录分开，工作环境可以跨轮保留。

### 审阅、交付与成果导出

预览固定版本的变更集，批准后写回来源；也可以生成独立成果并导出到指定位置。交付与导出保存逐项回执，文件变化、执行成功和交付完成有各自的依据。已交付文件可在后续对话中请求用系统默认应用打开。

### 桌面阅读与会话管理

按工作区组织会话，添加文本或图片附件，查看流式正文与执行过程。文件区支持标签切换、代码着色、Markdown 排版、静态 HTML 和常见图片预览；长文本按需续读。会话可重命名、归档、恢复，归档后可明确确认永久删除。

典型流程：选择工作区 → 描述目标 → 查找与读取资料 → 编辑或执行 → 检查结果 → 审阅并交付。问答与操作批准在各自需要时出现。

## 核心设计

| 设计 | 作用 |
| --- | --- |
| 单一任务循环 | 桌面与 CLI 共享 `UmiApplication → AgentEngine`，模型轮次、工具、停止与恢复沿同一入口处理 |
| 事件与资料持久化 | 用 SQLite 保存会话、执行事实和资料引用，通过纯状态归约构建实时与历史视图 |
| 具体操作批准 | 将决定绑定实际请求、对象、环境和版本；派发前保存事实，未知结果先核验 |
| 来源、工作副本、交付分离 | 在副本中处理文件，按冻结变更审阅与写回；独立成果使用明确导出目标 |
| 有界模型上下文 | 将完整存档与模型输入视图分开，结合预算、历史、来源引用及局部读取组织信息 |
| 明确的模块边界 | 协议定义契约，Agent 协调执行，适配器连接模型、存储和宿主，应用层负责组装 |

这套结构支撑文件处理、研究和开发任务，也为学习 Agent 的请求、工具、权限、上下文与恢复流程提供可追踪的代码入口。

## 快速开始

### 下载 Windows 版本

前往 [GitHub Releases](https://github.com/QI-seven33/Umi/releases)，选择对应版本：

| 文件 | 用途 |
| --- | --- |
| `Umi-Setup-<version>-x64.exe` | 当前用户安装版，包含卸载入口 |
| `Umi-<version>-win-x64-portable.zip` | 完整解压后运行其中的 `Umi.exe` |
| `SHA256SUMS.txt` | 下载文件的 SHA-256 校验值 |

目标环境为 Windows 10/11 x64。安装包暂未代码签名，实际验证范围见各版本发布说明。便携版需要整个解压目录；可用 PowerShell 的 `Get-FileHash <文件路径> -Algorithm SHA256` 核对下载文件。

首次启动后：

1. 在设置中填写自己的 DeepSeek API Key，并选择模型。
2. 选择项目或资料目录作为工作区，描述想完成的任务。
3. 根据需要补充信息、审阅请求和变更，接收交付结果。

密钥、会话和托管工作资料保存在本机用户数据目录，与安装目录分开。模型请求会发送到配置的 API 服务。关闭窗口会隐藏应用；通过 **Umi → 退出 Umi** 完整退出。更新程序或切换源码版与便携版前，请先退出旧实例。

### 从源码运行

要求 Node.js **`>=24.11.0 <25`**。使用仓库根目录的 npm 与锁文件，无需 Python 后端。

```powershell
git clone https://github.com/QI-seven33/Umi.git
cd Umi
npm ci --no-audit --no-fund
npm run dev
```

桌面设置或 `DEEPSEEK_API_KEY` 环境变量均可提供凭据。环境变量示例见 [.env.example](.env.example)；桌面入口不会自动读取任意 `.env` 文件。

无需密钥、使用模型替身的确定性演示：

```powershell
npm run demo
```

`npm run dev` 会重建桌面资源；`npm run desktop` 使用已有 `dist`。无界面入口及参数见[代码学习指南](docs/code-reading-guide.zh-CN.md)。

## 当前边界

- **宿主命令没有操作系统级文件或网络沙箱。** 工作副本、工作目录和 Windows Job 进程管理不构成这种隔离，请根据具体请求决定是否批准。
- 中断核验与持久记录不保证任意任务自动恢复。结果不确定、权限或来源变化时，可能需要继续核验或重新授权。
- HTML 为禁脚本的静态预览，PDF/Office 等二进制文件尚无完整内置解析；网页正文提取也不保证覆盖网站全部内容。
- 资料与日志有读取及留存上限；有界摘录可补读已存内容，不能追回未被保存的部分。
- 通用 skill/插件加载、任务内宿主信任、自动免批准执行和自选托管工作根仍待设计。
- 当前授权状态为 `UNLICENSED`，没有项目级开源许可；说明见[授权状态](LICENSING.md)。

尚待修复的问题和发布差异见[已知问题](docs/known-issues.zh-CN.md)与[版本说明](docs/releases/0.2.0-alpha.3.zh-CN.md)。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build:desktop
```

涉及桌面行为时，使用独立数据与模型替身运行真实 Electron 检查：

```powershell
npm run verify:desktop
npm run verify:desktop -- --preview-only
```

第二条命令只运行文件预览专项。GitHub 托管 CI 覆盖工作流明确列出的协议、文件 IO 与界面逻辑测试；真实 Windows 进程桥和桌面交互需要另行验证。CI 通过不能代替未运行的本机检查。真实 API 验证可能产生费用，不属于默认构建与测试流程。

Windows 分发：

```powershell
npm run build:icons
npm run package:windows
npm run verify:packaged
```

图标由 `assets/brand/umi-symbol.png` 生成。`package:windows` 重建便携版并生成安装器、完整便携 zip 和校验清单，输出到 `release/installers/`；本地构建与上传 Release 是独立步骤。详见[Windows 发布流程](docs/windows-release.zh-CN.md)。

## 代码与文档导航

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/` | Electron 生命周期、固定 preload/IPC、broker、worker 与 React 界面 |
| `apps/headless/src/` | 应用组装、CLI 与无界面运行入口 |
| `packages/protocol/src/` | 运行时数据契约、事件与纯状态归约 |
| `packages/agent/src/` | Agent 循环、上下文、工具与权限协调 |
| `packages/adapters/src/` | DeepSeek、SQLite、文件系统与进程适配器 |
| `tests/` | 契约、故障注入、恢复、资源与界面逻辑验证 |

- [代码学习指南](docs/code-reading-guide.zh-CN.md)：沿真实调用链阅读源码。
- [当前项目报告](docs/current-project-report.zh-CN.md)：实现状态、开发路线及阶段证据。
- [架构设计](docs/architecture-v1.md)与[核心契约](docs/contracts-v1.md)：理解设计基线及不变量；当前能力以源码和最新报告为准。
- [开发交接](docs/handoff.zh-CN.md)：按日期保留探索、取舍与验证记录，历史计划不等于已实现能力。
- [更新记录](CHANGELOG.md)：已发布与未发布的行为变化。

阶段报告中的本机路径只用于定位维护者当时的证据。原始日志、截图、会话数据库、凭据、依赖和构建产物不提交到源码 Git；安装文件通过 Releases 分发。

## 参与项目

欢迎通过 [Issues](https://github.com/QI-seven33/Umi/issues) 报告可复现问题或讨论具体需求。提交代码前请阅读[贡献指南](CONTRIBUTING.md)与 [AGENTS.md](AGENTS.md)；较大的行为变化先讨论，提交时说明影响、检查范围和剩余限制。

安全漏洞请按[安全报告](SECURITY.md)私密反馈。项目授权与第三方代码、字体及图标的许可分别见 [LICENSING.md](LICENSING.md) 和[第三方声明](THIRD_PARTY_NOTICES.md)。
