/**
 * Events with more than one date (Event.dateMode):
 *
 *   SINGLE  one date: the event's own startsAt/doorsAt/endsAt (no EventDate rows). Today's behaviour.
 *   DATES   a run of separate performances. Each is an EventDate with its own copy of every ticket type (TicketType
 *           .eventDateId, copies of one tier share `tierKey`), so inventory, seats and holds are per date for free.
 *           A ticket is for one date and admits once, on that date.
 *   DAYS    a multi-day event. Each day is an EventDate; ticket types are valid on one or more days (validDateIds)
 *           and admit once per valid day (TicketCheckIn).
 *
 * For DATES and DAYS the event's startsAt/doorsAt/endsAt are a summary of the ACTIVE dates (see summaryTimes), so
 * everything that lists, sorts or archives events keeps working. Times are the venue's wall clock stored as UTC.
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { instantToWallClock, wallClockLabel } from './wallclock';

export type DateMode = 'SINGLE' | 'DATES' | 'DAYS';
export const DATE_MODES: DateMode[] = ['SINGLE', 'DATES', 'DAYS'];
/** Most performances a DATES event can have, and days a DAYS event can have. */
export const MAX_DATES = 60;
export const MAX_DAYS = 14;

export type DateRow = { id: string; startsAt: Date; doorsAt: Date | null; endsAt: Date | null; label: string | null; status: string };

/** Hours a date without an end time is taken to last (for "is it over" checks). */
const ASSUMED_LENGTH_MS = 6 * 3600_000;

export const isActive = (d: { status: string }) => d.status === 'ACTIVE';
export const byStart = <T extends { startsAt: Date }>(a: T, b: T) => a.startsAt.getTime() - b.startsAt.getTime();
/** The wall-clock calendar day of a stored time ("2026-12-13"). */
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
/** When a date is over (its end, or its start plus a few hours). */
export const dateEnd = (d: { startsAt: Date; endsAt: Date | null }) => d.endsAt ?? new Date(d.startsAt.getTime() + ASSUMED_LENGTH_MS);

/** The event's summary times from its active dates: the earliest start and doors, the latest end (or start). */
export function summaryTimes(dates: DateRow[]) {
  const live = dates.filter(isActive).sort(byStart);
  if (!live.length) return null;
  const first = live[0];
  const last = live.reduce((a, d) => ((d.endsAt ?? d.startsAt) > (a.endsAt ?? a.startsAt) ? d : a), live[0]);
  return { startsAt: first.startsAt, doorsAt: first.doorsAt, endsAt: last.endsAt ?? last.startsAt };
}

/** A ticket's date fields, copied from its ticket type: the performance (DATES) and the per-date seat key. */
export const ticketDateFields = (tt: { eventDateId: string | null }) => ({ eventDateId: tt.eventDateId, dateKey: tt.eventDateId ?? '' });

/** What seat-map sections point at: the tier (DATES copies share one seat map) or the ticket type itself. */
export const seatTier = (tt: { id: string; tierKey: string | null }) => tt.tierKey ?? tt.id;

