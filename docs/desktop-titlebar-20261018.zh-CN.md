# 开发版与发行版的紧凑顶栏

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


日期：2026-10-18。顶栏修复现纳入0.2.0-alpha.3发行流程；下文“不提交/不更新Release”等为此前修复阶段的范围，本轮按用户新授权提交并发布新版本，旧alpha.2资产保留。

## 后续修正：两角灰色块与按钮反馈

用户截图暴露了前轮验证遗漏的两个具体问题：左侧展开按钮把 aria-expanded=true 当成了常驻选中底色；右侧原生标题按钮写死了 #f0f1f0/#202020，覆盖在 Mica 上形成独立灰色矩形。这两处主要是底色，不是 box-shadow。

本轮将 titleBarOverlay.color 固定为 #00000000，符号色仍随主题切换；左侧只有真正悬停、按下或应用/编辑菜单打开时才显示叠色，侧栏展开状态本身不再绘制底板。左侧悬停使用主题文字色6%透明度、按下10%，无投影、滤镜或缩放；原生最小化/最大化保留系统轻量悬停，关闭按钮保留系统红色反馈，不用自制窗口控件替换。

类型检查与构建通过；本轮源码完整桌面83/83通过，实际便携完整桌面83/83也通过；195个运行文件hash一致，最终源码/构建/便携指纹为741839e7747dddb028a77bb860667f74908d1dce11f1b6959a957a1876f27379。增加了浅深主题下所有顶栏按钮静止透明、左侧已展开仍透明、悬停与移出复位的真实样式检查。未重复运行上一轮13项逻辑测试或484项核心全量。

此前 capturePage 不包含原生窗口按钮，不能据此验收右上角色块。现在通过 Electron desktopCapturer 保存且仅保存本验收窗口的原生框架图，实际检查右侧三个按钮；Mica/DWM 材质不包含在窗口捕获内，透明部分在图片查看器中可能显示黑色，这不代表实际窗口变黑，也不把它当作壁纸材质完整视觉验收。证据与旧便携备份：维护者本地证据目录（不随源码分发）。

