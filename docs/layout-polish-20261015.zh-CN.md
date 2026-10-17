# Umi 布局、预览与拖动性能修正

日期：2026-10-15。对应用户最近七张截图的十二项反馈。此前文件预览报告是前轮记录，本说明覆盖其中按钮位置、路径布局和查看菜单的旧约定。

## 十二项处理

| 反馈 | 本轮处理 |
| --- | --- |
| 右收起按钮应在下方卡片右上角 | 按钮移动到 work-surface 内绝对定位；标签栏右侧专门预留按钮宽度，左按钮保留顶部原位。 |
| 两侧横线错位 | 聊天标题栏和文件标签栏共用 48px 高度、盒模型和底边界；标签在固定高度内收缩省略。 |
| HTML 展示不完整 | 响应式静态 HTML 沿用实际侧栏视口与自然字号；样式有明确像素 width/min-width 时才建立更宽视口并按侧栏宽度缩放，提示上限 1920px。不改原文件、不执行 HTML 脚本。代码、Markdown 和图片继续采用各自的折行/排版/比例规则。 |
| 输入框挤压错位 | 主聊天区保留 420px；模型选择可收缩省略，窄容器隐藏次要强度标签与上下文圆点，收紧间距。消息和输入区在窄容器中统一边距；textarea 用 field-sizing: content 随容器宽度和文字共同调整高度，上限 140px。 |
| 完整路径且不独占一行 | 已验证预览回执携带 displayPath，路径、查看、刷新、打开控件共用单行。过长视觉省略，标题和复制保留完整值。 |
| 原文无色及菜单粗糙 | 代码原文同样按后缀着色，保持每个字符；补充 JSONL/NDJSON。原文/预览与打开方式收进同一个 9px 圆角菜单，使用描边、无投影。 |
| 思考“已中断”竖排突兀 | 移除摘要尾部挤成竖排的小徽标；中断事实保留在该段标题提示和运行状态中。 |
| 失败操作阴影 | 红色失败文字保留，展开/悬停不增加灰色底板或投影。 |
| 设置悬停仍像阴影 | 修正真正的高权重全局 hover 规则，设置分类不再被统一灰底覆盖；设置面板/卡片无投影。 |
| 文件入口应可辨识 | 可预览的变化文件、工具文件和行内文件链接统一使用主题蓝色；悬停靠下划线，不增加卡片阴影。 |
| 标签与关闭按钮不协调 | 标签 7px、内部关闭按钮 4px，各自边界稳定；移除强制所有按钮 10px 圆角的高权重覆盖。 |
| 拖动卡顿 | 指针移动只通过 requestAnimationFrame 合并 CSS 宽度更新，不在每次移动时重绘 React 主树或写 localStorage；松手提交状态并保存一次，拖动期间关闭网格过渡，并覆盖跨 iframe、取消和失焦收尾。 |

## 根因和学习入口

`styles/global.css` 原来有一条高权重 `:root body button:not(...):hover`，让组件虽然写了“透明悬停”，实际仍被灰色底板覆盖。它现在是 `:where(...)` 的低权重后备规则，颜色来自主题变量。`styles/surface.css` 的全局强制圆角也改为低权重后备，组件可自行决定标签、菜单和关闭按钮的圆角。这是此次设置/失败操作/文件行视觉冲突的共同来源。

`usePreviewResize.ts` 单独负责拖动：捕获起点与实际宽度、计算最大侧栏宽度、每帧合并一次 DOM 写入，最后提交 React 状态与 localStorage。窗口级释放/取消/失焦与 pointer capture 共同保证收尾。`workspace-layout.css` 的 is-resizing 关闭宽度过渡，避免 320ms 网格动画一直追赶指针。

`App.tsx` 只装配控件和引用拖动 hook；`HtmlPreview.tsx` 只处理 iframe 视口尺寸和缩放，用 ResizeObserver 直接写尺寸，不以连续坐标驱动 React。文件内容不因拖动重新生成 srcdoc。`file-preview.css` 负责标签、预览工具栏和内容；`workspace-layout.css` 负责窄聊天区、拖动状态与相关平面控件。

