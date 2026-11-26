/** Date changes of live events (see src/organizer/date-changes.ts): which tickets a move hits, and how GET /me/tickets shows it. */
import type { DateChange, Prisma } from '@prisma/client';

const DAY = 86_400_000;
/** Moves shorter than this (fixing a typo, doors-to-start tweaks) aren't announced. */
export const MIN_MOVE_MS = 30 * 60_000;
/** How long buyers have to take a refund after a change (or until the new start, if that's sooner). */
export const REFUND_WINDOW_MS = 14 * DAY;

export type Move = { eventDateId: string | null; from: Date; to: Date };

/** The tickets a move affects. */
export function ticketsMoved(eventId: string, mode: string, eventDateId: string | null): Prisma.TicketWhereInput {
  if (mode === 'DATES' && eventDateId) return { eventId, eventDateId };
  if (mode === 'DAYS' && eventDateId) return { eventId, ticketType: { validDateIds: { has: eventDateId } } };
  return { eventId };
}

/** Whether a change applies to a ticket of this type (SINGLE: every ticket; DATES: its date; DAYS: one of its days). */
export const changeHits = (c: Pick<DateChange, 'eventDateId'>, mode: string, tt: { eventDateId: string | null; validDateIds: string[] }) =>
  mode === 'SINGLE' ? c.eventDateId === null : mode === 'DATES' ? c.eventDateId === tt.eventDateId : !!c.eventDateId && tt.validDateIds.includes(c.eventDateId);

/**
 * The latest change for a ticket that its order was bought before (later buyers bought the new time), as GET
 * /me/tickets shows it. `refundable`: the buyer can still take the refund (a paid sale, inside the window, nothing used).
 */
export function dateChangeView(
  changes: DateChange[],
  mode: string,
  tt: { eventDateId: string | null; validDateIds: string[] },
  order: { kind: string; status: string; paidAt: Date | null; createdAt: Date; totalCents: number; refundedCents: number },
  opts: { isBuyer: boolean; used: boolean; now?: number },
) {
  const bought = (order.paidAt ?? order.createdAt).getTime();
  const c = changes.filter((x) => changeHits(x, mode, tt) && x.createdAt.getTime() > bought).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!c) return null;
  const open = c.refundUntil.getTime() > (opts.now ?? Date.now());
  const paid = order.kind === 'SALE' && (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') && order.totalCents - order.refundedCents > 0;
  return {
    id: c.id,
    fromStartsAt: c.fromStartsAt,
    toStartsAt: c.toStartsAt,
    reason: c.reason,
    refundUntil: c.refundUntil,
    refundable: open && paid && opts.isBuyer && !opts.used,
    refundCents: paid ? order.totalCents - order.refundedCents : 0,
  };
}
