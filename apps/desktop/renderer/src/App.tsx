import {useEffect,useMemo,useRef,useState} from 'react';
import type {CSSProperties,FormEvent,PointerEvent} from 'react';
import {FileText,FolderOpen,Plus,X} from 'lucide-react';
import {Sidebar} from './features/sidebar/Sidebar.js';
import {ApprovalCard} from './ApprovalCard.js';
import {Composer} from './features/work/components/Composer.js';
import {PanelIcon} from './components/ui/PanelIcon.js';
import {ConversationMap,projectHistoryPreview} from './components/ui/ConversationMap.js';
import {usePersonalProfile} from './features/settings/usePersonalProfile.js';
import {applyBatch} from './transport.js';
import type {Snapshot,Batch} from './transport.js';
import type {FileTarget} from './Timeline.js';
import {Timeline,fileTargetKey} from './Timeline.js';
import HoldButton from './components/ui/HoldButton.js';
import {SettingsPage} from './features/settings/SettingsPage.js';
import {asTextDocument,documentInstruction} from './features/work/longInput.js';
import {MODEL_OPTIONS} from './features/work/models.js';
import {EmptyConversation} from './features/work/components/EmptyConversation.js';
import {useAttachments} from './features/work/attachments.js';
import {CommandGate} from './features/work/CommandGate.js';
import type {Settings} from '../../../../packages/protocol/src/model.js';
import type {Conversation,Workspace,ThemeMode,WorkContextStats} from './types/index.js';

