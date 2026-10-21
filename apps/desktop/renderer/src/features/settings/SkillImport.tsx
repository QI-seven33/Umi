import {useEffect,useRef,useState} from 'react';
import {Download,ChevronDown} from 'lucide-react';
import type {SkillImportRecord,SkillImportSummary} from '../../../../../../packages/protocol/src/skill-import.js';
import {userFacingError} from '../../ui-error.js';

type List={records:SkillImportSummary[];issues:string[]};
const states:Record<SkillImportRecord['state'],string>={fetching:'获取中',staged:'待确认',installing:'核对中',installed:'已导入',failed:'失败',cancelled:'已停止'};
export function SkillImport({onInstalled}:{onInstalled:()=>void}){
  const [repository,setRepository]=useState(''),[path,setPath]=useState(''),[ref,setRef]=useState('');
  const [list,setList]=useState<List>({records:[],issues:[]}),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<SkillImportRecord|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),lock=useRef(false),polling=useRef(false),epoch=useRef(0);
  const load=async()=>{
    if(polling.current)return;polling.current=true;
    try{const result=await window.umi.request({type:'skills_import_list'}) as List;if(alive.current)setList(result);}
    catch(e){if(alive.current)setError(userFacingError(e)||'获取记录暂不可用。');}
    finally{polling.current=false;}
  };
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;epoch.current++;};},[]);
  const fetching=list.records.some(r=>r.state==='fetching');
  useEffect(()=>{if(!fetching)return;const timer=setInterval(()=>void load(),1000);return()=>clearInterval(timer);},[fetching]);
  const selectedState=list.records.find(r=>r.id===selected)?.state;
  useEffect(()=>{
    const current=++epoch.current;setDetail(null);if(!selected)return;
    void window.umi.request({type:'skills_import_detail',id:selected}).then(r=>{if(alive.current&&epoch.current===current)setDetail(r as SkillImportRecord);}).catch(e=>{if(alive.current&&epoch.current===current)setError(userFacingError(e));});
  },[selected,selectedState]);
  const action=async(fn:()=>Promise<void>)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{await fn();await load();}catch(e){if(alive.current)setError(userFacingError(e)||'操作未完成，请刷新记录核对。');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  return <details className="settings-card settings-skill-import">
    <summary><span><Download size={14}/>从 GitHub 添加</span><small>{fetching?'正在后台获取':list.records.some(r=>r.state==='staged')?'有待确认的技能':'公开仓库 · 固定提交'}</small><ChevronDown size={14}/></summary>
    <p>获取完整技能目录，核对来源和内容后导入，默认停用。兼容技能可原样使用，脚本不会自动运行。</p>
    <form onSubmit={e=>{e.preventDefault();void action(async()=>{
      const r=await window.umi.request({type:'skills_import_start',input:{repository,path,ref}}) as {id:string};
      if(alive.current){setSelected(r.id);setNotice('正在后台获取，可继续使用工作台。');}
    });}}>
      <label className="settings-row"><span>仓库根链接</span><input aria-label="技能仓库链接" placeholder="https://github.com/owner/repo" value={repository} required maxLength={240} onChange={e=>setRepository(e.target.value)}/></label>
      <label className="settings-row"><span>技能子目录</span><input aria-label="技能子目录" placeholder="skills/my-skill，根目录可留空" value={path} maxLength={240} onChange={e=>setPath(e.target.value)}/></label>
      <label className="settings-row"><span>修订</span><input aria-label="技能修订" placeholder="分支、标签或提交；默认分支可留空" value={ref} maxLength={200} onChange={e=>setRef(e.target.value)}/></label>
      <div className="settings-actions"><button type="submit" className="ui-primary" disabled={busy||!repository.trim()}>获取并预览</button></div>
    </form>
    {list.records.length>0&&<ul className="settings-import-jobs">{list.records.map(r=><li key={r.id} data-import-id={r.id}>
      <div><button type="button" className="settings-import-review" aria-expanded={selected===r.id} onClick={()=>setSelected(selected===r.id?null:r.id)}>{r.name||r.input.path||r.input.repository}<small>{states[r.state]}</small></button><p>{r.progress}{r.error?'：'+r.error:''}</p></div>
      <div className="settings-import-actions">{r.state==='fetching'?<button type="button" disabled={busy} onClick={()=>void action(async()=>{await window.umi.request({type:'skills_import_cancel',id:r.id});})}>停止</button>:<button type="button" disabled={busy} onClick={()=>void action(async()=>{
        await window.umi.request({type:'skills_import_remove',id:r.id,confirm:true});if(alive.current&&selected===r.id)setSelected(null);
      })}>{r.state==='installed'?'移除记录（保留技能）':'放弃草稿'}</button>}</div>
    </li>)}</ul>}
    {selected&&<div className="settings-import-detail">{!detail?<p role="status">正在核对记录…</p>:detail.snapshot?<><h2>{detail.snapshot.name}</h2><p>{detail.snapshot.description}</p>
      <dl className="settings-statistics"><div><dt>原始来源</dt><dd>{detail.snapshot.source.repository}</dd></div><div><dt>目录</dt><dd>{detail.snapshot.source.path||'仓库根目录'}</dd></div><div><dt>固定提交</dt><dd><code>{detail.snapshot.source.commit}</code></dd></div><div><dt>文件 / 字节</dt><dd>{detail.snapshot.files.length} / {detail.snapshot.totalBytes.toLocaleString()}</dd></div></dl>
      <p>许可：{detail.snapshot.license}</p><p>兼容性：{detail.snapshot.compatibility}</p>
      <details><summary>文件清单与 SHA-256</summary><ul className="settings-import-files">{detail.snapshot.files.map(f=><li key={f.path}><code>{f.path}</code><span>{f.bytes.toLocaleString()} B · {f.sha256.slice(0,12)}</span></li>)}</ul></details>
      <details className="settings-skill-preview"><summary>查看原始 SKILL.md</summary><pre tabIndex={0}>{detail.snapshot.preview}</pre>{detail.snapshot.previewTruncated&&<p>此处为前12,000字节预览，完整正文已保存。</p>}</details>
      {detail.state==='staged'&&<div className="settings-actions"><button type="button" className="ui-primary settings-import-install" disabled={busy} onClick={()=>void action(async()=>{
        await window.umi.request({type:'skills_import_install',id:detail.id,planHash:detail.planHash!,confirm:true});
        if(alive.current){setNotice('已导入，默认停用。可在技能库查看并启用。');onInstalled();}
      })}>确认导入，保持停用</button></div>}
    </>:<p>{detail.progress}{detail.error?'：'+detail.error:''}</p>}</div>}
    {list.issues.map((message,i)=><p role="alert" className="settings-status" key={i}>{message}</p>)}
    {error&&<p role="alert" className="settings-status">{error}</p>}{notice&&<p role="status" className="settings-status">{notice}</p>}
  </details>;
}
