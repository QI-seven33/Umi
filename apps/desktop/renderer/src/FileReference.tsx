import { t as uiText } from './ui-language.js';
import {createContext,useContext,useEffect,useMemo,useState} from 'react';
import type {ReactNode} from 'react';
import type {FileReferenceTarget} from '../../../../packages/protocol/src/file-reference.js';
import {FileLinkClient} from './file-link-client.js';
const Client=createContext<FileLinkClient|null>(null);
const Preview=createContext<((target:FileReferenceTarget)=>void)|null>(null);
export function FileLinksProvider({conversationId,revision,children}:{conversationId:string;revision:string;children:ReactNode}){
 const client=useMemo(()=>new FileLinkClient(references=>window.umi.request({type:'resolve_file_links',conversationId,references})),[conversationId,revision]);
 return <Client.Provider value={client}>{children}</Client.Provider>;
}
export function FileLinkView({onPreview,children}:{onPreview:(target:FileReferenceTarget)=>void;children:ReactNode}){
 return <Preview.Provider value={onPreview}>{children}</Preview.Provider>;
}
function Reference({value,code,children}:{value:string;code?:boolean;children:ReactNode}){
 const client=useContext(Client),onPreview=useContext(Preview);
 const [resolved,setResolved]=useState<{client:FileLinkClient;value:string;target:FileReferenceTarget|null}|null>(null);
 useEffect(()=>{let live=true;if(client)void client.resolve(value).then(target=>{if(live)setResolved({client,value,target});});return ()=>{live=false;};},[client,value]);
 const target=resolved?.client===client&&resolved.value===value?resolved.target:null;
 if(target&&onPreview)return <button type="button" className={(code?'inline-code ':'')+'inline-file-link'} title={target.path} aria-label={uiText("预览文件：")+target.path} onClick={()=>onPreview(target)}>{children}</button>;
 return code?<code className="inline-code">{children}</code>:<span>{children}</span>;
}
// 组件身份稳定，避免每个流式片段都把已核验的按钮卸载/重新请求。
export function ChatFileAnchor({href,children}:{href?:string|undefined;children?:ReactNode}){
 if(href&&/^https?:\/\//i.test(href))return <a href={href} onClick={e=>{e.preventDefault();void window.umi.openUrl(href);}}>{children}</a>;
 return href?<Reference value={href}>{children}</Reference>:<span>{children}</span>;
}
export function ChatFileCode({children}:{children?:ReactNode}){return <Reference value={String(children)} code>{children}</Reference>;}
