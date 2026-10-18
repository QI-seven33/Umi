# Windows 主流安装与更新方式对比

日期：2026-10-18。范围：查阅官方文档和公开实现，给 Umi 的安装策略提供依据；此次不改安装器、自动更新、安装路径或系统配置。当前包体与清理行为见[上一份审查](installer-upgrade-review-20261018.zh-CN.md)。

## 核心判断

安装体验需要分别评估四件事：获取载荷、准备新文件、切换运行版本、清理旧文件。“少下载”不等于“少写磁盘”，“后台完成”不等于“没有耗时”，“使用某个安装框架”也不等于具备完整回滚。

Umi 当前的问题应先分成两个：旧安装目录的清理边界，以及完整载荷和大量散文件带来的等待。换安装界面本身解决不了这两件事。以下产品与框架提供了可借鉴的不同路径。

## 已核对的实现

| 产品或机制 | 资料支持的做法 | 对 Umi 的启发与代价 |
| --- | --- | --- |
| VS Code / Inno Setup | 官方推荐当前用户安装；公开安装脚本有后台准备目录、版本资源目录、新入口文件，以及等待应用退出再调用更新器的分支 | 学习“准备与切换分开”；不是把 NSIS 换成 Inno 就能自动得到同等体验 |
| Firefox 应用内更新 | 优先部分 MAR，失败可回退完整包；默认 staging 提前解压和补丁处理，重启阶段移动已准备的文件 | 把耗时前置可以减少用户等待，但要多一份准备空间和状态管理；手动 Setup 与应用内更新须分别判断 |
| Chromium 安装代码 | 新文件进入版本号目录；入口被占用时放到 new_chrome.exe，未占用时可替换入口；操作通过工作项组织 | 避免直接边清空边填充活动版本；整套浏览器更新设施不适合直接搬入当前 Umi |
| MSI | RemoveExistingProducts 的调度可在不同事务阶段；删除旧版的时机影响复用效率与回滚行为 | MSI 也可能先删旧版；扩展名不是可靠性的判断依据 |
| MSIX | 系统管理有身份、签名的包，按变化的 64 KiB 块更新；部署后的程序文件只读 | 清晰的载荷归属与系统部署能力有吸引力，但有签名、路径、数据与宿主兼容成本 |
| Velopack（候选框架） | 分开检查、下载、应用；支持差分重建和全量回退，提供 JS/Electron 接入 | 可列入后续更新框架验证；需要原生 Node 模块、启动钩子、构建工具和旧安装迁移，不能直接照搬 C# 示例 |

### 产品资料

