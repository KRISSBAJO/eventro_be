/**
 * The event schedule (agenda) and bookable sessions (see prisma ScheduleItem / SessionReservation).
 *
 * Every event may have a schedule: items with a time, an optional end, a title, a stage, people and a kind. DATES and
 * DAYS items are on one date; SINGLE items have none. Any item can be bookable: ticket holders reserve one of its
 * `capacity` places for free with an eligible ticket (the ticket's date or day, and optionally only some tiers). Times
 * are the venue's wall clock stored as UTC, like every event time.
 */
import type { ScheduleKind } from '@prisma/client';

export const SCHEDULE_KINDS: ScheduleKind[] = ['PERFORMANCE', 'TALK', 'WORKSHOP', 'BREAK', 'OTHER'];
/** Most items an event's schedule can have, and how many of them can be bookable. */
export const MAX_ITEMS = 200;
export const MAX_BOOKABLE = 60;
export const MAX_PLACES = 100_000;
export const MAX_PEOPLE = 12;

const HOUR = 3600_000;
/** How long an item without an end is taken to last when checking two bookings for a clash. */
export const ASSUMED_SESSION_MS = 30 * 60_000;

/** The span a date's items must fall in: doors (else start − 12 h) to its end (else start + 24 h). */
export function itemWindow(d: { startsAt: Date; doorsAt: Date | null; endsAt: Date | null }) {
  return { from: d.doorsAt ?? new Date(d.startsAt.getTime() - 12 * HOUR), to: d.endsAt ?? new Date(d.startsAt.getTime() + 24 * HOUR) };
}

/** Whether an item (start, and end if any) sits inside a window. */
export const inWindow = (i: { startsAt: Date; endsAt: Date | null }, w: { from: Date; to: Date }) => i.startsAt >= w.from && (i.endsAt ?? i.startsAt) <= w.to;

/** When an item ends for clash checks. */
export const sessionEnd = (i: { startsAt: Date; endsAt: Date | null }) => i.endsAt ?? new Date(i.startsAt.getTime() + ASSUMED_SESSION_MS);

/** Two items whose times overlap (touching end to start is fine). */
export const overlaps = (a: { startsAt: Date; endsAt: Date | null }, b: { startsAt: Date; endsAt: Date | null }) => a.startsAt < sessionEnd(b) && b.startsAt < sessionEnd(a);

/**
 * The date an item belongs on when an event gains dates: one on the same calendar day whose window holds it, else any
 * whose window holds it, else one on the same day, else the first.
 */
export function dateForItem<T extends { id: string; startsAt: Date; doorsAt: Date | null; endsAt: Date | null }>(i: { startsAt: Date; endsAt: Date | null }, dates: T[]) {
  const sameDay = (d: T) => d.startsAt.toISOString().slice(0, 10) === i.startsAt.toISOString().slice(0, 10);
  const holds = (d: T) => inWindow(i, itemWindow(d));
  return dates.find((d) => sameDay(d) && holds(d)) ?? dates.find(holds) ?? dates.find(sameDay) ?? dates[0] ?? null;
}

/** What a ticket needs for the eligibility checks. */
export type BookingTicket = { ticketTypeId: string; eventDateId: string | null; ticketType: { tierKey: string | null; validDateIds: string[] } };

/** The tier a ticket counts as for `eligibleTiers`: its tier key (DATES), else its ticket type. */
export const tierOf = (mode: string, t: BookingTicket) => (mode === 'DATES' ? (t.ticketType.tierKey ?? t.ticketTypeId) : t.ticketTypeId);

/** Whether a ticket is for an item's date: DATES its own date, DAYS a day its pass is valid on, SINGLE always. */
export function ticketOnDate(mode: string, t: BookingTicket, item: { eventDateId: string | null }) {
  if (mode === 'DATES') return !!item.eventDateId && t.eventDateId === item.eventDateId;
  if (mode === 'DAYS') return !!item.eventDateId && t.ticketType.validDateIds.includes(item.eventDateId);
  return true;
}

/** Places still free on a bookable item (null for plain items). */
export const placesLeft = (i: { bookable: boolean; capacity: number | null; reserved: number }) => (i.bookable ? Math.max(0, (i.capacity ?? 0) - i.reserved) : null);
