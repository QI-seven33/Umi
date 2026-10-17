# Umi

<img src="apps/desktop/renderer/public/umi-logo.png" width="96" height="96" alt="Umi 圆角白底应用图标">

A local Windows AI agent built with TypeScript, Electron, and React.

Umi 是运行在 Windows 上的单人 AI 工作代理：描述任务、查看执行过程、批准具体操作，在工作副本中修改文件，再把确认的变更交付回原位置。默认模型适配器使用 DeepSeek。

**当前版本：0.2.0-alpha.1，实验性预发布。** 当前唯一 Agent 核心为 TypeScript；旧 Python 实现保留在 Git 历史中。

## 下载与安装

从 [GitHub Releases](https://github.com/QI-seven33/Umi/releases) 下载 Windows x64 版本：

| 文件 | 用途 |
| --- | --- |
| `Umi-Setup-0.2.0-alpha.1-x64.exe` | 安装版，可选择目录，为当前用户安装，包含卸载入口 |
| `Umi-0.2.0-alpha.1-win-x64-portable.zip` | 便携版，完整解压后运行其中的 `Umi.exe` |
| `SHA256SUMS.txt` | 下载文件的 SHA-256 校验值 |

目标环境为 Windows 10/11 x64；本次实际验证环境和结果见[发布说明](docs/releases/0.2.0-alpha.1.zh-CN.md)。安装包暂未进行代码签名。请核对仓库来源和校验值，不要只从便携目录复制一个 exe。

```powershell
Get-FileHash .\Umi-Setup-0.2.0-alpha.1-x64.exe -Algorithm SHA256
```

首次启动后，在设置中填写自己的模型 API Key。密钥、会话和工作资料保存在本机用户数据目录，与安装目录分开。卸载默认保留用户数据；更新前建议自行备份。

关闭窗口会隐藏应用，任务继续；通过 **Umi → 退出 Umi** 完整退出。升级或在源码版和便携版之间切换时，请先从菜单退出旧实例。

## 已有能力

- 单一 Agent 循环、流式任务过程、持久事件和中断核验。
- 自然消息继续或切换任务，独立的选项问答与自定义回答。
- 资源发现、选定范围授权、工作副本、搜索、连续读取和原子文本编辑。
- 冻结变更集预览、具体批准后交付，以及交付文件的跨轮打开。
- 宿主命令批准、执行记录、停止与未知结果核验。
- 文件标签与代码/Markdown/静态 HTML/图片预览；可调节预览区域。
- 蓝色呼吸运行边缘，与输入框等宽的批准卡和选项卡。

**执行边界：宿主命令没有操作系统级文件或网络沙箱。** 工作目录和 Windows Job 进程管理不构成隔离。模型可以请求文件写回或命令执行；请阅读具体请求再决定是否批准。

技能、通用插件加载器、任务内宿主信任和自动免批准执行仍处于设计阶段。PDF/Office 等二进制文件尚无完整内置解析。已知问题见[问题清单](docs/known-issues.zh-CN.md)。

## 从源码运行

要求 Node.js **`>=24.11.0 <25`**，使用根目录 npm 和已提交的锁文件。

```powershell
git clone https://github.com/QI-seven33/Umi.git
cd Umi
npm ci --no-audit --no-fund
npm run typecheck
npm run dev
```

可在设置中配置密钥，或使用 `DEEPSEEK_API_KEY` 环境变量。桌面入口不会自动读取任意 `.env` 文件。无需密钥的确定性演示：

```powershell
npm run demo
```

无界面入口、协议与调用链见[代码学习指南](docs/code-reading-guide.zh-CN.md)和[核心契约](docs/contracts-v1.md)。

## 构建与验证

```powershell
npm test
npm run build:icons
npm run verify:desktop
npm run package:windows
npm run verify:packaged
```

`build:icons` 从 `assets/brand/umi-symbol.png` 生成圆角白底 PNG 和多尺寸 ICO。`package:windows` 先重建便携版，再生成安装器、完整便携 zip 和校验文件，输出到 `release/installers/`。本地构建不自动上传 GitHub。详见[Windows 发布流程](docs/windows-release.zh-CN.md)。

普通验证使用独立数据目录和模型替身。真实 API 验证可能产生费用，需要自己的密钥和单独授权，不属于默认构建流程。

## 项目结构与文档

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/` | Electron 主进程、固定 IPC、broker、worker 和 React 界面 |
| `apps/headless/src/` | 应用组装、CLI 和生命周期 |
| `packages/protocol/src/` | 运行时契约、事件和纯状态归约 |
| `packages/agent/src/` | 唯一 Agent 循环、上下文和工具调度 |
| `packages/adapters/src/` | 模型、SQLite、宿主文件与进程适配器 |
| `tests/` | 协议、恢复、故障注入和界面逻辑验证 |

- [当前项目报告](docs/current-project-report.zh-CN.md)：实现状态与架构。
- [代码学习指南](docs/code-reading-guide.zh-CN.md)：调用链和阅读入口。
- [开发交接](docs/handoff.zh-CN.md)：开发阶段记录，历史条目不等于当前实现。
- [更新记录](CHANGELOG.md)、[贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)。

阶段报告中的机器路径仅描述维护者当时的本地证据位置；原始日志、截图、数据库、密钥、依赖和构建产物不提交到源码 Git。安装文件通过 Releases 分发。

## 授权与第三方资料

本仓库当前没有授予开源许可证，npm 元数据标记为 `UNLICENSED`；具体说明见[授权状态](LICENSING.md)。公开仓库不等同于已授予任意再分发许可。项目所有者尚未选择开源协议。

第三方代码、字体和图标分别遵循各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。欢迎按[贡献指南](CONTRIBUTING.md)交流问题和改进建议。

## 托管CI覆盖范围

GitHub托管CI只运行明确列出的协议、文件IO和界面逻辑测试，不覆盖真实Windows进程桥。初次在托管环境运行全量时，宿主进程就绪/崩溃核验出现超时和失败，运行随后被停止；这项托管环境兼容性仍待处理，不能把后续CI绿色当成439项全量通过。本轮完整439项结果来自本机Windows 11，所有原测试及断言保留。
