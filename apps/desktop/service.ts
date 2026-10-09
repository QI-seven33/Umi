import {realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import type {UmiApplication} from '../headless/src/application.js';
import type {DesktopCommand} from '../../packages/protocol/src/desktop.js';
import {UmiError} from '../../packages/protocol/src/model.js';
import {safeRoot,safeFile} from '../../packages/adapters/src/host-files/paths.js';

// 传输只调已有应用入口；不创建第二套循环，也不在主进程保存第二份业务状态。
export class DesktopService {
  constructor(readonly app:UmiApplication){}
  snapshot(id:string){return {state:this.app.store.snapshot(id),messages:this.app.store.messages(id).filter(m=>m.role==='user').map(m=>({
    ...m,
    // UI 按接收事实定位；模型上下文另按 input.applied 排列，不能混用两种时序。
    projectionSequence:this.app.store.messageById(id,m.id)!.projectionSequence,
    attachments:this.app.store.messageAttachments(id,m.id)})),settings:this.app.store.settings(id),context:this.app.contextStatistics(id),resources:this.app.store.runtimeFacts(this.app.store.conversation(id).environment_id as string)};}
  async handle(command:DesktopCommand|{type:'create_internal';workspace:string}){
    const a=this.app,s=a.store,c=command;
    if(c.type==='create_internal')return a.createConversation(c.workspace);
    if(c.type==='list')return s.listConversations(c.archived);
    if(c.type==='create')throw new UmiError('PERMISSION_DENIED','目录选择证据只能由桌面主进程解析');
    switch(c.type){
      case 'new_conversation':{const conv=s.conversation(c.conversationId),w=s.get('SELECT source_root FROM workspaces WHERE id=?',conv.workspace_id as string)!;
        const original=s.get('SELECT identity FROM resource_candidates WHERE environment_id=? AND initial=1',conv.environment_id as string);safeRoot(w.source_root as string,original?.identity as string|undefined);
        const draft=s.emptyConversation(conv.workspace_id as string);
        return draft?{conversationId:String(draft.id),workspaceId:String(draft.workspaceId),environmentId:String(draft.environmentId)}:a.createConversation(w.source_root as string,s.settings(c.conversationId));}
      case 'tool_detail':{const t=Object.values(s.snapshot(c.conversationId).tools).find(t=>t.executionId&&s.tool(t.executionId).call_id===c.callId);if(!t)throw new UmiError('PERMISSION_DENIED','工具不属于当前会话');const row=s.tool(t.executionId),result=row.result_ref?s.readArtifact<{outcome:string;content:string}>(row.result_ref):null;return {arguments:JSON.parse(row.args),result:result?{outcome:result.outcome,content:result.content.slice(0,16000),truncated:result.content.length>16000}:null};}
      case 'snapshot':return this.snapshot(c.conversationId);
      case 'events':{
        // pull + cursor 是有界订阅；客户端消费后才请求下一批，没有无限推送缓冲。
        const events=s.events(c.conversationId,c.cursor,128);let size=0,limit=events.length;
        for(let i=0;i<events.length;i++){size+=Buffer.byteLength(JSON.stringify(events[i]));if(size>512000&&i>0){limit=i;break;}}
        const batch=events.slice(0,limit),ids=batch.flatMap(e=>e.type==='input.accepted'?[e.payload.messageId]:[]);
        return {events:batch,messages:ids.map(id=>s.messageById(c.conversationId,id)).filter(m=>m!==undefined).map(m=>({...m,attachments:s.messageAttachments(c.conversationId,m.id)})),
          ...(batch.some(e=>e.type.startsWith('resource.'))?{resources:s.runtimeFacts(s.conversation(c.conversationId).environment_id as string)}:{}),
          ...(batch.some(e=>e.type==='settings.changed')?{settings:s.settings(c.conversationId)}:{}),
          ...(batch.some(e=>e.type==='usage.recorded'||e.type.startsWith('context.'))?{context:a.contextStatistics(c.conversationId)}:{})};
      }
      case 'send':return a.send(c.conversationId,c.commandId,c.text,c.attachmentIds);
      case 'receipt':{s.conversation(c.conversationId);const row=s.get('SELECT receipt FROM commands WHERE conversation_id=? AND id=?',c.conversationId,c.commandId);return row?JSON.parse(row.receipt as string):null;}
      case 'settings':s.updateSettings(c.conversationId,c.settings);return s.settings(c.conversationId);
      case 'approve':a.approve(c.conversationId,c.approvalId,c.decision);return {accepted:true};
      case 'stop':await a.stop(c.conversationId,c.runId);return s.getRun(c.runId);
      case 'resume':a.resume(c.conversationId,c.runId);return {accepted:true};
      case 'recovery':return a.inspectRecovery(c.conversationId,c.runId);
      case 'rename':s.editConversation(c.conversationId,c.title);return {accepted:true};
      case 'restore':s.editConversation(c.conversationId,null,false);return {accepted:true};
      case 'approval_detail':{const approval=s.snapshot(c.conversationId).approvals[c.approvalId];if(!approval)throw new UmiError('PERMISSION_DENIED','批准不属于当前会话');const row=s.tool(s.approval(c.approvalId).execution_id);if(row.name!=='deliver_changeset')return {kind:'operation',description:approval.description};const args=JSON.parse(row.args) as {changeSetId:string};return {kind:'delivery',...a.previewChangeSet(c.conversationId,args.changeSetId)};}
      case 'archive':s.editConversation(c.conversationId,null,true);return {accepted:true};
      case 'preview_file':return a.previewFile(c.conversationId,c.mountId,c.path,c.startByte,c.byteLength);
      case 'open_file':{
        const env=s.environment(s.conversation(c.conversationId).environment_id as string),m=a.files.repo.mount(c.mountId,env.id);
        // read 完成能力、根身份、链接和路径核验；仅返回主进程内部使用的已绑定路径。
        a.files.read(m,c.path,0,1);const path=realpathSync(safeFile(m.root,c.path,m.rootIdentity));if(!statSync(path).isFile())throw new UmiError('PERMISSION_DENIED','只能打开已核验的副本文件位置');return {path};
      }
      case 'preview_changeset':return a.previewChangeSet(c.conversationId,c.changeSetId);
      case 'upload_image':return s.uploadImage(c.conversationId,c.name,c.base64);
      case 'preview_attachment':return s.previewAttachment(c.conversationId,c.attachmentId);
      case 'upload_attachment':return s.uploadAttachment(c.conversationId,c.name,c.mime,c.text);
      case 'read_attachment':return s.readAttachment(c.conversationId,c.attachmentId,c.startByte,c.byteLength);
    }
  }
}
