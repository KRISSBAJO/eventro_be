/**
 * Event schedule (agenda) and bookable sessions. The model and rules are in src/domain/schedule.ts; this is the API.
 *
 *   Public     GET  /events/:slug                         adds `schedule` and `stages` (EventsService.detail)
 *   Fans       GET  /me/tickets                           tickets add `sessions` (TicketsService.mine)
 *              GET  /tickets/:id/sessions                 bookable items this ticket could book, with a status each
 *              POST /tickets/:id/sessions/:itemId         book a place (201)
 *              DELETE /tickets/:id/sessions/:itemId       cancel it (204)
 *   Organizers GET  /organizer/events/:id/schedule        (DOOR and up)
 *              PUT  /organizer/events/:id/schedule        full replace (ADMIN, MANAGER)
 *              GET  /organizer/events/:id/schedule/:itemId/reservations[?format=csv]          (DOOR and up)
 *              POST /organizer/events/:id/schedule/:itemId/check-in { code }                   (DOOR and up)
 *              POST|DELETE /organizer/events/:id/schedule/:itemId/reservations/:rid/check-in   (DOOR and up)
 *   Admins     GET  /admin/events/:id/schedule            read-only, with reservation counts
 *
 * Booking takes the ticket's row lock, so one ticket can't book two clashing sessions at once, and takes a place with
 * a conditional increment (`reserved < capacity`), so two fans can't both get the last one. Ticket lifecycle releases
 * live in ./release.ts.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { EventDate, Prisma, ScheduleItem, SessionReservation } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { MailService, render } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import { parseQr, verifyQr } from '../domain/qr';
import { instantToWallClock, wallClockLabel } from '../domain/wallclock';
import { dateName, dateTimeLabel, dayLabel, type DateMode } from '../domain/event-dates';
import { overlaps, placesLeft, ticketOnDate, tierOf, type BookingTicket } from '../domain/schedule';
import { DOOR_ROLES, EDIT_ROLES, eventForRole } from '../organizer/access';
import { resolveRef, planDates } from '../organizer/event-dates';
import { ScheduleDto, SessionCheckInDto, type CreateEventDto } from '../organizer/organizer.dto';
import { planSchedule, type PlannedItem, type PlanContext } from './plan';
import { releaseReservationIds } from './release';

type Tx = Prisma.TransactionClient;
type TypeRow = { id: string; name: string; tierKey: string | null; validDateIds: string[] };
type SessionStatus = 'BOOKED' | 'OPEN' | 'FULL' | 'CLOSED' | 'NOT_ELIGIBLE' | 'CLASH';
type Holder = { reservationId: string; ticketId: string; ownerId: string | null; holderEmail: string; holderName: string };
type Change = { item: ScheduleItem; was?: { startsAt: Date; endsAt: Date | null }; holders: Holder[] };
/** A schedule planned before its event exists (create): dates and tiers are still indexes. */
export type CreatedSchedulePlan = { items: PlannedItem[]; planned: { startsAt: Date }[] | null };

/** Names of the tiers items are limited to: TicketType ids and tier keys both map to the tier's name. */
function tierNames(types: TypeRow[]) {
  const m = new Map<string, string>();
  for (const t of types) {
    m.set(t.id, t.name);
    if (t.tierKey && !m.has(t.tierKey)) m.set(t.tierKey, t.name);
  }
  return m;
}

/** An item as fans see it (event page, ticket screens). */
export function itemView(i: ScheduleItem, names: Map<string, string>) {
  return {
    id: i.id,
    eventDateId: i.eventDateId,
    startsAt: i.startsAt,
    endsAt: i.endsAt,
    title: i.title,
    note: i.note,
    stage: i.stage,
    people: i.people,
    kind: i.kind,
    bookable: i.bookable,
    capacity: i.bookable ? i.capacity : null,
    placesLeft: placesLeft(i),
    // empty = any ticket for that date or day
    eligibleTierNames: i.eligibleTiers.map((k) => names.get(k)).filter((n): n is string => !!n),
  };
}

/** The same with what organizers edit and count. */
function organizerView(i: ScheduleItem, names: Map<string, string>, checkedIn: number) {
  // A tier deleted since is left out, so the list can be sent back as it is.
  return { ...itemView(i, names), sortOrder: i.sortOrder, eligibleTiers: i.eligibleTiers.filter((k) => names.has(k)), reserved: i.reserved, checkedIn };
}

const reservationView = (r: SessionReservation) => ({ id: r.id, itemId: r.scheduleItemId, ticketId: r.ticketId, createdAt: r.createdAt, checkedInAt: r.checkedInAt });

