/**
 * What Omoshow tells fans by push, and when. Each method finds who should hear (people with an account), builds
 * the message with a deep link (`data.url` is `eventro://<path>`, `data.path` the same path as on the website) and
 * hands it to PushService, which checks each person's choices and never sends a deduplicated message twice.
 *
 *   order.paid               buyer                 orders      order.paid:<orderId>
 *   ticket.transfer          recipient             tickets     ticket.transfer:<ticketId>:<transferExpiresAt ms>
 *   ticket.accepted          sender                tickets     ticket.accepted:<ticketId>:<qrVersion>
 *   gift.delivered           recipient             tickets     gift.delivered:<giftId>
 *   resale.sold              seller                orders      resale.sold:<listingId>
 *   price_drop               watchers              priceDrops  price_drop:<dropId>:<userId>
 *   follow.new_event         followers             following   follow.new_event:<eventId>:<userId>
 *   event.cancelled          ticket holders        orders      event.cancelled:<eventId>:<userId>
 *   event.date_cancelled     the date's holders   orders      event.date_cancelled:<dateId>:<userId>
 *   event.venue              ticket holders        orders      event.venue:<eventId>:<changeId>:<userId>
 *   reminder.day            holders of ACTIVE     reminders   reminder.day:<eventId>:<userId>   (per date: reminder.day:<eventId>:<dateId>:<userId>)
 *   reminder.doors           holders of ACTIVE     reminders   reminder.doors:<eventId>:<userId>
 *   order.sale               org admins, managers  sales       order.sale:<orderId>:<userId>
 *   guarantee.<kind>         claimant              orders      guarantee.<kind>:<claimId>   (received, approved, declined, refunded)
 *   session.cancelled        holders who booked    tickets     session.cancelled:<itemId>:<userId>
 *   session.moved            holders who booked    tickets     session.moved:<itemId>:<startsAt ms>:<userId>
 *
 * Every method swallows its own errors (logged), so callers can `void` them.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { formatMoney } from '../mail/mail.module';
import { wallClockLabel, wallClockToInstant } from '../domain/wallclock';
import { PushService, type PushMessage } from './push.service';
import { ticketTimes } from '../domain/event-dates';

const HOUR = 3600_000;
const first = (name: string) => name.trim().split(/\s+/)[0] || name;
/** `/tickets/X` → { url: 'eventro://tickets/X', path: '/tickets/X' } */
const link = (path: string, extra: Record<string, unknown> = {}) => ({ url: `eventro:/${path}`, path, ...extra });

/** "Tomorrow" goes out when the start is 20–24 hours away; "doors open soon" in the hour before doors. */
export const DAY_REMINDER_FROM_MS = 20 * HOUR;
export const DAY_REMINDER_TO_MS = 24 * HOUR;
export const DOORS_REMINDER_MS = HOUR;

