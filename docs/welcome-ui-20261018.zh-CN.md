# 新会话布局与容器边缘材质

## 0.2.0发行时点

本页各轮设计、未测试和未发布状态按历史保留。最终欢迎语已由维护者改为“Thus begins the story.”，浅色导航为#E8EAED；侧栏232px、列间距0px。本次发行核心486/486、源码与实际便携各85/85桌面验证通过，首次旧中文断言失败已修正并保留记录。最新范围与限制见[0.2.0版本说明](releases/0.2.0.zh-CN.md)。

日期：2026-10-18。状态：源码与本地便携目录更新，尚未提交或发布。安装器审查另见 [报告](installer-upgrade-review-20261018.zh-CN.md)。

## 2026-10-18：居中单句与纯色背景（未发布，按要求未测试）

欢迎区移除图标、原问句和辅助小字，只显示“故事将由此展开。”。使用现有UI无衬线字体、400常规字重、26–32 CSS px，回到与输入框水平中心对齐的单句布局；首条消息后的底部输入逻辑保留。

聊天大卡片向左扩16px（展开侧栏宽224px），底部留3px、右侧留4px，侧栏收起时左侧留4px；通过补偿侧栏底部内边距保持头像垂直位置。容器柔和边缘阴影保留。浅色外围统一#F9F9F9，主窗口不再启用Mica，主题IPC固定返回solid并随主题更新不透明窗口背景；深色主题保留对应纯色深色背景。

本轮只进行编译/构建，没有执行单元测试、桌面验收、视觉截图或真实API。旧品牌欢迎区的相关断言已同步为新文案和无图标结构，但没有运行；前轮85项通过不作为本轮验收。本地便携运行资源已同步，需通过应用菜单完整退出后重新启动。没有生成Setup/ZIP、操作安装逻辑、提交Git或更新远端发布。修改前资料和运行资源备份：E:/Codex/Workspace/output/umi-story-solid-20261018。

下文图标+问句、灰蓝hello和相关验收为历史阶段。

## 前轮：品牌与任务入口（历史）

本轮将 hello 换为“今天想完成什么？”，与现有圆角白底 Umi 图标同排。标题使用主题正文色和统一 UI 字体，24–30 CSS px、500 字重；图标宽高 40px，窄聊天区 36px。下方以 13px 辅助字说明“整理文件、查找资料，或继续你的项目”，未选工作区与核心连接中有对应提示。

标题区与输入框等宽、左边缘对齐；新会话 textarea 最低 64px，为两三行起草保留空间，首条消息后回到原有紧凑底部输入。此前柔和边缘阴影、同一 Composer/textarea、0.618:1 弹性留白保留。未增加功能卡片、快捷任务入口或新的请求流程。旧 TextPressure 学习组件与字体资料保留，但欢迎页不再挂载它，不运行其逐帧字体变化。

本轮类型检查/构建通过，源码完整桌面 85/85、实际便携完整桌面 85/85 通过；验证浅深主题标题对比度至少 4.5、图标离线加载、宽窄对齐、无多余图标阴影、首条消息后的节点身份和底部位置。原 hello 压力动画断言按新设计改为品牌行和本地图标检查，不沿用旧文案期望。

首次实际便携回归在第 81 项之后的侧栏拖动状态断言失败；同一个未改动包复测 85/85 通过。未放宽拖动断言，单次失败根因仍未确定，失败证据保留。首次覆盖打包因用户正在运行本地便携版而 EBUSY；用户通过菜单完整退出后同步成功，没有强制终止该用户进程。

证据：E:/Codex/Workspace/output/umi-welcome-brand-20261018。desktop-source/、desktop-packaged/ 包含本轮截图与结果；desktop-packaged-first-attempt/ 保留失败；source-before/、baseline.diff 和 portable-before/ 保留修改前资料；final-build-consistency.json 核对源码/构建/便携的 196 个运行文件。

本地便携已同步，版本仍为 0.2.0-alpha.3 的未发布修改；安装器与已发布 ZIP 保持原版。安装方式的进一步调查见[主流方案对比](windows-installer-comparison-20261018.zh-CN.md)，本轮不改安装逻辑、不提交 Git 或更新远端发布。下文灰蓝 hello 与压力效果是前轮历史设计。

## 前轮结果与契约（历史）

