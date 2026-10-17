import {reduceConversation,projectConversation} from '../../../../packages/protocol/src/reducer.js';
import type {ConversationState} from '../../../../packages/protocol/src/reducer.js';
import {eventSchema} from '../../../../packages/protocol/src/events.js';
import type {DesktopBridge} from '../../../../packages/protocol/src/desktop.js';
import type {Settings} from '../../../../packages/protocol/src/model.js';
import type {MessageRow} from '../../../../packages/agent/src/persistence.js';

declare global {interface Window {umi:DesktopBridge;}}
export type UserRow=MessageRow&{attachments:{id:string;name:string;mime:string;byteLength:number}[]};
export type Snapshot={state:ConversationState;messages:UserRow[];settings:Settings;context:any;resources:any};
export type Batch={events:unknown[];messages:UserRow[];hasMore?:boolean;settings?:Settings;context?:any;resources?:any};
export function applyBatch(snapshot:Snapshot,batch:Batch):Snapshot{
  if (!batch.events.length && !batch.messages.length && batch.settings === undefined && batch.context === undefined && batch.resources === undefined) return snapshot;
  const events=batch.events.map(raw=>eventSchema.parse(raw));
  let state=snapshot.state;for(const event of events)state=reduceConversation(state,event);
  const messages=new Map(snapshot.messages.map(m=>[m.id,m]));for(const m of batch.messages)messages.set(m.id,m);
  for(const e of events){if(e.type==='input.applied'){const m=messages.get(e.payload.messageId);if(m)messages.set(m.id,{...m,applied:true});}}
  return {...snapshot,state,messages:batch.messages.length||events.some(e=>e.type==='input.applied')?[...messages.values()]:snapshot.messages,settings:batch.settings??snapshot.settings,context:batch.context??snapshot.context,resources:batch.resources??snapshot.resources};
}
export {projectConversation};
