import type { SqliteStore } from './store.js';
import type { Mount, Candidate, Manifest } from '../../../protocol/src/resources.js';
import { mountSchema } from '../../../protocol/src/resources.js';
import { UmiError } from '../../../protocol/src/model.js';
import { uid, hash } from '../../../agent/src/identity.js';
import type { ResourceScope } from '../../../protocol/src/resource-scope.js';

// 持久化授权事实，不访问宿主文件，不由模型参数决定权限。
export class DirectFileRepository {
  constructor(readonly store: SqliteStore) {}
  workspace(environmentId: string) { return String(this.store.get('SELECT workspace_id FROM conversations WHERE environment_id=?',environmentId)!.workspace_id); }
  conversation(environmentId: string) { return String(this.store.get('SELECT id FROM conversations WHERE environment_id=?',environmentId)!.id); }
  enabled(environmentId: string) { return Boolean(this.store.get('SELECT 1 FROM direct_file_environments WHERE environment_id=?',environmentId)); }
  enable(environmentId: string) { this.store.run('INSERT OR IGNORE INTO direct_file_environments VALUES(?,?)',environmentId,this.workspace(environmentId)); }
  grants(environmentId: string) { return this.store.all('SELECT * FROM workspace_file_grants WHERE workspace_id=? ORDER BY rowid',this.workspace(environmentId)); }
  grant(id: string,environmentId: string) {
    const row=this.store.get('SELECT * FROM workspace_file_grants WHERE id=? AND workspace_id=?',id,this.workspace(environmentId));
    if(!row) throw new UmiError('PERMISSION_DENIED','目录授权不属于当前工作区');
    return row;
  }
  createGrant(environmentId: string,root: string,identity: string,scope: ResourceScope,access:'read'|'edit',authority:string) {
    const old=this.grants(environmentId).find(g=>g.root===root && g.root_identity===identity && g.scope===JSON.stringify(scope) && g.access===access && g.revoked===0);
    if(old) return String(old.id);
    const id=uid();
    this.store.run('INSERT INTO workspace_file_grants VALUES(?,?,?,?,?,?,?,1,0,?)',id,this.workspace(environmentId),root,identity,JSON.stringify(scope),access,authority,new Date().toISOString());
    this.changed(environmentId,id); return id;
  }
  changed(environmentId:string,grantId:string) {
    const grant=this.grant(grantId,environmentId);
    // 所有同工作区会话接收事实更新；旧事件与批准不被改写。
    for(const c of this.store.all('SELECT id,environment_id FROM conversations WHERE workspace_id=?',this.workspace(environmentId))) {
      this.store.run('UPDATE environments SET revision=revision+1 WHERE id=?',c.environment_id!);
      this.store.append({conversationId:String(c.id)}, {type:'workspace.access_changed',payload:{grantId,revision:Number(grant.revision),revoked:grant.revoked===1}});
    }
  }
  revoke(environmentId:string,id:string) {
    const g=this.grant(id,environmentId); if(g.revoked===1) return;
    this.store.transaction(()=>{this.store.run('UPDATE workspace_file_grants SET revoked=1,revision=revision+1 WHERE id=?',id);this.changed(environmentId,id);});
  }
  attach(c:Candidate,grantId:string):Mount {
    const g=this.grant(grantId,c.environmentId);
    const prior=this.store.get('SELECT id FROM direct_file_mounts WHERE environment_id=? AND grant_id=?',c.environmentId,grantId);
    if(prior) return this.mount(String(prior.id),c.environmentId)!;
    const id=uid();
    this.store.transaction(()=>{
      const baseline=this.store.artifact({},'direct-file-baseline');
      this.store.run('INSERT INTO direct_file_mounts VALUES(?,?,?,?,?)',id,c.environmentId,c.id,grantId,baseline);
      this.store.append({conversationId:this.conversation(c.environmentId)},{type:'resource.direct_bound',payload:{mountId:id,resourceId:c.id,grantId,access:g.access as 'read'|'edit'}});
    });
    return this.mount(id,c.environmentId)!;
  }
  mount(id:string,environmentId:string):Mount|undefined {
    const row=this.store.get('SELECT m.*,g.root,g.root_identity,g.scope,g.revision,g.revoked,g.access FROM direct_file_mounts m JOIN workspace_file_grants g ON g.id=m.grant_id WHERE m.id=? AND m.environment_id=?',id,environmentId);
    return row?mountSchema.parse({id:row.id,environmentId,resourceId:row.resource_id,root:row.root,rootIdentity:row.root_identity,bindingVersion:1,
      baselineRef:row.baseline_ref,scope:JSON.parse(String(row.scope)),sourceRoot:row.root,sourceIdentity:row.root_identity,direct:{grantId:row.grant_id,revision:row.revision}}):undefined;
  }
  mounts(environmentId:string) { return this.store.all('SELECT id FROM direct_file_mounts WHERE environment_id=? ORDER BY rowid',environmentId).map(r=>this.mount(String(r.id),environmentId)!); }
  authorized(resourceId:string,environmentId:string,edit=false) {
    return Boolean(this.store.get(`SELECT 1 FROM direct_file_mounts m JOIN workspace_file_grants g ON g.id=m.grant_id WHERE m.resource_id=? AND m.environment_id=? AND g.revoked=0 AND (g.access='edit' OR ?=0)`,resourceId,environmentId,edit?1:0));
  }
  assert(m:Mount,edit=false) {
    if(!m.direct) return;
    const g=this.grant(m.direct.grantId,m.environmentId);
    if(g.revoked===1)throw new UmiError('ACCESS_REVOKED','目录授权已撤销；请通过工作区授权入口处理');
    if(Number(g.revision)!==m.direct.revision)throw new UmiError('APPROVAL_STALE','目录授权修订已变化，请重新取得当前绑定');
    if(edit&&g.access!=='edit')throw new UmiError('PERMISSION_DENIED','此授权只读，不允许修改；需要单独申请编辑权限');
  }
  content(bytes:Buffer|null) {
    if(bytes===null) return null;
    const value={base64:bytes.toString('base64')},digest=hash(JSON.stringify(value));
    const old=this.store.get(`SELECT id FROM artifacts WHERE kind='file-content' AND hash=?`,digest);
    return old?String(old.id):this.store.artifact(value,'file-content');
  }
  bytes(ref:string|null) { return ref===null?null:Buffer.from(this.store.readArtifact<{base64:string}>(ref).base64,'base64'); }
  change(id:string,conversationId:string) {
    const c=this.store.get('SELECT * FROM file_changes WHERE id=? AND conversation_id=?',id,conversationId);
    if(!c) throw new UmiError('PERMISSION_DENIED','修改记录不属于当前会话'); return c;
  }
  changes(conversationId:string,beforeChangeId?:string) { return this.store.all('SELECT id,mount_id mountId,path,state,desired_hash desiredHash,restores_id restoresId,created_at createdAt FROM file_changes WHERE conversation_id=?'+(beforeChangeId?' AND rowid<(SELECT rowid FROM file_changes WHERE id=? AND conversation_id=?)':'')+' ORDER BY rowid DESC LIMIT 100',conversationId,...(beforeChangeId?[beforeChangeId,conversationId]:[])); }
  history(environmentId:string) {
    return this.store.all("SELECT f.*,CAST(f.rowid AS TEXT) ordinal,g.root,g.root_identity,t.run_id FROM file_changes f LEFT JOIN tool_executions t ON t.id=f.execution_id JOIN direct_file_mounts m ON m.id=f.mount_id JOIN workspace_file_grants g ON g.id=m.grant_id WHERE g.workspace_id=? AND f.state='settled' ORDER BY f.rowid DESC",this.workspace(environmentId));
  }
  intent(m:Mount,path:string,before:Manifest[string]|null,bytes:Buffer|null,desired:Buffer|null,executionId?:string,restoresId?:string) {
    this.assert(m,true);
    const id=executionId??uid(),conversationId=this.conversation(m.environmentId);
    const old=this.store.get('SELECT id FROM file_changes WHERE id=?',id); if(old) throw new UmiError('TOOL_OUTCOME_UNKNOWN','原修改已有持久意图，必须核验，不能再次执行');
    this.store.transaction(()=>{
      this.store.run(`INSERT INTO file_changes VALUES(?,?,?,?,?,?,?,?,?,?,?,'intent',?,?)`,id,conversationId,m.environmentId,m.id,executionId??null,path,this.content(bytes),this.content(desired),JSON.stringify(before),null,desired===null?null:hashBytes(desired),restoresId??null,new Date().toISOString());
      this.store.append({conversationId},{type:'file.change_recorded',payload:{changeId:id,state:'intent'}});
    }); return id;
  }
  settle(id:string,environmentId:string,after:Manifest[string]|null,state:'settled'|'not_applied'='settled') {
    this.store.transaction(()=>{
      this.store.run('UPDATE file_changes SET state=?,after_entry=? WHERE id=?',state,JSON.stringify(after),id);
      this.store.append({conversationId:this.conversation(environmentId)},{type:'file.change_recorded',payload:{changeId:id,state}});
    });
  }
}
import {createHash} from 'node:crypto';
function hashBytes(bytes:Buffer) {return createHash('sha256').update(bytes).digest('hex');}
