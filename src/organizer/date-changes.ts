/**
 * Changes to a live event after tickets were sold, which ticket holders are told about and buyers can take a refund
 * for (each kept as a DateChange):
 *
 *   TIME       a single-date event's start, or one date (DATES) or day (DAYS) of it, moved by 30 minutes or more
 *   POSTPONED  new date to be announced (POST /organizer/events/:id/postpone): sales pause, tickets stay valid, and
 *              buyers can take a refund for 90 days; setting a new date (or "back on") ends it, and after 90 days
 *              without one the event is cancelled and everyone refunded (an hourly sweep)
 *   PERKS      a sold tier lost something it promised (a perk removed): its buyers can take a refund
 *
 * Everyone holding an affected ticket hears (one email per buyer with the refund offer, one per other holder, a push
 * to holders with an account); how many emails went out and failed is kept on the change. The refund is the whole
 * order, fees included, unless one of its tickets has been used; a multi-day pass whose one day moved gets that day's
 * share back and keeps working. If the organizer had already been paid for the order, their share becomes a debt.
 *
 *   POST /me/orders/:id/date-change-refund   the buyer takes the refund
 *
 * GET /me/tickets carries the latest change for each ticket (`dateChange`, see dateChangeView), and
 * GET /organizer/events/:id/impact says who a change would reach before it's made.
 */
import { BadRequestException, ConflictException, Controller, HttpCode, Injectable, Logger, NotFoundException, Param, Post, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, type DateChange } from '@prisma/client';
import { MIN_MOVE_MS, POSTPONE_LIMIT_MS, REFUND_WINDOW_MS, dateChangeView, moveRefund, ticketsHit, ticketsMoved, type ChangeKind, type Move } from '../domain/date-changes';

