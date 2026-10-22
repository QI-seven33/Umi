import {useEffect,useRef,useState} from 'react';
import {RefreshCw,ChevronDown,ChevronUp,BookOpen} from 'lucide-react';
import type {SkillLibrary} from '../../../../../../packages/protocol/src/skills.js';
import {SkillPreview} from './SkillPreview.js';
import {SkillImport} from './SkillImport.js';
import {userFacingError} from '../../ui-error.js';

export function SkillSettings(){
  const [library,setLibrary]=useState<SkillLibrary|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [query,setQuery]=useState(''),[selected,setSelected]=useState<string|null>(null),[filter,setFilter]=useState('all'),[notice,setNotice]=useState('');
  const alive=useRef(true),lock=useRef(false);
  const request=async(action:()=>Promise<unknown>)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const result=await action() as SkillLibrary;if(alive.current){
      if(selected&&library?.skills.find(s=>s.name===selected)?.version!==result.skills.find(s=>s.name===selected)?.version){setSelected(null);}
      setLibrary(result);
    }}
    catch(error){if(alive.current)setError(userFacingError(error)||'技能读取失败，请重试。');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  useEffect(()=>{alive.current=true;void request(()=>window.umi.request({type:'skills_list'}));return()=>{alive.current=false;};},[]);
  const shown=library?.skills.filter(s=>(s.name+' '+s.description).toLowerCase().includes(query.trim().toLowerCase())&&(filter==='all'||s.enabled===(filter==='enabled')))??[];
  return <div className="settings-skills">
    <SkillImport onInstalled={()=>{setSelected(null);void request(()=>window.umi.request({type:'skills_list',refresh:true}));}}/>
    <section className="settings-card"><h2>技能库</h2><p>兼容的技能可原样使用。模型按任务需要选择方法；改写由开发者或模型按需决定。</p>
      <div className="settings-skill-toolbar"><input type="search" aria-label="搜索技能" placeholder="搜索名称或用途" value={query} onChange={e=>setQuery(e.target.value)}/>
        <button type="button" disabled={busy} onClick={()=>{setSelected(null);void request(()=>window.umi.request({type:'skills_list',refresh:true}));}}><RefreshCw size={13}/>{busy?'读取中':'刷新目录'}</button></div>
      <div className="settings-skill-filter"><span>{library?library.skills.filter(s=>s.enabled).length+' 项已启用 · '+library.skills.length+' 项技能':'技能目录'}</span><label>显示<select aria-label="筛选技能" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部技能</option><option value="enabled">已启用</option><option value="disabled">未启用</option></select></label></div>
      {!library?<div className="settings-skill-loading" role="status">{error?'技能库暂不可用':'正在读取技能目录…'}</div>:shown.length===0?<p>没有匹配的技能。</p>:<ul className="settings-skill-list">{shown.map(skill=><li key={skill.name} data-skill={skill.name}>
        <div className="settings-skill-summary"><BookOpen size={16}/><div><div className="settings-skill-name"><strong>{skill.name}</strong><small>{skill.source==='builtin'?'内置':skill.origin?'GitHub 导入':'本地'}</small></div><p>{skill.description}</p></div>
          <label className="settings-skill-toggle"><span>{skill.enabled?'已启用':'未启用'}</span><input type="checkbox" aria-label={'启用技能 '+skill.name} checked={skill.enabled} disabled={busy} onChange={e=>void request(()=>window.umi.request({type:'skills_enable',name:skill.name,version:skill.version,enabled:e.target.checked}))}/></label></div>
        <button type="button" className="settings-skill-inspect" aria-expanded={selected===skill.name} onClick={()=>setSelected(selected===skill.name?null:skill.name)}>{selected===skill.name?<ChevronUp size={12}/>:<ChevronDown size={12}/>}查看内容与兼容性</button>
        {selected===skill.name&&<div className="settings-skill-preview"><p>{skill.compatibility??'未声明额外环境条件；实际能力以当前工具和宿主为准。'}</p>{skill.origin&&<p className="settings-skill-origin">原始来源：{skill.origin.repository} · {skill.origin.commit.slice(0,12)}{skill.origin.mainModified?' · 本地正文已修改':''}</p>}<small>正文版本 {skill.version.slice(0,12)} · 仅作为方法资料，不授予权限</small><SkillPreview key={skill.name+skill.version} source={{name:skill.name,version:skill.version}}/></div>}
      </li>)}</ul>}
    </section>
    {library&&<section className="settings-card settings-skill-directory"><h2>添加你的技能</h2><p>将完整的技能文件夹放到此目录，然后刷新、查看并启用。每个文件夹包含 SKILL.md，可附带 references、scripts 和 assets。</p><code tabIndex={0}>{library.directory}</code><div className="settings-actions"><button type="button" onClick={()=>{void navigator.clipboard.writeText(library.directory).then(()=>{if(alive.current)setNotice('技能目录已复制');}).catch(()=>{if(alive.current)setError('复制失败，可选中上方路径手动复制。');});}}>复制目录路径</button></div><p>新本地技能默认停用，正文更新后需重新启用。脚本的执行仍使用现有命令批准。</p></section>}
    {library?.limitReached&&<p className="settings-status" role="status">最多发现128个本地目录，超出部分未载入。</p>}
    {library?.issues.map((issue,i)=><p className="settings-status" role="alert" key={i}>{issue.name}：{issue.message}</p>)}
    {notice&&<p className="settings-status" role="status">{notice}</p>}
    {error&&<p className="settings-status" role="alert">{error}</p>}
  </div>;
}