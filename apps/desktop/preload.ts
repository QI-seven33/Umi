import { contextBridge, ipcRenderer } from 'electron';

//IPC = Inter-Process Communication，进程间通信
//向主进程发一个 IPC 请求并等待返回；若返回不成功（ok 为假或为空）
//就造一个带 message 和 code 的 Error 抛出，否则返回 reply.value
// 上行学习笔记描述旧实现；现在抛普通 DTO，Electron 桥才能保留 code。
async function invoke(channel: string, arg?: unknown) {
  const reply = await ipcRenderer.invoke(channel, arg); //向主进程发 IPC 请求，等返回 发给ipcMain.handle处理
  //如果 reply 为空，或 reply.ok 为假，就进这个分支
  if (!reply?.ok) {
    // contextBridge 复制 Error 时丢弃自定义 code；普通 DTO 能完整跨过隔离边界。
    throw { name: 'UmiDesktopError', code: reply?.code ?? 'IPC_ERROR', message: reply?.message ?? '桌面连接失败' };
  }
  return reply.value;
}

//每项能力对应固定频道；不暴露 ipcRenderer、文件系统或任意频道发送函数。
//把一组受控的函数暴露到页面的 window.umi 上，让页面能安全地调主进程，又不暴露危险能力
//contextBridge —— 预加载脚本里的对象，负责在"隔离的渲染进程"和"页面"之间搭桥
//exposeInMainWorld —— 把第二个参数的对象挂到页面的 window[名字] 上
//'umi' —— 挂到 window.umi
contextBridge.exposeInMainWorld(
  'umi',
  Object.freeze({
    //Object.freeze —— 冻结对象：属性不能再增、删、改  作用：防止页面代码篡改 window.umi，比如不能 window.umi.request = 恶意函数
    request: (c: unknown) => invoke('umi:request', c),
    setTheme: (theme: unknown) => invoke('umi:theme', theme),
    chooseWorkspace: () => invoke('umi:choose'),
    chooseOutputTarget: (conversationId: unknown, outputId: unknown) =>
      invoke('umi:output-target', { conversationId, outputId }),
    status: () => invoke('umi:status'),
    config: () => invoke('umi:config'),
    configure: (c: unknown) => invoke('umi:configure', c),
    checkPlugin: (p: unknown) => invoke('umi:plugin', p),
    openUrl: (url: unknown) => invoke('umi:url', url),
  }),
);
