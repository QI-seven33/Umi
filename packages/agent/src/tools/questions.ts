import { setTimeout as delay } from 'node:timers/promises';
import { answersSchema, questionsSchema } from '../../../protocol/src/question.js';
import type { Answers, Questions } from '../../../protocol/src/question.js';
import type { Environment, PersistencePort, ToolResult } from '../persistence.js';
import { UmiError } from '../../../protocol/src/model.js';
import type { ExecutionContext } from '../../../protocol/src/model.js';
import type { ToolRegistry } from './registry.js';
import { hash } from '../identity.js';
import { z } from 'zod';

type QuestionStore = Pick<PersistencePort, 'tool' | 'questionRequest' | 'getRun' | 'checkLease' | 'commit' | 'preparedToolScope' | 'messages'>;
// 等待用户属于当前工具，不另开 Agent 循环，也不把回答转换为批准。
export class UserQuestions {
  constructor(private readonly store: QuestionStore) {}

  private current(conversationId: string, executionId: string) {
    const tool = this.store.tool(executionId);
    const run = this.store.getRun(tool.run_id);
    if (run.conversation_id !== conversationId || tool.name !== 'ask_user_question')
      throw new UmiError('PERMISSION_DENIED', '问题不属于当前会话');
    return { tool, run, request: this.store.questionRequest(conversationId, executionId) };
  }

  answer(conversationId: string, executionId: string, input: Answers) {
    const { tool, run, request } = this.current(conversationId, executionId);
    if (!request) throw new UmiError('QUESTION_STALE', '问题已经失效');
    const parsed = answersSchema.parse(input);
    if (parsed.length !== request.questions.length || new Set(parsed.map(a => a.questionId)).size !== parsed.length)
      throw new UmiError('QUESTION_INVALID', '请回答每个问题');
    const answers = request.questions.map(question => {
      const answer = parsed.find(a => a.questionId === question.id);
      if (!answer) throw new UmiError('QUESTION_INVALID', '缺少问题回答');
      if (answer.optionIndex === null) {
        if (!answer.text) throw new UmiError('QUESTION_INVALID', '自定义回答不能为空');
        return answer;
      }
      const option = question.options[answer.optionIndex];
      if (!option) throw new UmiError('QUESTION_INVALID', '选择不在原问题范围内');
      return { ...answer, text: option.label };
    });
    if (request.status === 'answered' && hash(request.answers) === hash(answers)) return { accepted: true };
    if (request.status !== 'pending' || tool.state !== 'dispatched' || run.status !== 'running' || run.stop_requested ||
      this.store.messages(conversationId).some(m => m.runId === run.id && !m.applied))
      throw new UmiError('QUESTION_STALE', '任务已停止或要求已更新，此问题不再接收回答');
    this.store.checkLease(run.id, run.generation);
    this.store.commit(this.store.preparedToolScope(tool), {
      type: 'question.answered', payload: { questionId: executionId, answers },
    });
    return { accepted: true };
  }

  inspect(conversationId: string, executionId: string): ToolResult {
    const { request } = this.current(conversationId, executionId);
    return request?.status === 'answered'
      ? { outcome: 'succeeded', content: '', data: { questions: request.questions, answers: request.answers, authority: '本次用户回答；不构成任何权限批准' }, mutated: false }
      : { outcome: 'cancelled', content: '原问题未获得回答，未重问；按最新要求判断。', data: null, mutated: false };
  }

  async ask(conversationId: string, executionId: string, questions: Questions, signal: AbortSignal) {
    signal.throwIfAborted();
    const { tool, run, request } = this.current(conversationId, executionId);
    if (!request) {
      this.store.checkLease(run.id, run.generation);
      this.store.commit(this.store.preparedToolScope(tool), {
        type: 'question.requested', payload: { questionId: executionId, questions },
      });
    }
    while (true) {
      signal.throwIfAborted();
      this.store.checkLease(run.id, run.generation);
      const latest = this.store.questionRequest(conversationId, executionId);
      if (latest?.status === 'answered') return this.inspect(conversationId, executionId);
      if (latest?.status !== 'pending') throw new UmiError('QUESTION_STALE', '问题已取消');
      await delay(40, undefined, { signal });
    }
  }
}

export function registerQuestions(registry: ToolRegistry, questions: UserQuestions,
  prepare: (args: unknown, env: Environment) => ExecutionContext) {
  registry.register({
    name: 'ask_user_question',
    description: '遇到影响任务结果且无法合理确定的问题时，请用户选择。每次1–3问，各2–6个选项，并支持自定义回答。等待真实回答再继续；不要用它索取执行批准或询问能自行查证的事实。',
    schema: z.object({ questions: questionsSchema }).strict(),
    effect: 'read',
    prepare: (args, env, executionId) => ({ ...prepare(args, env), interactionExecutionId: executionId! }),
    executionTimeoutMs: () => null,
    execute: (args, context, conversationId, signal) => questions.ask(conversationId, context.interactionExecutionId!, (args as { questions: Questions }).questions, signal),
    inspect: (_args, _context, conversationId, _signal, executionId) => Promise.resolve(questions.inspect(conversationId, executionId)),
    reconcile: (_args, context, conversationId) => Promise.resolve(questions.inspect(conversationId, context.interactionExecutionId!)),
  });
}