/** Cells for the reservations CSV: quoted, and never read as a formula by spreadsheets. */
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

@Injectable()
export class ScheduleService {
  private readonly log = new Logger('Schedule');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /* ---------- reading ---------- */

  /** The event's live items: not removed, and not on a cancelled date. */
  private async liveItems(eventId: string, dates: { id: string; status: string }[], db: Tx | PrismaService = this.prisma) {
    const off = new Set(dates.filter((d) => d.status === 'CANCELLED').map((d) => d.id));
    const rows = await db.scheduleItem.findMany({ where: { eventId, cancelledAt: null }, orderBy: [{ startsAt: 'asc' }, { sortOrder: 'asc' }] });
    return rows.filter((i) => !i.eventDateId || !off.has(i.eventDateId));
  }

  /** Session check-ins per item (active reservations let in). */
  private async checkedInCounts(itemIds: string[]) {
    if (!itemIds.length) return new Map<string, number>();
    const rows = await this.prisma.sessionReservation.groupBy({ by: ['scheduleItemId'], where: { scheduleItemId: { in: itemIds }, cancelledAt: null, checkedInAt: { not: null } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.scheduleItemId, r._count._all]));
  }

  /** `schedule` and `stages` for GET /events/:slug. Empty for events without a schedule. */
  async publicView(e: { id: string; dates: { id: string; status: string }[]; ticketTypes: TypeRow[] }) {
    const items = await this.liveItems(e.id, e.dates);
    const names = tierNames(e.ticketTypes);
    const stages: string[] = [];
    for (const i of items) if (i.stage && !stages.includes(i.stage)) stages.push(i.stage);
    return { schedule: items.map((i) => itemView(i, names)), stages };
  }

  /** The schedule with booking counts, for organizers and Eventro admins. */
  private async fullView(e: { id: string; dates: { id: string; status: string }[]; ticketTypes: TypeRow[] }) {
    const items = await this.liveItems(e.id, e.dates);
    const inCounts = await this.checkedInCounts(items.map((i) => i.id));
    const names = tierNames(e.ticketTypes);
    return items.map((i) => organizerView(i, names, inCounts.get(i.id) ?? 0));
  }

  async organizerList(eventId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    return { items: await this.fullView(ev) };
  }