- 对话大卡片和普通输入框恢复静态、低对比的柔和边缘阴影；聚焦不抬升、不加重阴影。按钮、过程行、设置卡片与权限/选项卡沿用此前无投影设计。
- 新会话将 hello 与输入框组合放在聊天区中部。hello 缩至 48–64 CSS px，宽度 168–228 CSS px，随实际聊天容器宽度变化。
- 浅色 hello 使用灰蓝 #708295，深色使用 #9cacbd；保留现有本地可变字体、压力交互和减少动态偏好支持。
- 有第一条消息后恢复原有底部输入布局。复用同一个 Composer 和 textarea，保留草稿、附件与焦点所依赖的组件状态，不新增表单或发送流程。

“黄金比例”用于内容组上下的弹性留白：上方 0.618、下方 1。它不是把输入框固定在整个屏幕某一个像素或比例坐标；顶部栏、内容高度、右侧预览和短窗口都会影响最终位置。内容增高时先收缩留白，附件列表单独限制高度并可滚动。

## 修改入口与学习顺序

| 文件 | 职责与调整位置 |
| --- | --- |
| [App.tsx](../apps/desktop/renderer/src/App.tsx) | 按消息是否为空添加 is-welcome；把 EmptyConversation 传入现有 Composer 的 intro |
| [Composer.tsx](../apps/desktop/renderer/src/features/work/components/Composer.tsx) | 在原表单内显示 intro；普通输入、批准和问答的原有逻辑保留 |
| [workspace-layout.css](../apps/desktop/renderer/src/workspace-layout.css) | 最终布局覆盖；新会话的上下弹性留白、间距、附件限高，以及请求卡无阴影 |
| [interactions.css](../apps/desktop/renderer/src/components/ui/interactions.css) | text-pressure 的字号、宽高和颜色引用 |
| [surface.css](../apps/desktop/renderer/src/styles/surface.css) | --work-edge-shadow、--composer-edge-shadow、--welcome-ink 及深色主题值 |
| [verification-welcome.ts](../apps/desktop/verification-welcome.ts) | 真实 Electron 几何、主题与截图验收 |
| [verification.ts](../apps/desktop/verification.ts) | 发送首条消息后核验 textarea 节点身份与底部位置 |

输入框阴影丢失的直接原因是后加载的 workspace-layout.css 将 box-shadow 覆盖为 none。现在最终规则引用同一主题变量，避免只改前面的 surface.css 却不生效。大卡片增加轻微描边与短距离阴影；不会扩散为全局按钮投影。

普通输入框的边缘由两层低透明阴影构成，运行时仍沿用此前蓝色呼吸透明度动画。新会话布局仅由 CSS 负责，没有添加逐帧位置计算、监听器或页面滚动动画。

## 本轮验收

类型检查、TypeScript 编译和桌面打包通过。源码完整桌面 85/85、实际本地便携完整桌面 85/85 通过；这是本轮执行结果，没有把此前 486 项核心测试当作重跑。验收使用隔离临时数据库和离线模型，不操作默认会话库或真实 API。

首次便携验收在第 60 项后等待蓝边呼吸透明度变化超时；同一未改动包复测 85/85 通过。失败证据保存在 desktop-packaged-first-attempt/，本轮没有确认该次超时根因，也没有放宽原动画断言。

新增检查覆盖：

1. 浅色、深色、右预览展开后的窄聊天区，hello 与输入区居中且不重叠，输入区位于视觉中部。
2. hello 字号、容器宽度、边缘阴影及聚焦前后尺寸；发送按钮仍无投影。
3. 仅一个输入框，首条消息后保持同一个 textarea 节点、移除 hello 并回到底部；原有快速提交与附件身份检查继续通过。

证据位于 E:/Codex/Workspace/output/umi-welcome-surface-20261018：

- desktop-source/、desktop-packaged/：完整桌面结果与截图。
- welcome-centered-light.png、welcome-centered-dark.png、welcome-centered-narrow.png 在各自桌面证据目录内。
- portable-before/：同步前的 exe、运行构建与清单备份。
- final-build-consistency.json：最终源码、构建及便携运行文件一致性。
- installer-observation.json：原 alpha.3 包体只读统计。

截图使用实体 Electron 页面、固定纯色材质及减少动态偏好，以便比较排版。动态压力效果沿用原组件；窗口 DWM/Mica 视觉与所有系统缩放组合没有专项穷举。

## 运行与分发边界

本地 release/Umi-win32-x64/Umi.exe 已同步。本轮属于未发布 UI 修改，package 版本仍为 0.2.0-alpha.3；发布过的 alpha.3 Setup/ZIP 不包含这些新改动。通过“应用 → 退出 Umi”完整退出旧进程后再启动本地便携 exe；只关闭窗口会隐藏旧进程。

没有修改安装/卸载配置、宿主桥、权限协议、数据库迁移、Agent 循环或模型调用，也没有升级依赖、提交 Git 或更新远端资产。
