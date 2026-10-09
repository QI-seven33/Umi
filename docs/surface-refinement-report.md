# Umi 桌面外观与输入载体修复

日期：2026-10-05。产品名称仍为 **Umi**，目录名不作为产品名称。

## 本次完成

| 用户要求 | 实现 |
| --- | --- |
| 移除五种新底色 | 删除 CanvasColors 组件、入口、变量和专属 CSS；清除旧 `umi.canvasColor` 偏好 |
| 柔和桌面材质 | 支持的 Windows 11 使用原生 Mica；其他系统使用浅灰绿色静态外壳，深色主题使用低饱和深灰绿 |
| 侧栏与按钮 | 新对话采用简洁图标文字行，选中会话使用柔和白色底；工作区和会话保持一致行宽 |
| 图标 | 根据提供的像素吉祥物生成方形图标，导出 512 PNG 和七个尺寸的 ICO，写入 Windows 可执行文件；左上角去掉 Umi 文字 |
| 展开按钮阴影 | 按钮与 summary 的普通、悬停、按下、聚焦状态均不使用投影；浮层改用描边，保留键盘焦点提示 |
| 用户消息时间与复制 | 固定在气泡右下方；修复反向布局与尾端对齐叠加造成的位置错误；移除上下位移动画 |
| 思考强度切换 | 保留紧凑的单选芯片，取消文字缩放、弹出动画和阴影；选项放在模型菜单内部，不再横向挤出侧浮层 |
| 设置分类 | 拆成个人资料、模型设置、会话、插件、归档五个独立页面；配置能力沿用现有实现 |
| 长输入 | 6000 字符或 120 行起自动转为原文文本附件；长粘贴即时转附件，手写长消息在发送前转附件 |
| 移除粘贴按钮 | 保留 Ctrl+V、文件上传与拖放，去掉额外粘贴文本按钮及其专用 IPC |
| 会话标题 | 消息卡片顶部显示图标与当前标题，超长标题省略并可悬停查看 |
| 全局形状 | 普通控件统一 12px 圆角，卡片 16px，大面板 22px；小按钮不使用悬停投影 |

按钮 hover 继续使用 `#F0F0F2`。头像、上下文圆形仪表与时间刻度保留其形状；中止按钮变为圆角矩形，普通状态红白，悬停状态采用统一浅灰底与红色标识。

大面板与输入框仅保留静态、很淡的层级阴影，不在悬停或聚焦时突然增强。未对事件协议、唯一归约器、Agent Loop、数据库表或工具派发流程做重构。

## 材质的实际边界

`BrowserWindow.backgroundMaterial='mica'` 由 Windows DWM 绘制，页面背景透明以露出材质。页面没有桌面截图、壁纸读取或颜色采样权限。

Mica 使用壁纸和系统主题形成背景，不是持续采样窗口后面所有像素的 Acrylic。其外观还受系统透明效果、窗口活跃状态和系统设置影响。这里只采用公开的原生能力，不能据截图确认 Codex 内部使用的具体实现。

Electron 将该能力限定为 Windows 11 22H2 及以后；当前实现检查 OS build >=22621，并提供静态降级。轻薄绿色渐变只是降级样式，不是重新引入可选饱和底色。

参考：[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)。

桌面证据图由 Chromium `capturePage` 生成，它不包含 DWM 的原生材质。因此 `surface-settings-preview.png` 和 `surface-delivery-preview.png` 明确使用静态降级外壳，仅用于检查组件布局；不据此宣称验证了真实桌面壁纸呈现。

## 长输入与恢复

长输入的“文档化”是**载体转换**，并未把用户原文交给模型压缩后丢弃。使用已有上传、附件持久化和 `read_attachment` 通道，无新增表。

- 短文本、代码片段和模板表达式仍按普通文本粘贴。
- 长粘贴不覆盖输入框里已有的短草稿，生成“已粘贴的文本.txt”。
- 手写长消息生成“长消息.txt”，并发送指向完整原文的阅读说明。
- 沿用每条消息最多 8 个附件、每个附件最多 1 MB 的边界。超过限制明确报错，手写原文保留在输入框。
- 发送前沿用同步锁；待确认请求沿用 commandId 和回执检查。20 次快速提交只产生一个请求。
- 默认预览可以有界截断；原文件完整保存，模型可以通过读取范围继续读取。
- 预览标签身份改为附件 ID / 交付快照 ID / 工作区路径。相同文件名不会误用同一个标签，不同交付快照也不混用。

这项功能没有扩大模型上下文窗口，也没有改变阶段 4 的预算阻塞及恢复语义。超大附件仍需分段读取；不能据这次短任务验证宣称解决无限长任务。

## 为什么 Harness / Codex 显示具体命令，而 Umi 较泛化

这是三个环节共同形成的结果：**提供了哪些工具 → 工具参数与结果记录了什么 → UI 选择哪些字段展示**。不是 DeepSeek reasoning_content 的结构直接决定命令卡片外观。

### 本地 Harness 源码证据

检查路径：`E:\Deepseek-Harness\dsh-learn\deepseek-harness`。

