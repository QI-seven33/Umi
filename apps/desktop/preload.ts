import {contextBridge,ipcRenderer} from 'electron';
async function invoke(channel:string,arg?:unknown){const reply=await ipcRenderer.invoke(channel,arg);if(!reply?.ok){const error=new Error(reply?.message??'桌面连接失败');Object.assign(error,{code:reply?.code??'IPC_ERROR'});throw error;}return reply.value;}
// 每项能力对应固定频道；不暴露 ipcRenderer、文件系统或任意频道发送函数。
contextBridge.exposeInMainWorld('umi',Object.freeze({request:(c:unknown)=>invoke('umi:request',c),setTheme:(theme:unknown)=>invoke('umi:theme',theme),chooseWorkspace:()=>invoke('umi:choose'),status:()=>invoke('umi:status'),config:()=>invoke('umi:config'),configure:(c:unknown)=>invoke('umi:configure',c),checkPlugin:(p:unknown)=>invoke('umi:plugin',p),openUrl:(url:unknown)=>invoke('umi:url',url)}));