[Electron 标题栏透明色支持](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)与[当前44.5.1原生按钮绘制实现](https://github.com/electron/electron/blob/v44.5.1/shell/browser/ui/views/win_caption_button.cc)用于核对透明背景和系统悬停行为；没有升级依赖。本轮保留此前未提交修改，不提交Git、更新Setup/GitHub Release、调用真实API或改动默认会话数据。

## 原因与结果

旧 main.ts 无条件注册了“Umi / 开发”原生菜单；Windows 打包不会自动去掉手工注册的开发项。开发阶段提供重载和开发者工具是正常的，发行界面应单独确定菜单范围。

现在移除原生菜单栏和默认标题栏图标，采用40px紧凑顶栏：左侧收起按钮、应用、编辑；Windows原生最小化、最大化/还原和关闭按钮在右侧。右侧文件预览按钮、用户头像和工作区功能沿用既有位置。

| 模式 | 判定 | 菜单 |
| --- | --- | --- |
| 开发版 | Electron app.isPackaged 为 false | 应用、编辑、开发 |
| 发行构建 | Electron app.isPackaged 为 true | 应用、编辑 |

“应用”只保留关于 Umi 和退出 Umi；“编辑”沿用原生撤销、重做、剪切、复制、粘贴、全选。未加入更新管理、命令管理等新功能。界面内左上角图标已移除，exe、任务栏与安装器图标继续使用现有产品图标。

关闭窗口仍是隐藏；要结束进程，用“应用 → 退出 Umi”。设置页保留应用/编辑菜单，不会因工作台 inert 一起隐藏。开发版专有的重新加载会中断页面状态，仍仅供开发调试使用。

## 调用链与边界

- renderer/src/TitleBar.tsx 只传菜单名称及弹出坐标，菜单展开状态由原生关闭回调复位；顶栏可拖动，按钮不参与拖动。
- preload.ts 只新增固定 windowInfo/showMenu API，不暴露任意 IPC、菜单定义或窗口执行脚本能力。
- protocol/src/desktop.ts 用严格规格校验菜单枚举、整数坐标和额外字段。
- main.ts 继续核对主窗口主框架来源；基于 app.isPackaged 决定真实模式，不采用渲染层传来的开发标记。
- window-chrome.ts 定义窄菜单模板。打包后即使页面伪造 development 菜单请求，主进程也会拒绝；发行 BrowserWindow 的 devTools=false。
- titleBarStyle:hidden 与 titleBarOverlay 保留原生 Windows 窗口按钮和系统行为。CSS 读取 Window Controls Overlay 安全区域，避免菜单侵入原生按钮；主题变化同步原生按钮底色和符号色。

这里只约束应用菜单和调试入口，不构成 OS 文件或网络沙箱。Agent循环、资源批准、工作副本、预览内容和生产会话库没有因顶栏改动而改变。

首次便携回归在33项后被旧悬停对比度断言阻断：颜色仍在过渡中，取到了3.76的中间值。验收现在等待目标和祖先的CSSTransition结束后测量，保留4.5阈值和真实动画；未改产品颜色来迎合检查。失败证据保留于desktop-packaged-first-contrast-failure，最终源码/便携均完整通过。

## 调整位置

- 布局高度：surface.css 的 --titlebar-height，与 window-chrome.ts 的 TITLE_BAR_HEIGHT 同步，当前40px。
- 文字：surface.css 的 .titlebar-menu，当前13px、400字重、沿用主题 UI 字体。
- 左侧留白和菜单间距：surface.css 的 .app-titlebar 与其 nav 规则。
- 菜单项目及原生角色：window-chrome.ts。
- 开发/发行判定与窗口覆盖设置：main.ts。

不应再通过设置一个“release”前端布尔值隐藏开发按钮；必须同时保留主进程校验。Windows标题按钮使用系统原生实现，无自制最小化/关闭IPC。

## 验证与使用

验收采用独立 --data 临时目录和离线模型桩，不调用付费API或修改默认会话数据。类型检查与桌面构建、13项相关逻辑测试通过。源码完整桌面82/82通过，包含原生菜单真实弹出/关闭、伪造请求拒绝、最小化恢复/最大化、顶栏安全区、设置页以及已有批准/问答/预览流程。实际便携完整桌面82/82也通过，包含发行版真实openDevTools不打开以及伪造开发菜单请求被拒绝；195个运行文件逐项hash一致，源码/构建/便携指纹均为caeecf0226e2e2964c436b925d08dcd66066ffe6d22d9c0d5cf75b9183b7c924。

验证入口：tests/window-chrome.test.ts、apps/desktop/verification-window-chrome.ts；完整桌面脚本仍是 scripts/verify-desktop.mjs，增加 --packaged 验证实际 Umi.exe。截图仅捕获 Chromium 页面，不包含 DWM 原生标题按钮或原生弹出菜单；原生菜单以实际 popup/closePopup 和回调验证，标题区域以 Window Controls Overlay 实际几何验证。最窄窗口检查针对顶栏留位，不代表已重新验收所有窄窗口组合。

本轮证据与旧便携运行文件备份：维护者本地证据目录（不随源码分发）。没有重跑484项核心全量或执行安装/卸载。源码运行可用 npm run dev，本地便携入口为 release/Umi-win32-x64/Umi.exe；源码改动不会进入已经运行的旧进程，需要先完整退出再启动。

## 官方资料

- [Electron 自定义标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [原生菜单和移除应用菜单](https://www.electronjs.org/docs/latest/api/menu)
- [app.isPackaged](https://www.electronjs.org/docs/latest/api/app#appispackaged-readonly)
- [WebPreferences.devTools](https://www.electronjs.org/docs/latest/api/structures/web-preferences)
