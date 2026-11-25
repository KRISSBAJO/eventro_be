/**
 * Cancelling a whole event, by its organizer (org admins) or by Eventro.
 *
 * The event becomes CANCELLED with sales paused; active holds are released and resale listings taken down; every
 * paid order is refunded for what's left on it, one at a time through AdminService.refundOrder (the same path as
 * an admin refund, so resale payouts are held the same way); every ticket is voided; each buyer gets one email;
 * a pending or confirmed venue booking for it is cancelled ("The event was cancelled") and the venue's managers
 * hear; and the whole run is audited.
 *
 * A refund that fails leaves its order PAID and is listed in the answer and the audit entry. Calling cancel again
 * retries only those: orders already refunded are skipped, so nothing is refunded twice.
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { MailService, formatMoney, render, type Mail } from '../mail/mail.module';
import { config } from '../config';
import type { AuthUser } from '../common/auth';
import { AdminService } from './admin.module';
import { NoticeService } from '../push/notices';
import { VenueBookingService } from '../venues/venue-bookings';

const REFUNDABLE = ['PAID', 'PARTIALLY_REFUNDED'] as const;

export type CancelSummary = {
  status: 'CANCELLED';
  /** true when the event had already been cancelled (this call only retried refunds that failed before) */
  alreadyCancelled: boolean;
  cancelledAt: Date;
  /** orders refunded by this call */
  refunded: number;
  failed: { orderId: string; message: string }[];
  /** refunded by this call, per currency, in minor units */
  totalRefundedCents: Record<string, number>;
  ticketsVoided: number;
  listingsCancelled: number;
  holdsReleased: number;
  /** the code of the venue booking cancelled with the event (it was pending or confirmed), else null */
  venueBookingCancelled: string | null;
};

