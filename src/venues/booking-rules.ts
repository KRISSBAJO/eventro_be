/**
 * The rules of hiring a venue, kept free of the database so they're easy to read and test.
 *
 * Booking times are the venue's wall-clock time stored as UTC (like event times), so "Saturday 18:00" is a stored
 * Saturday 18:00Z whatever the zone; weekly hours are compared against that directly. Only "how far ahead" (notice)
 * and holds need the real moment, through wallClockToInstant.
 */
import { wallClockToInstant } from '../domain/wallclock';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** How long a request holds its time while the venue decides. */
export const HOLD_MS = 48 * HOUR_MS;
/** Longest single booking. */
export const MAX_BOOKING_DAYS = 14;
/** Farthest ahead a booking can be requested. */
export const MAX_AHEAD_DAYS = 730;

export const PRICE_MODES = ['HOUR', 'DAY', 'QUOTE'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];
export const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** One opening window: day 0–6 (Sunday = 0), "HH:MM" to "HH:MM" ("24:00" closes at midnight). */
export type OpeningHours = { day: number; open: string; close: string };

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Problems with a week of opening hours (empty when fine). */
export function hoursProblems(hours: OpeningHours[]): string[] {
  const out: string[] = [];
  const byDay = new Map<number, OpeningHours[]>();
  for (const h of hours) {
    if (!Number.isInteger(h.day) || h.day < 0 || h.day > 6) out.push(`Day ${h.day} isn’t 0–6 (Sunday = 0).`);
    if (!TIME.test(h.open) || h.open === '24:00') out.push(`Opening time "${h.open}" should look like 09:00.`);
    if (!TIME.test(h.close)) out.push(`Closing time "${h.close}" should look like 23:00 (or 24:00 for midnight).`);
    if (TIME.test(h.open) && TIME.test(h.close) && minutesOf(h.close) <= minutesOf(h.open)) out.push(`${DAYS[h.day] ?? 'A day'}: closing (${h.close}) has to be after opening (${h.open}). For late nights, close at 24:00 and open at 00:00 the next day.`);
    byDay.set(h.day, [...(byDay.get(h.day) ?? []), h]);
  }
  for (const [day, list] of byDay) {
    const sorted = [...list].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
    for (let i = 1; i < sorted.length; i++) if (minutesOf(sorted[i].open) < minutesOf(sorted[i - 1].close)) out.push(`${DAYS[day] ?? 'A day'}: opening hours overlap.`);
  }
  return out;
}

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Sorted by day then opening time. */
export const sortHours = (hours: OpeningHours[]) => [...hours].sort((a, b) => a.day - b.day || minutesOf(a.open) - minutesOf(b.open));

/**
 * Whether [start, end) sits inside the venue's opening hours. Windows that touch (a 24:00 close and a 00:00 open
 * the next day) join up, so an overnight booking works when the venue is open across midnight. No hours: any time.
 */
export function withinHours(start: Date, end: Date, hours: OpeningHours[] | null | undefined) {
  if (!hours?.length) return true;
  const windows: [number, number][] = [];
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let d = first - DAY_MS; d <= end.getTime(); d += DAY_MS) {
    const dow = new Date(d).getUTCDay();
    for (const h of hours) if (h.day === dow) windows.push([d + minutesOf(h.open) * 60_000, d + minutesOf(h.close) * 60_000]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged.some(([a, b]) => a <= start.getTime() && end.getTime() <= b);
}

/** Two half-open intervals overlap. */
export const overlaps = (aFrom: Date, aTo: Date, bFrom: Date, bTo: Date) => aFrom < bTo && bFrom < aTo;

/** The time kept free around a booking: setup before, cleanup after. */
export const blockOf = (start: Date, end: Date, bufferMinutes: number) => ({
  blockFrom: new Date(start.getTime() - bufferMinutes * 60_000),
  blockTo: new Date(end.getTime() + bufferMinutes * 60_000),
});

/**
 * The price shown for a booking: per started hour (rounded to the minute) or per started day; null when the venue
 * quotes. Amounts too big for the column are left to the venue to quote.
 */
export function quoteFor(mode: string, priceCents: number | null, start: Date, end: Date) {
  if (priceCents === null || mode === 'QUOTE') return null;
  const ms = end.getTime() - start.getTime();
  const cents = mode === 'HOUR' ? Math.round((priceCents * ms) / HOUR_MS) : priceCents * Math.max(1, Math.ceil(ms / DAY_MS));
  return cents <= 2_000_000_000 ? cents : null;
}

/** When a request stops holding its time: 48 hours from now, but never after the booking starts. */
export function holdUntilFor(start: Date, timezone: string, now = new Date()) {
  const startsAt = wallClockToInstant(start, timezone).getTime();
  return new Date(Math.max(now.getTime() + 60_000, Math.min(now.getTime() + HOLD_MS, startsAt)));
}

/** Pending requests past their hold no longer hold anything, even before the sweep marks them EXPIRED. */
export const isLive = (b: { status: string; holdUntil: Date }, now = new Date()) => b.status === 'CONFIRMED' || (b.status === 'PENDING' && b.holdUntil > now);

/** The status people should see: an unswept pending request past its hold shows as EXPIRED. */
export const effectiveStatus = (b: { status: string; holdUntil: Date }, now = new Date()) => (b.status === 'PENDING' && b.holdUntil <= now ? 'EXPIRED' : b.status);
