# DeepSeek 模型版本显示更新（2026-10-18）

## 官方事实与本轮范围

[官方更新日志](https://api-docs.deepseek.com/zh-cn/updates/)于 2026-10-17 宣布 Flash 升级为 **DeepSeek-V4.1-Flash-1017**，API 调用方式与价格不变，仍使用 **deepseek-flash**。截至本轮核对，[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)中的 Pro 具体版本为 **DeepSeek-V4-Pro-0813**，API ID 为 **deepseek-v4-pro**，继续提供服务。

本轮只同步 Umi 的版本展示与切换验收，不引入新的模型路由、联网自动发现机制、搜索 API 或新的思考档位。官方公告中的日期用于标注版本，不表示客户端可以用日期型号固定调用旧快照；供应商未来升级浮动路由时，仍需重新核对显示名称。没有向真实模型发出请求，不能把本轮离线检查描述成服务端返回型号的实测。

## 实现与学习入口

- [models.ts](../apps/desktop/renderer/src/features/work/models.ts)：统一维护界面名称与真实 API ID 的对应关系。输入区、菜单和设置页复用该表。两项完整名称分别为 DeepSeek-V4.1-Flash-1017 和 DeepSeek-V4-Pro-0813。
- [Composer.tsx](../apps/desktop/renderer/src/features/work/components/Composer.tsx)：模型按钮的提示与无障碍名称提供完整型号、API ID 和思考档位；点击继续传模型 ID，沿既有设置队列与 IPC 保存。
- [workspace-layout.css](../apps/desktop/renderer/src/workspace-layout.css)：聊天区不超过 440px 时，按钮仅隐藏 DeepSeek- 品牌前缀，让 V4.1-Flash-1017 / V4-Pro-0813 的型号和日期保持完整；菜单和设置页仍使用完整名称，字体、字重、卡片和输入框尺寸沿用现有主题。
- [adapter.ts](../packages/adapters/src/deepseek/adapter.ts)：既有请求仍发送 settings.model；本轮没有改变适配器、图片能力、上下文、批准行为或历史设置结构。
- [ui-flow.test.ts](../tests/ui-flow.test.ts)：从桌面服务更新设置，经唯一循环进入真实适配器的 prepare，再用模型替身返回响应，验证请求 ID 和重新打开后的设置。
- [verification.ts](../apps/desktop/verification.ts)：真实 Electron 页面点击两种模型，检查菜单名称、API ID 保存、按钮提示和窄区日期可见性。

## 验证与本地输出

类型检查、核心编译和桌面打包资源构建通过。ui-flow、adapter、deepseek-request 三个文件共 15 项测试通过，包括模型切换、后续请求路由与会话重新打开。未重跑历史全量 439 项，未调用付费 API 或操作生产会话。

实际本地便携 Umi.exe 真实 Electron 桌面验收 **74/74** 通过，覆盖完整型号、Pro/Flash 点击切换及持久化 API ID、完整提示，以及窄聊天区日期可见性与发送按钮不越界。本轮测试中 HTML 预览检查通过，但历史偶发问题仍保留，不因一次通过而宣称已修复。

源码构建与便携运行文件共 **182 项**逐项哈希一致；源码/构建/便携指纹均为 4c97382e737aaeb4a39bffe2a409cf2fb4a118d0ada17ec19a396ea1a7432c21。验收使用独立数据目录，生产会话与密钥未读取。

本轮本地便携输出为 release/Umi-win32-x64/Umi.exe；GitHub 已发布的 v0.2.0-alpha.1 安装器、便携压缩包及校验清单保持原样。本轮不提交、不打标签、不推送或发布新版本。源码、dist、本地便携目录与已发布安装器需要分别区分，不能认为修改源码会更新已安装应用。

使用本地更新前，请通过菜单完整退出旧 Umi；关闭窗口只是隐藏。检查日志、修改前备份与截图位于 E:/Codex/Workspace/output/umi-deepseek-models-20261018。
