# Umi 界面打磨与便携包同步（2026-10-15）

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


本轮按用户12项要求调整当前源码与指定便携版。真实源码：`仓库根目录`；交付程序：Umi.exe（维护者本地证据/生成产物，不随源码仓库分发）。此前全部多阶段改动、学习注释与未跟踪文件保留；没有reset/clean或Git提交。

## 1. 按需求核对

| 项目 | 当前行为 |
| --- | --- |
| 1. 移除界面内产品图标 | 左上角图形/普通Umi文字与欢迎图形均移除；系统窗口和exe图标保留 |
| 2. 左侧栏控制置顶 | 左展开/收起改为统一顶部28px区域的同一个按钮，为后续窗口控件留出位置；本轮未增加关闭/最小化按钮 |
| 3. 新对话上移、右侧不动 | 删除原品牌行，新对话与工作区跟随上移；右侧控制仍为原坐标，验收确认top=18px |
| 4. 头像不动 | 原个人资料/头像区域保留在底部，验收确认位置仍贴近原底边 |
| 5. 欢迎压力文字 | 欢迎语为小写hello，逐字改变字重、宽度和斜度；字体本地加载，可离线运行，参考[Text Pressure](https://www.reactbits.dev/text-animations/text-pressure) |
| 6. 批准卡 | 宽度最大620 CSS px，14px卡片圆角，正文12px、标题13px/500字重；长命令的完整内容收进可展开区；允许/拒绝与冻结范围契约不变 |
| 7. 问答卡 | 每次显示一问，支持上一问/下一问/最后统一提交；没有卡片正文内部滚动，多选项时适当分列；选中项显示说明，保留自定义回答和停止入口 |
| 8. 运行输入框动画 | 沿实际圆角路径绘制轻量蓝色电流，颜色#2e7feb，参考[Electric Border](https://www.reactbits.dev/animations/electric-border?color=2e7feb)；批准/问答卡不绘制 |
| 9. 变化列表与失败命令 | 变化行不再有悬停阴影/底色和侧边操作标签；工具行移除完成/失败等徽标，真实失败命令标红；结果与状态保留在详情及可访问名称中 |
| 10. 右侧预览 | 移除重复“新建工作区”；标签变为紧凑中性样式，保留关闭与成果入口；冻结变化红删绿增、行标和增删计数，版本hash默认折叠，参考[Code diff](https://www.assistant-ui.com/elements/code-diff) |
| 11. 更新exe | 原便携版确实为10月5日旧产物，已重新打包到指定release目录，并逐项验证148个运行文件与本轮构建一致 |
| 12. 消息操作 | 助手消息提供复制、赞、踩、重新组织、更多五项操作；复制成功换绿色勾，赞踩互斥，更多提供复制Markdown/引用；参考[Message actions](https://www.assistant-ui.com/elements/message-actions) |

设置页统一去除阴影，收窄内容与卡片内边距，保持既有主题变量和普通控件风格。消息操作区保留现有悬停/键盘聚焦显示习惯。问答答案不构成批准；批准卡没有新增自定义输入或停止按钮。

## 2. 组件如何接入现有架构

沿用现有React入口、preload、broker、DesktopService、UmiApplication和唯一AgentEngine。参考组件采用独立视图接入现有状态，不引入另一套聊天runtime或调度器，也没有安装新的运行依赖。

- [TextPressure.tsx](../apps/desktop/renderer/src/components/ui/TextPressure.tsx)：固定字槽，鼠标距离驱动可变字体轴，插值平滑；稳定后停止逐帧更新。
- 当时的ElectricBorder.tsx（历史组件，当前树已不保留此文件）：跟随ResizeObserver的圆角周长路径，canvas绘制，30fps上限，像素比上限2；隐藏/离屏停止，减少动态偏好下静止。
- [QuestionCard.tsx](../apps/desktop/renderer/src/QuestionCard.tsx)：局部保存每题答案与当前题序号，最后仍向原answer_question入口一次提交完整答案；没有改变核心问题规格、失效或持久化逻辑。
- [ApprovalCard.tsx](../apps/desktop/renderer/src/ApprovalCard.tsx)：只改信息层次、尺寸和字体，完整描述可展开，交付批准仍等待真实冻结详情。
- [CodeDiff.tsx](../apps/desktop/renderer/src/components/ui/CodeDiff.tsx)：展示已有冻结diff，正文仍沿原UTF-8连续分页接口；未重做diff算法，未把工作副本当成冻结版本。
- [FrozenFilePreview.tsx](../apps/desktop/renderer/src/FrozenFilePreview.tsx)：默认变化视图、原文/结果切换，重试只在失败时显露，保留继续显示和成功交付后的打开入口。
- [MessageActions.tsx](../apps/desktop/renderer/src/components/ui/MessageActions.tsx)：本地反馈、复制状态与菜单；重新组织/引用只写入现有输入草稿。
- [surface.css](../apps/desktop/renderer/src/styles/surface.css)：在原规则位置调整布局/卡片；[interactions.css](../apps/desktop/renderer/src/components/ui/interactions.css)仅承载新增组件的字体和局部样式。

字体为Google Fonts官方Roboto Flex可变字体，已确认wght/wdth/slnt等13个轴，文件随产物复制。OFL和React Bits许可保留在`public/third-party`并进入运行包。源链接与本地参考资料保存在本轮证据的references目录；初次取得的静态字体未进入产品。

## 3. 消息操作的实际语义

赞/踩按会话与最终消息身份保存在本机localStorage，不上传到服务商，不写成模型或任务验收事实。

“重新组织回答”先填入一条明确要求到输入框，用户可修改并发送。它不会立即调用收费API，也不会直接重跑上轮的文件、命令或未知副作用。更多菜单的“引用到输入框”同样只是草稿操作；复制Markdown复制原文。没有未接线的装饰按钮。

如果以后希望“单击即重新生成正文”，需要另定受限正文重答契约，明确历史绑定、工具禁用、费用和停止/新输入行为，不能用“重新提交原任务”冒充。

## 4. 预览的准确性

差异卡逐行区分context、added和removed，保留空白，长行在内容区水平滚动。增删计数在正文未完整加载时明确指向当前已加载范围；继续显示仍按相同冻结对象、hash和连续字节范围拼接。

“冻结版本”保留完整前后hash和大小但默认折叠，避免大段技术文字占首屏。打开已交付文件仍走原原生桥，只证明系统接收打开请求，不证明页面排版。失败命令只是将可见标题/命令提示标红，没有删除真实失败结果或改变运行状态。

## 5. 便携版为何会旧，以及这次怎样防止混淆

源码版使用仓库dist，`release/Umi-win32-x64`使用自己的`resources/app/dist`。此前只做源码构建而未安排发布，所以两份产物不同步；exe/包内UI都确认为10月5日旧版。

本轮先保存原exe、package.json与dist到证据的previous-release，再使用既有Electron44.5.1打包器重建完整便携目录。没有操作生产会话数据库、清除用户配置或修改Windows图标缓存。

新增构建信息链：

1. [build-info.mjs](../scripts/build-info.mjs)计算源码指纹与运行文件hash，写入`dist/umi-build.json`。
2. [build-desktop.mjs](../scripts/build-desktop.mjs)在renderer/preload及字体/许可复制完成后记录该信息。
3. [package-desktop.mjs](../scripts/package-desktop.mjs)打包前拒绝缺失清单、源码已变化或产物不符；打包后逐项核验包内148个运行文件，生成`umi-release.json`。

本次构建源码指纹：`b86b2354d60323913ecd02e2659772324037909bfde4b256901c9f0b6932a433`。该指纹是文件内容校验，不是Git提交号，也不代表已提交或已公开发布。

以后需要更新便携版时，在真实项目根运行：

```powershell
npm run package:desktop
```

这个命令本来就先构建再打包，现在还会验证实际产物；`npm run dev`仍然只更新并启动源码版。无需为了图标改注册表或刷新系统缓存。

## 6. 本轮验证与限制

| 验证 | 最终结果 |
| --- | --- |
| 常规TypeScript与renderer/preload构建 | 通过 |
| 核心全量 | 439/439，通过，无跳过/取消 |
| 最终相关UI/问答/预览回归 | 29/29，通过 |
| 单独复验执行准备专项 | 31/31，通过 |
| 源码真实Electron | 56/56，通过 |
| 指定release中真实Umi.exe | 56/56，通过 |
| 构建/包内容一致性 | 148运行文件逐项匹配，源码指纹一致 |
| 清单保护探针 | 正常清单通过，修改产物/路径穿越被拒绝 |
| Git diff空白检查 | 通过，保留既有CRLF提示 |

真实桌面覆盖：页内无产品图标、左控制置顶/新对话上移/头像与右控制位置、离线字体加载与压力变化、卡片尺寸/字体/圆角、真实失败命令红色、冻结红删绿增、运行电流实际帧变化、减少动态时静止、两题翻页/自定义/持久提交、五项消息操作及草稿不派发任务，另包含原桌面批准、恢复、附件、设置和停止回归。

第一次默认并发核心测试出现438通过/1项既有执行准备等待超时，原日志保留。单独31项通过后，以并发2重跑完整439项全部通过。没有修改该核心测试或扩大其等待上限。早期桌面断言、字体构建路径和隐藏窗口截图失败也保留，已在最终两套56项中修正或核对。

没有调用真实/付费模型接口，没有把历史439项当作这轮结果，没有读取/更改生产会话。动画检查与本地固定模型测试不等于全部硬件的生产帧率、真实模型完成率或费用基准。极长文字仍可能让选中说明/自定义输入变高；完整命令与长文件保留必要的显式展开/分页。

此前全面审计的A-01启动guard、A-02 TASK_LIMIT正文、A-03数据库版本上报问题仍未修复；本轮没有把UI请求扩展成后端整改。

## 7. 证据与截图

证据根：umi-ui-refinement-20261015（维护者本地证据/生成产物，不随源码仓库分发）。

- before/、before-manifest.json：本轮改动前262个Git可见记录，含3个此前删除项。
- previous-release/：旧exe、包描述和运行dist。
- full-tests.log / preflight-retry.log / full-tests-final.log / ui-regression-final.log：首次失败与最终复验。
- desktop-source/、desktop-packaged/：最终56项记录及PNG截图。
- provenance-checks.json、packaging.log、release-manifest.json：产物校验与实际打包信息。
- turn-changes.json、this-turn.patch：相对本轮前快照的变更，而非把旧多阶段diff当成本轮。

可先看欢迎页（维护者本地证据/生成产物，不随源码仓库分发）、批准与差异预览（维护者本地证据/生成产物，不随源码仓库分发）、问答卡（维护者本地证据/生成产物，不随源码仓库分发）。部分原生Mica截图会把透明桌面区域呈现为黑色，不能据此判断实际桌面底色；实体窗口与主题样式保持原有机制。

使用前从菜单完整退出旧Umi，再启动指定新exe。关闭窗口只隐藏；生产会话与设置继续使用原有数据根。
