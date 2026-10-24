import { verifiedDocumentPath } from '../../packages/adapters/src/host-files/delivered-open.js';
import { documentTargetSchema } from '../../packages/protocol/src/native-open.js';
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  safeStorage,
  Menu,
  nativeTheme,
} from 'electron';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  desktopCommandSchema,
  desktopConfigSchema,
  desktopMenuRequestSchema,
} from '../../packages/protocol/src/desktop.js';
import type { DesktopConfig } from '../../packages/protocol/src/desktop.js';
import { UmiError } from '../../packages/protocol/src/model.js';
import { safeRoot, rootIdentity } from '../../packages/adapters/src/host-files/paths.js';
import { AgentBroker } from './broker.js';
import { desktopMenuTemplate, TITLE_BAR_HEIGHT } from './window-chrome.js';

// 注册自定义协议。
// 这行必须在 app.whenReady() 之前执行，这是 Electron 的硬性要求。
// 注册一个叫 umi 的自定义协议，并赋予它特权：
//   standard: true     —— 按标准 URL 规则解析（有 host、path 等）。
//   secure: true       —— 当作安全来源（类似 https），可以用 fetch、Service Worker 等。
//   supportFetchAPI: true —— 允许对这个协议的 URL 使用 fetch。
// 后面页面会加载 umi://app/index.html，就是这个协议。
protocol.registerSchemesAsPrivileged([
  { scheme: 'umi', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// 模块级变量。

// codeRoot：当前文件所在目录。
// 因为用了 ESM，__dirname 不存在，所以用 fileURLToPath(import.meta.url) 再 dirname 拿到目录。
const codeRoot = dirname(fileURLToPath(import.meta.url));

// win：主窗口，可能为 null（还没创建或已销毁）。
// broker：AgentBroker 实例，后面创建。
// quitting：标记是否正在退出。用来区分“用户点关闭按钮”和“真的退出应用”。
// config：当前桌面配置。
let win: BrowserWindow | null = null,
  broker: AgentBroker,
  quitting = false,
  config: DesktopConfig;
let startupReady: ReturnType<AgentBroker['ready']> | undefined;

// 窗口与页面共用不透明纯色背景，避免桌面壁纸或窗口激活状态改变外观。
function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#202020' : '#F9F9F9';
}

// selected：一个 Map，存“用户刚通过对话框选中的目录”。
// key 是 selectionId（UUID），value 包含路径、身份标识、过期时间。
// 这是安全设计：渲染进程不能直接传路径，只能传一个临时 selectionId，
// 主进程再查真实路径，防止渲染进程伪造任意路径。
const selected = new Map<string, { path: string; identity: string; expires: number }>();

// userData 路径。
// 支持 --data <dir> 命令行参数指定数据目录；
// 没传就用 Electron 默认的 userData 下的 Umi 子目录。
const dataArg = process.argv.indexOf('--data');
const userData =
  dataArg >= 0
    ? resolve(process.argv[dataArg + 1] ?? '.umi-desktop')
    : join(app.getPath('userData'), 'Umi');

// app.setPath('userData', userData)：覆盖 Electron 默认的用户数据目录。
// 这会影响 app.getPath('userData') 以及 Chromium 的缓存、Cookie 等位置。
app.setPath('userData', userData);

function configFile() {
  return join(userData, 'desktop-config.json');
}

// 加载配置。
function loadConfig(): DesktopConfig {
  // 读配置文件，解析 JSON。失败就空对象（首次运行没有配置文件是正常的）。
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {}

  // 先从环境变量 DEEPSEEK_API_KEY 取 key 作为默认值。
  let key = process.env.DEEPSEEK_API_KEY ?? '';

  // 如果配置文件里有 encryptedKey 且系统加密可用，就解密覆盖。
  if (typeof raw.encryptedKey === 'string' && safeStorage.isEncryptionAvailable()) {
    try {
      key = safeStorage.decryptString(Buffer.from(raw.encryptedKey, 'base64'));
    } catch {}
  }

  // delete raw.encryptedKey：把加密字段从 raw 里删掉，避免它被展开进最终对象。
  // 因为 schema 是 strict 的，留着会报错。
  delete raw.encryptedKey;

  return desktopConfigSchema.parse({
    ...raw,
    baseUrl: raw.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: key,
  });
}

// 保存配置。
function saveConfig(value: DesktopConfig) {
  // 确保 userData 目录存在。
  mkdirSync(userData, { recursive: true });

  // 解构：把 apiKey 单独拿出来，其余进 plain。这样明文 key 不会写进 JSON。
  const { apiKey, ...plain } = value;

  // 安全底线：如果有 key 但系统加密不可用，直接抛错，绝不写明文。
  // 错误码 SECURE_STORAGE_UNAVAILABLE。
  if (apiKey && !safeStorage.isEncryptionAvailable()) {
    throw new UmiError(
      'SECURE_STORAGE_UNAVAILABLE',
      '系统加密存储不可用；请通过环境变量配置密钥，不保存明文',
    );
  }

  // 原子写入：先写 configFile() + '.tmp'，再 renameSync 覆盖正式文件。
  // 这样即使写入过程中崩溃，也不会留下半个损坏的配置文件。
  // rename 在同一文件系统上是原子的。
  const temp = configFile() + '.tmp';

  // JSON 内容：plain + 加密后的 encryptedKey（如果有 key）。
  writeFileSync(
    temp,
    JSON.stringify(
      {
        ...plain,
        ...(apiKey
          ? { encryptedKey: safeStorage.encryptString(apiKey).toString('base64') }
          : {}),
      },
      null,
      2,
    ),
  );

  renameSync(temp, configFile());
}

// IPC 信任校验。
function trust(event: Electron.IpcMainInvokeEvent) {
  // 这是安全核心。任何 IPC 调用进来，先检查：
  //   win 存在；
  //   event.sender 就是主窗口的 webContents（不是某个 iframe 或别的窗口）；
  //   event.senderFrame 是主 frame（不是嵌套 iframe）；
  //   frame 的 URL 以 umi://app/ 开头，且 host 是 app。
  // 四项都过才放行，否则抛 PERMISSION_DENIED。
  if (
    !win ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame ||
    !(
      event.senderFrame.url.startsWith('umi://app/') &&
      new URL(event.senderFrame.url).host === 'app'
    )
  ) {
    throw new UmiError('PERMISSION_DENIED', 'IPC 来源不是 Umi 主界面');
  }
}

// handle 包装器：这是对 ipcMain.handle 的统一封装。
function handle(
  name: string,
  fn: (event: Electron.IpcMainInvokeEvent, arg: unknown) => unknown,
) {
  ipcMain.handle(name, async (e, arg) => {
    try {
      // 先信任校验（trust）。
      trust(e);

      // 大小限制：把参数 JSON 序列化后算字节数，超过 3MB 直接拒绝。
      // 防止渲染进程发超大消息打爆内存。
      if (Buffer.byteLength(JSON.stringify(arg ?? null)) > 3_000_000) {
        throw new UmiError('PROTOCOL_INVALID', '消息过长');
      }

      // 成功返回 { ok: true, value }。
      return { ok: true, value: await fn(e, arg) };
    } catch (err) {
      // 失败返回 { ok: false, code, message }。
      // 且只暴露 UmiError 的 code/message，其它错误统一成 DESKTOP_ERROR + 通用文案。
      return {
        ok: false,
        code: err instanceof UmiError ? err.code : 'DESKTOP_ERROR',
        message: err instanceof UmiError ? err.message : '桌面操作未能完成',
      };
    }
  });
}

// 原生窗口控制覆盖页面右上角；主题变化时同步图标和背景。
function titleBarOverlay() {
  return {
    // 透出同一层纯色窗口背景，避免原生控制按钮出现独立底板。
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8e8' : '#292b30',
    height: TITLE_BAR_HEIGHT,
  };
}

function installIPC() {
  handle('umi:window-info', () => ({ development: !app.isPackaged }));
  handle('umi:menu', async (_e, raw) => {
    const parsed = desktopMenuRequestSchema.safeParse(raw);
    if (!parsed.success) throw new UmiError('PROTOCOL_INVALID', '菜单请求无效');
    const arg = parsed.data, current = win!;
    const menu = Menu.buildFromTemplate(desktopMenuTemplate(arg.menu, !app.isPackaged, {
      about: () => { void dialog.showMessageBox(current, {
        type: 'info', title: '关于 Umi', message: 'Umi',
        detail: '版本 ' + app.getVersion() + (app.isPackaged ? '' : '（开发版）'),
      }); },
      quit: () => app.quit(),
    }));
    const [width = 1, height = 1] = current.getContentSize();
    await new Promise<void>(resolveMenu => menu.popup({
      window: current,
      x: Math.min(arg.x, width - 1), y: Math.min(arg.y, height - 1),
      callback: resolveMenu,
    }));
  });
  // umi:theme：校验主题值，设置 nativeTheme.themeSource，
  // 返回固定的纯色材质；主题切换仍更新原生窗口文字与背景。
  handle('umi:theme', (_e, arg) => {
    if (arg !== 'light' && arg !== 'dark' && arg !== 'system') {
      throw new UmiError('PROTOCOL_INVALID', '主题无效');
    }
    nativeTheme.themeSource = arg;
    return { material: 'solid' };
  });

  // umi:status：返回 broker 是否 ready。
  handle('umi:status', () => {
    const initial = startupReady; startupReady = undefined;
    return initial ?? broker.ready();
  });

  handle('umi:choose', async () => {
    // 弹系统目录选择对话框。
    const result = await dialog.showOpenDialog(win!, {
      title: '选择工作文件夹（允许 Umi 直接读改，直到撤销）',
      buttonLabel: '选择并授权',
      properties: ['openDirectory'],
    });

    // 用户取消返回 null。
    if (result.canceled || !result.filePaths[0]) return null;

    // safeRoot(path)：规范化并校验路径（防止符号链接绕过等）。
    // 生成 selectionId（UUID）。
    // 存进 selected Map，带 identity（路径身份，可能是 inode/设备号之类的稳定标识）
    // 和 10 分钟过期时间。
    const path = safeRoot(result.filePaths[0]),
      selectionId = randomUUID();
    selected.set(selectionId, {
      path,
      identity: rootIdentity(path),
      expires: Date.now() + 600000,
    });

    // 如果 Map 超过 32 个，删掉最早的一个（简单的 LRU/防泄漏）。
    if (selected.size > 32) selected.delete(selected.keys().next().value!);

    // 返回 selectionId 和目录名给渲染进程。
    return { selectionId, name: path.split(/[\\/]/).at(-1) || path };
  });

  // 选址只生成请求草稿，不创建目标文件；真正导出仍由 Agent 的批准流程执行。
  handle('umi:output-target', async (_e, arg) => {
    const input = arg as { conversationId?: unknown; outputId?: unknown };
    const c = desktopCommandSchema.parse({
      type: 'preview_output',
      conversationId: input?.conversationId,
      outputId: input?.outputId,
      byteLength: 1,
    });
    const descriptor = (await broker.request(c)) as { name: string };
    const result = await dialog.showSaveDialog(win!, {
      title: '选择成果导出目标（发送请求后仍需批准）',
      defaultPath: descriptor.name.split(/[\\/]/).at(-1) || '成果',
      buttonLabel: '生成导出请求',
    });
    return result.canceled || !result.filePath ? null : { target: result.filePath };
  });

  handle('umi:request', async (_e, arg) => {
    // 用 desktopCommandSchema 校验命令。
    const c = desktopCommandSchema.parse(arg);

    // 如果 type === 'create'（创建会话）：
    if (c.type === 'create') {
      // 从 selected 查 selectionId。
      const s = selected.get(c.selectionId);

      // 不存在或过期 → PERMISSION_DENIED。
      if (!s || s.expires < Date.now()) {
        throw new UmiError('PERMISSION_DENIED', '目录选择已失效，请重新选择');
      }

      // safeRoot(s.path, s.identity)：再次校验路径身份，
      // 防止路径在选中后被替换（TOCTOU 攻击）。
      safeRoot(s.path, s.identity);

      // 用完即删 selectionId（一次性令牌）。
      selected.delete(c.selectionId);

      // 把内部命令 create_internal 和真实 workspace 路径交给 broker。
      return broker.request({
        internal: 'create_internal',
        payload: { workspace: s.path, rootIdentity:s.identity },
      });
    }

    // 其它命令：直接 broker.request(c)。
    const result = await broker.request(c);

    if (c.type === 'open_delivered') {
      if (process.argv.includes('--verify-desktop')) throw new UmiError('OPEN_UNAVAILABLE', '验收模式不启动系统应用');
      const path = verifiedDocumentPath(documentTargetSchema.parse(result));
      const error = await shell.openPath(path);
      if (error) throw new UmiError('OPEN_FAILED', error);
      return { systemAccepted: true };
    }
    // 如果是 open_file：拿结果里的 path，用 shell.showItemInFolder
    // 在文件管理器里高亮该文件，返回 { opened: true }。
    if (c.type === 'open_file' || c.type === 'open_export') {
      const path = (result as { path: string }).path;
      shell.showItemInFolder(path);
      return { opened: true };
    }

    return result;
  });

  // 返回配置摘要给界面。
  handle('umi:config', () => ({
    baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKey),
    docker: config.docker,
    wsl: config.wsl,
  }));

  // 如果没传 apiKey，沿用旧的。
  // baseUrl 变了就拒绝，因为 broker/agent 可能已经用旧端点建立了连接，
  // 热切换会出问题。错误码 CONFIG_RESTART_REQUIRED。
  handle('umi:configure', async (_e, arg) => {
    // 校验新配置。
    const next = desktopConfigSchema.parse(arg);
    next.apiKey = next.apiKey ?? config.apiKey ?? '';
    if (next.baseUrl !== config.baseUrl) {
      throw new UmiError('CONFIG_RESTART_REQUIRED', '当前会话不支持热切换 API 端点');
    }
    const prior = config;
    saveConfig(next);
    try {
      await broker.configure(next);
      config = next;
    } catch (e) {
      saveConfig(prior);
      throw e;
    }
  });

  handle('umi:url', async (_e, arg) => {
    if (typeof arg !== 'string' || arg.length > 4096) {
      throw new UmiError('PROTOCOL_INVALID', '网址无效');
    }

    const url = new URL(arg);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new UmiError('PERMISSION_DENIED', '仅支持普通网页链接');
    }

    await shell.openExternal(url.toString());
  });

  handle('umi:plugin', async (_e, arg) => {
    if (arg !== 'docker' && arg !== 'wsl') {
      throw new UmiError('PROTOCOL_INVALID', '插件类型无效');
    }

    const exe =
      arg === 'docker'
        ? 'docker.exe'
        : join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');

    const argv =
      arg === 'docker'
        ? ['info', '--format', '{{.ServerVersion}}']
        : ['--list', '--quiet'];

    const env: Record<string, string> = {};
    for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }

    return new Promise((resolveCheck) =>
      execFile(
        exe,
        argv,
        {
          windowsHide: true,
          timeout: 7000,
          maxBuffer: 32000,
          env,
          encoding: arg === 'wsl' ? 'utf16le' : 'utf8',
        },
        (error, stdout) =>
          resolveCheck({
            available: !error,
            message: error
              ? '工具未安装、服务未启动或检查超时；Umi 不会安装或启动服务。'
              : arg === 'wsl'
                ? `已安装发行版：${stdout.trim()}`
                : `Docker 服务版本：${stdout.trim()}`,
          }),
      ),
    );
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 840,
    minHeight: 620,
    title: 'Umi',
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay() } : {}),
    backgroundColor: windowBackgroundColor(),
    show: false,
    icon: join(codeRoot, process.platform === 'win32' ? 'renderer/umi.ico' : 'renderer/umi-logo.png'),
    webPreferences: {
      preload: join(codeRoot, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  if (process.platform === 'win32') {
    const updateOverlay = () => { if (win && !win.isDestroyed()) { win.setTitleBarOverlay(titleBarOverlay()); win.setBackgroundColor(windowBackgroundColor()); } };
    nativeTheme.on('updated', updateOverlay);
    win.once('closed', () => nativeTheme.removeListener('updated', updateOverlay));
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== 'umi://app/index.html') event.preventDefault();
  });

  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win!.hide();
    }
  });

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--verify-desktop')) win!.show();
  });

  void win.loadURL('umi://app/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });

  app.on('activate', () => {
    win?.show();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void broker?.close().finally(() => app.quit());
  });

  void app
    .whenReady()
    .then(async () => {
      protocol.handle('umi', (request) => {
        const url = new URL(request.url),
          path = resolve(codeRoot, 'renderer', '.' + decodeURIComponent(url.pathname));
        const rel = relative(join(codeRoot, 'renderer'), path);

        if (
          url.host !== 'app' ||
          rel.startsWith('..') ||
          isAbsolute(rel) ||
          !existsSync(path) ||
          !statSync(path).isFile()
        ) {
          return new Response('Not found', { status: 404 });
        }

        return net.fetch(pathToFileURL(path).toString());
      });

      // 统一由紧凑顶栏打开固定原生菜单，避免 Electron 默认菜单进入发行包。
      Menu.setApplicationMenu(null);

      config = loadConfig();
      broker = new AgentBroker(
        join(codeRoot, 'agent-worker.js'),
        join(userData, 'agent'),
        config,
        process.argv.includes('--verify-desktop'),
        async target => {
          const error = await shell.openPath(verifiedDocumentPath(target));
          if (error) throw new UmiError('OPEN_FAILED', error);
        },
      );
      // 与页面加载并行，第一次status仍收到原始启动结果（包括具体失败原因）。
      startupReady = broker.ready();
      void startupReady.catch(() => {});
      installIPC();
      createWindow();

      if (process.argv.includes('--verify-desktop')) {
        const { verifyDesktop } = await import('./verification.js');
        await verifyDesktop(broker, win!, userData);
        quitting = true;
        await broker.close();
        app.exit(0);
      }
    })
    .catch(() => {
      quitting = true;
      app.exit(1);
    });
}
