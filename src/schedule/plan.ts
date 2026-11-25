/**
 * Checks an event's schedule as sent (create, or the full list on PUT) and returns the rows to store. Pure: the
 * caller gives the event's times, its dates and how ticket-type refs resolve, so the same rules run before an event
 * exists (create: dates and tiers are indexes into what was sent) and on edit.
 */
import { BadRequestException } from '@nestjs/common';
import type { ScheduleKind } from '@prisma/client';
import { dateTimeLabel, dayLabel, type DateMode } from '../domain/event-dates';
import { MAX_BOOKABLE, MAX_ITEMS, MAX_PEOPLE, inWindow, itemWindow } from '../domain/schedule';

export type ScheduleInput = {
  id?: string;
  eventDateId?: string | null;
  dateRef?: number | string | null;
  startsAt: string;
  endsAt?: string | null;
  title: string;
  note?: string | null;
  stage?: string | null;
  people?: string[] | null;
  kind?: ScheduleKind;
  bookable?: boolean;
  capacity?: number | null;
  eligibleTiers?: string[] | null;
};

export type PlannedItem = {
  id?: string;
  eventDateId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  title: string;
  note: string;
  stage: string | null;
  people: string[];
  kind: ScheduleKind;
  sortOrder: number;
  bookable: boolean;
  capacity: number | null;
  eligibleTiers: string[];
};

type Times = { startsAt: Date; doorsAt: Date | null; endsAt: Date | null };

export type PlanContext = {
  mode: DateMode;
  /** SINGLE: the event's own times. */
  event: Times;
  /** DATES/DAYS: the event's dates (on create, ids are their indexes as sent: "0", "1"…). */
  dates: (Times & { id: string; status: string })[];
  /** Create: a date may be given as `dateRef` (index into `dates`), and eventDateId may be an index too. */
  byIndex?: boolean;
  /** A ticket-type ref as stored (TicketType id, or tier key for DATES), or null if it isn't part of the event. */
  tier: (ref: string) => string | null;
  /** The tier's name (messages), and for DAYS the days it's valid on. */
  tierInfo: (key: string) => { name: string; validDateIds: string[] };
  /** Edit: the items that can be kept (by id). */
  existing?: Set<string>;
};

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The rows of a schedule, in the order sent (sortOrder), or a 400 that names the item. */
export function planSchedule(input: ScheduleInput[], ctx: PlanContext): PlannedItem[] {
  if (input.length > MAX_ITEMS) throw new BadRequestException(`A schedule can have up to ${MAX_ITEMS} items.`);
  const seen = new Set<string>();
  const noun = ctx.mode === 'DAYS' ? 'day' : 'date';
  const out = input.map((x, i): PlannedItem => {
    const where = `Item ${i + 1}`;
    if (x.id) {
      if (!ctx.existing?.has(x.id)) throw new BadRequestException(`${where}: that item isn’t part of this schedule.`);
      if (seen.has(x.id)) throw new BadRequestException(`${where} is listed twice.`);
      seen.add(x.id);
    }
    const title = clean(x.title);
    if (!title) throw new BadRequestException(`${where}: add a title.`);
    if (title.length > 120) throw new BadRequestException(`${where}: keep the title to 120 characters.`);
    const startsAt = new Date(x.startsAt);
    const endsAt = x.endsAt ? new Date(x.endsAt) : null;
    if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) throw new BadRequestException(`${where}: that time isn’t valid.`);
    if (endsAt && endsAt <= startsAt) throw new BadRequestException(`${where}: the end has to be after the start.`);

    // The date it's on (DATES/DAYS), and the window its times must fall in.
    let eventDateId: string | null = null;
    let span: Times = ctx.event;
    const ref = x.eventDateId ?? (ctx.byIndex && x.dateRef !== undefined && x.dateRef !== null ? String(x.dateRef) : null);
    if (ctx.mode === 'SINGLE') {
      if (ref) throw new BadRequestException(`${where}: this event has one date, so leave out eventDateId.`);
    } else {
      if (!ref) throw new BadRequestException(`${where}: pick the ${noun} it’s on (eventDateId).`);
      const d = ctx.dates.find((y) => y.id === String(ref)) ?? (ctx.byIndex && /^\d{1,3}$/.test(String(ref)) ? ctx.dates[Number(ref)] : undefined);
      if (!d) throw new BadRequestException(`${where}: that ${noun} isn’t part of this event.`);
      if (d.status === 'CANCELLED') throw new BadRequestException(`${where}: that ${noun} was cancelled.`);
      eventDateId = d.id;
      span = d;
    }
    const w = itemWindow(span);
    if (!inWindow({ startsAt, endsAt }, w)) {
      throw new BadRequestException(`${where} (${title}) has to be between ${dateTimeLabel(w.from)} and ${dateTimeLabel(w.to)}, the ${ctx.mode === 'SINGLE' ? 'event' : noun}’s times.`);
    }

    const people: string[] = [];
    for (const p of x.people ?? []) {
      const v = clean(p);
      if (v && !people.some((o) => o.toLowerCase() === v.toLowerCase())) people.push(v.slice(0, 80));
    }
    if (people.length > MAX_PEOPLE) throw new BadRequestException(`${where}: up to ${MAX_PEOPLE} people per item.`);

    const bookable = !!x.bookable;
    let capacity: number | null = null;
    const eligibleTiers: string[] = [];
    if (bookable) {
      if (!x.capacity) throw new BadRequestException(`${where}: set the number of places (capacity) to let ticket holders book it.`);
      capacity = x.capacity;
      for (const r of x.eligibleTiers ?? []) {
        const key = ctx.tier(String(r).trim());
        if (!key) throw new BadRequestException(`${where}: eligibleTiers names a ticket type that isn’t part of this event ("${r}").`);
        const info = ctx.tierInfo(key);
        // A multi-day pass that isn't valid that day could never book it.
        if (ctx.mode === 'DAYS' && eventDateId && !info.validDateIds.includes(eventDateId)) {
          const d = ctx.dates.find((y) => y.id === eventDateId)!;
          throw new BadRequestException(`${where}: ${info.name} isn’t valid on ${dayLabel(d.startsAt)}.`);
        }
        if (!eligibleTiers.includes(key)) eligibleTiers.push(key);
      }
    }
    return {
      ...(x.id ? { id: x.id } : {}),
      eventDateId,
      startsAt,
      endsAt,
      title,
      note: (x.note ?? '').trim().slice(0, 600),
      stage: clean(x.stage) || null,
      people,
      kind: x.kind ?? 'OTHER',
      sortOrder: i,
      bookable,
      capacity,
      eligibleTiers,
    };
  });
  if (out.filter((p) => p.bookable).length > MAX_BOOKABLE) throw new BadRequestException(`Up to ${MAX_BOOKABLE} items can be bookable.`);
  return out;
}