  async adminList(eventId: string) {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId }, include: { dates: true, ticketTypes: { select: { id: true, name: true, tierKey: true, validDateIds: true } } } });
    if (!ev) throw new NotFoundException('Event not found.');
    return { items: await this.fullView(ev) };
  }

  /** Stats: each bookable item with places and check-ins ([] without bookable items). */
  async statsSessions(eventId: string, dates: { id: string; status: string }[]) {
    const items = (await this.liveItems(eventId, dates)).filter((i) => i.bookable);
    const inCounts = await this.checkedInCounts(items.map((i) => i.id));
    return items.map((i) => ({ itemId: i.id, title: i.title, startsAt: i.startsAt, capacity: i.capacity, reserved: i.reserved, checkedIn: inCounts.get(i.id) ?? 0 }));
  }

  /** `/me/tickets`: each ticket's booked sessions (active reservations on live items), by ticket id. */
  async sessionsByTicket(ticketIds: string[]) {
    const out = new Map<string, { reservationId: string; itemId: string; title: string; startsAt: Date; endsAt: Date | null; stage: string | null; checkedIn: boolean }[]>();
    if (!ticketIds.length) return out;
    const rows = await this.prisma.sessionReservation.findMany({
      where: { ticketId: { in: ticketIds }, cancelledAt: null, item: { cancelledAt: null } },
      include: { item: { select: { id: true, title: true, startsAt: true, endsAt: true, stage: true } } },
      orderBy: { item: { startsAt: 'asc' } },
    });
    for (const r of rows) {
      const list = out.get(r.ticketId) ?? [];
      list.push({ reservationId: r.id, itemId: r.item.id, title: r.item.title, startsAt: r.item.startsAt, endsAt: r.item.endsAt, stage: r.item.stage, checkedIn: !!r.checkedInAt });
      out.set(r.ticketId, list);
    }
    return out;
  }

  /* ---------- organizers: editing ---------- */

  /** How ticket-type refs resolve on an existing event: TicketType ids, and for DATES tier keys (any copy id works too). */
  private tierContext(mode: string, types: TypeRow[]): Pick<PlanContext, 'tier' | 'tierInfo'> {
    return {
      tier: (ref) => {
        const t = types.find((x) => x.id === ref || (mode === 'DATES' && x.tierKey === ref));
        return t ? (mode === 'DATES' ? (t.tierKey ?? t.id) : t.id) : null;
      },
      tierInfo: (key) => {
        const t = types.find((x) => x.id === key || x.tierKey === key)!;
        return { name: t.name, validDateIds: t.validDateIds };
      },
    };
  }

  /**
   * Create event with `schedule`: checks it before the event is made (dates and tiers as indexes into what was sent),
   * so a bad schedule creates nothing.
   */
  planForCreate(dto: CreateEventDto): CreatedSchedulePlan {
    const mode: DateMode = dto.dateMode ?? 'SINGLE';
    const planned = mode === 'SINGLE' ? null : planDates(mode, dto.dates);
    const dates = (planned ?? []).map((p, i) => ({ id: String(i), startsAt: p.startsAt, doorsAt: p.doorsAt, endsAt: p.endsAt, status: 'ACTIVE' }));
    const at = (s?: string) => (s ? new Date(s) : null);
    const items = planSchedule(dto.schedule ?? [], {
      mode,
      event: { startsAt: new Date(dto.startsAt), doorsAt: at(dto.doorsAt), endsAt: at(dto.endsAt) },
      dates,
      byIndex: true,
      tier: (ref) => (/^\d{1,2}$/.test(ref) && Number(ref) < dto.ticketTypes.length ? String(Number(ref)) : null),
      tierInfo: (key) => {
        const t = dto.ticketTypes[Number(key)];
        const validDateIds = mode === 'DAYS' ? (t.validDates ?? []).map((r) => resolveRef(r, dates)).filter((x): x is string => !!x) : [];
        return { name: t.name.trim(), validDateIds };
      },
    });
    return { items, planned };
  }

  /** Stores a schedule planned at create time, now that the event's dates and ticket types exist. */
  async insertCreated(eventId: string, plan: CreatedSchedulePlan) {
    const ev = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId }, include: { dates: true, ticketTypes: { select: { id: true, name: true, tierKey: true, validDateIds: true, sortOrder: true } } } });
    // Dates by their start (distinct within an event), tiers by their position as sent (sortOrder).
    const dateAt = (i: string) => ev.dates.find((d) => d.startsAt.getTime() === plan.planned![Number(i)].startsAt.getTime())!.id;
    const tierAt = (i: string) => {
      const t = ev.ticketTypes.find((x) => x.sortOrder === Number(i))!;
      return ev.dateMode === 'DATES' ? (t.tierKey ?? t.id) : t.id;
    };
    await this.prisma.scheduleItem.createMany({
      data: plan.items.map(({ id: _id, ...p }) => ({ ...p, eventId, eventDateId: p.eventDateId === null ? null : dateAt(p.eventDateId), eligibleTiers: p.eligibleTiers.map(tierAt) })),
    });
    return this.fullView(ev);
  }

  /**
   * PUT /organizer/events/:id/schedule: the full list. Items with `id` are kept and changed, new ones added, the rest
   * removed. Removing a bookable item with bookings (or turning booking off) releases them and tells the holders; a
   * new time on a booked item tells them too. Capacity can't go below the places booked, and a booked item can't move
   * to another date. Items on a cancelled date are left as they are.
   */
  async replace(eventId: string, user: AuthUser, dto: ScheduleDto) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    const tiers = this.tierContext(ev.dateMode, ev.ticketTypes);
    const out = await this.prisma.$transaction(
      async (tx) => {
        // Bookings wait for this to finish (they update the same rows), so `reserved` can't move under the checks.
        await tx.$queryRaw`SELECT id FROM "ScheduleItem" WHERE "eventId" = ${eventId} AND "cancelledAt" IS NULL FOR UPDATE`;
        const current = await this.liveItems(eventId, ev.dates, tx);
        const byId = new Map(current.map((i) => [i.id, i]));
        const plan = planSchedule(dto.items, { mode: ev.dateMode, event: ev, dates: ev.dates, existing: new Set(byId.keys()), ...tiers });

        const cancelled: ScheduleItem[] = [];
        const moved: { item: ScheduleItem; was: { startsAt: Date; endsAt: Date | null } }[] = [];
        for (const p of plan) {
          const old = p.id ? byId.get(p.id) : undefined;
          if (!old || old.reserved === 0) continue;
          if (!p.bookable) {
            cancelled.push(old);
            continue;
          }
          if (p.capacity! < old.reserved) {
            throw new ConflictException({ statusCode: 409, code: 'CAPACITY_BELOW_RESERVED', message: `${old.title} has ${old.reserved} place${old.reserved === 1 ? '' : 's'} booked, so it needs at least ${old.reserved}.` });
          }
          if (p.eventDateId !== old.eventDateId) {
            throw new ConflictException({ statusCode: 409, code: 'ITEM_HAS_BOOKINGS', message: `${old.title} has bookings, so it can’t move to another date. Remove it and add a new one instead.` });
          }
          const sameTimes = p.startsAt.getTime() === old.startsAt.getTime() && (p.endsAt?.getTime() ?? null) === (old.endsAt?.getTime() ?? null);
          if (!sameTimes) moved.push({ item: old, was: { startsAt: old.startsAt, endsAt: old.endsAt } });
        }
        const kept = new Set(plan.filter((p) => p.id).map((p) => p.id!));
        const removed = current.filter((i) => !kept.has(i.id));
        cancelled.push(...removed.filter((i) => i.reserved > 0));

        // Who to tell, read before their reservations are released.
        const holdersOf = async (itemIds: string[]) => {
          if (!itemIds.length) return new Map<string, Holder[]>();
          const rows = await tx.sessionReservation.findMany({
            where: { scheduleItemId: { in: itemIds }, cancelledAt: null },
            select: { id: true, scheduleItemId: true, ticket: { select: { id: true, ownerId: true, holderEmail: true, holderName: true } } },
          });
          const m = new Map<string, Holder[]>();
          for (const r of rows) m.set(r.scheduleItemId, [...(m.get(r.scheduleItemId) ?? []), { reservationId: r.id, ticketId: r.ticket.id, ownerId: r.ticket.ownerId, holderEmail: r.ticket.holderEmail, holderName: r.ticket.holderName }]);
          return m;
        };
        const cancelHolders = await holdersOf(cancelled.map((i) => i.id));
        const moveHolders = await holdersOf(moved.map((m) => m.item.id));
        const released = await releaseReservationIds(tx, [...cancelHolders.values()].flat().map((h) => h.reservationId));

        // Removed: kept as cancelled when it had bookings (its holders were told), else deleted.
        const withBookings = new Set(cancelled.map((i) => i.id));
        const gone = removed.filter((i) => !withBookings.has(i.id)).map((i) => i.id);
        if (gone.length) await tx.scheduleItem.deleteMany({ where: { id: { in: gone } } });
        const soft = removed.filter((i) => withBookings.has(i.id)).map((i) => i.id);
        if (soft.length) await tx.scheduleItem.updateMany({ where: { id: { in: soft } }, data: { cancelledAt: new Date() } });

        for (const { id, ...p } of plan) {
          if (id) await tx.scheduleItem.update({ where: { id }, data: p });
          else await tx.scheduleItem.create({ data: { ...p, eventId } });
        }
        const after = await this.liveItems(eventId, ev.dates, tx);
        const changes: { cancelled: Change[]; moved: Change[] } = {
          cancelled: cancelled.map((item) => ({ item, holders: cancelHolders.get(item.id) ?? [] })),
          moved: moved.map((m) => ({ item: after.find((i) => i.id === m.item.id)!, was: m.was, holders: moveHolders.get(m.item.id) ?? [] })),
        };
        return { plan, removed, released, changes, added: plan.filter((p) => !p.id).length };
      },
      { timeout: 30_000 },
    );

    const notified = await this.tellHolders({ id: ev.id, title: ev.title, orgName: ev.org.name }, out.changes);
    await this.audit.log(user.id, 'schedule.update', 'Event', eventId, {
      items: out.plan.length,
      added: out.added,
      removed: out.removed.length,
      cancelledSessions: out.changes.cancelled.map((c) => c.item.id),
      movedSessions: out.changes.moved.map((c) => c.item.id),
      released: out.released,
      notified,
    });
    return { items: await this.fullView(ev), notified };
  }

  /**
   * Emails and pushes holders of sessions that were cancelled or moved. Returns how many people (holder emails) were
   * told. Emails and pushes never fail the change that caused them.
   */
  private async tellHolders(e: { id: string; title: string; orgName: string }, changes: { cancelled: Change[]; moved: Change[] }) {
    const told = new Set<string>();
    const mails: { kind: string; to: string; subject: string; html: string; text: string }[] = [];
    for (const kind of ['cancelled', 'moved'] as const) {
      for (const c of changes[kind]) {
        const seen = new Set<string>();
        for (const h of c.holders) {
          const to = h.holderEmail.trim().toLowerCase();
          told.add(to);
          if (seen.has(to)) continue;
          seen.add(to);
          const when = dateTimeLabel(c.item.startsAt);
          const copy =
            kind === 'cancelled'
              ? render({
                  preheader: `${c.item.title} at ${e.title} was cancelled.`,
                  heading: `Session cancelled: ${c.item.title}`,
                  paragraphs: [`Hi ${first(h.holderName)}, ${e.orgName} cancelled ${c.item.title} (${when}) at ${e.title}, so your booking for it has been released.`, `Your ticket for ${e.title} still works as before.`],
                  cta: { label: 'See your tickets', url: `${config.webUrl}/tickets` },
                  footer: 'You’re getting this because you booked this session with your Eventro ticket.',
                })
              : render({
                  preheader: `${c.item.title} at ${e.title} has a new time.`,
                  heading: `Session moved: ${c.item.title}`,
                  paragraphs: [
                    `Hi ${first(h.holderName)}, ${c.item.title} at ${e.title} has moved to ${when} (it was ${dateTimeLabel(c.was!.startsAt)}).`,
                    'Your place is still booked. Can’t make the new time? Cancel your booking in your tickets so someone else can have the place.',
                  ],
                  cta: { label: 'See your tickets', url: `${config.webUrl}/tickets` },
                  footer: 'You’re getting this because you booked this session with your Eventro ticket.',
                });
          mails.push({ kind: `session.${kind}`, to, subject: `Session ${kind}: ${c.item.title}`, ...copy });
        }
        void this.notices.sessionChanged(kind, e, c.item, c.holders);
      }
    }
    for (const kind of ['session.cancelled', 'session.moved']) {
      const batch = mails.filter((m) => m.kind === kind).map(({ kind: _k, ...m }) => m);
      if (batch.length) void this.mail.sendMany(kind, batch).catch((err) => this.log.warn(`${kind} emails for ${e.id}: ${(err as Error).message}`));
    }
    return told.size;
  }

  /* ---------- organizers: bookings and session check-in ---------- */

  private async bookableItem(eventId: string, itemId: string) {
    const item = await this.prisma.scheduleItem.findUnique({ where: { id: itemId } });
    if (!item || item.eventId !== eventId || item.cancelledAt || !item.bookable) throw new NotFoundException('Session not found.');
    return item;
  }

  async reservations(eventId: string, itemId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const item = await this.bookableItem(eventId, itemId);
    const rows = await this.prisma.sessionReservation.findMany({
      where: { scheduleItemId: itemId, cancelledAt: null },
      include: { ticket: { select: { id: true, holderName: true, holderEmail: true, ticketType: { select: { name: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    const inCount = rows.filter((r) => r.checkedInAt).length;
    return {
      item: organizerView(item, tierNames(ev.ticketTypes), inCount),
      items: rows.map((r) => ({ reservationId: r.id, ticketId: r.ticket.id, holderName: r.ticket.holderName, holderEmail: r.ticket.holderEmail, ticketType: r.ticket.ticketType.name, createdAt: r.createdAt, checkedInAt: r.checkedInAt })),
    };
  }

  async reservationsCsv(eventId: string, itemId: string, user: AuthUser) {
    const r = await this.reservations(eventId, itemId, user);
    const head = ['Name', 'Email', 'Ticket', 'Ticket type', 'Booked at', 'Checked in at'];
    const rows = r.items.map((x) => [x.holderName, x.holderEmail, x.ticketId, x.ticketType, x.createdAt.toISOString(), x.checkedInAt?.toISOString() ?? '']);
    return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  /** Lets a booking in (conditional, so two phones can't both admit it): ADMIT, or ALREADY_IN with the first time. */
  private async admit(r: SessionReservation, userId: string, timezone: string) {
    const at = new Date();
    const { count } = await this.prisma.sessionReservation.updateMany({ where: { id: r.id, cancelledAt: null, checkedInAt: null }, data: { checkedInAt: at, checkedInBy: userId } });
    const fresh = await this.prisma.sessionReservation.findUniqueOrThrow({ where: { id: r.id } });
    return count ? { result: 'ADMIT' as const, message: 'Booked: let them in.', reservation: reservationView(fresh) } : { result: 'ALREADY_IN' as const, message: `Already checked in to this session at ${wallClockLabel(instantToWallClock(fresh.checkedInAt ?? new Date(), timezone), { hour: 'numeric', minute: '2-digit' })}.`, reservation: reservationView(fresh) };
  }

  /**
   * Session check-in by the ticket's QR code or number (DOOR and up). Results: ADMIT (booked here, let in now),
   * ALREADY_IN, NOT_BOOKED (a valid ticket without a booking here), WRONG_DATE (the ticket isn't for this item's date or
   * day) and INVALID (unknown, expired or void code). Separate from the event's door check-in; needs a connection.
   */
  async checkInCode(eventId: string, itemId: string, user: AuthUser, code: string) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const item = await this.bookableItem(eventId, itemId);
    const raw = code.trim();
    let ticketId = raw.toUpperCase();
    const invalid = (message: string) => ({ result: 'INVALID' as const, message });
    if (raw.includes('.')) {
      const p = parseQr(raw);
      if (!p.ok) return invalid('Not a valid Eventro code.');
      const owner = await this.prisma.ticket.findUnique({ where: { id: p.ticketId }, select: { qrVersion: true } });
      if (!owner) return invalid('Not a valid Eventro code.');
      const v = verifyQr(config.qrSecret, raw, Date.now(), owner.qrVersion);
      if (!v.ok) return invalid(v.reason === 'expired' ? 'This code has expired. Ask them to reopen the ticket.' : 'Not a valid Eventro code.');
      ticketId = v.ticketId;
    }
    const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { ticketType: { select: { name: true, tierKey: true, validDateIds: true } } } });
    if (!t) return invalid('Ticket not found.');
    const ticket = { id: t.id, holderName: t.holderName, ticketType: t.ticketType.name, eventDateId: t.eventDateId };
    if (t.eventId !== eventId) return { ...invalid('This ticket is for a different event.'), ticket };
    if (t.status === 'VOID') return { ...invalid('This ticket was refunded or cancelled.'), ticket };
    if (t.status === 'TRANSFER_PENDING') return { ...invalid('This ticket is being transferred.'), ticket };
    if (!ticketOnDate(ev.dateMode, t, item)) {
      const own = ev.dates.find((d) => d.id === t.eventDateId);
      const day = ev.dates.find((d) => d.id === item.eventDateId);
      const message = ev.dateMode === 'DATES' ? (own ? `This ticket is for ${dateName(own)}.` : 'This ticket is for another date.') : `This pass isn’t valid on ${day ? dayLabel(day.startsAt) : 'this day'}.`;
      return { result: 'WRONG_DATE' as const, message, ticket };
    }
    const r = await this.prisma.sessionReservation.findUnique({ where: { scheduleItemId_ticketId: { scheduleItemId: itemId, ticketId: t.id } } });
    if (!r || r.cancelledAt) return { result: 'NOT_BOOKED' as const, message: 'Not booked for this session.', ticket };
    return { ...(await this.admit(r, user.id, ev.timezone)), ticket };
  }

  private async reservationOf(itemId: string, reservationId: string) {
    const r = await this.prisma.sessionReservation.findUnique({ where: { id: reservationId }, include: { ticket: { select: { id: true, holderName: true, eventDateId: true, ticketType: { select: { name: true } } } } } });
    if (!r || r.scheduleItemId !== itemId || r.cancelledAt) throw new NotFoundException('Booking not found.');
    return r;
  }

  /** Check-in by tapping a name in the reservations list. */
  async checkInReservation(eventId: string, itemId: string, reservationId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    await this.bookableItem(eventId, itemId);
    const r = await this.reservationOf(itemId, reservationId);
    const ticket = { id: r.ticket.id, holderName: r.ticket.holderName, ticketType: r.ticket.ticketType.name, eventDateId: r.ticket.eventDateId };
    return { ...(await this.admit(r, user.id, ev.timezone)), ticket };
  }

  /** Takes back a session check-in made by mistake (audited). */
  async undoCheckIn(eventId: string, itemId: string, reservationId: string, user: AuthUser) {
    await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    await this.bookableItem(eventId, itemId);
    const r = await this.reservationOf(itemId, reservationId);
    if (!r.checkedInAt) throw new BadRequestException('This booking hasn’t been checked in.');
    await this.prisma.sessionReservation.update({ where: { id: r.id }, data: { checkedInAt: null, checkedInBy: null } });
    await this.audit.log(user.id, 'session.check_in_undo', 'SessionReservation', r.id, { eventId, itemId, ticketId: r.ticketId });
    return { reservation: reservationView(await this.prisma.sessionReservation.findUniqueOrThrow({ where: { id: r.id } })) };
  }

  /* ---------- fans ---------- */

  /** The ticket, if it's this account's (owner, or the holder's email), with what booking checks need. */
  private async ticketFor(ticketId: string, user: AuthUser, db: Tx | PrismaService = this.prisma) {
    const t = await db.ticket.findUnique({
      where: { id: ticketId },
      include: {
        ticketType: { select: { name: true, tierKey: true, validDateIds: true } },
        event: { select: { id: true, title: true, dateMode: true, timezone: true, dates: true, ticketTypes: { select: { id: true, name: true, tierKey: true, validDateIds: true } } } },
      },
    });
    if (!t || (t.ownerId !== user.id && t.holderEmail !== user.email)) throw new NotFoundException('Ticket not found.');
    return t;
  }

  /** Why this ticket can't book this item, or null. */
  private whyNot(mode: string, dates: EventDate[], t: BookingTicket & { status: string }, item: ScheduleItem, names: Map<string, string>) {
    if (t.status === 'VOID') return 'This ticket was refunded or cancelled.';
    if (t.status === 'LISTED') return 'This ticket is listed for resale. Take it off resale to book.';
    if (t.status === 'TRANSFER_PENDING') return 'This ticket is being transferred.';
    if (!ticketOnDate(mode, t, item)) {
      const own = dates.find((d) => d.id === t.eventDateId);
      const day = dates.find((d) => d.id === item.eventDateId);
      return mode === 'DATES' ? (own ? `This ticket is for ${dateName(own)}.` : 'This ticket is for another date.') : `Your pass isn’t valid on ${day ? dayLabel(day.startsAt) : 'that day'}.`;
    }
    if (item.eligibleTiers.length && !item.eligibleTiers.includes(tierOf(mode, t))) {
      const allowed = item.eligibleTiers.map((k) => names.get(k)).filter(Boolean);
      return `Only for ${allowed.join(', ') || 'some'} tickets.`;
    }
    return null;
  }

  /** Booking closes when the item starts (at the venue). */
  private started(item: { startsAt: Date }, timezone: string) {
    return item.startsAt <= instantToWallClock(new Date(), timezone);
  }

  /**
   * GET /tickets/:id/sessions: the bookable items on this ticket's date (DATES), days (DAYS) or event, each with its
   * status for this ticket (BOOKED, OPEN, FULL, CLOSED, NOT_ELIGIBLE with `reason`, CLASH with `reason`).
   */
  async forTicket(ticketId: string, user: AuthUser) {
    const t = await this.ticketFor(ticketId, user);
    const ev = t.event;
    const names = tierNames(ev.ticketTypes);
    const items = (await this.liveItems(ev.id, ev.dates)).filter((i) => i.bookable && ticketOnDate(ev.dateMode, t, i));
    const mine = await this.prisma.sessionReservation.findMany({ where: { ticketId, cancelledAt: null, item: { cancelledAt: null } }, include: { item: true } });
    return {
      ticketId,
      items: items.map((i) => {
        const r = mine.find((m) => m.scheduleItemId === i.id);
        const why = r ? null : this.whyNot(ev.dateMode, ev.dates, t, i, names);
        const clash = r ? null : mine.find((m) => m.item.bookable && overlaps(m.item, i));
        let status: SessionStatus = 'OPEN';
        let reason: string | null = null;
        if (r) status = 'BOOKED';
        else if (this.started(i, ev.timezone)) status = 'CLOSED';
        else if (why) [status, reason] = ['NOT_ELIGIBLE', why];
        else if (placesLeft(i) === 0) status = 'FULL';
        else if (clash) [status, reason] = ['CLASH', `You’ve booked ${clash.item.title} at that time.`];
        return { ...itemView(i, names), status, reason, reservationId: r?.id ?? null, checkedIn: !!r?.checkedInAt };
      }),
    };
  }

  /** POST /tickets/:id/sessions/:itemId: reserves a place (booking the same item again returns the booking). */
  async book(ticketId: string, itemId: string, user: AuthUser) {
    const t0 = await this.ticketFor(ticketId, user);
    const item = await this.prisma.scheduleItem.findUnique({ where: { id: itemId } });
    const dateOff = t0.event.dates.some((d) => d.id === item?.eventDateId && d.status === 'CANCELLED');
    if (!item || item.eventId !== t0.eventId || item.cancelledAt || !item.bookable || dateOff) throw new NotFoundException('Session not found.');
    const names = tierNames(t0.event.ticketTypes);
    const r = await this.prisma.$transaction(async (tx) => {
      // One booking at a time per ticket (clash checks), and after any void or transfer that's under way.
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticketId} FOR UPDATE`;
      const t = await this.ticketFor(ticketId, user, tx);
      const existing = await tx.sessionReservation.findUnique({ where: { scheduleItemId_ticketId: { scheduleItemId: itemId, ticketId } } });
      if (existing && !existing.cancelledAt) return existing;
      const why = this.whyNot(t.event.dateMode, t.event.dates, t, item, names);
      if (why) throw new ForbiddenException({ statusCode: 403, code: 'NOT_ELIGIBLE', message: why });
      if (this.started(item, t.event.timezone)) throw new ConflictException({ statusCode: 409, code: 'CLOSED', message: 'Booking closed when this session started.' });
      const mine = await tx.sessionReservation.findMany({ where: { ticketId, cancelledAt: null, item: { cancelledAt: null, bookable: true } }, include: { item: true } });
      const clash = mine.find((m) => m.scheduleItemId !== itemId && overlaps(m.item, item));
      if (clash) throw new ConflictException({ statusCode: 409, code: 'CLASH', message: `You’ve booked ${clash.item.title} at that time.` });
      const took = await tx.$executeRaw`UPDATE "ScheduleItem" SET reserved = reserved + 1 WHERE id = ${itemId} AND bookable AND "cancelledAt" IS NULL AND reserved < capacity`;
      if (!took) throw new ConflictException({ statusCode: 409, code: 'FULL', message: 'This session is full.' });
      const data = { userId: user.id, cancelledAt: null, checkedInAt: null, checkedInBy: null, createdAt: new Date() };
      return existing ? tx.sessionReservation.update({ where: { id: existing.id }, data }) : tx.sessionReservation.create({ data: { ...data, scheduleItemId: itemId, ticketId } });
    });
    return { ...reservationView(r), item: itemView((await this.prisma.scheduleItem.findUniqueOrThrow({ where: { id: itemId } })), names) };
  }

  /** DELETE /tickets/:id/sessions/:itemId: gives the place back, until the session starts. */
  async cancel(ticketId: string, itemId: string, user: AuthUser) {
    const t = await this.ticketFor(ticketId, user);
    const item = await this.prisma.scheduleItem.findUnique({ where: { id: itemId } });
    if (!item || item.eventId !== t.eventId) throw new NotFoundException('Session not found.');
    const r = await this.prisma.sessionReservation.findUnique({ where: { scheduleItemId_ticketId: { scheduleItemId: itemId, ticketId } } });
    if (!r || r.cancelledAt) throw new NotFoundException('You haven’t booked this session.');
    if (this.started(item, t.event.timezone)) throw new ConflictException({ statusCode: 409, code: 'CLOSED', message: 'This session has started, so the booking can’t be cancelled.' });
    await releaseReservationIds(this.prisma, [r.id]);
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets/:id/sessions')
export class TicketSessionsController {
  constructor(private readonly svc: ScheduleService) {}

  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.forTicket(id, u);
  }
  @Post(':itemId') book(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() u: AuthUser) {
    return this.svc.book(id, itemId, u);
  }
  @Delete(':itemId') @HttpCode(204) async cancel(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() u: AuthUser) {
    await this.svc.cancel(id, itemId, u);
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id/schedule')
export class OrganizerScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.organizerList(id, u);
  }
  @Put() replace(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ScheduleDto) {
    return this.svc.replace(id, u, dto);
  }
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @Get(':itemId/reservations') async reservations(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response, @Query('format') format?: string) {
    if (format !== 'csv') return this.svc.reservations(id, itemId, u);
    const csv = await this.svc.reservationsCsv(id, itemId, u);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="session-bookings.csv"');
    return csv;
  }
  @Post(':itemId/check-in') @HttpCode(200) checkIn(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() u: AuthUser, @Body() dto: SessionCheckInDto) {
    return this.svc.checkInCode(id, itemId, u, dto.code);
  }
  @Post(':itemId/reservations/:reservationId/check-in') @HttpCode(200) checkInOne(@Param('id') id: string, @Param('itemId') itemId: string, @Param('reservationId') rid: string, @CurrentUser() u: AuthUser) {
    return this.svc.checkInReservation(id, itemId, rid, u);
  }
  @Delete(':itemId/reservations/:reservationId/check-in') undo(@Param('id') id: string, @Param('itemId') itemId: string, @Param('reservationId') rid: string, @CurrentUser() u: AuthUser) {
    return this.svc.undoCheckIn(id, itemId, rid, u);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/events/:id/schedule')
export class AdminScheduleController {
  constructor(private readonly svc: ScheduleService) {}

  /** Read-only: the event's schedule with booking counts. */
  @Get() list(@Param('id') id: string) {
    return this.svc.adminList(id);
  }
}

/** Global: events, tickets and organizer services read and write schedules through ScheduleService. */
@Global()
@Module({ controllers: [TicketSessionsController, OrganizerScheduleController, AdminScheduleController], providers: [ScheduleService], exports: [ScheduleService] })
export class ScheduleModule {}
