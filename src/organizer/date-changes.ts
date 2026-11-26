/**
 * A live event moved to a new time after tickets were sold: a single-date event's start, or one date (DATES) or day
 * (DAYS) of it, moved by 30 minutes or more.
 *
 * Each move is kept as a DateChange. Everyone holding a ticket for it hears (one email per buyer, one per other
 * holder, a push to holders with an account): their tickets still work at the new time, and buyers can get a full
 * refund until `refundUntil`, the earlier of 14 days after the change and the new start. The refund is the whole
 * order, fees included (the fan didn't choose the change), unless one of its tickets has already been used. If the
 * organizer had already been paid for the order, their share is recorded as owed (Order.refundOwedCents).
 *
 *   POST /me/orders/:id/date-change-refund   the buyer takes the refund
 *
 * GET /me/tickets carries the latest change for each ticket (`dateChange`, see dateChangeView).
 */
import { BadRequestException, ConflictException, Controller, HttpCode, Injectable, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { DateChange, Prisma } from '@prisma/client';
import { MIN_MOVE_MS, REFUND_WINDOW_MS, dateChangeView, moveRefund, ticketsMoved, type Move } from '../domain/date-changes';

export type { Move } from '../domain/date-changes';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { AdminService } from '../admin/admin.module';
import { MailService, formatMoney, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import { wallClockLabel } from '../domain/wallclock';

@Injectable()
export class DateChangeService {
  private readonly log = new Logger('DateChanges');
  /** orders being refunded right now in this process, so a double tap refunds once */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /**
   * Records the moves of a live event that has tickets out and tells their holders. Not live (a draft, in review,
   * taken down, cancelled): nothing to announce. Returns the changes recorded.
   */
  async record(eventId: string, moves: Move[], reason: string | undefined, actor: AuthUser) {
    const e = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, slug: true, title: true, status: true, dateMode: true, timezone: true, online: true, org: { select: { name: true } }, venue: { select: { name: true, city: true } } },
    });
    if (!e || e.status !== 'PUBLISHED') return [];
    const now = Date.now();
    const out: DateChange[] = [];
    for (const m of moves) {
      if (Math.abs(m.to.getTime() - m.from.getTime()) < MIN_MOVE_MS) continue;
      const where = ticketsMoved(e.id, e.dateMode, m.eventDateId);
      const live = await this.prisma.ticket.count({ where: { ...where, status: { not: 'VOID' } } });
      if (!live) continue;
      const c = await this.prisma.dateChange.create({
        data: { eventId: e.id, eventDateId: m.eventDateId, fromStartsAt: m.from, toStartsAt: m.to, reason: reason?.trim() || null, refundUntil: new Date(Math.min(now + REFUND_WINDOW_MS, m.to.getTime())) },
      });
      out.push(c);
      await this.audit.log(actor.id, 'event.date_change', 'Event', e.id, { eventDateId: m.eventDateId, from: m.from.toISOString(), to: m.to.toISOString(), reason: c.reason, refundUntil: c.refundUntil.toISOString(), tickets: live });
      void this.tell(e, c, where).catch((err) => this.log.warn(`Date change notices for ${e.id}: ${(err as Error).message}`));
    }
    return out;
  }

  /** One email per buyer (with the refund offer), one per other holder (the ticket still works), a push to holders. */
  private async tell(
    e: { id: string; slug: string; title: string; dateMode: string; online: boolean; org: { name: string }; venue: { name: string; city: string } | null },
    c: DateChange,
    where: Prisma.TicketWhereInput,
  ) {
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
    const why = c.reason ? [`The reason given: “${c.reason}”`] : [];
    const mails: Mail[] = [];
    const told = new Set<string>();
    for (const t of tickets) {
      const o = t.order;
      if (told.has(`o:${o.id}`)) continue;
      const left = o.totalCents - o.refundedCents;
      const back = moveRefund(o, e.dateMode, o.ticketType, dates, c, tickets.filter((x) => x.order.id === o.id).map((x) => x.id));
      if (o.kind === 'SALE' && (o.status === 'PAID' || o.status === 'PARTIALLY_REFUNDED') && left > 0 && back.cents > 0) {
        told.add(`o:${o.id}`);
        told.add(o.email.toLowerCase());
        mails.push({
          to: o.email,
          subject: `New time: ${e.title}`,
          ...render({
            preheader: `${e.title} has moved to ${to}. Your tickets still work. Can’t make it? You can get a full refund until ${until}.`,
            heading: `${e.title} has a new time`,
            paragraphs: [
              `Hi ${first(o.buyerName)}, ${e.org.name} has moved ${e.title}${where_}.`,
              ...why,
              'Your tickets still work for the new time, so there’s nothing you need to do.',
              back.whole
                ? `Can’t make it? You can get a full refund of ${formatMoney(back.cents, o.currency)} for order ${o.id}, fees included, until ${until}. Open your tickets and choose “Get a refund”.`
                : `Can’t make that day? You can get that day’s share of your pass back, ${formatMoney(back.cents, o.currency)}, until ${until}, and keep the pass for the other days. Open your tickets and choose “Get a refund”.`,
            ],
            highlight: { label: `Was ${from}`, value: `Now ${to}` },
            cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
            footer,
          }),
        });
      }
    }
    // Other holders (a transfer, a gift, a comp): the ticket still works; refunds go to whoever paid.
    for (const t of tickets) {
      const to_ = t.holderEmail.trim().toLowerCase();
      if (!to_ || told.has(to_)) continue;
      told.add(to_);
      mails.push({
        to: to_,
        subject: `New time: ${e.title}`,
        ...render({
          preheader: `${e.title} has moved to ${to}. Your ticket still works.`,
          heading: `${e.title} has a new time`,
          paragraphs: [
            `Hi ${first(t.holderName)}, ${e.org.name} has moved ${e.title}${where_}.`,
            ...why,
            t.order.kind === 'COMP' ? 'Your complimentary ticket still works for the new time.' : 'Your ticket still works for the new time. If you can’t make it, the person who bought it can get a refund until ' + until + '.',
          ],
          highlight: { label: `Was ${from}`, value: `Now ${to}` },
          cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
          footer,
        }),
      });
    }
    if (mails.length) await this.mail.sendMany('event.date_change', mails);
    const holders = await this.notices.holdersWhere({ ...where, status: { not: 'VOID' } });
    void this.notices.eventMoved({ id: e.id, title: e.title, orgName: e.org.name }, { id: c.id, to }, holders);
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
        ticketType: { select: { eventDateId: true, validDateIds: true } },
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