/** "Sat, Dec 13" */
export const dayLabel = (d: Date) => wallClockLabel(d, { weekday: 'short', month: 'short', day: 'numeric' });
/** "Sat, Dec 13, 8:00 PM" */
export const dateTimeLabel = (d: Date) => wallClockLabel(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** "Sat 12" (DAYS chips) */
export const shortDay = (d: Date) => wallClockLabel(d, { weekday: 'short', day: 'numeric' });
/** "Sat, Dec 13 (Matinee)" */
export const dateName = (d: { startsAt: Date; label: string | null }) => `${dateTimeLabel(d.startsAt)}${d.label ? ` (${d.label})` : ''}`;
/** "Sat 12, Sun 13" */
export const daysList = (days: { startsAt: Date }[]) => days.map((d) => shortDay(d.startsAt)).join(', ');

/** A date as clients see it. */
export const dateView = (d: DateRow) => ({ id: d.id, startsAt: d.startsAt, doorsAt: d.doorsAt, endsAt: d.endsAt, label: d.label, status: d.status as 'ACTIVE' | 'CANCELLED' });

/** The days a DAYS ticket type admits on, in date order. */
export const validDays = <T extends DateRow>(dates: T[], ids: string[]) => dates.filter((d) => ids.includes(d.id)).sort(byStart);

/**
 * A ticket's own date info for clients: `date` (DATES: its performance) and `validDates` (DAYS: the days it admits on).
 * SINGLE: { date: null, validDates: [] }.
 */
export function ticketDates(mode: string, tt: { eventDateId: string | null; validDateIds: string[] }, dates: (DateRow & { cancelledAt?: Date | null; cancelReason?: string | null })[]) {
  const own = mode === 'DATES' && tt.eventDateId ? dates.find((d) => d.id === tt.eventDateId) : undefined;
  return {
    // A cancelled date also says when and why, so a ticket can show "cancelled · refunded".
    date: own
      ? { id: own.id, startsAt: own.startsAt, doorsAt: own.doorsAt, endsAt: own.endsAt, label: own.label, status: own.status as 'ACTIVE' | 'CANCELLED', cancelledAt: own.cancelledAt ?? null, cancelReason: own.cancelReason ?? null }
      : null,
    validDates: mode === 'DAYS' ? validDays(dates, tt.validDateIds).map((d) => ({ id: d.id, startsAt: d.startsAt, label: d.label, status: d.status as 'ACTIVE' | 'CANCELLED' })) : [],
  };
}

/**
 * The times that rule a ticket: `first` (sales, transfer and resale cut-offs) and `last` (seller payouts). SINGLE:
 * the event's. DATES: the ticket's performance. DAYS: its first and last valid day.
 */
export function ticketTimes(
  mode: string,
  e: { startsAt: Date; doorsAt: Date | null; endsAt: Date | null },
  tt: { eventDateId: string | null; validDateIds: string[] },
  dates: DateRow[],
): { first: { startsAt: Date; doorsAt: Date | null; endsAt: Date | null }; last: { startsAt: Date; doorsAt: Date | null; endsAt: Date | null } } {
  if (mode === 'DATES' && tt.eventDateId) {
    const d = dates.find((x) => x.id === tt.eventDateId);
    if (d) return { first: d, last: d };
  }
  if (mode === 'DAYS') {
    const days = validDays(dates, tt.validDateIds).filter(isActive);
    if (days.length) return { first: days[0], last: days[days.length - 1] };
  }
  return { first: e, last: e };
}

/**
 * The date the door works on by default: the active date on today's calendar day at the venue (the latest one that
 * has started, if there are two), else the next one coming up, else the last one. `now` is a real moment.
 */
export function doorDate<T extends DateRow>(dates: T[], timezone: string | null, now = new Date()): T | null {
  const live = dates.filter(isActive).sort(byStart);
  if (!live.length) return null;
  const wall = instantToWallClock(now, timezone);
  const today = live.filter((d) => dayOf(d.startsAt) === dayOf(wall));
  if (today.length) return [...today].reverse().find((d) => d.startsAt <= wall) ?? today[0];
  // Still running from last night (ends after midnight).
  const running = live.find((d) => d.startsAt <= wall && dateEnd(d) >= wall);
  if (running) return running;
  return live.find((d) => d.startsAt > wall) ?? live[live.length - 1];
}

/**
 * Events with a date in a range: SINGLE events by their own start, DATES/DAYS events by any active date (so a run
 * whose first show has passed still lists while later shows are coming).
 */
export function dateRangeWhere(from: Date, to?: Date): Prisma.EventWhereInput {
  const range = { gte: from, ...(to ? { lte: to } : {}) };
  return { OR: [{ dateMode: 'SINGLE', startsAt: range }, { dateMode: { not: 'SINGLE' }, dates: { some: { status: 'ACTIVE', startsAt: range } } }] };
}

/** The first active date from `from` on (list items' `nextDate`), or null. */
export const nextActive = <T extends DateRow>(dates: T[], from = new Date()) => dates.filter((d) => isActive(d) && d.startsAt >= from).sort(byStart)[0] ?? null;

/** List items' `nextDate`: { id, startsAt } of the first upcoming active date, or null (SINGLE: always null). */
export function nextDateView(mode: string, dates: DateRow[], from = new Date()) {
  const d = mode === 'SINGLE' ? null : nextActive(dates, from);
  return d ? { id: d.id, startsAt: d.startsAt } : null;
}

const longWhen = (d: Date) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);