`DesktopService` 仅在现有预览对象通过会话归属、路径与读取核验后附加 displayPath。工作副本显示实际工作副本绝对路径；冻结文件显示原来源/交付目标绝对路径，读取仍来自原冻结内容。附件没有已知的原磁盘路径时显示“附件 / 文件名”，不伪造宿主绝对路径。打开命令仍传原对象身份和相对路径，没有新增任意文件或 Shell 接口。

`FileContent.tsx` 的原文视图改为带语言的 Syntax 呈现，着色仅增加转义后的 span，不改变文本。`Timeline.tsx` 保留中断块和工具失败事实，只收紧它们的展示。

## 验证

本轮 TypeScript 与桌面构建通过，29 项相关 UI/分页/交付回归、13 项桌面服务契约通过；源码真实 Electron 72/72、实际便携版 Umi.exe 72/72 检查通过。183 个运行文件 hash 与构建清单一致，源码、dist、便携版指纹相符。未重跑历史 439 项全量测试。构建时间 2026-10-15T12:30:28.684Z，打包时间 2026-10-15T12:32:13.611Z。

真实拖动观察：36 次指针移动期间 localStorage 写入 0 次、iframe srcdoc 重载 0 次、宽度过渡 0s；松手保存 1 次。聊天区 420px、输入框 388px，按钮无越界，短草稿重排完整。

新增/更新检查包含：固定宽度 HTML 实际子页排版与隔离；代码原文和 JSONL 语法着色；完整冻结路径；顶栏分隔线与标签按钮避让；共享菜单圆角和无阴影；设置、失败操作、文件入口的真实强制悬停样式；36 次真实鼠标移动期间保存次数与 iframe 重载次数；窄聊天区全部输入控件是否越界；中文长文件完整末尾与图片尺寸。

证据根：`E:\Codex\Workspace\output\umi-layout-polish-20261015`。本轮前保存 307 个源码记录（含 3 个既有删除项）、Git diff/status 和旧便携版 exe/dist。全部多阶段未提交改动与学习注释保留。验收使用临时独立数据和本地验证模型，不访问生产会话或付费 API。

## 边界

HTML 是只读静态预览，仍不运行脚本、加载远程资源或访问 Umi 桥。固定桌面视口按宽度缩小时文字也会变小；极端任意网页布局仍不等同系统浏览器的完整行为。窗口实际尺寸、系统缩放和负载会影响帧率；本轮验证的是消除逐事件重绘/同步存储/iframe 重载，不宣称所有设备固定达到某个 FPS。二进制 Office/PDF 解析范围没有增加。

本轮没有改变唯一 Agent 循环、权限模式、具体批准、源文件交付或跨轮打开规则。旧审计 A-01/A-02/A-03 仍留待单独处理。

打包另修正了一个实际阻塞：@electron/get 即使已有压缩包缓存，也会在线重取 SHASUMS 清单。现在给下载器传入当前固定 Electron npm 包附带的 checksums.json，仍核验缓存压缩包，不跳过校验。源码和包内运行文件 hash 检查继续保留。

中途验收修正了脚本选择器插值、Chromium 前端节点索引与稳定后端节点身份、组件效果尚未就绪，以及 Windows 透明窗口跳过合成绘制的问题。最终使用可见但不抢焦点的临时验收窗口，保留有界绘制等待与重试；正常产品启动不变。iframe 切换后的立即截图可能早于子页首帧，HTML 最终排版以实际子文档与已完成首帧的截图交叉核对。失败记录与最终通过记录分开保留，没有把历史通过数当作本轮结果。

参考：[MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)、[CSS transform-origin](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/transform-origin)、[field-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/field-sizing)、[Playwright 的 Chromium 验收启动参数](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts)。
