import {app,BrowserWindow,ipcMain,dialog,shell,protocol,net,safeStorage,Menu,nativeTheme} from 'electron';
import {release as osRelease} from 'node:os';
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {desktopCommandSchema,desktopConfigSchema} from '../../packages/protocol/src/desktop.js';
import type {DesktopConfig} from '../../packages/protocol/src/desktop.js';
import {UmiError} from '../../packages/protocol/src/model.js';
import {safeRoot,rootIdentity} from '../../packages/adapters/src/host-files/paths.js';
import {AgentBroker} from './broker.js';

protocol.registerSchemesAsPrivileged([{scheme:'umi',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const codeRoot=dirname(fileURLToPath(import.meta.url));let win:BrowserWindow|null=null,broker:AgentBroker,quitting=false,config:DesktopConfig;
const micaSupported=process.platform==='win32'&&Number(osRelease().split('.')[2])>=22621;
const selected=new Map<string,{path:string;identity:string;expires:number}>();
const dataArg=process.argv.indexOf('--data');const userData=dataArg>=0?resolve(process.argv[dataArg+1]??'.umi-desktop'):join(app.getPath('userData'),'Umi');
app.setPath('userData',userData);
function configFile(){return join(userData,'desktop-config.json');}
function loadConfig():DesktopConfig{
  let raw:Record<string,unknown>={};try{raw=JSON.parse(readFileSync(configFile(),'utf8'));}catch{}
  let key=process.env.DEEPSEEK_API_KEY??'';
  if(typeof raw.encryptedKey==='string'&&safeStorage.isEncryptionAvailable())try{key=safeStorage.decryptString(Buffer.from(raw.encryptedKey,'base64'));}catch{}
  delete raw.encryptedKey;return desktopConfigSchema.parse({...raw,baseUrl:raw.baseUrl??process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com',apiKey:key});
}
function saveConfig(value:DesktopConfig){mkdirSync(userData,{recursive:true});const {apiKey,...plain}=value;
  if(apiKey&&!safeStorage.isEncryptionAvailable())throw new UmiError('SECURE_STORAGE_UNAVAILABLE','系统加密存储不可用；请通过环境变量配置密钥，不保存明文');
  const temp=configFile()+'.tmp';writeFileSync(temp,JSON.stringify({...plain,...(apiKey?{encryptedKey:safeStorage.encryptString(apiKey).toString('base64')}:{})},null,2));renameSync(temp,configFile());}
function trust(event:Electron.IpcMainInvokeEvent){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!(event.senderFrame.url.startsWith('umi://app/')&&new URL(event.senderFrame.url).host==='app'))throw new UmiError('PERMISSION_DENIED','IPC 来源不是 Umi 主界面');}
function handle(name:string,fn:(event:Electron.IpcMainInvokeEvent,arg:unknown)=>unknown){ipcMain.handle(name,async(e,arg)=>{try{trust(e);if(Buffer.byteLength(JSON.stringify(arg??null))>3_000_000)throw new UmiError('PROTOCOL_INVALID','消息过长');return {ok:true,value:await fn(e,arg)};}catch(err){return {ok:false,code:err instanceof UmiError?err.code:'DESKTOP_ERROR',message:err instanceof UmiError?err.message:'桌面操作未能完成'};}});}
function installIPC(){
  handle('umi:theme',(_e,arg)=>{if(arg!=='light'&&arg!=='dark'&&arg!=='system')throw new UmiError('PROTOCOL_INVALID','主题无效');nativeTheme.themeSource=arg;return {material:micaSupported?'mica':'solid'};});
  handle('umi:status',()=>broker.ready());
  handle('umi:choose',async()=>{const result=await dialog.showOpenDialog(win!,{title:'选择 Umi 工作区',properties:['openDirectory']});if(result.canceled||!result.filePaths[0])return null;
    const path=safeRoot(result.filePaths[0]),selectionId=randomUUID();selected.set(selectionId,{path,identity:rootIdentity(path),expires:Date.now()+600000});if(selected.size>32)selected.delete(selected.keys().next().value!);return {selectionId,name:path.split(/[\\/]/).at(-1)||path};});
  handle('umi:request',async(_e,arg)=>{const c=desktopCommandSchema.parse(arg);
    if(c.type==='create'){const s=selected.get(c.selectionId);if(!s||s.expires<Date.now())throw new UmiError('PERMISSION_DENIED','目录选择已失效，请重新选择');safeRoot(s.path,s.identity);selected.delete(c.selectionId);return broker.request({internal:'create_internal',payload:{workspace:s.path}});}
    const result=await broker.request(c);if(c.type==='open_file'){const path=(result as {path:string}).path;shell.showItemInFolder(path);return {opened:true};}return result;});
  handle('umi:config',()=>({baseUrl:config.baseUrl,hasKey:Boolean(config.apiKey),docker:config.docker,wsl:config.wsl}));
  handle('umi:configure',async(_e,arg)=>{const next=desktopConfigSchema.parse(arg);next.apiKey=next.apiKey??config.apiKey??'';if(next.baseUrl!==config.baseUrl)throw new UmiError('CONFIG_RESTART_REQUIRED','当前会话不支持热切换 API 端点');const prior=config;saveConfig(next);try{await broker.configure(next);config=next;}catch(e){saveConfig(prior);throw e;}});
  handle('umi:url',async(_e,arg)=>{if(typeof arg!=='string'||arg.length>4096)throw new UmiError('PROTOCOL_INVALID','网址无效');const url=new URL(arg);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new UmiError('PERMISSION_DENIED','仅支持普通网页链接');await shell.openExternal(url.toString());});
  handle('umi:plugin',async(_e,arg)=>{
    if(arg!=='docker'&&arg!=='wsl')throw new UmiError('PROTOCOL_INVALID','插件类型无效');
    const exe=arg==='docker'?'docker.exe':join(process.env.SystemRoot??'C:\\Windows','System32','wsl.exe'),argv=arg==='docker'?['info','--format','{{.ServerVersion}}']:['--list','--quiet'];
    const env:Record<string,string>={};for(const k of ['PATH','SystemRoot','WINDIR','USERPROFILE','TEMP','TMP'])if(process.env[k])env[k]=process.env[k]!;
    return new Promise(resolveCheck=>execFile(exe,argv,{windowsHide:true,timeout:7000,maxBuffer:32000,env,encoding:arg==='wsl'?'utf16le':'utf8'},(error,stdout)=>resolveCheck({available:!error,message:error?'工具未安装、服务未启动或检查超时；Umi 不会安装或启动服务。':arg==='wsl'?`已安装发行版：${stdout.trim()}`:`Docker 服务版本：${stdout.trim()}`})));
  });
}
function createWindow(){win=new BrowserWindow({width:1440,height:960,minWidth:840,minHeight:620,title:'Umi',backgroundColor:micaSupported?'#00000000':'#eef2f0',...(micaSupported?{backgroundMaterial:'mica' as const}:{}),show:false,
    icon:join(codeRoot,'renderer/umi-logo.png'),webPreferences:{preload:join(codeRoot,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!=='umi://app/index.html')event.preventDefault();});
  win.on('close',event=>{if(!quitting){event.preventDefault();win!.hide();}});win.once('ready-to-show',()=>{if(!process.argv.includes('--verify-desktop'))win!.show();});void win.loadURL('umi://app/index.html');}
if(!app.requestSingleInstanceLock())app.quit();else {
  app.on('second-instance',()=>{win?.show();win?.focus();});app.on('activate',()=>{win?.show();});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void broker?.close().finally(()=>app.quit());});
  void app.whenReady().then(async()=>{
    protocol.handle('umi',request=>{const url=new URL(request.url),path=resolve(codeRoot,'renderer','.'+decodeURIComponent(url.pathname));const rel=relative(join(codeRoot,'renderer'),path);
      if(url.host!=='app'||rel.startsWith('..')||isAbsolute(rel)||!existsSync(path)||!statSync(path).isFile())return new Response('Not found',{status:404});return net.fetch(pathToFileURL(path).toString());});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Umi',submenu:[{label:'显示窗口',click:()=>win?.show()},{label:'退出 Umi',click:()=>app.quit()}]},{label:'开发',submenu:[{role:'reload'},{role:'toggleDevTools'}]}]));
    config=loadConfig();broker=new AgentBroker(join(codeRoot,'agent-worker.js'),join(userData,'agent'),config,process.argv.includes('--verify-desktop'));installIPC();createWindow();
    if(process.argv.includes('--verify-desktop')){const {verifyDesktop}=await import('./verification.js');await verifyDesktop(broker,win!,userData);quitting=true;await broker.close();app.exit(0);}
  }).catch(()=>{quitting=true;app.exit(1);});
}