@Injectable()
export class EventCancellation {
  private readonly log = new Logger('EventCancellation');
  /** events being cancelled right now in this process, so two clicks can't refund in parallel */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
    private readonly bookings: VenueBookingService,
  ) {}

  /** What cancelling would do: the paid orders that would be refunded and how much, per currency. */
  async preview(eventId: string) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, status: true, cancelledAt: true, cancelReason: true } });
    if (!e) throw new NotFoundException('Event not found.');
    const orders = await this.prisma.order.findMany({ where: { eventId, kind: 'SALE', status: { in: [...REFUNDABLE] } }, select: { totalCents: true, refundedCents: true, currency: true } });
    const totals: Record<string, number> = {};
    for (const o of orders) totals[o.currency] = (totals[o.currency] ?? 0) + (o.totalCents - o.refundedCents);
    const [tickets, listings] = await Promise.all([
      this.prisma.ticket.count({ where: { eventId, status: { not: 'VOID' } } }),
      this.prisma.resaleListing.count({ where: { eventId, status: { in: ['ACTIVE', 'HELD'] } } }),
    ]);
    return {
      id: e.id,
      title: e.title,
      status: e.status,
      cancelledAt: e.cancelledAt,
      cancelReason: e.cancelReason,
      paidOrders: orders.length,
      refundCents: Object.entries(totals).map(([currency, cents]) => ({ currency, cents })),
      tickets,
      resaleListings: listings,
    };
  }

  async cancel(eventId: string, actor: AuthUser, reason: string, by: 'organizer' | 'admin'): Promise<CancelSummary> {
    if (this.running.has(eventId)) throw new ConflictException('This event is already being cancelled. Refresh in a moment to see the result.');
    this.running.add(eventId);
    try {
      return await this.run(eventId, actor, reason.trim(), by);
    } finally {
      this.running.delete(eventId);
    }
  }

  private async run(eventId: string, actor: AuthUser, reason: string, by: 'organizer' | 'admin'): Promise<CancelSummary> {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, include: { venue: { select: { name: true, city: true } }, org: { select: { name: true, supportEmail: true } } } });
    if (!e) throw new NotFoundException('Event not found.');
    const alreadyCancelled = e.status === 'CANCELLED';
    const cancelledAt = e.cancelledAt ?? new Date();
    const shownReason = alreadyCancelled ? (e.cancelReason ?? reason) : reason;

    // 1. Stop sales first so nothing new is sold while refunds run.
    if (!alreadyCancelled) {
      await this.prisma.event.update({ where: { id: eventId }, data: { status: 'CANCELLED', cancelledAt, cancelReason: reason, salesPaused: true } });
    }
    const [holds, listings] = await Promise.all([
      this.prisma.hold.updateMany({ where: { eventId, status: 'ACTIVE' }, data: { status: 'RELEASED' } }),
      this.prisma.resaleListing.updateMany({ where: { eventId, status: { in: ['ACTIVE', 'HELD'] } }, data: { status: 'CANCELLED', cancelReason: 'Event cancelled', heldBy: null, heldUntil: null } }),
    ]);
    // The venue booked for it on Eventro is let go, and its managers hear. Never stops the refunds.
    const venueBookingCancelled = await this.bookings.cancelForEvent(eventId, actor).catch((err) => {
      this.log.warn(`Venue booking of cancelled event ${eventId}: ${(err as Error).message}`);
      return null;
    });

    // Counted now: refunds void their own tickets as they go.
    const liveTickets = await this.prisma.ticket.count({ where: { eventId, status: { not: 'VOID' } } });
    // Who to tell by push, also collected before the tickets are voided.
    const holders = await this.notices.holders(eventId).catch(() => [] as string[]);

    // 2. Refund each paid order on its own, so one failure doesn't stop the rest.
    // Sales only (a donation on an order is refunded with it: there's no event). Comps have nothing to refund; they're
    // voided below and their holders hear separately.
    const orders = await this.prisma.order.findMany({
      where: { eventId, kind: 'SALE', status: { in: [...REFUNDABLE] } },
      select: { id: true, email: true, buyerName: true, quantity: true, totalCents: true, refundedCents: true, currency: true, donationCents: true, donationRefundedCents: true, donationCause: true },
      orderBy: { createdAt: 'asc' },
    });
    const comps = await this.prisma.order.findMany({
      where: { eventId, kind: 'COMP', status: 'PAID' },
      select: { id: true, tickets: { where: { status: { not: 'VOID' } }, select: { holderEmail: true, holderName: true } } },
    });
    await this.prisma.order.updateMany({ where: { id: { in: comps.map((c) => c.id) } }, data: { status: 'CANCELLED' } });
    const refunded: { id: string; email: string; buyerName: string; quantity: number; cents: number; currency: string; donationCents: number; donationCause: string | null }[] = [];
    const failed: { orderId: string; message: string; email: string; buyerName: string; cents: number; currency: string }[] = [];
    for (const o of orders) {
      const left = o.totalCents - o.refundedCents;
      try {
        await this.admin.refundOrder(o.id, left, actor, `Event cancelled: ${shownReason}`);
        refunded.push({ id: o.id, email: o.email, buyerName: o.buyerName, quantity: o.quantity, cents: left, currency: o.currency, donationCents: o.donationCents - o.donationRefundedCents, donationCause: o.donationCause });
      } catch (err) {
        const message = ((err as Error).message || 'Refund failed').slice(0, 300);
        this.log.warn(`Refund of ${o.id} for cancelled event ${eventId} failed: ${message}`);
        failed.push({ orderId: o.id, message, email: o.email, buyerName: o.buyerName, cents: left, currency: o.currency });
      }
    }

    // 3. No ticket for a cancelled event can be used, listed or transferred, refunded or not.
    await this.prisma.ticket.updateMany({ where: { eventId, status: { not: 'VOID' } }, data: { status: 'VOID', listCents: null, transferTo: null, transferExpiresAt: null } });

    const totalRefundedCents: Record<string, number> = {};
    for (const r of refunded) totalRefundedCents[r.currency] = (totalRefundedCents[r.currency] ?? 0) + r.cents;

    await this.audit.log(actor.id, alreadyCancelled ? 'event.cancel_retry' : 'event.cancel', 'Event', eventId, {
      by,
      reason: shownReason,
      refunded: refunded.map((r) => ({ orderId: r.id, cents: r.cents, currency: r.currency })),
      failed: failed.map((f) => ({ orderId: f.orderId, message: f.message })),
      totalRefundedCents,
      ticketsVoided: liveTickets,
      listingsCancelled: listings.count,
      holdsReleased: holds.count,
      venueBookingCancelled,
    });

    // 4. One email per order, after replying: refunded ones say how much; failed ones that a refund is coming.
    const compHolders = comps.flatMap((c) => c.tickets.map((t) => ({ email: t.holderEmail, name: t.holderName })));
    void this.emailBuyers(e, shownReason, refunded, failed, alreadyCancelled, compHolders).catch((err) => this.log.warn(`Cancellation emails for ${eventId}: ${(err as Error).message}`));
    // Push to every ticket holder with an account (once per person, even if cancel is retried).
    void this.notices.eventCancelled({ id: e.id, title: e.title, orgName: e.org.name }, holders);

    return {
      status: 'CANCELLED',
      alreadyCancelled,
      cancelledAt,
      refunded: refunded.length,
      failed: failed.map(({ orderId, message }) => ({ orderId, message })),
      totalRefundedCents,
      ticketsVoided: liveTickets,
      listingsCancelled: listings.count,
      holdsReleased: holds.count,
      venueBookingCancelled,
    };
  }

  private async emailBuyers(
    e: { title: string; slug: string; startsAt: Date; venue: { name: string; city: string } | null; org: { name: string; supportEmail: string } },
    reason: string,
    refunded: { id: string; email: string; buyerName: string; cents: number; currency: string; donationCents: number; donationCause: string | null }[],
    failed: { orderId: string; email: string; buyerName: string; cents: number; currency: string }[],
    retry: boolean,
    compHolders: { email: string; name: string }[] = [],
  ) {
    const when = e.startsAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const where = e.venue ? ` at ${e.venue.name}, ${e.venue.city}` : '';
    const first = (name: string) => name.split(' ')[0] || 'there';
    const footer = `You’re getting this because you bought tickets to ${e.title} on Eventro.`;
    const mails: Mail[] = refunded.map((r) => {
      const amount = formatMoney(r.cents, r.currency);
      return {
        to: r.email,
        subject: `Cancelled: ${e.title} (refund of ${amount} on its way)`,
        ...render({
          preheader: `${e.title} won’t go ahead. We’ve refunded ${amount} to your original payment method.`,
          heading: `${e.title} has been cancelled`,
          paragraphs: [
            `Hi ${first(r.buyerName)}, we’re sorry: ${e.title} by ${e.org.name} (${when}${where}) has been cancelled.`,
            `The reason given: “${reason}”`,
            `We’ve refunded ${amount} for order ${r.id} to your original payment method${r.donationCents > 0 ? `, including your ${formatMoney(r.donationCents, r.currency)} donation${r.donationCause ? ` to ${r.donationCause}` : ''}` : ''}. It can take 5–10 business days to show up, depending on your bank.`,
            'Your tickets have been cancelled, so there’s nothing else you need to do.',
          ],
          highlight: { label: 'Refunded', value: amount },
          cta: { label: 'Find another event', url: `${config.webUrl}/events` },
          footer,
        }),
      };
    });
    // On a retry, buyers whose refund failed again already heard about the cancellation.
    if (!retry) {
      for (const f of failed) {
        const amount = formatMoney(f.cents, f.currency);
        mails.push({
          to: f.email,
          subject: `Cancelled: ${e.title}`,
          ...render({
            preheader: `${e.title} won’t go ahead. Your refund of ${amount} is being processed.`,
            heading: `${e.title} has been cancelled`,
            paragraphs: [
              `Hi ${first(f.buyerName)}, we’re sorry: ${e.title} by ${e.org.name} (${when}${where}) has been cancelled.`,
              `The reason given: “${reason}”`,
              `Your refund of ${amount} for order ${f.orderId} is being processed by the Eventro team. We’ll email you again as soon as it’s sent; after that it can take 5–10 business days to show up.`,
            ],
            highlight: { label: 'Refund due', value: amount },
            footer,
          }),
        });
      }
    }
    // Complimentary tickets: nothing to refund, but the guest needs to know (once, not on a retry).
    if (!retry) {
      const seen = new Set<string>();
      for (const c of compHolders) {
        const to = c.email.trim().toLowerCase();
        if (!to || seen.has(to)) continue;
        seen.add(to);
        mails.push({
          to,
          subject: `Cancelled: ${e.title}`,
          ...render({
            preheader: `${e.title} won’t go ahead. Your complimentary ticket has been cancelled.`,
            heading: `${e.title} has been cancelled`,
            paragraphs: [
              `Hi ${first(c.name)}, we’re sorry: ${e.title} by ${e.org.name} (${when}${where}) has been cancelled.`,
              `The reason given: “${reason}”`,
              'You were on the guest list with a complimentary ticket. It has been cancelled, so there’s nothing else you need to do.',
            ],
            cta: { label: 'Find another event', url: `${config.webUrl}/events` },
            footer: `You’re getting this because ${e.org.name} put you on the guest list for ${e.title} on Eventro.`,
          }),
        });
      }
    }
    if (mails.length) await this.mail.sendMany('event.cancelled', mails);
  }
}
