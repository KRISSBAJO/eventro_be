/**
 * Questions at checkout ("T-shirt size", "Dietary needs", "Attendee name"). The organizer keeps up to 8 on an event
 * (Event.questions); each is free text or a choice, optional or required, asked once per order or once per ticket.
 * The buyer's answers are checked when the order is made and stored on it (Order.answers), so the organizer sees them
 * with the attendees and in the CSV.
 */
import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export const MAX_QUESTIONS = 8;
export const MAX_OPTIONS = 12;
export const ANSWER_MAX = 200;
export const QUESTION_TYPES = ['TEXT', 'CHOICE'] as const;
export const QUESTION_SCOPES = ['ORDER', 'TICKET'] as const;

export type Question = { id: string; label: string; type: (typeof QUESTION_TYPES)[number]; options: string[]; required: boolean; per: (typeof QUESTION_SCOPES)[number] };
export type QuestionInput = { id?: string; label: string; type?: string; options?: string[]; required?: boolean; per?: string };
export type AnswerInput = { questionId: string; value: string; ticket?: number };
export type Answer = { id: string; label: string; value: string };
/** What an order keeps: answers asked once, and answers per ticket (by the ticket's number within the order). */
export type OrderAnswers = { order: Answer[]; tickets: Answer[][] };

/** The event's questions as stored (a missing or odd value reads as none). */
export function questionsOf(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is Question => !!q && typeof q === 'object' && typeof (q as Question).id === 'string' && typeof (q as Question).label === 'string');
}

/** The organizer's list, tidied: a question keeps its id when it's edited, so earlier answers still line up. */
export function cleanQuestions(input: QuestionInput[] | null | undefined, existing: Question[]): Question[] | null {
  if (!input?.length) return null;
  if (input.length > MAX_QUESTIONS) throw new BadRequestException(`An event can ask up to ${MAX_QUESTIONS} questions.`);
  const known = new Set(existing.map((q) => q.id));
  const used = new Set<string>();
  return input.map((q) => {
    const label = q.label.replace(/\s+/g, ' ').trim();
    const type = q.type === 'CHOICE' ? 'CHOICE' : 'TEXT';
    const options = type === 'CHOICE' ? [...new Set((q.options ?? []).map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean))] : [];
    if (type === 'CHOICE' && options.length < 2) throw new BadRequestException(`“${label}” needs at least two choices.`);
    let id = q.id && known.has(q.id) && !used.has(q.id) ? q.id : `q${randomBytes(4).toString('hex')}`;
    while (used.has(id)) id = `q${randomBytes(4).toString('hex')}`;
    used.add(id);
    return { id, label, type, options, required: !!q.required, per: q.per === 'TICKET' ? 'TICKET' : 'ORDER' };
  });
}

/**
 * Checks the buyer's answers against the event's questions and splits them by order: `quantities` is the number of
 * tickets on each order of the checkout (one for a plain order; a cart's lines in order), and an answer's `ticket` is
 * the ticket's number across the whole checkout, from 0. Answers asked once go on every order. Null when the event
 * asks nothing.
 */
export function checkAnswers(questions: Question[], input: AnswerInput[] | undefined, quantities: number[]): (OrderAnswers | null)[] {
  if (!questions.length) return quantities.map(() => null);
  const given = new Map<string, string>();
  for (const a of input ?? []) {
    const v = a.value.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX);
    if (v) given.set(`${a.questionId}:${a.ticket ?? ''}`, v);
  }
  const answer = (q: Question, ticket: number | null): Answer | null => {
    const v = given.get(`${q.id}:${ticket ?? ''}`);
    const who = ticket === null ? '' : ` for ticket ${ticket + 1}`;
    if (!v) {
      if (q.required) throw new BadRequestException(`Please answer “${q.label}”${who}.`);
      return null;
    }
    if (q.type === 'CHOICE' && !q.options.includes(v)) throw new BadRequestException(`Pick one of the choices for “${q.label}”${who}.`);
    return { id: q.id, label: q.label, value: v };
  };
  const once = questions.filter((q) => q.per === 'ORDER').map((q) => answer(q, null)).filter((a): a is Answer => !!a);
  const each = questions.filter((q) => q.per === 'TICKET');
  let n = 0;
  return quantities.map((qty) => ({
    order: once,
    tickets: Array.from({ length: qty }, () => {
      const t = n++;
      return each.map((q) => answer(q, t)).filter((a): a is Answer => !!a);
    }),
  }));
}

/** An order's stored answers (older orders have none). */
export function answersOf(raw: unknown): OrderAnswers {
  const a = (raw ?? {}) as Partial<OrderAnswers>;
  return { order: Array.isArray(a.order) ? a.order : [], tickets: Array.isArray(a.tickets) ? a.tickets : [] };
}

/** One ticket's answers in words, for the attendee list and the CSV: what was asked once, then what was asked of it. */
export function ticketAnswers(raw: unknown, index: number): Answer[] {
  const a = answersOf(raw);
  return [...a.order, ...(a.tickets[index] ?? [])];
}