/** The "when" line in emails: the event's start, the ticket's performance (DATES), or the days it's valid (DAYS). */
export function whenText(mode: string, e: { startsAt: Date }, tt: { eventDateId: string | null; validDateIds: string[] }, dates: DateRow[]) {
  if (mode === 'DATES') {
    const d = dates.find((x) => x.id === tt.eventDateId);
    if (d) return `${longWhen(d.startsAt)}${d.label ? ` (${d.label})` : ''}`;
  }
  if (mode === 'DAYS') {
    const days = validDays(dates, tt.validDateIds);
    if (days.length) return `Valid ${days.map((d) => dayLabel(d.startsAt)).join(', ')}`;
  }
  return longWhen(e.startsAt);
}

/**
 * Ticket types that still count for display (capacity, from-price, availability): every type except DATES copies of a
 * cancelled date. One-date and multi-day types have no eventDateId, so they always count.
 */
export const LIVE_TYPE: Prisma.TicketTypeWhereInput = { OR: [{ eventDateId: null }, { eventDate: { status: 'ACTIVE' } }] };
/** The same rule in memory, given the event's dates. */
export const liveType = (t: { eventDateId: string | null }, dates: { id: string; status: string }[]) => !t.eventDateId || dates.some((d) => d.id === t.eventDateId && d.status === 'ACTIVE');

/**
 * A single-date event's times: doors no later than the start, the end after it, and a new or moved start in the
 * future (an unchanged start may already have passed, so other fields of a running event can still be fixed).
 */
export function checkSingleTimes(t: { startsAt: Date; doorsAt: Date | null; endsAt: Date | null }, startMoved: boolean, now = new Date()) {
  if (Number.isNaN(t.startsAt.getTime())) throw new BadRequestException('Give the event a start time.');
  if (t.doorsAt && t.doorsAt > t.startsAt) throw new BadRequestException('Doors can’t open after the start.');
  if (t.endsAt && t.endsAt <= t.startsAt) throw new BadRequestException('The end has to be after the start.');
  if (startMoved && t.startsAt <= now) throw new BadRequestException('The start time is in the past.');
}

/**
 * What a fan bought, as it was at checkout (Order.snapshot): the event, its date (DATES: the performance; DAYS: the
 * days), the venue, the tier with its perks, and the price. Kept as-is when the event or tier changes later.
 */
export function purchaseSnapshot(
  e: { title: string; dateMode: string; startsAt: Date; doorsAt: Date | null; endsAt: Date | null; online: boolean; currency: string },
  tt: { name: string; perks: string[]; eventDateId: string | null; validDateIds: string[] },
  venue: { name: string; city: string; address?: string } | null,
  dates: DateRow[],
  unitCents: number,
) {
  const t = ticketTimes(e.dateMode, e, tt, dates);
  return {
    title: e.title,
    startsAt: t.first.startsAt.toISOString(),
    ...(e.dateMode === 'DAYS' ? { days: validDays(dates, tt.validDateIds).map((d) => d.startsAt.toISOString()) } : {}),
    venue: venue ? { name: venue.name, city: venue.city } : null,
    online: e.online,
    tierName: tt.name,
    perks: tt.perks,
    unitCents,
    currency: e.currency,
  };
}