@Injectable()
export class NoticeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notices');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  /** Reminders run every 5 minutes (not in tests, which call `sendReminders` directly). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.sendReminders(), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async guard(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.log.warn(`${what}: ${(e as Error).message}`);
    }
  }

  private async usersByEmail(emails: string[]) {
    if (!emails.length) return new Map<string, string>();
    const rows = await this.prisma.user.findMany({ where: { email: { in: [...new Set(emails)] } }, select: { id: true, email: true } });
    return new Map(rows.map((r) => [r.email, r.id]));
  }

  /** "You're going to <event>": to the buyer's account, opening the (first) ticket. */
  orderPaid(orderId: string) {
    return this.guard(`order.paid ${orderId}`, async () => {
      const o = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { event: { select: { id: true, title: true, startsAt: true, doorsAt: true, endsAt: true, dateMode: true, dates: true } }, ticketType: { select: { name: true, eventDateId: true, validDateIds: true } }, tickets: { select: { id: true }, orderBy: { id: 'asc' }, take: 1 }, gift: true },
      });
      if (!o || o.status !== 'PAID') return;
      const buyerId = o.buyerId ?? (await this.usersByEmail([o.email])).get(o.email);
      if (!buyerId) return;
      const ticketId = o.tickets[0]?.id;
      // The tickets' own date (multiple dates) or first day (multi-day).
      const when = wallClockLabel(ticketTimes(o.event.dateMode, o.event, o.ticketType, o.event.dates).first.startsAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const msg: PushMessage = o.gift
        ? {
            userId: buyerId,
            title: `Gift booked: ${o.event.title}`,
            body: o.gift.sendAt > new Date() ? `We’ll deliver it to ${first(o.gift.recipientName)} on ${o.gift.sendAt.toUTCString().slice(0, 16)}.` : `We’ve sent it to ${first(o.gift.recipientName)}.`,
            data: link('/tickets', { type: 'order.paid', orderId, eventId: o.event.id }),
            dedupeKey: `order.paid:${orderId}`,
          }
        : {
            userId: buyerId,
            title: `You’re going to ${o.event.title}`,
            body: `${o.quantity} × ${o.ticketType.name} · ${when}. Your tickets are in the app.`,
            data: link(ticketId ? `/tickets/${ticketId}` : '/tickets', { type: 'order.paid', orderId, eventId: o.event.id, ticketId: ticketId ?? null }),
            dedupeKey: `order.paid:${orderId}`,
          };
      await this.push.send('order.paid', 'orders', [msg]);
    });
  }

  /**
   * "New sale": to the organization's active admins and managers (door staff don't see sales), opening the event's
   * organizer page. Resale orders are fans selling to fans, not the organizer's sale, so they're left out.
   */
  newSale(orderId: string) {
    return this.guard(`order.sale ${orderId}`, async () => {
      const o = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          quantity: true,
          totalCents: true,
          currency: true,
          resaleListingId: true,
          ticketType: { select: { name: true } },
          event: { select: { id: true, title: true, orgId: true } },
        },
      });
      if (!o || o.status !== 'PAID' || o.resaleListingId) return;
      const members = await this.prisma.organizationMember.findMany({
        where: { orgId: o.event.orgId, status: 'ACTIVE', role: { in: ['ADMIN', 'MANAGER'] }, userId: { not: null } },
        select: { userId: true },
      });
      const ids = [...new Set(members.map((m) => m.userId!))];
      const amount = o.totalCents > 0 ? formatMoney(o.totalCents, o.currency) : 'Free';
      await this.push.send(
        'order.sale',
        'sales',
        ids.map((userId) => ({
          userId,
          title: `New sale: ${o.event.title}`,
          body: `${o.quantity} × ${o.ticketType.name} · ${amount}`,
          data: link(`/organizer/events/${o.event.id}`, { type: 'order.sale', orderId, eventId: o.event.id }),
          dedupeKey: `order.sale:${orderId}:${userId}`,
        })),
      );
    });
  }

  /** A transfer is waiting: to the recipient, if they have an account. */
  transferSent(ticketId: string, fromName: string) {
    return this.guard(`ticket.transfer ${ticketId}`, async () => {
      const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { event: { select: { title: true } }, ticketType: { select: { name: true } } } });
      if (!t || t.status !== 'TRANSFER_PENDING' || !t.transferTo) return;
      const to = (await this.usersByEmail([t.transferTo])).get(t.transferTo);
      if (!to) return;
      await this.push.send('ticket.transfer', 'tickets', [
        {
          userId: to,
          title: `${first(fromName)} sent you a ticket`,
          body: `${t.ticketType.name} for ${t.event.title}. Open Omoshow to accept it.`,
          data: link('/tickets', { type: 'ticket.transfer', ticketId }),
          dedupeKey: `ticket.transfer:${ticketId}:${t.transferExpiresAt?.getTime() ?? 0}`,
        },
      ]);
    });
  }

  /** The recipient accepted: to the sender. */
  transferAccepted(ticketId: string, senderId: string | null, recipientName: string) {
    return this.guard(`ticket.accepted ${ticketId}`, async () => {
      if (!senderId) return;
      const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { event: { select: { title: true } } } });
      if (!t) return;
      await this.push.send('ticket.accepted', 'tickets', [
        {
          userId: senderId,
          title: `${first(recipientName)} accepted your ticket`,
          body: `${t.event.title}: the ticket is in their account now.`,
          data: link('/tickets', { type: 'ticket.accepted', ticketId }),
          dedupeKey: `ticket.accepted:${ticketId}:${t.qrVersion}`,
        },
      ]);
    });
  }

  /** A gift arrived: to the recipient, if they have an account. Opens the gift page. */
  giftDelivered(giftId: string) {
    return this.guard(`gift.delivered ${giftId}`, async () => {
      const g = await this.prisma.gift.findUnique({ where: { id: giftId }, include: { order: { include: { event: { select: { title: true, org: { select: { name: true } } } }, ticketType: { select: { name: true } } } } } });
      if (!g || g.claimedAt) return;
      const to = (await this.usersByEmail([g.recipientEmail])).get(g.recipientEmail);
      if (!to) return;
      const comp = g.order.kind === 'COMP';
      await this.push.send('gift.delivered', 'tickets', [
        {
          userId: to,
          // A comp is from the organizer: the order is in the guest's own name.
          title: comp ? `You’re on the guest list for ${g.order.event.title}` : `🎁 ${first(g.order.buyerName)} sent you tickets`,
          body: comp
            ? `${g.order.event.org.name} sent you a complimentary ${g.order.ticketType.name} ticket. Claim it to add it to your tickets.`
            : `${g.order.quantity} × ${g.order.ticketType.name} for ${g.order.event.title}. Open your gift to add them.`,
          data: link(`/gift/${g.token}`, { type: 'gift.delivered', giftId }),
          dedupeKey: `gift.delivered:${giftId}`,
        },
      ]);
    });
  }

  /** A resale listing sold: to the seller. */
  resaleSold(listingId: string) {
    return this.guard(`resale.sold ${listingId}`, async () => {
      const l = await this.prisma.resaleListing.findUnique({ where: { id: listingId }, include: { event: { select: { title: true } } } });
      if (!l || l.status !== 'SOLD') return;
      await this.push.send('resale.sold', 'orders', [
        {
          userId: l.sellerId,
          title: 'Your ticket sold',
          body: `${l.event.title}: sold for ${formatMoney(l.priceCents, l.currency)}.${l.payoutCents !== null ? ` You’ll receive ${formatMoney(l.payoutCents, l.currency)}.` : ''}`,
          data: link('/tickets', { type: 'resale.sold', listingId }),
          dedupeKey: `resale.sold:${listingId}`,
        },
      ]);
    });
  }

  /** An Omoshow Guarantee claim was received or decided, or its refund went out: to the claimant, opening the ticket. */
  guaranteeClaim(kind: 'received' | 'approved' | 'declined' | 'refunded', m: { userId: string; claimId: string; ticketId: string; title: string; body: string }) {
    return this.guard(`guarantee.${kind} ${m.claimId}`, async () => {
      await this.push.send(`guarantee.${kind}`, 'orders', [
        {
          userId: m.userId,
          title: m.title,
          body: m.body,
          data: link(`/tickets/${m.ticketId}`, { type: `guarantee.${kind}`, claimId: m.claimId, ticketId: m.ticketId }),
          dedupeKey: `guarantee.${kind}:${m.claimId}`,
        },
      ]);
    });
  }

  /** A price drop worth telling about: to watchers of the event who have an account. */
  priceDrop(dropId: string, e: { id: string; slug: string; title: string; currency: string }, ticketName: string, toCents: number, percentOff: number) {
    return this.guard(`price_drop ${dropId}`, async () => {
      const watchers = await this.prisma.priceWatch.findMany({ where: { eventId: e.id, stoppedAt: null }, select: { email: true, userId: true } });
      const byEmail = await this.usersByEmail(watchers.filter((w) => !w.userId).map((w) => w.email));
      const ids = new Set<string>();
      for (const w of watchers) {
        const id = w.userId ?? byEmail.get(w.email);
        if (id) ids.add(id);
      }
      await this.push.send(
        'price_drop',
        'priceDrops',
        [...ids].map((userId) => ({
          userId,
          title: `Price drop: ${e.title}`,
          body: `${ticketName} is now ${formatMoney(toCents, e.currency)} (${percentOff}% off).`,
          data: link(`/events/${e.slug}`, { type: 'price_drop', eventId: e.id }),
          dedupeKey: `price_drop:${dropId}:${userId}`,
        })),
      );
    });
  }

  /**
   * An event went on sale for the first time: to fans following its organizer or its venue (once each, and only for
   * public events). Followers of the organizer hear "New from <organizer>", the venue's "New at <venue>".
   */
  newEvent(eventId: string) {
    return this.guard(`follow.new_event ${eventId}`, async () => {
      const e = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, slug: true, title: true, status: true, visibility: true, startsAt: true, orgId: true, venueId: true, org: { select: { name: true } }, venue: { select: { name: true, city: true } } },
      });
      if (!e || e.status !== 'PUBLISHED' || e.visibility !== 'PUBLIC') return;
      const rows = await this.prisma.follow.findMany({
        where: { OR: [{ orgId: e.orgId }, ...(e.venueId ? [{ venueId: e.venueId }] : [])] },
        select: { userId: true, orgId: true },
      });
      const viaOrg = new Map<string, boolean>();
      for (const r of rows) viaOrg.set(r.userId, viaOrg.get(r.userId) || !!r.orgId);
      const where = e.venue ? ` · ${e.venue.city || e.venue.name}` : '';
      await this.push.send(
        'follow.new_event',
        'following',
        [...viaOrg].map(([userId, org]) => ({
          userId,
          title: org || !e.venue ? `New from ${e.org.name}` : `New at ${e.venue.name}`,
          body: `${e.title}, ${wallClockLabel(e.startsAt, { weekday: 'short', month: 'short', day: 'numeric' })}${where}. Tickets are on sale now.`,
          data: link(`/events/${e.slug}`, { type: 'follow.new_event', eventId: e.id }),
          dedupeKey: `follow.new_event:${e.id}:${userId}`,
        })),
      );
    });
  }

  /** Account ids holding any non-void ticket for an event, or one date of it (owners, or accounts with the holder's email). */
  async holders(eventId: string, eventDateId?: string) {
    const rows = await this.prisma.ticket.findMany({ where: { eventId, status: { not: 'VOID' }, ...(eventDateId ? { eventDateId } : {}) }, select: { ownerId: true, holderEmail: true } });
    const byEmail = await this.usersByEmail(rows.filter((r) => !r.ownerId).map((r) => r.holderEmail));
    const ids = new Set<string>();
    for (const r of rows) {
      const id = r.ownerId ?? byEmail.get(r.holderEmail);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** Accounts holding the tickets `where` picks (owners, or holders by email). */
  async holdersWhere(where: Prisma.TicketWhereInput) {
    const rows = await this.prisma.ticket.findMany({ where, select: { ownerId: true, holderEmail: true } });
    const byEmail = await this.usersByEmail(rows.filter((r) => !r.ownerId).map((r) => r.holderEmail));
    return [...new Set(rows.map((r) => r.ownerId ?? byEmail.get(r.holderEmail)).filter((x): x is string => !!x))];
  }

  /** The event (or one date of it) moved: to everyone holding a ticket for it. Once per change and person. */
  eventMoved(e: { id: string; title: string; orgName: string }, c: { id: string; to: string }, userIds: string[]) {
    return this.guard(`event.moved ${c.id}`, async () => {
      await this.push.send(
        'event.moved',
        'orders',
        userIds.map((userId) => ({
          userId,
          title: `New time: ${e.title}`,
          body: `${e.orgName} moved it to ${c.to}. Your tickets still work. Can’t make it? You can get a refund.`,
          data: link('/tickets', { type: 'event.moved', eventId: e.id }),
          dedupeKey: `event.moved:${c.id}:${userId}`,
        })),
      );
    });
  }

  /** The event was cancelled: to everyone who held a ticket (collected before the tickets were voided). */
  eventCancelled(e: { id: string; title: string; orgName: string }, userIds: string[]) {
    return this.guard(`event.cancelled ${e.id}`, async () => {
      await this.push.send(
        'event.cancelled',
        'orders',
        userIds.map((userId) => ({
          userId,
          title: `Cancelled: ${e.title}`,
          body: `${e.orgName} cancelled this event. Refunds go back to the original payment method.`,
          data: link('/tickets', { type: 'event.cancelled', eventId: e.id }),
          dedupeKey: `event.cancelled:${e.id}:${userId}`,
        })),
      );
    });
  }

  /** One date of a multiple-dates event was cancelled: to everyone who held a ticket for it. */
  dateCancelled(e: { id: string; title: string; orgName: string }, d: { id: string; name: string }, userIds: string[]) {
    return this.guard(`event.date_cancelled ${d.id}`, async () => {
      await this.push.send(
        'event.date_cancelled',
        'orders',
        userIds.map((userId) => ({
          userId,
          title: `Cancelled: ${e.title}, ${d.name}`,
          body: `${e.orgName} cancelled this date. Refunds go back to the original payment method.`,
          data: link('/tickets', { type: 'event.date_cancelled', eventId: e.id, eventDateId: d.id }),
          dedupeKey: `event.date_cancelled:${d.id}:${userId}`,
        })),
      );
    });
  }

  /**
   * The event moved to another venue: to everyone holding a ticket, once per change (`changeId` is the audit entry
   * of that move, so moving again tells them again, but a retry of the same move doesn't).
   */
  venueChanged(e: { id: string; title: string }, venue: { name: string; city: string }, changeId: string, userIds: string[]) {
    return this.guard(`event.venue ${e.id}`, async () => {
      await this.push.send(
        'event.venue',
        'orders',
        userIds.map((userId) => ({
          userId,
          title: `New venue: ${e.title}`,
          body: `Now at ${venue.name}, ${venue.city}. Same date and time, and your tickets still work.`,
          data: link('/tickets', { type: 'event.venue', eventId: e.id }),
          dedupeKey: `event.venue:${e.id}:${changeId}:${userId}`,
        })),
      );
    });
  }

  /**
   * A booked session (bookable schedule item) was cancelled, or has a new time: to each holder with an account, once
   * per person per change (a holder with two tickets booked hears once), opening their ticket.
   */
  sessionChanged(kind: 'cancelled' | 'moved', e: { id: string; title: string }, item: { id: string; title: string; startsAt: Date }, holders: { ticketId: string; ownerId: string | null; holderEmail: string }[]) {
    return this.guard(`session.${kind} ${item.id}`, async () => {
      const byEmail = await this.usersByEmail(holders.filter((h) => !h.ownerId).map((h) => h.holderEmail));
      const ticketOf = new Map<string, string>();
      for (const h of holders) {
        const id = h.ownerId ?? byEmail.get(h.holderEmail);
        if (id && !ticketOf.has(id)) ticketOf.set(id, h.ticketId);
      }
      const when = wallClockLabel(item.startsAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      await this.push.send(
        `session.${kind}`,
        'tickets',
        [...ticketOf].map(([userId, ticketId]) => ({
          userId,
          title: kind === 'cancelled' ? `Session cancelled: ${item.title}` : `Session moved: ${item.title}`,
          body: kind === 'cancelled' ? `${e.title}: this session was cancelled and your place released. Your ticket still works.` : `${e.title}: now ${when}. Your place is still booked.`,
          data: link(`/tickets/${ticketId}`, { type: `session.${kind}`, eventId: e.id, itemId: item.id, ticketId }),
          dedupeKey: kind === 'cancelled' ? `session.cancelled:${item.id}:${userId}` : `session.moved:${item.id}:${item.startsAt.getTime()}:${userId}`,
        })),
      );
    });
  }

  /**
   * "Tomorrow: <event>" when the start is 20–24 hours away and "Doors open soon" in the hour before doors (or
   * the start), to accounts holding an ACTIVE ticket. Event times are converted from the venue's wall clock.
   * Safe to run as often as you like: each person gets each reminder once per event.
   */
  async sendReminders(now = new Date()) {
    const summary = { day: 0, doors: 0 };
    try {
      const t = now.getTime();
      // Stored times are wall-clock; zones run from UTC−12 to UTC+14, so look a little wider and convert.
      const from = new Date(t - 15 * HOUR);
      const to = new Date(t + DAY_REMINDER_TO_MS + 15 * HOUR);
      const events = await this.prisma.event.findMany({
        where: { status: 'PUBLISHED', dateMode: 'SINGLE', startsAt: { gte: from, lte: to } },
        select: { id: true, slug: true, title: true, startsAt: true, doorsAt: true, timezone: true, online: true, venue: { select: { name: true } } },
      });
      // Multiple dates and multi-day events: each date on its own, to that date's holders.
      const dated = await this.prisma.eventDate.findMany({
        where: { status: 'ACTIVE', startsAt: { gte: from, lte: to }, event: { status: 'PUBLISHED', dateMode: { not: 'SINGLE' } } },
        select: { id: true, startsAt: true, doorsAt: true, event: { select: { id: true, slug: true, title: true, timezone: true, online: true, dateMode: true, venue: { select: { name: true } } } } },
      });
      for (const d of dated) {
        const r = await this.remind({ ...d.event, startsAt: d.startsAt, doorsAt: d.doorsAt }, t, d.event.dateMode === 'DATES' ? { eventDateId: d.id } : { ticketType: { validDateIds: { has: d.id } } }, d.id);
        summary.day += r.day;
        summary.doors += r.doors;
      }
      for (const e of events) {
        const r = await this.remind(e, t, {}, null);
        summary.day += r.day;
        summary.doors += r.doors;
      }
    } catch (e) {
      this.log.warn(`Reminders: ${(e as Error).message}`);
    }
    return summary;
  }

  /**
   * The reminder due now for one start (an event, or one date of it: `dateId`, holders narrowed by `tickets`), if any.
   * Multi-day passes already used on an earlier day (CHECKED_IN) still hear about the next day.
   */
  private async remind(
    e: { id: string; slug: string; title: string; startsAt: Date; doorsAt: Date | null; timezone: string; online: boolean; venue: { name: string } | null },
    t: number,
    tickets: Prisma.TicketWhereInput,
    dateId: string | null,
  ) {
    const out = { day: 0, doors: 0 };
    const start = wallClockToInstant(e.startsAt, e.timezone).getTime();
    const doors = e.doorsAt ? wallClockToInstant(e.doorsAt, e.timezone).getTime() : start;
    const untilStart = start - t;
    const untilDoors = doors - t;
    const day = untilStart > DAY_REMINDER_FROM_MS && untilStart <= DAY_REMINDER_TO_MS;
    const soon = untilDoors > 0 && untilDoors <= DOORS_REMINDER_MS && untilStart > 0;
    if (!day && !soon) return out;
    const statuses = dateId ? (['ACTIVE', 'CHECKED_IN'] as const) : (['ACTIVE'] as const);
    const rows = await this.prisma.ticket.findMany({ where: { eventId: e.id, status: { in: [...statuses] }, ownerId: { not: null }, ...tickets }, select: { id: true, ownerId: true }, orderBy: { id: 'asc' } });
    const firstTicket = new Map<string, string>();
    for (const x of rows) if (!firstTicket.has(x.ownerId!)) firstTicket.set(x.ownerId!, x.id);
    if (!firstTicket.size) return out;
    const where = e.online ? 'Online' : (e.venue?.name ?? '');
    const kind = day ? 'reminder.day' : 'reminder.doors';
    const messages: PushMessage[] = [...firstTicket].map(([userId, ticketId]) => ({
      userId,
      title: day ? `Tomorrow: ${e.title}` : `Doors open soon: ${e.title}`,
      body: day
        ? `${wallClockLabel(e.startsAt)}${where ? ` · ${where}` : ''}. Your ticket is in the app, and works offline.`
        : `${e.online ? 'Starts' : 'Doors'} at ${wallClockLabel(e.doorsAt ?? e.startsAt, { hour: 'numeric', minute: '2-digit' })}${where ? ` · ${where}` : ''}. Have your ticket ready.`,
      data: link(`/tickets/${ticketId}`, { type: kind, eventId: e.id, ticketId, ...(dateId ? { eventDateId: dateId } : {}) }),
      // Per date for multiple dates and multi-day events, so each date gets its own reminder.
      dedupeKey: dateId ? `${kind}:${e.id}:${dateId}:${userId}` : `${kind}:${e.id}:${userId}`,
    }));
    const r = await this.push.send(kind, 'reminders', messages);
    if (day) out.day += r.sent + r.skipped + r.failed;
    else out.doors += r.sent + r.skipped + r.failed;
    return out;
  }
}
