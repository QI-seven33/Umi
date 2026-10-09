import { createHash, randomUUID } from 'node:crypto';
export const uid=()=>randomUUID();
export function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
