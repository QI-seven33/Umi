# Umi 输入区调整与验收（2026-10-16）

本轮按用户要求替换运行输入框的闪电效果，并修正权限/选择卡片过窄的问题。

## 效果与尺寸

- 运行输入框：#2e7feb蓝色细边，3.2秒缓慢呼吸，透明度0.22–0.68。边缘固定、无抖动；不改变宽高，不覆盖输入和按钮。等待批准/回答时不显示；停止或中断后移除；系统偏好减少动态时静止。
- 权限卡与选择卡：移除各自620px上限，复用普通输入框宽度和边距；包含560px以下聊天容器的窄布局。外圆角与输入框统一18px，内部选项9px、操作按钮8px，无浮起阴影。
- 字体：沿用现有主题UI字体栈，正文12px常规，标题13px/500字重，辅助文案11px。保留逐问/自定义回答/最终提交，批准仍只有允许/拒绝。

## 代码阅读入口

1. apps/desktop/renderer/src/features/work/components/Composer.tsx：正常输入、批准、问答仍是同一底部区域的三种状态；运行时插入aria-hidden装饰层，不增加状态循环。
2. apps/desktop/renderer/src/components/ui/interactions.css：composer-breathing样式与减少动态规则。动画仅改变装饰层透明度，替代canvas逐帧路径绘制及观察器。
3. apps/desktop/renderer/src/styles/surface.css：卡片不再声明单独宽度和外圆角，保留内部紧凑排版。
4. apps/desktop/renderer/src/workspace-layout.css：三类输入区域共用布局，卡片明确继承主题字体。560px以下统一缩小外边距。
5. apps/desktop/verification.ts：在同一容器中实测普通输入框作参照，验证两类卡片的宽度、左边缘、字体及圆角；真实工具产生批准/问答，验证提交记录与呼吸/减少动态/中断状态。

## 本轮验证

本轮 TypeScript、桌面构建与29项相关UI/分页/问答/交付回归通过；宽窄批准卡/问答卡、真实提交、蓝色呼吸、减少动态及停止状态的桌面检查均通过。完整桌面检查：源码版72/72通过；实际便携版Umi.exe 72/72通过。182个运行文件逐项hash匹配，源码、dist、便携版指纹一致。没有重跑历史439项全量或13项服务契约。

真实桌面截图已核看：运行蓝边、宽权限卡、宽问答卡及展开右预览后的窄卡片。两类卡片宽区均820px，窄区约446px，左边缘与普通输入框一致；问答正文无内部滚动。验收不修改生产会话，不调用付费模型。

补充窄区验收时，860px窗口触发了原有右栏隐藏规则，未覆盖目标双栏窄区；改用1120px双栏窗口后测到真实窄聊天容器并通过。完整复核中曾反复读到HTML子页尚未排版的首帧，截图也曾为空白；父容器与iframe实测尺寸正常且可见，子文档节点存在但未进入可见排版。单独尝试延长等待、父/子页样式诊断、置顶和聚焦，仍能复现；尚未确认根因。上述未验证有效的验收修改已撤回，原HTML布局/内容/隔离断言保留，产品文件预览实现未修改。失败日志、尺寸诊断、截图和原始DOM快照保留，后续作为独立预览问题处理，不把本轮UI验收写成全部产品问题已解决。观察通道使用Chromium官方[DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/)与[CSS](https://chromedevtools.github.io/devtools-protocol/tot/CSS/)只读接口。

构建时间：2026-10-16T15:02:42.149Z；打包时间：2026-10-16T15:03:53.405Z。源码指纹：0d8118cdaccc4ce655f3c960a926684a462a129715e5672dc79537e1dade82a8。

## 范围与证据

所有原有多阶段修改与学习注释保留；修改前快照311条记录含3条旧删除。旧特效源码是本轮明确移除项，旧版本可从before快照恢复。没有修改Agent循环、IPC/宿主桥、权限策略或文件预览。此前审计A-01/A-02/A-03仍待单独处理。

证据目录：E:/Codex/Workspace/output/umi-composer-breathing-20261016。before/保存本轮前源码；previous-release/保存旧exe及dist；desktop-source/、desktop-packaged/包含真实桌面截图和测量；ui-tests.log记录29项回归。使用菜单完整退出Umi后再启动更新版，关闭窗口仍仅隐藏。
