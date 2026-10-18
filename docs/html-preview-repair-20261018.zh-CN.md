# HTML 预览修复与多格式核验（2026-10-18）

本轮修复预览链路中的空文档导航和截断 HTML 反复重载。保留已有源码、未提交改动和学习注释；不调用真实模型 API，不修改默认会话数据库，不提交 Git 或更新远端发布/Setup 安装器。

## 结论与证据

旧实现会在读取开始前，用空字符串生成一份 HTML 并挂载 iframe；首段返回后立即修改同一个 iframe 的 srcdoc。后续每追加一页，也会重新解析并导航。空白时不是“文件没有读到”：子文档里有标题和正文，iframe 尺寸正常，但排版节点只有文档根，文字框为零，截图也是空白。

本轮用真实 Electron、真实附件入口和正式预览组件建立独立复现：原实现连续24次均空白。先测量尺寸再创建 iframe 的单独对照仍有23次空白；调整窗口焦点、尺寸也没有解决重复打开。最终保留原来的 HtmlPreview 缩放代码，只在完整正文到达后挂载 iframe，连续24次均有实际排版。扩展验收再覆盖切换原文/预览、重载、窄宽度、侧栏收起恢复、窗口隐藏恢复。

这定位了 Umi 的触发路径和有效修复，不足以宣称已定位 Chromium 内部缺陷。Chromium 官方说明 srcdoc 设置是异步的，文件读取完成、子文档存在与可见排版是不同阶段。[渲染路径说明](https://www.chromium.org/developers/the-rendering-critical-path/)。

## 实现契约与学习入口

正式链路仍为：FilePreview 或 FrozenFilePreview 读取8KiB首段 → 同版本64KiB连续补读 → FileContent → HTML清理 → HtmlPreview独立视口。协议、权限、来源与交付身份均未调整。

- [FileContent](../apps/desktop/renderer/src/FileContent.tsx)：HTML预览自动补读至同一版本结束；读取完整前显示紧凑提示。只清理完整文本，不为初始空值创建子页面，不把截断标签或样式逐页装入iframe。读取失败显示错误，保留重新加载入口。空文件正常留白。
- [HtmlPreview](../apps/desktop/renderer/src/HtmlPreview.tsx)：沿用现有ResizeObserver和命令式尺寸更新，拖动不通过React反复导航。响应式文档使用实际宽度，固定像素宽度文档沿用原来的缩放策略。
- [预览分页](../apps/desktop/renderer/src/preview-page.ts)：原有hash一致、字节连续校验不变。原文展示保留全部字符，HTML清理不写回源文件。
- [独立预览验收](../apps/desktop/verification-file-preview.ts)：测试数据独立，HTML通过只读CDP观察实际子页面的排版和文字框，结合截图检查；不通过注入脚本或降低CSP来检查内容。

HTML禁脚本、无同源权限、禁止外部请求的规则保留。sandbox srcdoc可由独立渲染进程承载，因此验收需要跟随当前窗口对应的子目标。[Chromium OOPIF说明](https://www.chromium.org/developers/design-documents/oop-iframes/)、[MDN srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc)。

## 其他格式与完整性

| 样本 | 本轮观察 |
| --- | --- |
| 响应式HTML、1280px固定宽度HTML | 反复打开与恢复后有实际排版；沿用无横向滚动布局 |
| 约172KiB长HTML | 首段截在长样式注释内部；补读后仅创建一次iframe，正文末尾存在，原文逐字符一致 |
| 空HTML、HTML片段 | 空文件读取完成后留白；片段可正常排版，不永久显示加载提示 |
| Markdown、约100KiB长Markdown | 标题、表格和代码着色正常；滚动续读至末尾，原文完整 |
| TypeScript、JSONL、长TypeScript | 语法着色和长行折行正常，UTF-8连续分页保留全部字符 |
| 普通文本 | 特殊标签作为文字显示，原字符保留 |
| PNG | 实际解码，48×32原始比例保留 |

这些格式未复现HTML同类的子文档空白。Markdown和代码继续按滚动需求续读，不为了HTML修复改为全部预读。大HTML的代价是需要先完成本地补读，但避免了每页重建文档；没有增加缓存、依赖或新的模型上下文内容。

## 验证与复跑

类型检查、桌面构建通过；相关66项逻辑测试通过，覆盖预览UTF-8/同版本分页、冻结内容、资源权限与桌面事件；完整源码桌面78项通过。源码与实际便携版的独立预览回归均34项通过，实际便携版完整桌面78项也通过。未将上一轮484项核心测试计作本轮重跑。

复跑前使用Node24执行 npm run build:desktop，然后执行 node scripts/verify-desktop.mjs --preview-only；便携版追加 --packaged。测试使用临时独立数据、无真实模型调用。报告分别写入docs/evidence/file-preview-runtime.json和file-preview-packaged.json；失败截图、DOM快照和各格式截图保留在报告指向的dataRoot。完整桌面验收仍沿用原命令，无断言降级。

原始失败、对照样本、源码备份及本轮最终验证证据保存在 E:/Codex/Workspace/output/umi-preview-rendering-20261018。默认会话库及之前测试数据备份不受本轮操作影响。

## 仍然适用的边界

内置HTML是静态文件预览：页面脚本、远程CSS/图片、依赖脚本生成的内容不加载；固定宽度适配仍是有限的像素宽度提示，不承诺任意网页布局与系统浏览器完全一致。PNG通过不代表所有图片编码均已专项验收。PDF/Office完整内置解析未新增。已损坏或本身遮挡内容的HTML仍需检查文件结构。

本地release/Umi-win32-x64/Umi.exe载荷已同步，192个运行文件逐项hash一致；源码、构建和便携指纹均为13670d942460ecbc998cf9dba12af457857a634a1ace72f52c41acc8e43cc125。旧便携载荷备份在本轮output/portable-before。Windows安装器和远端Release仍是历史发布。关闭窗口只是隐藏，使用菜单“退出 Umi”后重新启动才能确定加载新版本。