- `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`：行组件接收 title、summary、bodyRaw、output、state 和 terminal 等专用卡片。输入参数与执行输出可以分别展开。
- `packages/client/ui-tool/src/client/tool/models/terminal-card-model.ts`：shell 卡片保留具体 command、description、cwd、exitCode、signal 和 running。工具提供的用途描述保持原文，产品状态文案在渲染时本地化。
- ToolRow 优先把 terminal.description 用作简短说明，因此可以显示“Verify repo state…”这类用途文字；展开后仍有真正的命令和结果。

这些行为是对已记录工具调用的展示投影，不是把模型的内部推理翻译成命令。用户截图中 Codex 的 Get-Content、rg 等文字也是执行调用的可读记录；不能据这些界面文字推断其全部内部实现。

### Umi 当前差别

1. `activity.ts` 的 `activityLabel` 根据成功工具类别生成标签，去重并最多显示三类，再追加“等”。这用于组标题，因此天然比单次调用具体描述更概括。
2. `Timeline.tsx` 的 Tool 行只从参数选取 path、query、program、messageId 作为提示。run_command 的 argv、cwd，run_shell 的完整 script 没有拼进折叠行。
3. 展开内容优先显示 `result.content`；已有结果时没有同时展示请求参数。这会让用户看到输出，却看不到当时具体运行了什么。
4. `apps/desktop/service.ts` 的 tool_detail 已从执行记录读取完整 JSON 参数，返回有界结果输出。也就是说，一部分事实已在后端，缺的是合适的 UI 投影；不能笼统归因于“后端没执行命令”。
5. Umi 采用结构化文件工具与受批准的命令工具。使用 read_file / search_text 时实际操作本来就不是 Get-Content / rg；为了显示类似文字而改成 Shell，会改变真实能力与权限边界。

后续最小改进可以是“用途说明 → 实际请求（程序、参数或脚本、目录）→ 生命周期状态 → 执行结果”的分层展示，并以工具类型生成可本地化标题。若已有参数足够，先改投影；只有真正缺少用途元数据时才扩展相应 DTO。本次遵照要求，仅分析，不改变这些运行展示的语义和执行逻辑。

## 验证证据

- 自动案例：146/146 通过，详见 `docs/evidence/surface-tests.log`。最后补充的预览身份断言在交互组 9/9 通过。
- 真实 Electron 运行：37 项检查通过，覆盖五类设置、思考芯片无缩放/模糊、用户气泡对齐、中止按钮强制 hover 样式、长粘贴与长手写输入、连续提交、批准预览、归档恢复、崩溃重建和预算阻塞。
- 打包版本采用相同验收脚本和独立临时数据，不连接用户数据库。隔离副本打包与最终项目打包程序均 37/37 通过。
- 真实 DeepSeek Flash / thinking off：2 次请求，读取 19,893 字节原文附件，在默认预览范围以外的文末找到验收口令“海风”，最终回复唯一。见 `docs/evidence/surface-long-input.json`。

这些验证覆盖协议与本次界面边界，不代替长期任务验证。桌面测试夹具的重复文案不是本次真实模型输出。

## 图标来源与导出

生成方式：内置 imagegen 编辑，引用用户提供的第三张图片；非 SVG 手工重绘。

原始生成文件：`C:\Users\sevan\.codex\generated_images\01a0cd28-0c05-7501-a2f3-e622dc237bd6\exec-4bfc5fed-34cd-410f-b93e-c0d74a2087b2.png`。

交付：`apps/desktop/renderer/public/umi-logo.png`、`apps/desktop/renderer/public/umi.ico`。ICO 包含 16/24/32/48/64/128/256，使用 `scripts/build-icons.cjs` 导出；512 PNG 同时用于侧栏和窗口图标。生成版本保留参考图的像素吉祥物特征，不声明逐像素相同。

完整生成提示词：

> Edit target: the supplied Umi pixel mascot app icon. Produce one square app icon, high resolution. Preserve the exact original pixel-art shape and colors: small white face, two dark pixel eyes, navy dark triangular hat/outline, blue circular headphone/ear at right, blue plus sparkle above right. Do not redesign, smooth, add objects or text. Enlarge the original crisp pixel geometry with nearest-neighbor-like sharp blocks; center it with about 12% safe margin inside a very pale neutral off-white softly rounded square tile. Crop the input's uneven outer blank margins into a symmetrical square. Keep the original minimalist silhouette, no extra drop shadow, no gradients on mascot, no lettering. Intended use Windows desktop Umi app icon and compact 32px sidebar logo.

## 修改落点

- 原生材质与受限主题桥：`apps/desktop/main.ts`、`preload.ts`、`packages/protocol/src/desktop.ts`。
- 窗口布局与发送入口：`apps/desktop/renderer/src/App.tsx`。
- 统一外观：`styles/surface.css`；删除旧纯色专用样式，沿用全局字体与主题变量。
- 设置：`features/settings/SettingsPage.tsx`。
- 长输入与附件：`features/work/longInput.ts`、`attachments.ts`、`components/Composer.tsx`。
- 无缩放思考芯片：`components/ui/JellyRadio.tsx`、`styles/JellyRadio.css`。
- 包装与验收：`scripts/package-desktop.mjs`、`scripts/verify-long-input.ts`、`apps/desktop/verification.ts`、`tests/interaction.test.ts`。

同步前逐个核对源文件 SHA256，原文件和旧执行文件备份在 `E:\Codex\Workspace\umi-surface-refinement-backup`。未改动会话数据或用户工作文件。启动更新版前需完整退出旧 Umi 后重新打开。
