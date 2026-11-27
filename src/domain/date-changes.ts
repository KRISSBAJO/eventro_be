/**
 * Changes to live events that ticket holders are told about and buyers can take a refund for (see
 * src/organizer/date-changes.ts): TIME (a start moved), POSTPONED (new date to be announced), PERKS (a sold tier lost
 * something it promised). Which tickets each hits, and how GET /me/tickets shows it.
 */
import type { DateChange, Prisma } from '@prisma/client';
import { dayShare } from '../guarantee/guarantee';
import { ticketLeft } from './pwyw';

const DAY = 86_400_000;
/** Moves shorter than this (fixing a typo, doors-to-start tweaks) aren't announced. */
export const MIN_MOVE_MS = 30 * 60_000;
/** How long buyers have to take a refund after a change (or until the new start, if that's sooner). */
export const REFUND_WINDOW_MS = 14 * DAY;

export type Move = { eventDateId: string | null; from: Date; to: Date };
export type ChangeKind = 'TIME' | 'POSTPONED' | 'PERKS';
/** How long buyers have to take a refund while an event is postponed (then it's cancelled and everyone refunded). */
export const POSTPONE_LIMIT_MS = 90 * DAY;

/** The tickets a change affects. */
export function ticketsHit(c: { eventId: string; kind?: string; eventDateId: string | null; ticketTypeIds?: string[] }, mode: string): Prisma.TicketWhereInput {
  if (c.kind === 'PERKS') return { eventId: c.eventId, ticketTypeId: { in: c.ticketTypeIds ?? [] } };
  if (c.kind === 'POSTPONED') return { eventId: c.eventId };
  return ticketsMoved(c.eventId, mode, c.eventDateId);
}

/** The tickets a move affects. */
export function ticketsMoved(eventId: string, mode: string, eventDateId: string | null): Prisma.TicketWhereInput {
  if (mode === 'DATES' && eventDateId) return { eventId, eventDateId };
  if (mode === 'DAYS' && eventDateId) return { eventId, ticketType: { validDateIds: { has: eventDateId } } };
  return { eventId };
}

/**
 * Whether a change applies to a ticket of this type. A postponement: every ticket. Lost perks: that tier's tickets.
 * A time change: SINGLE every ticket; DATES its date; DAYS one of its days.
 */
export const changeHits = (c: Pick<DateChange, 'eventDateId'> & { kind?: string; ticketTypeIds?: string[] }, mode: string, tt: { id?: string; eventDateId: string | null; validDateIds: string[] }) =>
  c.kind === 'POSTPONED'
    ? true
    : c.kind === 'PERKS'
      ? !!tt.id && (c.ticketTypeIds ?? []).includes(tt.id)
      : mode === 'SINGLE'
        ? c.eventDateId === null
        : mode === 'DATES'
          ? c.eventDateId === tt.eventDateId
          : !!c.eventDateId && tt.validDateIds.includes(c.eventDateId);

/**
 * The latest change for a ticket that its order was bought before (later buyers bought the new time), as GET
 * /me/tickets shows it. `refundable`: the buyer can still take the refund (a paid sale, inside the window, nothing used).
 */
export function dateChangeView(
  changes: DateChange[],
  mode: string,
  tt: { id?: string; eventDateId: string | null; validDateIds: string[] },
  order: { kind: string; status: string; paidAt: Date | null; createdAt: Date; totalCents: number; refundedCents: number },
  opts: { isBuyer: boolean; used: boolean; now?: number; refund?: (c: DateChange) => { cents: number; whole: boolean }; taken?: (changeId: string) => boolean },
) {
  const bought = (order.paidAt ?? order.createdAt).getTime();
  const c = changes.filter((x) => changeHits(x, mode, tt) && x.createdAt.getTime() > bought).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!c) return null;
  const open = c.refundUntil.getTime() > (opts.now ?? Date.now());
  const paid = order.kind === 'SALE' && (order.status === 'PAID' || order.status === 'PARTIALLY_REFUNDED') && order.totalCents - order.refundedCents > 0;
  const refund = opts.refund?.(c);
  return {
    id: c.id,
    kind: (c.kind ?? 'TIME') as ChangeKind,
    /** PERKS: { tier, removed } */
    detail: (c.detail ?? null) as { tier?: string; removed?: string[] } | null,
    fromStartsAt: c.fromStartsAt,
    toStartsAt: c.toStartsAt,
    reason: c.reason,
    refundUntil: c.refundUntil,
    refundable: open && paid && opts.isBuyer && !opts.used && !opts.taken?.(c.id) && (refund?.cents ?? 1) > 0,
    refundCents: paid ? (refund?.cents ?? order.totalCents - order.refundedCents) : 0,
    /** false: a multi-day pass that also covers other days gets the moved day's share back and keeps working */
    whole: refund?.whole ?? true,
  };
}

/**
 * What taking a change's refund gives back on an order: everything left on it, or, for a multi-day pass that also
 * covers other days still on, the moved day's share of its tickets (split as for a cancelled day) while the pass
 * keeps working on the others.
 */
export function moveRefund(
  o: { totalCents: number; refundedCents: number; quantity: number; donationCents?: number; donationRefundedCents?: number },
  mode: string,
  tt: { validDateIds: string[] },
  dates: { id: string; startsAt: Date; status: string }[],
  change: Pick<DateChange, 'eventDateId'> & { kind?: string },
  ticketIds: string[],
) {
  const left = Math.max(0, o.totalCents - o.refundedCents);
  const dayId = change.eventDateId;
  // A postponement or a lost perk is about the whole order.
  if (mode !== 'DAYS' || !dayId || (change.kind && change.kind !== 'TIME')) return { cents: left, whole: true };
  const own = dates.filter((d) => tt.validDateIds.includes(d.id)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (!own.some((d) => d.id !== dayId && d.status === 'ACTIVE')) return { cents: left, whole: true };
  const days = own.map((d) => d.id);
  return { cents: Math.min(ticketLeft(o), ticketIds.reduce((sum, id) => sum + dayShare(o, id, days, dayId), 0)), whole: false };
}

/** An order's ticket codes ("EVT-…-01", "-02", …), for working out shares. */
export const ticketIdsOf = (orderId: string, quantity: number) => Array.from({ length: quantity }, (_, i) => `${orderId}-${String(i + 1).padStart(2, '0')}`);
