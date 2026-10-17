import type {
  Block,
  ConversationState,
} from '../../../../packages/protocol/src/reducer.js';

export const toolNames: Record<string, string> = {
  ask_user_question: '询问用户',
  open_delivered_file: '打开交付文件',
  list_resources: '查看工作副本',
  list_user_requirements: '查看用户要求',
  record_task_checkpoint: '记录任务进度',
  set_task_state: '调整任务状态',
  read_task_checkpoints: '读取任务进度',
  inspect_tool_execution: '核验原操作',
  delete_file: '删除副本文件',
  inspect_execution: '检查执行准备',
  create_output: '生成成果',
  capture_output: '收集成果',
  list_outputs: '查看成果',
  read_output: '读取成果',
  export_outputs: '导出成果',
  inspect_export: '核验导出',
  discover_resource: '查找资源',
  request_resource: '申请资源访问',
  read_file: '读取文件',
  write_file: '修改文件',
  edit_file: '编辑文件',
  list_files: '查看目录',
  search_text: '搜索内容',
  stat_file: '检查文件',
  build_changeset: '准备交付',
  create_changeset: '准备交付',
  deliver_changeset: '交付文件',
  recycle_file: '移入系统回收站',
  run_command: '运行命令',
  run_shell: '运行脚本',
  read_process_output: '读取命令输出',
  search_history: '查找历史',
  read_history: '读取历史',
  write_scratch: '写入任务资料',
  read_attachment: '读取附件',
  deepseek_server_web_search: '搜索网页',
  record_work_note: '记录任务笔记',
  record_requirement: '记录要求',
  request_context_reset: '维护上下文',
  read_work_memory: '读取任务记录',
  read_artifact: '读取任务资料',
  get_execution_plugins: '查看执行插件',
};
export type ActivityItem =
  | { kind: 'reasoning'; block: Block; sequence: string }
  | { kind: 'tool'; id: string; sequence: string };
export type ProcessItem =
  | { kind: 'activity'; id: string; items: ActivityItem[] }
  | { kind: 'text'; block: Block };

// 仅派生展示分段：正文形成自然进展边界，思考和工具仍保留原 turn / attempt 身份。
export function processItems(
  state: ConversationState,
  runId: string,
  from = '0',
  to: string | null = null,
): ProcessItem[] {
  const within = (sequence: string) =>
    BigInt(sequence) > BigInt(from) && (to === null || BigInt(sequence) < BigInt(to));
  const events: ({ kind: 'text'; block: Block; sequence: string } | ActivityItem)[] = [
    ...state.blocks
      .filter(
        (b) =>
          b.runId === runId &&
          within(b.sequence) &&
          b.kind !== 'tool' &&
          !(b.kind === 'text' && b.displayRole === 'final'),
      )
      .map((b) =>
        b.kind === 'reasoning'
          ? { kind: 'reasoning' as const, block: b, sequence: b.sequence }
          : { kind: 'text' as const, block: b, sequence: b.sequence },
      ),
    ...Object.entries(state.tools)
      .filter(([, t]) => t.runId === runId && within(t.sequence))
      .map(([id, t]) => ({ kind: 'tool' as const, id, sequence: t.sequence })),
  ];
  events.sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence)
      ? -1
      : BigInt(a.sequence) > BigInt(b.sequence)
        ? 1
        : 0,
  );
  const result: ProcessItem[] = [];
  for (const item of events) {
    if (item.kind === 'text') {
      result.push({ kind: 'text', block: item.block });
      continue;
    }
    const previous = result.at(-1);
    if (previous?.kind === 'activity') previous.items.push(item);
    else
      result.push({
        kind: 'activity',
        id: item.kind === 'reasoning' ? item.block.id : item.id,
        items: [item],
      });
  }
  return result;
}
const verbs: Record<string, string> = {
  ask_user_question: '询问用户',
  open_delivered_file: '打开交付文件',
  list_resources: '查看工作副本',
  list_user_requirements: '查看用户要求',
  record_task_checkpoint: '记录任务进度',
  set_task_state: '调整任务状态',
  read_task_checkpoints: '读取任务进度',
  inspect_tool_execution: '核验原操作',
  delete_file: '删除副本文件',
  inspect_execution: '检查执行准备',
  create_output: '生成成果',
  capture_output: '收集成果',
  list_outputs: '查看成果',
  read_output: '读取成果',
  export_outputs: '导出成果',
  inspect_export: '核验导出',
  read_file: '读取文件',
  read_attachment: '读取附件',
  read_history: '读取历史',
  read_work_memory: '读取任务记录',
  read_artifact: '读取资料',
  list_files: '查看目录',
  search_text: '搜索内容',
  discover_resource: '查找资源',
  request_resource: '申请资源访问',
  run_command: '运行命令',
  run_shell: '运行脚本',
  read_process_output: '读取命令输出',
  write_file: '修改文件',
  edit_file: '编辑文件',
  write_scratch: '写入资料',
  build_changeset: '准备交付',
  deliver_changeset: '交付文件',
  recycle_file: '移入回收站',
  deepseek_server_web_search: '搜索网页',
};
export function activityLabel(items: ActivityItem[], state: ConversationState) {
  const tools = items.filter((i) => i.kind === 'tool').map((i) => state.tools[i.id]!);
  if (Object.values(state.questions ?? {}).some(question => question.status === 'pending' && tools.some(tool => tool.executionId === state.tools[question.callId]?.executionId))) return '等待你的回答';
  const ids = new Set(items.filter((i) => i.kind === 'tool').map((i) => i.id));
  if (
    Object.values(state.approvals).some(
      (a) => ids.has(a.callId) && a.status === 'pending',
    )
  )
    return '等待你的批准';
  const active = tools.find((t) => t.status === 'running' || t.status === 'prepared');
  if (active) return `正在${verbs[active.name] ?? '使用工具'}`;
  if (
    items.some(
      (i) =>
        i.kind === 'reasoning' &&
        i.block.status === 'running' &&
        state.runs[i.block.runId]?.status === 'running',
    )
  )
    return '正在思考';
  const labels = [
    ...new Set(
      tools
        .filter((t) => t.status === 'succeeded')
        .map((t) => `已${verbs[t.name] ?? '调用工具'}`),
    ),
  ];
  // 已知失败/拒绝/取消已经结算；只有 unknown 需要核验实际效果。
  const outcomes = [
    ['unknown', '结果待核验'], ['failed', '操作失败'], ['denied', '操作已拒绝'], ['cancelled', '操作已取消'],
  ] as const;
  const exceptions = outcomes.filter(([status]) => tools.some(t => t.status === status)).map(([, label]) => label);
  labels.unshift(...exceptions);
  if (!labels.length)
    return items.some((i) => i.kind === 'reasoning' && i.block.status === 'interrupted')
      ? '思考已中断'
      : '思考过程';
  return labels.slice(0, 3).join('，') + (labels.length > 3 ? '等' : '');
}
export function clockTime(value?: string) {
  return value
    ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
}
export function elapsedTime(start?: string, end?: string) {
  if (!start || !end) return '';
  const seconds = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
      : `${seconds}秒`;
}