**VS Code：**[Windows 安装说明](https://code.visualstudio.com/docs/setup/windows)说明 User/System/ZIP 的区别；[公开 code.iss](https://github.com/microsoft/vscode/blob/main/build/win32/code.iss)的 GetDestDir、GetExeBasename 和后台更新完成分支展示了准备、等待及调用更新器的顺序。不同更新模式的目录策略有差异，不能把某个分支描述为所有用户的固定布局。

**Firefox：**[更新实现](https://firefox-source-docs.mozilla.org/toolkit/mozapps/update/docs/Implementation.html)说明部分与完整 MAR 的回退；[后台更新文档](https://firefox-source-docs.mozilla.org/toolkit/mozapps/update/docs/BackgroundUpdates.html)解释 staging 如何把解压和补丁工作移出启动路径。它减少的是可感知的阻塞，不承诺总工作量消失。

**Chromium：**[install_worker.cc](https://github.com/chromium/chromium/blob/main/chrome/installer/setup/install_worker.cc)的 AddChromeWorkItems 先放置新版本目录，再根据入口占用状态安排 chrome.exe 或 new_chrome.exe。这里核对的是公开 Chromium 实现，不把它当作所有 Chrome 分发渠道和版本的完整保证。

### 系统和框架资料

**MSI：**[微软 RemoveExistingProducts 文档](https://learn.microsoft.com/en-us/windows/win32/msi/removeexistingproducts-action)说明调度位置如何影响文件复用及失败回滚。因此，“先卸载再安装”不是某一种安装器独有的行为，也不能只凭它判定实现一定出错。

**MSIX：**[差分更新说明](https://learn.microsoft.com/en-us/windows/msix/desktop/managing-your-msix-deployment-update)解释块级复用；[包概述](https://learn.microsoft.com/en-us/windows/msix/overview)说明身份和签名；[桌面应用运行行为](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)说明只读安装文件及不同信任/虚拟化模式。打 MSIX 包不自动等于把 Umi 执行的宿主命令放入操作系统沙箱，仍需按实际运行模式核验。

**Velopack：**[更新流程](https://docs.velopack.io/integrating/overview)及[差分机制](https://docs.velopack.io/packaging/deltas)说明下载、重建和应用的边界；[JS/Electron 指南](https://docs.velopack.io/getting-started/javascript)要求尽早处理启动生命周期，JS 使用等待退出再应用的接口，并有原生模块与构建工具要求。对 Umi 的主进程、单实例、关闭即隐藏和 utility process 都需要专项验证。

以上在线 main/master 和文档为本次查阅时的状态；并未实际安装这些产品、测量其耗时，也未在 Umi 上接入这些实现。

## 对 Umi 的建议

### 优先：保留当前分发方式，先明确清理范围并测量

这是结合 Umi 现状的工程建议，不是已经实施的能力：

1. 在独立目标目录记录“退出/占用检查、旧文件处理、解压、新版本首次启动”耗时；同时测试取消、磁盘不足、路径迁移和旧目录混放哨兵文件。
2. 先梳理实际要交付的依赖和资源，减少无运行价值的散文件。前轮 alpha.3 约 435 MiB、8,686 文件，说明文件数量也值得测量，而不只是压缩包大小。
3. 明确程序载荷与用户资料的归属，决定专用目录、清单清理及迁移策略。当前正常用户数据在 AppData，不应把它移回安装目录。
4. 再验证可选 ASAR 或分组载荷。[Electron ASAR 文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives)说明执行程序等 API 的限制；Umi 的 worker、宿主桥与脚本真实路径必须先核验，不能只改一个 asar 开关。
5. 验收应包含“准备失败时旧版还能启动”“用户资料不因程序升级消失”“新旧版本文件不会混用”，而非仅检查 Setup 成功退出。

**迁移旧包是单独的问题。** 下一版安装器仍可能调用已经发布的旧卸载器；只修改新版 customRemoveFiles，无法反向改变旧卸载器的清理行为。首次迁移必须检查旧安装目录内容并制定单独策略，不能承诺改新模板就保护了所有旧版升级。

### 后续：先比较现有栈更新能力，再决定是否换框架

electron-builder 本身提供 [NSIS](https://www.electron.build/v26/docs/nsis/) 和 [electron-updater](https://www.electron.build/docs/features/auto-update/) 机制。Umi 当前没有更新客户端，不能将 differentialPackage=true 写成“已支持增量升级”；差分下载也不直接改变旧目录清理方式。在线文档含不同版本内容，实施前必须回到本地锁定版本验证。

若产品决定需要“检查更新 → 下载 → 用户确认重启”，建议先用隔离小样比较现有栈与 Velopack，评估下载量、应用时间、占用处理、签名、回退和迁移成本。Umi 需要在退出前结束/核验 Agent 运行、关闭 worker 和数据库；不能照抄会超时杀进程的默认流程。

MSIX 可作为未来商店或企业部署候选；当前不建议仅为减轻一次覆盖安装的等待而立即迁移。自行重做 Chromium 式安装/服务体系也超出当前阶段的收益。

## 本地打包占用观察

本轮同步开发用便携目录时，@electron/packager 的 overwrite 删除阶段因正在运行的 Umi 进程报 EBUSY。用户完整退出后打包成功。这是本地构建输出覆盖，不是用户运行 NSIS Setup 的一次安装计时，不能混为同一条安装链路。后续可单独评估打包前的占用预检；此次没有更改打包脚本。

## 本轮边界

安装研究只形成此报告；没有新增更新依赖、计划任务、常驻服务、注册表项或安装钩子，没有执行安装/卸载、升级打包工具或发布资产。UI 和本地便携布局迭代另见[欢迎区说明](welcome-ui-20261018.zh-CN.md)的后续调整。
