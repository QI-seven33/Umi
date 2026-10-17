import { z } from 'zod';
import { id } from './model.js';

export const questionsSchema = z.array(z.object({
  id,
  prompt: z.string().trim().min(1).max(1600),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(160),
    description: z.string().max(500).default(''),
  }).strict()).min(2).max(6),
}).strict()).min(1).max(3).refine(items => new Set(items.map(q => q.id)).size === items.length, '问题身份重复');

export const answersSchema = z.array(z.object({
  questionId: id,
  optionIndex: z.number().int().min(0).max(5).nullable(),
  text: z.string().trim().max(8000),
}).strict()).min(1).max(3);
export type Questions = z.infer<typeof questionsSchema>;
export type Answers = z.infer<typeof answersSchema>;
export type QuestionRequest = {
  callId: string;
  runId: string;
  questions: Questions;
  status: 'pending' | 'answered' | 'cancelled';
  answers?: Answers;
};
