import {useEffect,useRef,useState} from 'react';
import type {SkillPreview as Page} from '../../../../../../packages/protocol/src/skills.js';
import {userFacingError} from '../../ui-error.js';

// 预览可在停用/导入前使用，只经固定管理桥读取正文，不运行内容。
export function SkillPreview({source}:{source:{name:string;version:string}|{id:string}}){
  const [page,setPage]=useState<Page|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),lock=useRef(false),cursor=useRef(0),hash=useRef<string|null>(null),pre=useRef<HTMLPreElement>(null);
  const load=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      const result=await window.umi.request('id' in source?{type:'skills_import_preview',id:source.id,startByte:cursor.current}:{type:'skills_preview',...source,startByte:cursor.current}) as Page;
      if(!alive.current)return;
      if(hash.current&&hash.current!==result.sourceHash)throw Error('正文已变化，请关闭预览并刷新目录。');
      if(result.startByte!==cursor.current)throw Error('正文分页不连续，请重新打开预览。');
      const previousHeight=pre.current?.scrollHeight??0;
      hash.current=result.sourceHash;cursor.current=result.endByte;setPage(result);setText(value=>value+result.text);
      if(previousHeight)requestAnimationFrame(()=>{if(alive.current&&pre.current)pre.current.scrollTop=previousHeight-40;});
    }catch(e){if(alive.current)setError(userFacingError(e)||'正文读取失败，请重试或刷新目录。');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[]);
  return <div className="settings-skill-reader">
    {page&&<><pre ref={pre} tabIndex={0}>{text}</pre><p role="status">已显示 {page.endByte.toLocaleString()} / {page.totalBytes.toLocaleString()} 字节{page.nextStartByte===null?' · 正文完整':''}</p></>}
    {error&&<p role="alert" className="settings-status">{error}</p>}
    {busy&&<p role="status">正在读取正文…</p>}
    {(!page||page.nextStartByte!==null||error)&&<div className="settings-actions"><button type="button" disabled={busy} onClick={()=>void load()}>{error?'重试读取':page?'继续阅读':'读取正文'}</button></div>}
  </div>;
}