export type { Move } from '../domain/date-changes';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { AdminService } from '../admin/admin.module';
import { EventCancellation } from '../admin/cancel-event';
import { MailService, formatMoney, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import { wallClockLabel } from '../domain/wallclock';

type ChangeEvent = { id: string; slug: string; title: string; status: string; dateMode: string; online: boolean; startsAt: Date; org: { name: string }; venue: { name: string; city: string } | null };
const EVENT_SELECT = { id: true, slug: true, title: true, status: true, dateMode: true, online: true, startsAt: true, org: { select: { name: true } }, venue: { select: { name: true, city: true } } } as const;

@Injectable()
export class DateChangeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DateChanges');
  /** orders being refunded right now in this process, so a double tap refunds once */
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
    private readonly cancellation: EventCancellation,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.sweepPostponed().catch((e) => this.log.warn(`Postponed sweep: ${(e as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------- who a change reaches ---------- */

  /**
   * Who a change to the event (or one date or day of it) would reach, before it's made: paid orders, tickets out
   * (comps among them, and ones now held by someone other than the buyer), checkouts in progress, accounts that get a
   * push, and the paid total. GET /organizer/events/:id/impact?dateId=…
   */
  async impact(eventId: string, dateId?: string) {
    const e = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { dateMode: true, currency: true } });
    const where = ticketsMoved(eventId, e.dateMode, dateId ?? null);
    const tickets = await this.prisma.ticket.findMany({
      where: { ...where, status: { not: 'VOID' } },
      select: { holderEmail: true, ownerId: true, order: { select: { id: true, kind: true, status: true, email: true, buyerId: true, totalCents: true, refundedCents: true, currency: true } } },
    });
    const paid = new Map<string, { cents: number; currency: string }>();
    for (const t of tickets) if (t.order.kind === 'SALE' && (t.order.status === 'PAID' || t.order.status === 'PARTIALLY_REFUNDED')) paid.set(t.order.id, { cents: t.order.totalCents - t.order.refundedCents, currency: t.order.currency });
    const totals: Record<string, number> = {};
    for (const p of paid.values()) totals[p.currency] = (totals[p.currency] ?? 0) + p.cents;
    const typeIds = dateId && e.dateMode === 'DATES' ? (await this.prisma.ticketType.findMany({ where: { eventDateId: dateId }, select: { id: true } })).map((t) => t.id) : undefined;
    const typeDays = dateId && e.dateMode === 'DAYS' ? (await this.prisma.ticketType.findMany({ where: { eventId, validDateIds: { has: dateId } }, select: { id: true } })).map((t) => t.id) : undefined;
    const holds = await this.prisma.hold.count({ where: { eventId, status: 'ACTIVE', expiresAt: { gt: new Date() }, ...(typeIds || typeDays ? { ticketTypeId: { in: typeIds ?? typeDays } } : {}) } });
    const holders = await this.notices.holdersWhere({ ...where, status: { not: 'VOID' } });
    return {
      paidOrders: paid.size,
      tickets: tickets.length,
      comps: tickets.filter((t) => t.order.kind === 'COMP').length,
      // held by someone other than the buyer (a transfer, a gift): told separately, and the refund goes to the buyer
      transferred: tickets.filter((t) => t.order.kind === 'SALE' && t.holderEmail.trim().toLowerCase() !== t.order.email.trim().toLowerCase()).length,
      activeHolds: holds,
      pushAccounts: holders.length,
      paidCents: Object.entries(totals).map(([currency, cents]) => ({ currency, cents })),
    };
  }

  /* ---------- time changes ---------- */

  /**
   * Records the moves of a live event that has tickets out and tells their holders. Not live (a draft, in review,
   * taken down, cancelled): nothing to announce. Returns the changes recorded.
   */
  async record(eventId: string, moves: Move[], reason: string | undefined, actor: AuthUser) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: EVENT_SELECT });
    if (!e || e.status !== 'PUBLISHED') return [];
    const now = Date.now();
    const out: DateChange[] = [];
    for (const m of moves) {
      if (Math.abs(m.to.getTime() - m.from.getTime()) < MIN_MOVE_MS) continue;
      const where = ticketsMoved(e.id, e.dateMode, m.eventDateId);
      const live = await this.prisma.ticket.count({ where: { ...where, status: { not: 'VOID' } } });
      if (!live) continue;
      const c = await this.prisma.dateChange.create({
        data: { eventId: e.id, kind: 'TIME', eventDateId: m.eventDateId, fromStartsAt: m.from, toStartsAt: m.to, reason: reason?.trim() || null, refundUntil: new Date(Math.min(now + REFUND_WINDOW_MS, m.to.getTime())) },
      });
      out.push(c);
      await this.audit.log(actor.id, 'event.date_change', 'Event', e.id, { eventDateId: m.eventDateId, from: m.from.toISOString(), to: m.to.toISOString(), reason: c.reason, refundUntil: c.refundUntil.toISOString(), tickets: live });
      void this.tell(e, c).catch((err) => this.log.warn(`Date change notices for ${e.id}: ${(err as Error).message}`));
    }
    return out;
  }

  /* ---------- postponed ---------- */

  /** Postpones a live event that hasn't started: new date to be announced. Org admins (it opens refunds). */
  async postpone(eventId: string, reason: string, actor: AuthUser) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: { ...EVENT_SELECT, postponedAt: true, dates: { select: { startsAt: true, status: true } } } });
    if (!e) throw new NotFoundException('Event not found.');
    if (e.status !== 'PUBLISHED') throw new BadRequestException(e.status === 'CANCELLED' ? 'This event was cancelled.' : 'Only events on sale can be postponed.');
    if (e.postponedAt) throw new ConflictException('This event is already postponed.');
    const now = new Date();
    const started = e.dateMode === 'SINGLE' ? e.startsAt <= now : e.dates.some((d) => d.status === 'ACTIVE' && d.startsAt <= now);
    if (started) throw new ConflictException({ statusCode: 409, code: 'EVENT_STARTED', message: 'Part of this event has already happened, so it can’t be postponed. Move or cancel the dates still to come instead.' });
    const why = reason.trim();
    await this.prisma.event.update({ where: { id: eventId }, data: { postponedAt: now, postponeReason: why, postponedById: actor.id, salesPaused: true } });
    const c = await this.prisma.dateChange.create({
      data: { eventId, kind: 'POSTPONED', eventDateId: null, fromStartsAt: e.startsAt, toStartsAt: e.startsAt, reason: why, refundUntil: new Date(now.getTime() + POSTPONE_LIMIT_MS) },
    });
    await this.audit.log(actor.id, 'event.postpone', 'Event', eventId, { reason: why, refundUntil: c.refundUntil.toISOString() });
    void this.tell(e, c).catch((err) => this.log.warn(`Postponement notices for ${eventId}: ${(err as Error).message}`));
    return { postponedAt: now, refundUntil: c.refundUntil, change: c };
  }

  /**
   * Ends a postponement: when a new date is set (the edit records the move as a TIME change, with its own 14-day refund
   * window) or the event is back on as planned (`sameDate`, holders are told). Sales resume.
   */
  async endPostponement(eventId: string, actor: AuthUser, sameDate: boolean) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: { ...EVENT_SELECT, postponedAt: true } });
    if (!e?.postponedAt) {
      if (sameDate) throw new BadRequestException('This event isn’t postponed.');
      return;
    }
    await this.prisma.event.update({ where: { id: eventId }, data: { postponedAt: null, postponeReason: null, postponedById: null, salesPaused: false } });
    // The postponement's refund window closes: a new date opens its own.
    await this.prisma.dateChange.updateMany({ where: { eventId, kind: 'POSTPONED', refundUntil: { gt: new Date() } }, data: { refundUntil: new Date() } });
    await this.audit.log(actor.id, 'event.postpone_end', 'Event', eventId, { sameDate });
    if (sameDate) {
      const c = await this.prisma.dateChange.create({ data: { eventId, kind: 'TIME', eventDateId: null, fromStartsAt: e.startsAt, toStartsAt: e.startsAt, reason: 'Back on as planned', refundUntil: new Date() } });
      void this.tell(e, c, { backOn: true }).catch((err) => this.log.warn(`Back-on notices for ${eventId}: ${(err as Error).message}`));
    }
    return { postponedAt: null };
  }

  /** Postponed for 90 days without a new date: cancelled, everyone refunded (in the name of whoever postponed it). */
  async sweepPostponed(now = new Date()) {
    const due = await this.prisma.event.findMany({ where: { status: 'PUBLISHED', postponedAt: { lte: new Date(now.getTime() - POSTPONE_LIMIT_MS) } }, select: { id: true, postponedById: true, orgId: true } });
    for (const e of due) {
      const actor = { id: e.postponedById ?? (await this.prisma.organizationMember.findFirst({ where: { orgId: e.orgId, role: 'ADMIN', userId: { not: null } }, select: { userId: true } }))?.userId ?? null } as AuthUser;
      try {
        await this.cancellation.cancel(e.id, actor, 'Postponed for 90 days without a new date, so it’s cancelled and every order refunded.', 'admin');
        await this.prisma.event.update({ where: { id: e.id }, data: { postponedAt: null } });
      } catch (err) {
        this.log.warn(`Cancelling postponed event ${e.id}: ${(err as Error).message}`);
      }
    }
    return due.length;
  }

  /* ---------- lost perks ---------- */

  /** A sold tier of a live event lost perks: its buyers are told and can take a refund for 14 days (or until it starts). */
  async perksRemoved(eventId: string, ticketTypeIds: string[], tier: string, removed: string[], actor: AuthUser) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: EVENT_SELECT });
    if (!e || e.status !== 'PUBLISHED' || !removed.length) return null;
    const live = await this.prisma.ticket.count({ where: { eventId, ticketTypeId: { in: ticketTypeIds }, status: { not: 'VOID' } } });
    if (!live) return null;
    const now = Date.now();
    const c = await this.prisma.dateChange.create({
      data: {
        eventId,
        kind: 'PERKS',
        ticketTypeIds,
        detail: { tier, removed } as Prisma.InputJsonValue,
        eventDateId: null,
        fromStartsAt: e.startsAt,
        toStartsAt: e.startsAt,
        refundUntil: new Date(Math.max(now + 60_000, Math.min(now + REFUND_WINDOW_MS, e.startsAt.getTime()))),
      },
    });
    await this.audit.log(actor.id, 'ticket_type.perks_removed', 'Event', eventId, { tier, removed, ticketTypeIds, tickets: live });
    void this.tell(e, c).catch((err) => this.log.warn(`Perk change notices for ${eventId}: ${(err as Error).message}`));
    return c;
  }

  /* ---------- telling holders ---------- */

  /** One email per buyer (with the refund offer), one per other holder (the ticket still works), a push to holders. */
  private async tell(e: ChangeEvent, c: DateChange, opts: { backOn?: boolean } = {}) {
    const where = ticketsHit(c, e.dateMode);
    const tickets = await this.prisma.ticket.findMany({
      where: { ...where, status: { not: 'VOID' } },
      select: {
        id: true,
        ownerId: true,
        holderEmail: true,
        holderName: true,
        order: { select: { id: true, email: true, buyerName: true, kind: true, status: true, totalCents: true, refundedCents: true, quantity: true, donationCents: true, donationRefundedCents: true, currency: true, ticketType: { select: { validDateIds: true } } } },
      },
    });
    const dates = await this.prisma.eventDate.findMany({ where: { eventId: e.id }, select: { id: true, startsAt: true, status: true } });
    // Event times are wall-clock times at the venue (see domain/wallclock).
    const label = (d: Date) => wallClockLabel(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const from = label(c.fromStartsAt);
    const to = label(c.toStartsAt);
    const until = wallClockLabel(c.refundUntil, { weekday: 'short', month: 'short', day: 'numeric' });
    const where_ = e.venue ? ` at ${e.venue.name}, ${e.venue.city}` : e.online ? ' (online)' : '';
    const first = (name: string) => name.split(' ')[0] || 'there';
    const footer = `You’re getting this because you have tickets to ${e.title} on Omoshow.`;
    const why = c.reason && !opts.backOn ? [`The reason given: “${c.reason}”`] : [];
    const kind = c.kind as ChangeKind;
    const perks = (c.detail ?? {}) as { tier?: string; removed?: string[] };
    const lost = (perks.removed ?? []).join(', ');
    const copy = opts.backOn
      ? { subject: `Back on: ${e.title}`, heading: `${e.title} is back on`, what: `${e.org.name} says ${e.title}${where_} goes ahead as planned on ${to}.`, keep: 'Your tickets work as they are, so there’s nothing you need to do.' }
      : kind === 'POSTPONED'
        ? { subject: `Postponed: ${e.title}`, heading: `${e.title} is postponed`, what: `${e.org.name} has postponed ${e.title}${where_}. The new date hasn’t been announced yet; we’ll tell you as soon as it is.`, keep: 'Your tickets stay valid for the new date.' }
        : kind === 'PERKS'
          ? { subject: `Change to your tickets: ${e.title}`, heading: `${perks.tier ?? 'Your tickets'} changed`, what: `${e.org.name} changed ${perks.tier ?? 'your tickets'} for ${e.title}: it no longer includes ${lost}.`, keep: 'Your tickets still get you in.' }
          : { subject: `New time: ${e.title}`, heading: `${e.title} has a new time`, what: `${e.org.name} has moved ${e.title}${where_}.`, keep: 'Your tickets still work for the new time, so there’s nothing you need to do.' };
    const highlight = kind === 'TIME' && !opts.backOn ? { label: `Was ${from}`, value: `Now ${to}` } : undefined;
    const mails: Mail[] = [];
    const told = new Set<string>();
    for (const t of tickets) {
      const o = t.order;
      if (told.has(`o:${o.id}`)) continue;
      const left = o.totalCents - o.refundedCents;
      const back = moveRefund(o, e.dateMode, o.ticketType, dates, c, tickets.filter((x) => x.order.id === o.id).map((x) => x.id));
      if (o.kind !== 'SALE' || (o.status !== 'PAID' && o.status !== 'PARTIALLY_REFUNDED') || left <= 0 || back.cents <= 0) continue;
      told.add(`o:${o.id}`);
      told.add(o.email.toLowerCase());
      const offer = opts.backOn
        ? []
        : [
            back.whole
              ? `${kind === 'TIME' ? 'Can’t make it?' : 'Prefer your money back?'} You can get a full refund of ${formatMoney(back.cents, o.currency)} for order ${o.id}, fees included, until ${until}. Open your tickets and choose “Get a refund”.`
              : `Can’t make that day? You can get that day’s share of your pass back, ${formatMoney(back.cents, o.currency)}, until ${until}, and keep the pass for the other days. Open your tickets and choose “Get a refund”.`,
          ];
      mails.push({
        to: o.email,
        subject: copy.subject,
        ...render({
          preheader: `${copy.what} ${copy.keep}`,
          heading: copy.heading,
          paragraphs: [`Hi ${first(o.buyerName)}, ${copy.what.charAt(0).toLowerCase()}${copy.what.slice(1)}`, ...why, copy.keep, ...offer],
          ...(highlight ? { highlight } : {}),
          cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
          footer,
        }),
      });
    }
    // Other holders (a transfer, a gift, a comp): the ticket still works; refunds go to whoever paid.
    for (const t of tickets) {
      const to_ = t.holderEmail.trim().toLowerCase();
      if (!to_ || told.has(to_)) continue;
      told.add(to_);
      mails.push({
        to: to_,
        subject: copy.subject,
        ...render({
          preheader: `${copy.what} ${copy.keep}`,
          heading: copy.heading,
          paragraphs: [
            `Hi ${first(t.holderName)}, ${copy.what.charAt(0).toLowerCase()}${copy.what.slice(1)}`,
            ...why,
            copy.keep,
            ...(t.order.kind === 'COMP' || opts.backOn ? [] : [`If you’d rather not go, the person who bought it can get a refund until ${until}.`]),
          ],
          ...(highlight ? { highlight } : {}),
          cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
          footer,
        }),
      });
    }
    // How many went out (and didn't), for the organizer's record of the change.
    const mailKind = opts.backOn ? 'event.back_on' : kind === 'POSTPONED' ? 'event.postponed' : kind === 'PERKS' ? 'event.perks_changed' : 'event.date_change';
    const sent = mails.length ? await this.mail.sendMany(mailKind, mails) : [];
    const failed = sent.filter((ok) => !ok).length;
    await this.prisma.dateChange.update({ where: { id: c.id }, data: { emailed: sent.length - failed, failed } });
    const holders = await this.notices.holdersWhere({ ...where, status: { not: 'VOID' } });
    const push =
      opts.backOn
        ? { title: `Back on: ${e.title}`, body: `It goes ahead as planned on ${to}. Your tickets work as they are.` }
        : kind === 'POSTPONED'
          ? { title: `Postponed: ${e.title}`, body: `${e.org.name} postponed it; the new date will be announced. Your tickets stay valid, or you can get a refund.` }
          : kind === 'PERKS'
            ? { title: `Change to your tickets: ${e.title}`, body: `${perks.tier ?? 'Your tier'} no longer includes ${lost}. You can get a refund if you’d rather not go.` }
            : { title: `New time: ${e.title}`, body: `${e.org.name} moved it to ${to}. Your tickets still work. Can’t make it? You can get a refund.` };
    void this.notices.eventMoved({ id: e.id }, { id: c.id, ...push }, holders);
  }

  /** The buyer takes the refund a date change offers: the whole order, while the window is open and nothing's been used. */
  async refund(orderId: string, user: AuthUser) {
    if (this.running.has(orderId)) throw new ConflictException('This refund is already on its way. Refresh in a moment.');
    this.running.add(orderId);
    try {
      return await this.runRefund(orderId, user);
    } finally {
      this.running.delete(orderId);
    }
  }

  /** Whether this order already took the refund for this change (a multi-day pass keeps its status, so the audit trail says). */
  private async taken(orderId: string, changeId: string) {
    return !!(await this.prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: 'order.date_change_refund', data: { path: ['dateChangeId'], equals: changeId } } }));
  }

  private async runRefund(orderId: string, user: AuthUser) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { id: true, title: true, dateMode: true, status: true, dates: { select: { id: true, startsAt: true, status: true } } } },
        ticketType: { select: { id: true, eventDateId: true, validDateIds: true } },
        tickets: { select: { id: true, status: true } },
      },
    });
    if (!o || (o.buyerId !== user.id && o.email !== user.email)) throw new NotFoundException('Order not found.');
    if (o.kind !== 'SALE') throw new BadRequestException('This is a complimentary ticket, so there’s nothing to refund.');
    if (o.event.status === 'CANCELLED') throw new BadRequestException('This event was cancelled, so your order is refunded in full automatically.');
    if (o.status !== 'PAID' && o.status !== 'PARTIALLY_REFUNDED') throw new BadRequestException(o.status === 'REFUNDED' ? 'This order has already been refunded.' : 'Only paid orders can be refunded.');
    const changes = await this.prisma.dateChange.findMany({ where: { eventId: o.eventId } });
    const view = dateChangeView(changes, o.event.dateMode, o.ticketType, o, { isBuyer: true, used: false });
    if (!view) throw new BadRequestException('The date of this order hasn’t changed since you bought it, so it can’t be refunded this way. You can still ask for a refund.');
    if (view.refundUntil.getTime() <= Date.now()) throw new BadRequestException('The time to get a refund for this date change has passed.');
    if (await this.taken(o.id, view.id)) throw new BadRequestException('You’ve already had the refund for this change.');
    const live = o.tickets.filter((t) => t.status !== 'VOID');
    const change = changes.find((c) => c.id === view.id)!;
    const refund = moveRefund(o, o.event.dateMode, o.ticketType, o.event.dates, change, live.map((t) => t.id));
    // The whole order: nothing on it used yet. A pass's day: nobody came in on that day yet.
    const used = refund.whole
      ? o.tickets.some((t) => t.status === 'CHECKED_IN') || (await this.prisma.ticketCheckIn.count({ where: { ticketId: { in: o.tickets.map((t) => t.id) } } })) > 0
      : (await this.prisma.ticketCheckIn.count({ where: { ticketId: { in: live.map((t) => t.id) }, eventDateId: change.eventDateId } })) > 0;
    if (used) throw new BadRequestException(refund.whole ? 'A ticket on this order has already been used, so it can’t be refunded.' : 'A ticket on this order was already used on that day, so it can’t be refunded for it.');
    if (refund.cents <= 0) throw new BadRequestException('There’s nothing left to refund on this order.');
    const amount = formatMoney(refund.cents, o.currency);
    await this.admin.refundOrder(o.id, refund.cents, user, `Date changed (${view.toStartsAt.toISOString()}): the buyer chose a refund`, { recordOwed: true, refundKey: `datechange-${o.id}-${view.id}` });
    await this.audit.log(user.id, 'order.date_change_refund', 'Order', o.id, { amountCents: refund.cents, currency: o.currency, dateChangeId: view.id, whole: refund.whole });
    void this.mail
      .send('order.date_change_refund', {
        to: o.email,
        subject: `Refunded: ${o.event.title}`,
        ...render({
          preheader: `We’ve refunded ${amount} for order ${o.id}.`,
          heading: 'Your refund is on its way',
          paragraphs: [
            `We’ve refunded ${amount} for order ${o.id} (${o.event.title}) to your original payment method. It can take 5–10 business days to show up, depending on your bank.`,
            refund.whole ? 'Your tickets for it have been cancelled.' : 'That was the moved day’s share of your pass. It still works on the other days, so keep it.',
          ],
          highlight: { label: 'Refunded', value: amount },
          cta: refund.whole ? { label: 'Find another event', url: `${config.webUrl}/events` } : { label: 'View my tickets', url: `${config.webUrl}/tickets` },
          footer: `You’re getting this because you asked for a refund of order ${o.id} on Omoshow.`,
        }),
      })
      .catch(() => undefined);
    return { orderId: o.id, status: refund.whole ? ('REFUNDED' as const) : ('PARTIALLY_REFUNDED' as const), refundedCents: refund.cents, whole: refund.whole, currency: o.currency };
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('me/orders')
export class DateChangeController {
  constructor(private readonly svc: DateChangeService) {}

  /** Takes the full refund a date change offers (see DateChangeService). */
  @Post(':id/date-change-refund')
  @HttpCode(200)
  refund(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.refund(id, u);
  }
}
