# Umi 双侧栏与文件预览调整

日期：2026-10-15。本说明对应用户对按钮错位和右侧预览区的补充要求；此前十二项界面报告保留为历史记录。

## 本次界面契约

- 左右收起按钮是同一条顶栏中的两个控件，共享高度和垂直对齐规则。头像、新对话和主体消息布局沿用已有位置。
- 右侧只承担文件查看：没有打开的文件时留白；移除成果首页、成果计数、空态说明、分页导航和首页按钮。
- 文件标签使用 vscode-icons 原仓库的彩色文件图标，包含 TypeScript、React、JavaScript、Python、Markdown、HTML、CSS、JSON、Rust、Shell、图片等；未知类型使用通用文件图标。图标随包内置，不依赖运行时网络。
- 文件上方依次为路径、原文/预览切换、重新加载、打开方式。初次打开默认预览；路径过长时省略，悬停可看完整路径。标签过多时换行，不提供横向滑动。
- 原文保留字符、换行和缩进，仅视觉折行。代码预览按语言着色，Markdown 显示标题、列表、引用、表格和代码块，HTML 显示静态排版，现有图片读取结果按原比例展示。
- 移除内层卡片、版本 hash/字节说明、冻结版本折叠块、手动“继续显示”按钮及底部长期开启状态提示。长文件靠近底部时自动请求下一段。正文长行和表格折行，纵向滚动条细且低对比。

## 学习入口和调用关系

`App.tsx` 只管理侧栏展开、标签和完整文件身份。身份仍来自 `fileTargetKey`，附件、工作副本、冻结变更不会因同名混在一起。关闭当前标签时选择相邻剩余文件，最后一个关闭后恢复空白。

`FilePreview.tsx` 保留工作副本/附件读取和目标 hash 失效判断；`FrozenFilePreview.tsx` 读取冻结版本，默认展示 after，删除项展示 before。原文和预览是同一份内容的两种呈现，不会重新读取来源文件替代冻结版本。

`PreviewToolbar.tsx` 负责显示方式、刷新和可用的打开动作。已交付冻结文件沿原 `open_delivered` 桥请求系统默认应用；普通工作副本沿原 `open_file` 在文件夹中显示；附件提供复制路径。不会从页面拼接 Shell 命令，也没有新增任意宿主执行入口。系统打开使用同步防重复锁。

`FileContent.tsx` 只处理显示：ReactMarkdown + GFM、highlight.js、图片和静态 HTML。IntersectionObserver 在接近底部时触发已有分页请求；仍由 `appendPreviewPage` 校验同版本和连续范围，保留代际标记，旧文件的迟到结果不能覆盖新文件。

`file-format.ts` 集中映射后缀到语法和图标；`FileIcon.tsx` 只呈现本地图标；`file-preview.css` 在现有三层样式和交互样式之后加载，规则限定在顶栏和预览区。构建脚本复制图标，并把 SVG 加入源码指纹和包内 hash 清单。

## 范围和限制

HTML 采用无脚本、无同源能力的 iframe，移除脚本、事件处理、导航、外部链接样式和表单；内容 CSP 只接受内联样式和内嵌图片。HTML 中依赖 JavaScript、外部字体、网络或相对资源的部分不保证与系统浏览器相同。主页面仅为该预览允许同源框架地址，不开放外部框架源。

Markdown 同样不加载远程图片或执行嵌入 HTML。普通源码不执行，原始 `<script>` 等字符显示为代码。PDF、Office 等二进制格式没有因此新增完整解析器；冻结二进制页仍受既有适配器能力限制，不能拿当前工作副本冒充冻结版本。打开方式只显示现有桥实际支持的动作，没有新增 Windows 应用枚举。

未改变唯一 Agent 循环、工具权限、交付批准、生产数据库、付费 API 或 Windows 系统设置。未清理旧未提交改动和学习注释。先前审计 A-01/A-02/A-03 不在本次范围。

## 验证与证据

本轮 TypeScript 编译与桌面构建通过，29 项相关 UI/分页/交付回归通过；源码真实 Electron 63/63、实际便携版 Umi.exe 63/63 检查通过。181 个运行文件的 hash 与构建清单匹配，源码指纹与源码、dist、便携版一致。本轮没有重跑上一轮 439 项全量测试。构建时间 2026-10-15T11:05:50.464Z，便携版打包时间 2026-10-15T11:07:05.264Z。

证据根：`E:\Codex\Workspace\output\umi-file-preview-20261015`。修改前保存 272 个源码记录，其中 3 个为既有删除项；保留 Git 状态、diff 和上一个便携版 exe/package/dist。真实桌面验收使用临时独立数据目录与本地验证模型，未访问用户生产会话。

旧断言已改为新契约：右侧空白、两按钮同高、默认结果预览和两种模式；新增真实附件入口下的 Markdown、着色源码、原文/刷新、静态 HTML、UTF-8 长文件自动续读、图片与最后标签关闭检查。

中途 HTML 观察失败是验收方法不能向无脚本子页注入 JavaScript，且主文档快照不包含独立渲染进程；后续通过该子进程的 Chromium DOMSnapshot 观察，并在透明验收窗口中唤醒绘制，不放宽产品限制。循环滚动探测还修正了一处验收脚本的全局变量重复声明。失败记录保留，最终结果独立列出。

## 官方实现资料

- [vscode-icons 原仓库](https://github.com/vscode-icons/vscode-icons)、[许可证](https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE)：26 个原版 SVG 固定在 `5170b0e7ee6b23ad31d69848bd051e70e5f26cf1`，来源和许可证随包内置；它是文件图标主题项目，不冒称 Microsoft 官方文件图标标准。
- [MDN：iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc)：静态内容页与宿主隔离。
- [Chromium DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)：验收观察实际子文档，不向预览内容注入脚本。
