type ResourceFailure={resourceId:string;path?:string;code:string;reason:string;failure?:{stage:string;effects:string}};
export type RecoveryInspection={budget:{canResume:boolean;reason?:string};tools:{name:string;state:string;result?:{content:string}}[];materializations:{resourceFailures?:ResourceFailure[]}};
// 只展示核心返回的检查事实；只读检查不执行 reconcile 或再次复制。
export function recoverySummary(inspection:RecoveryInspection):string[] {
  const lines=['本次检查只读取恢复记录，没有执行或重新复制。'];
  for(const f of inspection.materializations.resourceFailures??[])lines.push(resourceFailureLabel(f));
  const unresolved=inspection.tools.filter(t=>['unknown','dispatched'].includes(t.state));
  lines.push(unresolved.length?`有 ${unresolved.length} 项原操作待核验；新消息先交模型判断，需要时只检查原执行，不重跑。`:'没有待核验的原工具；可直接发消息提出当前要求。');
  if(inspection.budget.reason)lines.push(inspection.budget.reason);
  return lines;
}
export function resourceFailureLabel(f:ResourceFailure):string {
  const stage=f.failure?.stage==='scan'?'扫描前/扫描阶段':f.failure?.stage==='copy'?'复制阶段':f.failure?.stage==='reconcile'?'恢复核验':'物化';
  const effects=f.failure?.effects==='not-started'?'尚未开始复制':'原副本保留，不自动重复制';
  return `${f.path??'资源'}：${stage}失败（${f.code}），${f.reason}；${effects}。`;
}
