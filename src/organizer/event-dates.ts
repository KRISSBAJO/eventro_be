/**
 * Creating and editing the dates of a DATES (multiple dates) or DAYS (multi-day) event, and the tier copies that go
 * with them (see src/domain/event-dates.ts for the model).
 *
 * DATES: every tier has one TicketType per date (same tierKey). Adding a date copies every tier onto it; removing a
 * date (only without orders) removes its copies. Tier edits go to every copy; capacity is per date.
 * DAYS: ticket types list the days they admit on (validDateIds). Removing a day is refused while a type valid that
 * day has sales.
 *
 * The event's startsAt/doorsAt/endsAt are kept as the summary of its active dates (syncSummary).
 */
import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type EventDate, type TicketType } from '@prisma/client';
import { MAX_DATES, MAX_DAYS, byStart, dateTimeLabel, dayLabel, dayOf, isActive, summaryTimes, type DateMode } from '../domain/event-dates';
import type { SeatMap } from '../domain/seatmap';
import { dateForItem } from '../domain/schedule';

type Tx = Prisma.TransactionClient;

export type DateInput = { id?: string; startsAt: string; doorsAt?: string; endsAt?: string; label?: string };
export type PlannedDate = { id?: string; startsAt: Date; doorsAt: Date | null; endsAt: Date | null; label: string | null; index: number };
/** A ticket type to create, with its per-date settings still as refs. */
export type TierInput = { data: Omit<Prisma.TicketTypeUncheckedCreateInput, 'eventId'> & { name: string; capacity: number }; capacityByDate?: Record<string, number>; validDates?: string[] };

const MAX_CAPACITY = 200_000;

/** A fresh key that groups the copies of one tier (DATES). */
export const newTierKey = () => `tier_${randomBytes(9).toString('base64url')}`;

/** A date ref (an id, or an index into `dates`) as a date id, or null. */
export function resolveRef(ref: string | number, dates: { id: string }[]) {
  const r = String(ref).trim();
  if (dates.some((d) => d.id === r)) return r;
  if (/^\d{1,3}$/.test(r) && Number(r) < dates.length) return dates[Number(r)].id;
  return null;
}

/** Per-date capacities of a DATES tier: `capacity` everywhere, `capacityByDate` on the dates it names. */
export function capacitiesFor(name: string, capacity: number, byDate: Record<string, number> | undefined, dates: { id: string }[]) {
  const out = new Map(dates.map((d) => [d.id, capacity]));
  for (const [ref, n] of Object.entries(byDate ?? {})) {
    const id = resolveRef(ref, dates);
    if (!id) throw new BadRequestException(`${name}: capacityByDate names a date that isn’t part of this event ("${ref}").`);
    if (!Number.isInteger(n) || n < 0 || n > MAX_CAPACITY) throw new BadRequestException(`${name}: the capacity on each date must be a whole number from 0 to 200,000.`);
    out.set(id, n);
  }
  return out;
}

/** The days a DAYS ticket type admits on, as date ids (at least one). */
export function daysFor(name: string, refs: string[] | undefined, dates: { id: string }[]) {
  if (!refs?.length) throw new BadRequestException(`${name}: pick the days this ticket is valid on (validDates).`);
  const ids = new Set<string>();
  for (const ref of refs) {
    const id = resolveRef(ref, dates);
    if (!id) throw new BadRequestException(`${name}: validDates names a day that isn’t part of this event ("${ref}").`);
    ids.add(id);
  }
  return [...ids];
}

const at = (s: string | undefined | null) => (s ? new Date(s) : null);

/**
 * Checks a list of dates (create, or the full list on edit) and returns them as times. New dates, and dates whose
 * start moves, must be in the future; each date's doors ≤ start ≤ end; DAYS are distinct calendar days and DATES
 * distinct start times. `existing` are the event's current dates (edit); cancelled ones can't change.
 */
