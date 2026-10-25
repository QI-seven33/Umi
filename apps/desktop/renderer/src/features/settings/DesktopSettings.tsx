import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Copy, HardDrive, Download, AppWindow, Database } from 'lucide-react';
import type { DataLocation, DesktopInformation, DesktopPreferences, DesktopPreferencePatch } from '../../../../../../packages/protocol/src/desktop-preferences.js';
import { Select } from '../../components/ui/Select.js';
import { t as uiText, setUiLanguage } from '../../ui-language.js';
import { userFacingError } from '../../ui-error.js';

export function applyDesktopPreferences(value: DesktopPreferences) {
  setUiLanguage(value.language);
  document.documentElement.dataset.reducedMotion = String(value.reducedMotion);
}

export function DesktopSettings({ storage = false }: { storage?: boolean }) {
  const [prefs,setPrefs]=useState<DesktopPreferences|null>(null),[info,setInfo]=useState<DesktopInformation|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const live=useRef(true),lock=useRef(false);
  useEffect(()=>{live.current=true;void Promise.all([window.umi.preferences(),window.umi.applicationInfo()]).then(([p,i])=>{if(live.current){setPrefs(p);setInfo(i);}}).catch(e=>{if(live.current)setError(userFacingError(e));});return()=>{live.current=false;};},[]);
  const change=async(patch:DesktopPreferencePatch)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try {const next=await window.umi.updatePreferences(patch);applyDesktopPreferences(next);if(live.current)setPrefs(next);}
    catch(e){if(live.current)setError(userFacingError(e));}finally{lock.current=false;if(live.current)setBusy(false);}
  };
  const choose=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try {const next=await window.umi.chooseExportDirectory();if(next&&live.current){setPrefs(next);setInfo(await window.umi.applicationInfo());setNotice(uiText('导出位置已更新'));}}
    catch(e){if(live.current)setError(userFacingError(e));}finally{lock.current=false;if(live.current)setBusy(false);}
  };
  const paths: {id:DataLocation; title:string; description:string; icon:typeof HardDrive}[]=[
    {id:'data',title:uiText('应用数据'),description:uiText('偏好、模型连接配置与缓存。'),icon:HardDrive},
    {id:'agent',title:uiText('会话与工作记录'),description:uiText('会话库、恢复备份、附件与技能文件。当前不支持在运行中迁移。'),icon:Database},
    {id:'exports',title:uiText('默认导出位置'),description:uiText('仅影响下次导出时的默认位置，已有文件保持原位。'),icon:Download},
    {id:'application',title:uiText('程序位置'),description:uiText('由安装或解压位置决定。'),icon:AppWindow},
  ];
  return <>
    {!storage?<><section className="settings-card"><h2>{uiText('语言与动效')}</h2>
      <label className="settings-row"><span>{uiText('界面语言')}<small>{uiText('只切换菜单与控件，不改变聊天与标题。')}</small></span><Select aria-label={uiText('界面语言')} disabled={!prefs||busy} value={prefs?.language??'zh-CN'} onChange={e=>void change({language:e.target.value as 'zh-CN'|'en'})}><option value="zh-CN">简体中文</option><option value="en">English</option></Select></label>
      <label className="settings-row"><span>{uiText('减少动态效果')}<small>{uiText('关闭标题滚动等装饰性动画。')}</small></span><input className="ui-switch" role="switch" aria-label={uiText('减少动态效果')} type="checkbox" checked={prefs?.reducedMotion??false} disabled={!prefs||busy} onChange={e=>void change({reducedMotion:e.target.checked})}/></label>
    </section><section className="settings-card"><h2>{uiText('窗口行为')}</h2>
      <label className="settings-row"><span>{uiText('关闭窗口时')}<small>{uiText('仅影响右上角关闭按钮。')}</small></span><Select aria-label={uiText('关闭窗口时')} disabled={!prefs||busy} value={prefs?.closeAction??'background'} onChange={e=>void change({closeAction:e.target.value as 'background'|'quit'})}><option value="background">{uiText('在后台继续运行')}</option><option value="quit">{uiText('退出 Umi')}</option></Select></label>
      <p className="settings-note">{prefs?.closeAction==='quit'?uiText('关闭后会结束应用与正在执行的任务。'):uiText('关闭后任务继续运行；再次启动 Umi 可唤回窗口。可从应用菜单彻底退出。')}</p>
    </section></>:<><section className="settings-card storage-card"><h2>{uiText('本机文件位置')}</h2>
      {info?paths.map(({id,title,description,icon:Icon})=><div className="storage-row" key={id}>
        <Icon size={18}/><div className="storage-copy"><strong>{title}</strong><p>{description}</p><code title={info.paths[id]}>{info.paths[id]}</code></div>
        <div className="storage-actions"><button title={uiText('复制路径')} aria-label={uiText('复制路径')+' · '+title} onClick={()=>void navigator.clipboard.writeText(info.paths[id]).then(()=>setNotice(uiText('路径已复制'))).catch(e=>setError(userFacingError(e)))}><Copy size={15}/></button>
        <button title={uiText('打开文件夹')} aria-label={uiText('打开文件夹')+' · '+title} onClick={()=>void window.umi.showDataLocation(id).catch(e=>setError(userFacingError(e)))}><FolderOpen size={15}/></button>
        {id==='exports'&&<button disabled={busy} onClick={()=>void choose()}>{uiText('更改')}</button>}</div>
      </div>):<p role="status">{uiText('正在读取…')}</p>}
    </section><section className="settings-card about-card"><div className="settings-brand">Umi<span>{info?.version??'—'}{info?.development?' · '+uiText('开发版'):''}</span></div><p>Thus begins the story.</p><small>{uiText('界面偏好保存在此设备，不扩展 Agent 的权限。')}</small></section></>}
    {error&&<p role="alert" className="settings-status">{error}</p>}{notice&&<p role="status" className="settings-status">{notice}</p>}
  </>;
}
