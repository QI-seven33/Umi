import {reduceConversation,projectConversation} from '../../../../packages/protocol/src/reducer.js';
import type {ConversationState} from '../../../../packages/protocol/src/reducer.js';
import {eventSchema} from '../../../../packages/protocol/src/events.js';
import type {DesktopBridge} from '../../../../packages/protocol/src/desktop.js';
import type {Settings} from '../../../../packages/protocol/src/model.js';
import type {MessageRow} from '../../../../packages/agent/src/persistence.js';

declare global {interface Window {umi:DesktopBridge;}}
export type UserRow=MessageRow&{attachments:{id:string;name:string;mime:string;byteLength:number}[]};
export type Snapshot={state:ConversationState;messages:UserRow[];settings:Settings;context:any;resources:any};
export type Batch={events:unknown[];messages:UserRow[];settings?:Settings;context?:any;resources?:any};
export function applyBatch(snapshot:Snapshot,batch:Batch):Snapshot{
  let state=snapshot.state;for(const raw of batch.events)state=reduceConversation(state,eventSchema.parse(raw));
  const messages=new Map(snapshot.messages.map(m=>[m.id,m]));for(const m of batch.messages)messages.set(m.id,m);
  for(const raw of batch.events){const e=eventSchema.parse(raw);if(e.type==='input.applied'){const m=messages.get(e.payload.messageId);if(m)messages.set(m.id,{...m,applied:true});}}
  return {...snapshot,state,messages:[...messages.values()],settings:batch.settings??snapshot.settings,context:batch.context??snapshot.context,resources:batch.resources??snapshot.resources};
}
export {projectConversation};
