# Windows 构建与发布

目标：Windows x64。Node.js `>=24.11.0 <25`，npm 锁文件固定依赖。Git 保存源码和构建说明，二进制通过 GitHub Releases 分发。

## 本地构建

1. 在 package.json 和 package-lock.json 同步版本，更新 CHANGELOG 和对应发布说明。
2. 安装依赖：`npm ci --no-audit --no-fund`。
3. 需要更新图标时运行 `npm run build:icons`。源图形位于 assets/brand/umi-symbol.png，脚本用固定白底圆角生成512px PNG和七尺寸ICO，不修改角色图形。
4. 运行 `npm run typecheck`、`npm test` 和 `npm run verify:desktop`。
5. 运行 `npm run package:windows`，随后运行 `npm run verify:packaged`。

`package:windows` 先构建源码和便携目录，再用 electron-builder/NSIS 生成安装器，并压缩完整便携目录。该命令只生成本地文件。输出：

```text
release/Umi-win32-x64/                 完整便携目录
release/installers/Umi-Setup-<version>-x64.exe
release/installers/Umi-<version>-win-x64-portable.zip
release/installers/SHA256SUMS.txt
release/installers/umi-windows-release.json
```

安装器采用当前用户安装，可选择目录，提供卸载入口，卸载保留用户数据。安装后不自动启动应用。本项目没有配置签名证书或自动更新。

## 一致性与验收

- dist/umi-build.json 记录源码指纹和运行文件hash；打包前拒绝过期dist。
- 便携目录中的 umi-release.json 记录构建时间、指纹和已校验文件数。
- 安装器从同一已验证便携目录生成，umi-windows-release.json 记录版本、指纹、文件大小和SHA-256。
- 发布前检查安装器封装内容，使用独立测试数据核验实际exe。若额外执行安装/卸载试验，必须明确目标目录和系统改动范围，不能把构建完成当成安装体验已验收。
- 原始证据保留在维护者本地，发布说明写实际结果及未通过项，不混用历史测试数量。

## GitHub 发布

提交源码和文档后，为该提交创建唯一版本标签（例如 v0.2.0-alpha.1），并上传安装器、便携zip、SHA256SUMS.txt和发布清单。alpha 版本标为 Pre-release。上传完成后核对远端文件名、大小和可用下载地址。

已有标签和发布资产不强制覆盖。若修复同一版本的构建，应使用新版本或先明确保存和替换策略。推送前检查差异、第三方许可和敏感信息；不上传个人数据库、密钥、证书或原始聊天日志。

参考：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[electron-builder NSIS](https://www.electron.build/nsis/)。

## 托管CI覆盖范围

GitHub托管CI只运行工作流明确列出的协议、文件IO与界面逻辑测试，并做类型检查、编译和桌面资源构建；真实Windows进程桥与桌面交互需单独验收。发布说明分别记录本机和托管检查，不能用CI绿色代替未运行的检查。既有托管环境限制见[已知问题](known-issues.zh-CN.md)。
