# Windows 安装器升级流程审查

> 阶段技术记录：本页能力和验收数字只对应原文日期；当前实现以[当前技术状态](current-state.zh-CN.md)和[运行契约](runtime-contracts.zh-CN.md)为准。


日期：2026-10-18。范围：解释现有 alpha.3 安装包的覆盖方式及可能的耗时因素。本轮只做源码与包体检查，没有运行安装/卸载，没有修改安装器、注册表或安装目录。

## 结论

用户观察到的“先清空旧目录，再写入新文件”与当前默认 NSIS 升级路径一致：找到已注册的旧版本后，安装器先调用旧卸载器，再解压安装新版本。这是现有安装框架的默认流程，不是本轮 UI 修改新增的行为。

这里涉及的是注册记录中的旧安装目录。第一次安装、未找到旧卸载器、迁移到新目录与正常覆盖升级的分支并不完全相同，不能概括为“任何选中的文件夹都会被无条件清空”。本轮也没有复现用户机器上的具体一次安装过程。

## 从配置到文件操作

项目配置见 [electron-builder.yml](../electron-builder.yml)，发行入口见 [build-windows.mjs](../scripts/build-windows.mjs)。本地锁定的 app-builder-lib 为 26.15.3；没有配置 customRemoveFiles 或其他自定义 NSIS 清理钩子。

| 环节 | 本地模板证据 | 行为 |
| --- | --- | --- |
| 查找旧版本 | templates/nsis/include/installUtil.nsh：uninstallOldVersion，约 142–175 行 | 从卸载注册项读取 UninstallString、InstallLocation，必要时从卸载器路径回推旧目录 |
| 先卸载后安装 | templates/nsis/installSection.nsh：52、66 行 | 先 uninstallOldVersion，再 installApplicationFiles |
| 调用卸载器 | include/installUtil.nsh：201–230 行 | 当前升级分支传入 --updated，并等待旧卸载器完成 |
| 旧目录清理 | templates/nsis/uninstaller.nsh：38–94、161–187 行 | 升级时递归移出旧文件到临时 old-install；遇占用尝试恢复并终止；随后递归移除旧目录 |
| AppData | uninstaller.nsh：217–245 行 | 用户数据删除是另一分支；当前 deleteAppDataOnUninstall=false，正常升级保留用户数据 |

以上相对模板路径均位于本机 node_modules/app-builder-lib 下，结论以本地实际模板为准。升级运行的是旧版本提供的卸载器；若旧包使用了不同模板或自定义逻辑，需要另外检查旧包。

**旧安装目录并不是“只删除程序清单列出的文件”。** 当前默认递归逻辑会处理该目录中的其他文件。因此，夹在程序安装目录里的个人文件也有丢失风险；AppData 的保留规则不覆盖这些混放文件。这是后续安装策略需要明确的边界。

文件被占用时有恢复旧文件的分支，但这不足以证明整个升级具有完整事务回滚。解压中断、磁盘不足等情形本轮未验证。

## 为什么可能慢

对本轮 UI 打包前的 alpha.3 本地目录与既有安装器做了只读统计：

| 项目 | 数值 |
| --- | ---: |
| 完整便携目录 | 8,686 个文件，455,720,929 字节（约 434.61 MiB） |
| resources/app | 8,613 个文件，70,876,424 字节 |
| Setup | 105,322,922 字节（约 100.44 MiB） |
| asar | false |
| differentialPackage | false |

Setup 的 SHA-256 为 b6f93665f76a24b32650dc138a92e6b07264e5a7e0811882a9c49e80a1aef8b0。原始统计保存于 维护者本地证据目录（不随源码分发）。

完整包解压、大量散文件的移动/创建/删除、杀毒扫描与进程占用重试，都可能增加耗时。这些是结合流程和包体作出的推断，没有阶段计时，不能确定哪一项主导了用户感受到的延迟。安装执行使用本地完整载荷，与模型 API 响应速度无关。

把 differentialPackage 改为 true 不能直接解决旧目录清理，也不能保证缩短手动运行完整 Setup 的耗时。当前没有接入自动更新客户端，差分更新需要另行设计、验收。

## 后续候选，尚未实施

1. 在独立测试安装目录记录“关闭进程、旧文件迁移/清理、新包解压、快捷方式”的分段耗时，并覆盖文件占用、取消、磁盘不足和跨目录升级。
2. 用测试哨兵文件验证安装目录内非程序文件的处理，决定是限制专用安装目录、明确提示，还是采用受控文件清单；不能只换一条删除命令。
3. 审查实际运行依赖与散文件数，评估精简载荷、选择性 ASAR。宿主桥、utility process、PowerShell 脚本与真实文件路径依赖需先验证，不能直接全量封包。
4. 安装体验优化应单独安排，避免与 UI 迭代混合变更。是否需要差分/自动更新，应结合产品阶段讨论。

## 资料与验证边界

- [electron-builder 官方 NSIS 配置说明](https://www.electron.build/nsis/)。
- [上游 installSection.nsh](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/installSection.nsh) 可交叉核对先卸载再安装的顺序。
- [上游 uninstaller.nsh](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/uninstaller.nsh) 可交叉核对旧文件迁移、恢复及目录清理。

在线 master 是可变化的上游参考，不冒充本机 26.15.3 的版本固定证据。此次没有实际安装/卸载计时，不把此前载荷哈希一致性当作安装交互验收。本轮未生成新 Setup、便携 ZIP 或 GitHub Release；原 alpha.3 发布资产保持原样。