type Entry={id:string;workspaceId:string;workspace:string;environmentId:string;title:string;updatedAt:string|null;hasMessages:boolean};
export default function App(){
  const [entries,setEntries]=useState<Entry[]>([]),[active,setActive]=useState(''),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const [left,setLeft]=useState(true),[right,setRight]=useState(false),[width,setWidth]=useState(()=>Number(localStorage.getItem('umi.work.rightWidth'))||380),[settingsOpen,setSettingsOpen]=useState(false);
  const [prompt,setPrompt]=useState(''),[tabs,setTabs]=useState<FileTarget[]>([]),[previewTab,setPreviewTab]=useState<FileTarget|null>(null),[preview,setPreview]=useState<any>(null);
  const [selectedWorkspace,setSelectedWorkspace]=useState(''),[expanded,setExpanded]=useState<Set<string>>(new Set()),[theme,setTheme]=useState<ThemeMode>(()=>localStorage.getItem('umi.theme') as ThemeMode||'system');
  const {avatar,setAvatar,username,setUsername}=usePersonalProfile();
  const canvas=useRef<HTMLElement>(null),current=useRef<Snapshot|null>(null),activeRef=useRef(''),settingsQueue=useRef(Promise.resolve()),pendingCommand=useRef<{id:string;text:string;attachments:string[]}|null>(null),[deleteId,setDeleteId]=useState<string|null>(null);
  const fail=(e:unknown)=>setError(e instanceof Error?e.message:String(e));
  const {attachments,addFiles,remove:removeAttachment,consume:consumeAttachments}=useAttachments(active,fail);
  const submitGate=useRef(new CommandGate()),[submitting,setSubmitting]=useState(''),[archiving,setArchiving]=useState(false),[archiveError,setArchiveError]=useState('');
  const [isAtBottom,setIsAtBottom]=useState(true);
  const drafts=useRef(new Map<string,string>()),creatingConversation=useRef(false);
  const writePrompt=(value:string)=>{drafts.current.set(active,value);setPrompt(value);};
  useEffect(()=>{localStorage.removeItem('umi.canvasColor');},[]);
  const updateBottom=()=>{const node=canvas.current;setIsAtBottom(!node||node.scrollHeight-node.scrollTop-node.clientHeight<70);};
  useEffect(()=>{const node=canvas.current;if(!node)return;const observer=new ResizeObserver(updateBottom);observer.observe(node);if(node.firstElementChild)observer.observe(node.firstElementChild);updateBottom();return()=>observer.disconnect();},[snapshot?.messages.length,active,right]);
  const list=async()=>{const rows=await window.umi.request({type:'list'}) as Entry[];setEntries(rows);return rows;};
  const select=(id:string)=>{setActive(id);localStorage.setItem('umi.work.activeThread',id);const row=entries.find(e=>e.id===id);if(row){setSelectedWorkspace(row.workspaceId);setExpanded(s=>new Set(s).add(row.workspaceId));}};
  useEffect(()=>{let live=true;void window.umi.status().then(async()=>{const rows=await list();if(!live)return;setReady(true);const previous=localStorage.getItem('umi.work.activeThread');const first=rows.find(r=>r.id===previous)??rows[0];if(first){setActive(first.id);setSelectedWorkspace(first.workspaceId);setExpanded(new Set([first.workspaceId]));}}).catch(fail);return()=>{live=false;};},[]);
  useEffect(()=>{activeRef.current=active;setTabs([]);setPreviewTab(null);setSnapshot(null);current.current=null;pendingCommand.current=null;setPrompt(drafts.current.get(active)??'');if(!active)return;try{const saved=JSON.parse(localStorage.getItem('umi.pending.'+active)??'null');if(saved&&typeof saved.id==='string'&&typeof saved.text==='string'&&Array.isArray(saved.attachments)){pendingCommand.current=saved;setPrompt(saved.text);}}catch{localStorage.removeItem('umi.pending.'+active);}
    let live=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{try{const full=await window.umi.request({type:'snapshot',conversationId:active}) as Snapshot;if(!live)return;current.current=full;setSnapshot(full);requestAnimationFrame(()=>canvas.current?.scrollTo({top:canvas.current.scrollHeight}));}catch(e){if(live)fail(e);}};
    const poll=async()=>{if(!live)return;try{if(!current.current){await refresh();}else{const batch=await window.umi.request({type:'events',conversationId:active,cursor:current.current.state.cursor}) as Batch;if(!live)return;
      const nearBottom=canvas.current?canvas.current.scrollHeight-canvas.current.scrollTop-canvas.current.clientHeight<120:true;
      const next=applyBatch(current.current!,batch);current.current=next;if(batch.events.length){setSnapshot(next);if(nearBottom)requestAnimationFrame(()=>canvas.current?.scrollTo({top:canvas.current.scrollHeight}));void list().catch(()=>{});}
    }}catch(e){if(live){if(['CURSOR_GAP','CURSOR_INVALID','INSTANCE_STALE'].includes((e as any).code)){current.current=null;}else fail(e);}}finally{if(live)timer=setTimeout(poll,120);}};
    void poll();return()=>{live=false;clearTimeout(timer);};
  },[active]);
  useEffect(()=>{const query=matchMedia('(prefers-color-scheme: dark)'),apply=()=>{document.documentElement.dataset.theme=theme==='system'?(query.matches?'dark':'light'):theme;};apply();query.addEventListener('change',apply);localStorage.setItem('umi.theme',theme);void window.umi.setTheme(theme).then(value=>{document.documentElement.dataset.material=value.material;}).catch(()=>{document.documentElement.dataset.material='solid';});return()=>query.removeEventListener('change',apply);},[theme]);
  useEffect(()=>{if(!previewTab||!active){setPreview(null);return;}let live=true;setPreview(null);void (async()=>{if(previewTab.attachmentId)return window.umi.request({type:'preview_attachment',conversationId:active,attachmentId:previewTab.attachmentId});if(previewTab.changeSetId){const data=await window.umi.request({type:'preview_changeset',conversationId:active,changeSetId:previewTab.changeSetId}) as any;const item=data.preview.changes.find((x:any)=>x.path===previewTab.path);return {text:item?.binary?'二进制文件仅展示变更信息':item?.afterText??item?.beforeText??'',truncated:item?.previewTruncated,deleted:item?.operation==='delete',beforeText:item?.beforeText,afterText:item?.afterText};}return window.umi.request({type:'preview_file',conversationId:active,mountId:previewTab.mountId,path:previewTab.path});})().then(p=>{if(live)setPreview(p);}).catch(e=>{if(live){setPreview({text:'文件预览未能读取。'});fail(e);}});return()=>{live=false;};},[previewTab,active]);
  const workspaces:Workspace[]=[...new Map(entries.map(e=>[e.workspaceId,{workspaceId:e.workspaceId,name:e.workspace.split(/[\\/]/).at(-1)||e.workspace,path:e.workspace,mode:'work' as const,worktreeRoot:null,createdAt:null}])).values()];
  const conversations:Conversation[]=entries.filter(e=>e.hasMessages).map(e=>({id:e.id,workspaceId:e.workspaceId,title:e.title,messages:[],updatedAt:e.updatedAt?Date.parse(e.updatedAt):null}));
  const settings=snapshot?.settings;
  const updateSettings=(patch:Partial<Settings>)=>{const id=active;settingsQueue.current=settingsQueue.current.then(async()=>{if(!current.current||activeRef.current!==id)return;const next=await window.umi.request({type:'settings',conversationId:id,settings:{...current.current.settings,...patch}}) as Settings;
    if(activeRef.current===id&&current.current){current.current={...current.current,settings:next};setSnapshot(current.current);}}).catch(fail);};
  const create=async()=>{if(creatingConversation.current)return;creatingConversation.current=true;try{const choice=await window.umi.chooseWorkspace();if(!choice)return;const c=await window.umi.request({type:'create',selectionId:choice.selectionId}) as {conversationId:string;workspaceId:string};await list();setActive(c.conversationId);localStorage.setItem('umi.work.activeThread',c.conversationId);setSelectedWorkspace(c.workspaceId);setExpanded(s=>new Set(s).add(c.workspaceId));}catch(e){fail(e);}finally{creatingConversation.current=false;}};
  const newConversation=async(workspaceId=selectedWorkspace)=>{const row=entries.find(e=>e.workspaceId===workspaceId);if(!row){await create();return;}if(creatingConversation.current)return;creatingConversation.current=true;try{
    // 复用已选择工作区的证据由核心与主进程完成，不让页面重新指定磁盘目录。
    const c=await window.umi.request({type:'new_conversation',conversationId:row.id}) as {conversationId:string};await list();setActive(c.conversationId);localStorage.setItem('umi.work.activeThread',c.conversationId);setSelectedWorkspace(workspaceId);setExpanded(value=>new Set(value).add(workspaceId));
  }catch(e){fail(e);}finally{creatingConversation.current=false;}};
  const activeRun=snapshot?Object.entries(snapshot.state.runs).find(([,r])=>['queued','running','waiting_permission','stopping','recovering'].includes(r.status)):null;
  const pendingApprovals=snapshot?Object.entries(snapshot.state.approvals).filter(([,approval])=>approval.status==='pending').map(([id])=>id):[];
  const send=async(e:FormEvent)=>{
    e.preventDefault();const conversationId=active;
    if(!conversationId||(!prompt.trim()&&!attachments.length)||attachments.some(a=>a.state!=='done'||!a.serverId||(a.kind==='image'&&settings?.model!=='deepseek-flash')))return;
    const release=submitGate.current.acquire(conversationId);if(!release)return;
    // 冻结这一条请求；回执超时后继续使用同一 commandId，不依据新草稿创建重复任务。
    const sentPrompt=prompt;setSubmitting(conversationId);
    try{
      let p=pendingCommand.current;
      if(!p){
        let text=prompt.trim()?prompt:'请查看附件。',ids=attachments.map(a=>a.serverId!);
        if(asTextDocument(prompt)){
          if(ids.length>=8)throw Error('长消息需要一个附件名额，请先移除一个附件。');
          if(new TextEncoder().encode(prompt).byteLength>1_000_000)throw Error('长消息超过 1 MB，请拆分后发送；原文仍留在输入框。');
          const [document]=await addFiles([new File([prompt],'长消息.txt',{type:'text/plain'})]);
          if(!document?.serverId||document.state!=='done')throw Error('长消息附件未上传成功，原文仍留在输入框。');
          ids=[...ids,document.serverId];text=documentInstruction(document.name);
        }
        p={id:crypto.randomUUID(),text,attachments:ids};pendingCommand.current=p;
      }
      localStorage.setItem('umi.pending.'+conversationId,JSON.stringify(p));await settingsQueue.current;
      const existing=await window.umi.request({type:'receipt',conversationId,commandId:p.id});
      if(!existing)await window.umi.request({type:'send',conversationId,commandId:p.id,text:p.text,attachmentIds:p.attachments});
      localStorage.removeItem('umi.pending.'+conversationId);
      if(drafts.current.get(conversationId)===sentPrompt)drafts.current.delete(conversationId);
      // 首次发送成功后立即把它投影到历史列表，不依赖下一次轮询。
      await list();
      if(activeRef.current===conversationId){pendingCommand.current=null;setPrompt(value=>value===sentPrompt?'':value);consumeAttachments(p.attachments);setError('');}
    }catch(e){fail(e);}finally{release();setSubmitting(current=>current===conversationId?'':current);}
  };
  const onPreview=(target:FileTarget)=>{setTabs(t=>t.some(f=>fileTargetKey(f)===fileTargetKey(target))?t:[...t,target]);setPreviewTab(target);setRight(true);};
  const resize=(e:PointerEvent<HTMLDivElement>)=>{e.preventDefault();const start=e.clientX,original=width,node=e.currentTarget;node.setPointerCapture(e.pointerId);const move=(ev:globalThis.PointerEvent)=>{const w=Math.max(300,Math.min(720,original+start-ev.clientX));setWidth(w);localStorage.setItem('umi.work.rightWidth',String(w));};const end=()=>{node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);};node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);};
  const m=snapshot?.context.latestRequest?.metrics,b=snapshot?.state.runs[activeRun?.[0]??'']?.budgetBlock,usage=snapshot?.context.lastActualUsage;
  const stats:WorkContextStats|null=m?{tokens:snapshot!.context.latestRequest.estimatedInputTokens,budget:snapshot!.context.latestRequest.inputCeiling,context_window:m.contextWindow,output_reserved:m.maxOutputTokens,safety_margin:m.safetyHeadroom,summarized_messages:m.archivedMessages,token_source:'estimated',scope:'latest_request',includes_images:snapshot!.messages.some(message=>message.attachments.some(a=>a.mime.startsWith('image/')))&&settings?.model==='deepseek-flash',images_omitted:snapshot!.messages.some(message=>message.attachments.some(a=>a.mime.startsWith('image/')))&&settings?.model!=='deepseek-flash'}:null;
  const mapMessages=useMemo(()=>projectHistoryPreview(snapshot),[snapshot]);
  return <>
    <main className={`app-shell ${left?'left-expanded':'left-collapsed'} ${right?'right-expanded':'right-collapsed'}`} inert={settingsOpen} aria-hidden={settingsOpen} style={{'--right-open-width':`${width}px`} as CSSProperties}>
      <Sidebar onCollapse={()=>setLeft(false)} workspaces={workspaces} selectedWorkspaceId={selectedWorkspace} onSelectWorkspace={id=>{setSelectedWorkspace(id);if(id!==selectedWorkspace){const c=entries.find(e=>e.workspaceId===id);if(c){setActive(c.id);localStorage.setItem('umi.work.activeThread',c.id);}}}} expandedWorkspaceIds={expanded} onToggleWorkspace={id=>setExpanded(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;})} onCreateWorkspace={()=>void create()} conversations={conversations} activeId={active} onSelectConversation={select} onNewConversation={id=>void newConversation(id)} onRequestDeleteConversation={id=>{setArchiveError('');setDeleteId(id);}} avatar={avatar} username={username} themeMode={theme} onSelectTheme={setTheme} onOpenSettings={()=>setSettingsOpen(true)}/>
      {!left&&<button className="sidebar-toggle rail-toggle left-rail-toggle" aria-label="展开侧边栏" onClick={()=>setLeft(true)}><PanelIcon side="left"/></button>}
      <div className="work-surface"><section className="main-area"><header className="topbar"><div className="conversation-title"><span title={entries.find(entry=>entry.id===active)?.title}>{entries.find(entry=>entry.id===active)?.title??'新对话'}</span></div></header><section className="chat-canvas-wrap"><ConversationMap key={active} messages={mapMessages} canvasRef={canvas}/><section ref={canvas} onScroll={updateBottom} className={`chat-canvas ${snapshot?.messages.length?'has-messages':''}`}>
        {error&&<div className="umi-error" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭提示"><X size={14}/></button></div>}
        {snapshot?.messages.length?<Timeline snapshot={snapshot} onPreview={onPreview} onError={setError}/>:<EmptyConversation ready={ready} workspace={Boolean(active)}/>}
      </section></section>
      <Composer approvalPanel={snapshot&&pendingApprovals.length?<>{pendingApprovals.map(id=><ApprovalCard key={id} id={id} state={snapshot.state} conversationId={active} onPreview={onPreview} onError={setError}/>)}</>:undefined} workspace={active?workspaces.find(w=>w.workspaceId===selectedWorkspace)?.name??'工作区':''} prompt={prompt} onPromptChange={e=>writePrompt(e.target.value)} onDragOver={e=>e.preventDefault()} onDragLeave={()=>{}} onDrop={e=>{e.preventDefault();void addFiles(e.dataTransfer.files);}} onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();void addFiles(e.clipboardData.files);}}} attachments={attachments} onAddFiles={f=>void addFiles(f)} onRemoveAttachment={removeAttachment} onPreviewAttachment={id=>{const a=attachments.find(a=>a.id===id);if(a)onPreview({mountId:'attachment',path:a.name,attachmentId:a.serverId??a.id});}} modelOptions={MODEL_OPTIONS} selectedModel={settings?.model??'deepseek-flash'} onSelectModel={model=>updateSettings({model:model as Settings['model']})} thinking={settings?.thinking??'off'} onSelectThinking={thinking=>updateSettings({thinking})} executionPolicy={settings?.executionPolicy??'ask'} onSelectExecutionPolicy={executionPolicy=>updateSettings({executionPolicy})} contextStats={stats} submitting={submitting===active} streaming={Boolean(activeRun)} onSubmit={send} onStop={()=>{if(activeRun)void window.umi.request({type:'stop',conversationId:active,runId:activeRun[0]}).catch(fail);}} isAtBottom={isAtBottom} onScrollToBottom={()=>canvas.current?.scrollTo({top:canvas.current.scrollHeight,behavior:'smooth'})}/>
      </section><aside className="delivery-panel"><div className="work-preview-resizer" role="separator" aria-label="调整预览宽度" onPointerDown={resize}/><div className="work-preview-tabs">{tabs.map(t=><div className={`work-preview-tab ${Boolean(previewTab&&fileTargetKey(t)===fileTargetKey(previewTab))?'active':''}`} key={fileTargetKey(t)}><button onClick={()=>setPreviewTab(t)}><FileText size={15}/><span>{t.path.split('/').at(-1)}</span></button><button className="work-preview-tab-close" aria-label="关闭文件" onClick={()=>{setTabs(tabs.filter(f=>f!==t));if(Boolean(previewTab&&fileTargetKey(t)===fileTargetKey(previewTab)))setPreviewTab(null);}}><X size={13}/></button></div>)}<button className="work-preview-add" aria-label="工作区首页" onClick={()=>setPreviewTab(null)}><Plus size={18}/></button></div>{previewTab?<div className="work-preview-content"><div className="work-preview-breadcrumb"><strong>{previewTab.path}</strong><button className="work-preview-location" disabled={Boolean(previewTab.attachmentId||preview?.deleted)} onClick={()=>void window.umi.request({type:'open_file',conversationId:active,mountId:previewTab.mountId,path:previewTab.path}).catch(fail)}><FolderOpen size={15}/>打开文件位置</button></div><div className="umi-preview-body">{preview?.dataUrl?<img className="umi-image-preview" src={preview.dataUrl} alt={previewTab.path}/>:<pre className="umi-file-preview">{preview?.text??'正在读取…'}</pre>}</div>{preview?.truncated&&<p>预览仅显示当前字节范围，原文件未截断。</p>}</div>:<div className="work-panel-body"><button className="work-action" onClick={()=>void create()}><FolderOpen size={18}/>新建工作区</button></div>}</aside></div>
      <button className="sidebar-toggle rail-toggle right-rail-toggle" aria-label={right?'收起工作区侧栏':'展开工作区侧栏'} aria-expanded={right} onClick={()=>setRight(!right)}><PanelIcon side="right"/></button>
    </main>
    {deleteId&&<div className="umi-confirm" onKeyDown={e=>{if(e.key==='Escape'&&!archiving)setDeleteId(null);}}><section role="dialog" aria-modal="true" aria-labelledby="archive-title"><h3 id="archive-title">归档这条会话？</h3><p>归档后可在设置中恢复，消息和工作副本会保留。</p>{archiveError&&<p role="alert">{archiveError}</p>}<div className="umi-confirm-actions"><button disabled={archiving} onClick={()=>setDeleteId(null)}>取消</button><HoldButton size="sm" radius={10} glow={false} holdTime={1200} resetAfter={0} disabled={archiving} doneLabel="正在归档" backgroundColor="var(--text-primary)" textColor="var(--bg-primary)" fillColor="var(--text-secondary)" onHold={()=>{setArchiving(true);void window.umi.request({type:'archive',conversationId:deleteId}).then(async()=>{const rows=await list();setDeleteId(null);if(activeRef.current===deleteId)setActive(rows[0]?.id??'');}).catch(e=>{setArchiveError(e.message);setDeleteId(null);fail(e);}).finally(()=>setArchiving(false));}}>长按归档</HoldButton></div></section></div>}
    {settingsOpen&&<SettingsPage avatar={avatar} username={username} onAvatar={setAvatar} onUsername={setUsername} snapshot={snapshot} onSettings={updateSettings} onRestore={()=>{void list().catch(fail);}} onClose={()=>setSettingsOpen(false)}/>}
  </>;
}