export function planDates(mode: DateMode, input: DateInput[] | undefined, existing: EventDate[] = [], now = new Date()): PlannedDate[] {
  const max = mode === 'DAYS' ? MAX_DAYS : MAX_DATES;
  const noun = mode === 'DAYS' ? 'day' : 'date';
  if (!input?.length) throw new BadRequestException(mode === 'DAYS' ? 'Add the days of the event.' : 'Add at least one date.');
  const byId = new Map(existing.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const out: PlannedDate[] = input.map((d, i) => {
    const where = `${mode === 'DAYS' ? 'Day' : 'Date'} ${i + 1}`;
    const old = d.id ? byId.get(d.id) : undefined;
    if (d.id && !old) throw new BadRequestException(`${where}: that ${noun} isn’t part of this event.`);
    if (d.id && seen.has(d.id)) throw new BadRequestException(`${where} is listed twice.`);
    if (d.id) seen.add(d.id);
    const p: PlannedDate = { id: d.id, startsAt: new Date(d.startsAt), doorsAt: at(d.doorsAt), endsAt: at(d.endsAt), label: d.label?.trim() || null, index: i };
    if (old && old.status === 'CANCELLED') {
      const same = old.startsAt.getTime() === p.startsAt.getTime() && (old.doorsAt?.getTime() ?? null) === (p.doorsAt?.getTime() ?? null) && (old.endsAt?.getTime() ?? null) === (p.endsAt?.getTime() ?? null) && old.label === p.label;
      if (!same) throw new BadRequestException(`${where} was cancelled, so it can’t be changed.`);
      return p;
    }
    if (p.doorsAt && p.doorsAt > p.startsAt) throw new BadRequestException(`${where}: doors can’t open after the start.`);
    if (p.endsAt && p.endsAt < p.startsAt) throw new BadRequestException(`${where}: the end has to be after the start.`);
    const moved = !old || old.startsAt.getTime() !== p.startsAt.getTime();
    if (moved && p.startsAt <= now) throw new BadRequestException(`${where} (${dateTimeLabel(p.startsAt)}) is in the past.`);
    return p;
  });
  const cancelled = existing.filter((d) => d.status === 'CANCELLED').map((d) => d.id);
  const live = out.filter((p) => !p.id || !cancelled.includes(p.id));
  if (live.length > max) throw new BadRequestException(mode === 'DAYS' ? `A multi-day event can have up to ${MAX_DAYS} days.` : `An event can have up to ${MAX_DATES} dates.`);
  if (!live.length) throw new BadRequestException(mode === 'DAYS' ? 'Add the days of the event.' : 'Add at least one date.');
  const keys = new Map<string, PlannedDate>();
  for (const p of live) {
    const k = mode === 'DAYS' ? dayOf(p.startsAt) : p.startsAt.toISOString();
    if (keys.has(k)) {
      throw new BadRequestException(mode === 'DAYS' ? `Two days fall on ${dayLabel(p.startsAt)}. Each day of a multi-day event is a different calendar day.` : `Two dates start at ${dateTimeLabel(p.startsAt)}.`);
    }
    keys.set(k, p);
  }
  return out;
}

/** The copy fields of a ticket type (everything a tier shares), for a new copy on another date. */
function copyOf(t: TicketType, eventDateId: string, capacity: number): Prisma.TicketTypeUncheckedCreateInput {
  return {
    eventId: t.eventId,
    name: t.name,
    description: t.description,
    priceCents: t.priceCents,
    capacity,
    maxPerOrder: t.maxPerOrder,
    sortOrder: t.sortOrder,
    perks: t.perks,
    badge: t.badge,
    style: t.style,
    pricing: t.pricing,
    pwywMinCents: t.pwywMinCents,
    pwywSuggestedCents: t.pwywSuggestedCents,
    pwywMaxCents: t.pwywMaxCents,
    pwywQuickPicks: t.pwywQuickPicks,
    salesStart: t.salesStart,
    salesEnd: t.salesEnd,
    tierKey: t.tierKey,
    eventDateId,
  };
}

/** The seat map with each section's ticket type swapped (null map stays null). */
function remapSections(map: SeatMap | null, to: (ticketTypeId: string) => string) {
  if (!map) return undefined;
  return { ...map, sections: map.sections.map((s) => ({ ...s, ticketTypeId: to(s.ticketTypeId) })) } as unknown as Prisma.InputJsonValue;
}

@Injectable()
export class EventDatesService {
  /** Keeps the event's startsAt/doorsAt/endsAt the summary of its active dates. */
  async syncSummary(tx: Tx, eventId: string) {
    const dates = await tx.eventDate.findMany({ where: { eventId } });
    const s = summaryTimes(dates);
    if (s) await tx.event.update({ where: { id: eventId }, data: s });
    return s;
  }

  /** Creates the dates of a new DATES/DAYS event and its ticket types (DATES: a copy of each tier per date). */
  async create(tx: Tx, eventId: string, mode: DateMode, planned: PlannedDate[], tiers: TierInput[]) {
    const ranks = [...planned].sort(byStart);
    const dates: EventDate[] = [];
    for (const p of planned) {
      dates.push(await tx.eventDate.create({ data: { eventId, startsAt: p.startsAt, doorsAt: p.doorsAt, endsAt: p.endsAt, label: p.label, sortOrder: ranks.indexOf(p) } }));
    }
    for (const t of tiers) {
      if (mode === 'DATES') {
        if (t.validDates) throw new BadRequestException(`${t.data.name}: validDates is for multi-day events.`);
        const caps = capacitiesFor(t.data.name, t.data.capacity, t.capacityByDate, dates);
        const tierKey = newTierKey();
        await tx.ticketType.createMany({ data: dates.map((d) => ({ ...t.data, eventId, tierKey, eventDateId: d.id, capacity: caps.get(d.id)! })) });
      } else {
        if (t.capacityByDate) throw new BadRequestException(`${t.data.name}: capacityByDate is for events with multiple dates.`);
        await tx.ticketType.create({ data: { ...t.data, eventId, validDateIds: daysFor(t.data.name, t.validDates, dates) } });
      }
    }
    await this.syncSummary(tx, eventId);
    return dates;
  }

  /** New ticket types on an existing DATES/DAYS event (POST ticket-types): DATES makes one copy per active date. */
  async addTier(tx: Tx, ev: { id: string; dateMode: string }, t: TierInput) {
    const dates = await tx.eventDate.findMany({ where: { eventId: ev.id }, orderBy: { startsAt: 'asc' } });
    if (ev.dateMode === 'DATES') {
      if (t.validDates) throw new BadRequestException(`${t.data.name}: validDates is for multi-day events.`);
      const caps = capacitiesFor(t.data.name, t.data.capacity, t.capacityByDate, dates);
      const tierKey = newTierKey();
      const live = dates.filter(isActive);
      const copies: TicketType[] = [];
      for (const d of live) copies.push(await tx.ticketType.create({ data: { ...t.data, eventId: ev.id, tierKey, eventDateId: d.id, capacity: caps.get(d.id)! } }));
      return copies;
    }
    if (t.capacityByDate) throw new BadRequestException(`${t.data.name}: capacityByDate is for events with multiple dates.`);
    return [await tx.ticketType.create({ data: { ...t.data, eventId: ev.id, validDateIds: daysFor(t.data.name, t.validDates, dates) } })];
  }

  /** Refuses changes that only work before anything was ordered (switching between one date, dates and days). */
  private async assertNoOrders(tx: Tx, eventId: string) {
    const orders = await tx.order.count({ where: { eventId } });
    if (orders) {
      throw new ConflictException({ statusCode: 409, code: 'DATE_MODE_LOCKED', message: 'This event has orders, so it can’t switch between one date, multiple dates and a multi-day event.' });
    }
  }

  /**
   * PATCH /organizer/events/:id with dateMode and/or dates. Switching mode needs an event without orders; the dates
   * list is the full list (see UpdateEventDto.dates). Returns the event's dates after the change.
   */
  async update(tx: Tx, ev: { id: string; dateMode: DateMode; seatMap: unknown }, mode: DateMode | undefined, input: DateInput[] | undefined) {
    const target = mode ?? ev.dateMode;
    if (target === 'SINGLE' && input?.length) throw new BadRequestException('Set dateMode to DATES or DAYS to give this event more than one date.');
    if (target !== ev.dateMode) {
      await this.assertNoOrders(tx, ev.id);
      if (target !== 'SINGLE' && !input?.length) throw new BadRequestException(target === 'DAYS' ? 'Add the days of the event.' : 'Add the dates of the event.');
      if (ev.dateMode !== 'SINGLE') await this.toSingle(tx, ev);
      if (target !== 'SINGLE') await this.fromSingle(tx, ev.id, target, planDates(target, input!.map(({ id: _id, ...d }) => d)));
      return tx.eventDate.findMany({ where: { eventId: ev.id }, orderBy: { startsAt: 'asc' } });
    }
    if (target !== 'SINGLE' && input) await this.syncDates(tx, ev.id, target, input);
    return tx.eventDate.findMany({ where: { eventId: ev.id }, orderBy: { startsAt: 'asc' } });
  }

  /** DATES/DAYS → one date: DATES keeps the first date's copies as the ticket types. The event keeps its summary times. */
  private async toSingle(tx: Tx, ev: { id: string; dateMode: DateMode; seatMap: unknown }) {
    const dates = await tx.eventDate.findMany({ where: { eventId: ev.id }, orderBy: { startsAt: 'asc' } });
    if (ev.dateMode === 'DATES') {
      const keep = dates.find(isActive) ?? dates[0];
      const kept = keep ? await tx.ticketType.findMany({ where: { eventId: ev.id, eventDateId: keep.id } }) : [];
      const byTier = new Map(kept.map((t) => [t.tierKey ?? t.id, t.id]));
      await tx.ticketType.updateMany({ where: { id: { in: kept.map((t) => t.id) } }, data: { eventDateId: null, tierKey: null } });
      await tx.ticketType.deleteMany({ where: { eventId: ev.id, eventDateId: { not: null } } });
      const map = remapSections(ev.seatMap as SeatMap | null, (k) => byTier.get(k) ?? k);
      if (map) await tx.event.update({ where: { id: ev.id }, data: { seatMap: map } });
    } else {
      await tx.ticketType.updateMany({ where: { eventId: ev.id }, data: { validDateIds: [] } });
    }
    // The schedule stays, as the one date's (no orders, so no bookings).
    await tx.scheduleItem.updateMany({ where: { eventId: ev.id }, data: { eventDateId: null } });
    await tx.eventDate.deleteMany({ where: { eventId: ev.id } });
    await tx.event.update({ where: { id: ev.id }, data: { dateMode: 'SINGLE' } });
  }

  /** One date → DATES (today's ticket types become the first date's copies) or DAYS (valid on every day). */
  private async fromSingle(tx: Tx, eventId: string, mode: DateMode, planned: PlannedDate[]) {
    const ranks = [...planned].sort(byStart);
    const dates: EventDate[] = [];
    for (const p of planned) dates.push(await tx.eventDate.create({ data: { eventId, startsAt: p.startsAt, doorsAt: p.doorsAt, endsAt: p.endsAt, label: p.label, sortOrder: ranks.indexOf(p) } }));
    const types = await tx.ticketType.findMany({ where: { eventId } });
    const ev = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { seatMap: true } });
    if (mode === 'DATES') {
      const tierOf = new Map<string, string>();
      for (const t of types) {
        const tierKey = newTierKey();
        tierOf.set(t.id, tierKey);
        const first = await tx.ticketType.update({ where: { id: t.id }, data: { tierKey, eventDateId: dates[0].id } });
        for (const d of dates.slice(1)) await tx.ticketType.create({ data: copyOf(first, d.id, first.capacity) });
      }
      const map = remapSections(ev.seatMap as SeatMap | null, (id) => tierOf.get(id) ?? id);
      if (map) await tx.event.update({ where: { id: eventId }, data: { seatMap: map } });
    } else {
      await tx.ticketType.updateMany({ where: { eventId }, data: { validDateIds: dates.map((d) => d.id) } });
    }
    // Schedule items go on the date whose times hold them (else the same calendar day, else the first date).
    for (const i of await tx.scheduleItem.findMany({ where: { eventId, eventDateId: null } })) {
      await tx.scheduleItem.update({ where: { id: i.id }, data: { eventDateId: dateForItem(i, dates)?.id ?? null } });
    }
    await tx.event.update({ where: { id: eventId }, data: { dateMode: mode } });
    await this.syncSummary(tx, eventId);
  }

  /** Applies the full dates list of a DATES/DAYS event: keeps and changes, adds, removes (only without sales). */
  private async syncDates(tx: Tx, eventId: string, mode: DateMode, input: DateInput[]) {
    const existing = await tx.eventDate.findMany({ where: { eventId }, orderBy: { startsAt: 'asc' } });
    const planned = planDates(mode, input, existing);
    const kept = new Set(planned.filter((p) => p.id).map((p) => p.id!));
    const removed = existing.filter((d) => isActive(d) && !kept.has(d.id));
    const types = await tx.ticketType.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc' } });

    // Removing: a date (or day) that has sales must be cancelled instead.
    for (const d of removed) {
      const label = mode === 'DAYS' ? dayLabel(d.startsAt) : dateTimeLabel(d.startsAt);
      if (mode === 'DATES') {
        const copies = types.filter((t) => t.eventDateId === d.id);
        const orders = await tx.order.count({ where: { ticketTypeId: { in: copies.map((t) => t.id) } } });
        if (orders || copies.some((t) => t.sold > 0)) throw new BadRequestException(`${label} has orders, so it can’t be removed. Cancel that date instead.`);
      } else {
        const sold = types.filter((t) => t.validDateIds.includes(d.id) && t.sold > 0);
        if (sold.length) throw new BadRequestException(`${label} can’t be removed: ${sold.map((t) => t.name).join(', ')} ${sold.length === 1 ? 'has' : 'have'} been sold for it.`);
        const orphan = types.filter((t) => t.validDateIds.length && t.validDateIds.every((x) => x === d.id || removed.some((r) => r.id === x)));
        if (orphan.length) throw new BadRequestException(`${orphan.map((t) => t.name).join(', ')} would have no days left. Change ${orphan.length === 1 ? 'its' : 'their'} days first.`);
      }
    }
    for (const d of removed) {
      if (mode === 'DAYS') {
        for (const t of types.filter((x) => x.validDateIds.includes(d.id))) {
          t.validDateIds = t.validDateIds.filter((x) => x !== d.id);
          await tx.ticketType.update({ where: { id: t.id }, data: { validDateIds: t.validDateIds } });
        }
      }
      // DATES: its copies (and their holds) go with it.
      await tx.eventDate.delete({ where: { id: d.id } });
    }

    // Keeping: new times and labels. Adding: a new date, with a copy of every tier (DATES).
    const ranks = [...planned].sort(byStart);
    const tiers = new Map<string, TicketType>();
    if (mode === 'DATES') {
      // One template per tier: its copy on the earliest active date (any copy if none).
      const liveIds = new Set(existing.filter(isActive).map((d) => d.id));
      for (const t of types) {
        const k = t.tierKey ?? t.id;
        const cur = tiers.get(k);
        if (!cur || (!liveIds.has(cur.eventDateId ?? '') && liveIds.has(t.eventDateId ?? ''))) tiers.set(k, t);
      }
    }
    for (const p of planned) {
      const data = { startsAt: p.startsAt, doorsAt: p.doorsAt, endsAt: p.endsAt, label: p.label, sortOrder: ranks.indexOf(p) };
      if (p.id) {
        const old = existing.find((d) => d.id === p.id)!;
        if (isActive(old)) await tx.eventDate.update({ where: { id: p.id }, data });
        continue;
      }
      const d = await tx.eventDate.create({ data: { eventId, ...data } });
      for (const t of tiers.values()) await tx.ticketType.create({ data: copyOf(t, d.id, t.capacity) });
    }
    await this.syncSummary(tx, eventId);
  }
}
