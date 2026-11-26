import { previewToken } from '../events/preview';
import { NoticeService } from '../push/notices';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { effectiveStatus } from '../venues/booking-rules';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { Payments } from '../checkout/payments';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { config } from '../config';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { donationLeft, ticketLeft, ticketRefunded, ticketTotal } from '../domain/pwyw';
import { organizerPaidOut, organizerShareOf } from '../domain/paid-out';
import { organizerNet } from '../domain/money';
import { Prisma, type Order } from '@prisma/client';
import { readPendingEdit } from '../domain/pending-edit';
import { LIVE_TYPE, dateView } from '../domain/event-dates';
import { releaseReservations } from '../schedule/release';

export class RejectDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(500) note: string;
}

export class RefundDecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'PARTIAL', 'DENY'] }) @IsIn(['APPROVE', 'PARTIAL', 'DENY']) decision: 'APPROVE' | 'PARTIAL' | 'DENY';
  @ApiPropertyOptional({ description: 'Required for PARTIAL, in cents' }) @IsOptional() @IsInt() @Min(1) amountCents?: number;
}

export class FraudDecisionDto {
  @ApiProperty({ enum: ['BLOCK', 'WATCH', 'ALLOW'] }) @IsIn(['BLOCK', 'WATCH', 'ALLOW']) decision: 'BLOCK' | 'WATCH' | 'ALLOW';
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: Payments,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /** Automatic flags shown next to each event in the review queue. */
  private flags(e: { title: string; ticketTypes: { priceCents: number; capacity: number }[]; org: { _count: { events: number } } }, publishedByOrg: number) {
    const f: string[] = [];
    if (e.ticketTypes.some((t) => t.priceCents > 50_000)) f.push('Price above $500');
    if (e.ticketTypes.reduce((s, t) => s + t.capacity, 0) > 5000) f.push('Capacity over 5,000');
    if (/free|giveaway|win |prize/i.test(e.title)) f.push('Prize-promotion wording');
    if (publishedByOrg === 0) f.push('New organizer (no published events)');
    return f;
  }

  async reviews(status = 'IN_REVIEW') {
    const events = await this.prisma.event.findMany({
      where: { status: status as 'IN_REVIEW' | 'PUBLISHED' | 'REJECTED' },
      // Multiple dates: the dates, and only the tier copies of dates still on (as on every event payload).
      include: { ticketTypes: { where: LIVE_TYPE }, dates: { orderBy: { startsAt: 'asc' } }, venue: true, org: { select: { id: true, name: true, supportEmail: true, _count: { select: { events: true } } } } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    const published = await this.prisma.event.groupBy({ by: ['orgId'], where: { status: 'PUBLISHED' }, _count: { _all: true } });
    const pub = new Map(published.map((p) => [p.orgId, p._count._all]));
    return events.map((e) => ({ ...e, dates: e.dates.map(dateView), previewToken: previewToken(e.slug, e.status), flags: this.flags(e, pub.get(e.orgId) ?? 0) }));
  }

  /**
   * An event held at a venue booked on Omoshow goes live only while that booking is confirmed (it can be cancelled
   * during review, or after a takedown). Used by review approval and by the console's publish.
   */
  async assertVenueBookingConfirmed(eventId: string, hint = 'Reject it so the organizer can pick another venue.') {
    const booking = await this.prisma.venueBooking.findUnique({ where: { eventId }, select: { code: true, status: true, holdUntil: true } });
    if (booking && effectiveStatus(booking) !== 'CONFIRMED') {
      throw new ConflictException({ statusCode: 409, code: 'VENUE_BOOKING_NOT_CONFIRMED', message: `This event’s venue booking (${booking.code}) is ${effectiveStatus(booking).toLowerCase()}, not confirmed. ${hint}` });
    }
  }

  async approve(id: string, admin: AuthUser) {
    await this.assertVenueBookingConfirmed(id);
    const { count } = await this.prisma.event.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'PUBLISHED', reviewNote: null } });
    if (!count) throw new NotFoundException('No event waiting for review with that id.');
    // First time on sale: "Just announced" counts from here (approving an edit later doesn't move it).
    const first = await this.prisma.event.updateMany({ where: { id, publishedAt: null }, data: { publishedAt: new Date() } });
    await this.audit.log(admin.id, 'event.approve', 'Event', id);
    await this.notifyDecision(id, admin, 'approved');
    // New on sale: fans following the organizer or the venue hear about it (not when an edit is approved later).
    if (first.count) void this.notices.newEvent(id);
    return { status: 'PUBLISHED' };
  }

  async reject(id: string, admin: AuthUser, note: string) {
    const { count } = await this.prisma.event.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'REJECTED', reviewNote: note } });
    if (!count) throw new NotFoundException('No event waiting for review with that id.');
    await this.audit.log(admin.id, 'event.reject', 'Event', id, { note });
    await this.notifyDecision(id, admin, 'rejected', note);
    return { status: 'REJECTED' };
  }

  /* ---------- edits to live events ---------- */

  /** Live events with a title, subtitle, cover or photo change waiting (Event.pendingEdit), oldest first. */
  async pendingEdits() {
    const rows = await this.prisma.event.findMany({
      where: { pendingEdit: { not: Prisma.DbNull } },
      select: { id: true, slug: true, title: true, subtitle: true, imageUrl: true, status: true, pendingEdit: true, org: { select: { id: true, name: true, verifiedAt: true } } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    return rows
      .map((e) => ({ ...e, pendingEdit: readPendingEdit(e.pendingEdit) }))
      .filter((e) => e.pendingEdit)
      .sort((a, b) => a.pendingEdit!.submittedAt.localeCompare(b.pendingEdit!.submittedAt));
  }

  /** Puts a waiting edit live (only what's still waiting; the organizer may have withdrawn it). */
  async approveEdit(id: string, admin: AuthUser) {
    const e = await this.prisma.event.findUnique({ where: { id }, select: { pendingEdit: true, updatedAt: true } });
    const pe = readPendingEdit(e?.pendingEdit);
    if (!e || !pe) throw new NotFoundException('No change waiting for review on this event.');
    // Only the version the admin looked at: if the organizer changed it since, they look again.
    const { count } = await this.prisma.event.updateMany({
      where: { id, updatedAt: e.updatedAt },
      data: {
        ...(pe.title !== undefined ? { title: pe.title } : {}),
        ...(pe.subtitle !== undefined ? { subtitle: pe.subtitle } : {}),
        ...(pe.imageUrl !== undefined ? { imageUrl: pe.imageUrl } : {}),
        ...(pe.media !== undefined ? { media: pe.media as Prisma.InputJsonValue } : {}),
        pendingEdit: Prisma.DbNull,
        pendingEditNote: null,
      },
    });
    if (!count) throw new ConflictException('The organizer changed this edit a moment ago. Refresh and look again.');
    await this.audit.log(admin.id, 'event.edit_approve', 'Event', id, { fields: Object.keys(pe).filter((k) => k !== 'submittedAt' && k !== 'by') });
    void this.notifyEdit(id, 'approved');
    return { approved: true };
  }

  /** Turns a waiting edit down: fans keep seeing the approved version, and the organizer gets the note. */
  async rejectEdit(id: string, admin: AuthUser, note: string) {
    const e = await this.prisma.event.findUnique({ where: { id }, select: { pendingEdit: true } });
    if (!e || !readPendingEdit(e.pendingEdit)) throw new NotFoundException('No change waiting for review on this event.');
    await this.prisma.event.update({ where: { id }, data: { pendingEdit: Prisma.DbNull, pendingEditNote: note.trim() } });
    await this.audit.log(admin.id, 'event.edit_reject', 'Event', id, { note });
    void this.notifyEdit(id, 'rejected', note.trim());
    return { approved: false };
  }

  /** "Your changes to X are live" / "weren't approved", to the organizer's admins and managers. */
  private async notifyEdit(id: string, decision: 'approved' | 'rejected', note?: string) {
    try {
      const e = await this.prisma.event.findUnique({
        where: { id },
        select: { id: true, slug: true, title: true, org: { select: { name: true, supportEmail: true, members: { where: { status: 'ACTIVE', role: { in: ['ADMIN', 'MANAGER'] } }, select: { email: true } } } } },
      });
      if (!e) return;
      const to = [...new Set([e.org.supportEmail, ...e.org.members.map((m) => m.email)].filter(Boolean).map((x) => x.trim().toLowerCase()))];
      const copy =
        decision === 'approved'
          ? render({
              preheader: `Your changes to ${e.title} are live.`,
              heading: 'Your changes are live',
              paragraphs: [`Omoshow checked your changes to ${e.title}, and fans now see them.`],
              cta: { label: 'See your event', url: `${config.webUrl}/events/${e.slug}` },
              footer: `You’re getting this because you manage ${e.org.name} on Omoshow.`,
            })
          : render({
              preheader: `Your changes to ${e.title} weren’t approved.`,
              heading: 'Your changes weren’t approved',
              paragraphs: [`Omoshow didn’t approve your changes to ${e.title}, so fans still see the version that was live before. The note from the team:`, `“${note ?? ''}”`, 'You can make new changes any time.'],
              cta: { label: 'Edit the event', url: `${config.webUrl}/organizer/events/${e.id}` },
              footer: `You’re getting this because you manage ${e.org.name} on Omoshow.`,
            });
      await this.mail.sendMany(`event.edit_${decision}`, to.map((x) => ({ to: x, subject: decision === 'approved' ? `Live: your changes to ${e.title}` : `Not approved: your changes to ${e.title}`, ...copy })));
    } catch {
      /* the decision stands */
    }
  }

  /**
   * Tells the organizer about a review decision (their admins and managers, plus the support address), and copies the
   * other Omoshow admins on rejections so the team sees why. Email trouble never undoes the decision.
   */
  private async notifyDecision(id: string, admin: AuthUser, decision: 'approved' | 'rejected', note?: string) {
    try {
      const e = await this.prisma.event.findUnique({
        where: { id },
        select: {
          id: true,
          slug: true,
          title: true,
          org: { select: { name: true, supportEmail: true, members: { where: { status: 'ACTIVE', role: { in: ['ADMIN', 'MANAGER'] } }, select: { email: true } } } },
        },
      });
      if (!e) return;
      const manage = `${config.webUrl}/organizer/events/${e.id}`;
      const to = [...new Set([e.org.supportEmail, ...e.org.members.map((m) => m.email)].filter(Boolean).map((x) => x.trim().toLowerCase()))];
      const org =
        decision === 'approved'
          ? render({
              preheader: `${e.title} passed review and is on sale now.`,
              heading: `${e.title} is live`,
              paragraphs: ['Your event passed review and is now public on Omoshow, with tickets on sale.', 'Share the link to get your first sales.'],
              cta: { label: 'See your event', url: `${config.webUrl}/events/${e.slug}` },
              footer: `You’re getting this because you manage ${e.org.name} on Omoshow.`,
            })
          : render({
              preheader: `${e.title} needs a few changes before it can go live.`,
              heading: `${e.title} needs changes`,
              paragraphs: [
                `Omoshow’s review team couldn’t approve ${e.title} yet. Their note:`,
                `“${note ?? ''}”`,
                'Make the changes in your dashboard and submit the event again. Resubmitted events go back to the front of the queue.',
              ],
              cta: { label: 'Edit and resubmit', url: manage },
              footer: `You’re getting this because you manage ${e.org.name} on Omoshow. Questions? Reply to this email.`,
            });
      const subject = decision === 'approved' ? `Approved: ${e.title} is live` : `Changes needed: ${e.title}`;
      await this.mail.sendMany(`event.${decision}`, to.map((addr) => ({ to: addr, subject, ...org })));

      if (decision === 'rejected') {
        const admins = await this.prisma.user.findMany({ where: { roles: { has: 'ADMIN' }, id: { not: admin.id }, suspendedAt: null }, select: { email: true } });
        if (admins.length) {
          const copy = render({
            preheader: `${admin.name} rejected ${e.title}.`,
            heading: `${e.title} was rejected`,
            paragraphs: [`${admin.name} rejected ${e.title} by ${e.org.name}. The note sent to the organizer:`, `“${note ?? ''}”`],
            cta: { label: 'Open the review queue', url: `${config.webUrl}/admin#review` },
            footer: 'You’re getting this because you’re an Omoshow admin.',
          });
          await this.mail.sendMany('event.rejected.admins', admins.map((a) => ({ to: a.email, subject: `Rejected: ${e.title} (${e.org.name})`, ...copy })));
        }
      }
    } catch {
      /* the decision stands; the email log shows what didn't send */
    }
  }

  /**
   * Refunds through the payment provider; a full refund voids the tickets and returns them to sale.
   * A full refund of a resale order holds the seller's payout for review, except with `keepSellerPayout`: the resale
   * scan guarantee refunds at Omoshow's cost, and the seller (whose ticket was voided at sale) is paid as normal.
   */
  async refundOrder(orderId: string, amountCents: number, admin: Pick<AuthUser, 'id'> | null, reason: string, opts: { keepSellerPayout?: boolean; refundKey?: string; recordOwed?: boolean } = {}) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    const remaining = o.totalCents - o.refundedCents;
    // `recordOwed` (an event or date cancelled or moved): if the organizer was already paid for this order, their share
    // of the refund is recorded as owed by them to Omoshow, so the money isn't silently Omoshow's loss.
    const debt = opts.recordOwed ? await this.owedOnRefund(o, Math.min(amountCents, remaining)) : null;
    const owed = debt?.cents ?? 0;
    if (amountCents > remaining) throw new BadRequestException(`At most ${remaining} cents can still be refunded.`);
    // `refundKey`: a retried refund is a no-op at providers that support idempotency (Stripe), so a retry after a
    // database failure can't refund twice.
    if (o.paymentRef && amountCents > 0) await this.payments.byName(o.provider).refund(o.paymentRef, amountCents, opts.refundKey);
    const full = amountCents === remaining;
    // A donation is refunded last: a partial refund counts against the tickets first, and only what goes past the
    // ticket total is the donation. A full refund (e.g. the event was cancelled) refunds the donation too.
    const donationRefundedCents = full ? o.donationCents : Math.min(o.donationCents, Math.max(o.donationRefundedCents, o.refundedCents + amountCents - ticketTotal(o)));
    // The tickets are done once everything paid for them is back, even if a donation stays on the order (an Omoshow
    // Guarantee refund of a resale order that came with a donation): they're voided as on a full refund. Without a
    // donation this is the same as a full refund.
    const ticketsDone = full || (amountCents > 0 && amountCents >= ticketLeft(o));
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { refundedCents: { increment: amountCents }, donationRefundedCents, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ...(owed ? { refundOwedCents: { increment: owed } } : {}) },
      });
      // What they owe comes out of their next payouts (OrganizerService.payouts).
      if (debt && owed) await tx.organizerDebt.create({ data: { orgId: debt.orgId, orderId, kind: 'REFUND', cents: owed, refundedCents: amountCents, currency: o.currency } });
      if (ticketsDone) {
        const { count } = await tx.ticket.updateMany({ where: { orderId, status: { not: 'VOID' } }, data: { status: 'VOID', listCents: null, transferTo: null } });
        // Session places booked with these tickets go back.
        await releaseReservations(tx, { orderId, status: 'VOID' });
        // A resale order's seat was already counted as sold for the original buyer; hold the seller's payout for review.
        if (o.resaleListingId) {
          if (!opts.keepSellerPayout) await tx.resaleListing.update({ where: { id: o.resaleListingId }, data: { payoutStatus: 'HELD', payoutNote: `Buyer refunded: ${reason}` } });
        } else if (count) await tx.ticketType.update({ where: { id: o.ticketTypeId }, data: { sold: { decrement: count } } });
      }
    });
    await this.audit.log(admin?.id ?? null, full ? 'order.refund' : 'order.partial_refund', 'Order', orderId, { amountCents, currency: o.currency, reason, ...(owed ? { organizerOwedCents: owed } : {}) });
  }

  /** The organizer's share of a refund of `amountCents` from `o`, if they'd already been paid for the order; else 0. */
  private async owedOnRefund(o: Order, amountCents: number) {
    if (amountCents <= 0 || o.kind !== 'SALE') return null;
    const e = await this.prisma.event.findUnique({
      where: { id: o.eventId },
      select: { orgId: true, feeMode: true, org: { select: { payoutSchedule: true, payoutProvider: true, paystackSubaccount: true, stripeAccountId: true } } },
    });
    if (!e || !organizerPaidOut(o, e.org)) return null;
    const listing = o.resaleListingId ? await this.prisma.resaleListing.findUnique({ where: { id: o.resaleListingId }, select: { royaltyCents: true } }) : null;
    const ticketNet = o.resaleListingId ? (listing?.royaltyCents ?? 0) : organizerNet(o.unitCents, e.feeMode, config.organizerFeePermille) * o.quantity - o.discountCents - ticketRefunded(o);
    return { orgId: e.orgId, cents: organizerShareOf(o, amountCents, ticketNet) };
  }

  /**
   * Refunds one ticket of an order (the Omoshow Guarantee on a normal order): `amountCents` back through the payment
   * provider, and only that ticket voided and returned to sale. The order becomes REFUNDED once none of its tickets
   * is left and its whole total has been refunded; until then it is PARTIALLY_REFUNDED. Not for resale orders, whose
   * seller payout rules live in `refundOrder`. With `keepTicket` (a multi-day pass refunded for one of its days) the
   * money goes back but the ticket stays valid for its other days.
   */
  async refundTicket(orderId: string, ticketId: string, amountCents: number, admin: Pick<AuthUser, 'id'> | null, reason: string, opts: { refundKey?: string; keepTicket?: boolean } = {}) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    if (o.resaleListingId) throw new BadRequestException('Resale orders are refunded as a whole.');
    const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { orderId: true, status: true, ticketTypeId: true } });
    if (!t || t.orderId !== orderId) throw new NotFoundException('Ticket not found on this order.');
    if (t.status === 'VOID') throw new BadRequestException('This ticket has already been cancelled.');
    const remaining = o.totalCents - o.refundedCents;
    if (amountCents > remaining) throw new BadRequestException(`At most ${remaining} cents can still be refunded.`);
    if (o.paymentRef && amountCents > 0) await this.payments.byName(o.provider).refund(o.paymentRef, amountCents, opts.refundKey);
    const status = await this.prisma.$transaction(async (tx) => {
      const { count } = opts.keepTicket ? { count: 0 } : await tx.ticket.updateMany({ where: { id: ticketId, status: { not: 'VOID' } }, data: { status: 'VOID', listCents: null, transferTo: null } });
      if (count) await tx.ticketType.update({ where: { id: t.ticketTypeId }, data: { sold: { decrement: count } } });
      // A voided ticket's session places go back (a multi-day pass kept for its other days keeps them).
      if (count) await releaseReservations(tx, { id: ticketId });
      const live = await tx.ticket.count({ where: { orderId, status: { not: 'VOID' } } });
      const next = live === 0 && amountCents === remaining ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await tx.order.update({ where: { id: orderId }, data: { refundedCents: { increment: amountCents }, status: next } });
      return next;
    });
    await this.audit.log(admin?.id ?? null, status === 'REFUNDED' ? 'order.refund' : 'order.partial_refund', 'Order', orderId, { amountCents, currency: o.currency, reason, ticketId, ...(opts.keepTicket ? { ticketKept: true } : {}) });
    return status;
  }

  /**
   * Refunds what's left of an order's charity donation, by hand: an Omoshow admin (admin console) or the event's org
   * admin (OrganizerDonations). The tickets are untouched. Both go through here, guarded by a conditional update (so
   * a double click, or an admin and an organizer at once, refunds once) and the provider idempotency key
   * `donation-<orderId>`. If the organizer had already been paid for the order (organizerPaidOut, as for guarantee
   * claims), the refunded amount is recorded as owed by them to Omoshow (Order.donationOwedCents). Their payouts drop
   * by it either way (they count donationCents − donationRefundedCents). The buyer gets an email.
   */
  async refundDonation(orderId: string, admin: Pick<AuthUser, 'id'>, reason: string, opts: { by?: 'eventro' | 'organizer' } = {}) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { event: { select: { title: true, orgId: true, org: { select: { name: true, payoutSchedule: true, payoutProvider: true, paystackSubaccount: true, stripeAccountId: true } } } } } });
    if (!o) throw new NotFoundException('Order not found.');
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.status)) throw new BadRequestException('Only paid orders can be refunded.');
    const amount = Math.min(donationLeft(o), o.totalCents - o.refundedCents);
    if (amount <= 0) throw new BadRequestException('This order has no donation left to refund.');
    // Claim the refund first: only one call moves donationRefundedCents.
    const { count } = await this.prisma.order.updateMany({
      where: { id: orderId, donationRefundedCents: o.donationRefundedCents, refundedCents: o.refundedCents },
      data: { donationRefundedCents: { increment: amount }, refundedCents: { increment: amount } },
    });
    if (!count) throw new ConflictException('This order changed a moment ago. Refresh and try again.');
    try {
      if (o.paymentRef) await this.payments.byName(o.provider).refund(o.paymentRef, amount, `donation-${orderId}`);
    } catch (e) {
      await this.prisma.order.update({ where: { id: orderId }, data: { donationRefundedCents: { decrement: amount }, refundedCents: { decrement: amount } } });
      throw e;
    }
    const live = await this.prisma.ticket.count({ where: { orderId, status: { not: 'VOID' } } });
    const after = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // Fully refunded only when nothing is left on it and none of its tickets work any more.
    const status = live === 0 && after.refundedCents >= after.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const owed = organizerPaidOut(o, o.event.org) ? amount : 0;
    await this.prisma.order.update({ where: { id: orderId }, data: { status, ...(owed ? { donationOwedCents: { increment: owed } } : {}) } });
    if (owed) await this.prisma.organizerDebt.create({ data: { orgId: o.event.orgId, orderId, kind: 'DONATION', cents: owed, refundedCents: owed, currency: o.currency } });
    await this.audit.log(admin.id, 'order.donation_refund', 'Order', orderId, { amountCents: amount, currency: o.currency, cause: o.donationCause, reason, by: opts.by ?? 'eventro', organizerOwedCents: owed });
    void this.donationRefundEmail(o, amount).catch(() => undefined);
    const view = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true, refundedCents: true, totalCents: true, donationCents: true, donationRefundedCents: true, donationCause: true, currency: true, donationOwedCents: true },
    });
    return { ...view, refundedNowCents: amount };
  }

  /** "Your donation of $X to {cause} was refunded." to the buyer. Email trouble never undoes the refund. */
  private async donationRefundEmail(o: { id: string; email: string; currency: string; donationCause: string | null; event: { title: string; org: { name: string } } }, amount: number) {
    const cause = o.donationCause ?? 'the organizer’s cause';
    const line = `Your donation of ${formatMoney(amount, o.currency)} to ${cause} was refunded.`;
    const { html, text } = render({
      preheader: line,
      heading: 'Your donation was refunded',
      highlight: { label: `Order ${o.id} · ${o.event.title}`, value: formatMoney(amount, o.currency) },
      paragraphs: [line, 'It goes back to your original payment method and can take 5–10 business days to show up, depending on your bank. Your tickets aren’t affected.'],
      cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
      footer: `You got this email because you donated through Omoshow at checkout for an event by ${o.event.org.name}.`,
    });
    await this.mail.send('order.donation_refund', { to: o.email, subject: `Your donation to ${cause} was refunded`, html, text });
  }

  refunds(status = 'OPEN') {
    return this.prisma.refundRequest.findMany({
      where: { status: status as 'OPEN' },
      include: { order: { select: { id: true, buyerName: true, email: true, totalCents: true, refundedCents: true, quantity: true, currency: true, event: { select: { title: true, startsAt: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async decideRefund(id: string, admin: AuthUser, dto: RefundDecisionDto) {
    const r = await this.prisma.refundRequest.findUnique({ where: { id }, include: { order: true } });
    if (!r || r.status !== 'OPEN') throw new NotFoundException('Open refund request not found.');
    let amount: number | null = null;
    if (dto.decision === 'APPROVE') amount = r.order.totalCents - r.order.refundedCents;
    if (dto.decision === 'PARTIAL') {
      if (!dto.amountCents) throw new BadRequestException('Give the partial amount in cents.');
      amount = dto.amountCents;
    }
    if (amount) await this.refundOrder(r.orderId, amount, admin, `refund request ${id}`);
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : dto.decision === 'PARTIAL' ? 'PARTIAL' : 'DENIED';
    await this.audit.log(admin.id, `refund_request.${status.toLowerCase()}`, 'RefundRequest', id, { amountCents: amount });
    return this.prisma.refundRequest.update({ where: { id }, data: { status, amountCents: amount, decidedBy: admin.id, decidedAt: new Date() } });
  }

  fraud(status = 'OPEN') {
    return this.prisma.fraudFlag.findMany({
      where: { status: status as 'OPEN' },
      include: { order: { select: { id: true, email: true, totalCents: true, quantity: true, status: true, currency: true, event: { select: { title: true } } } } },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async decideFraud(id: string, admin: AuthUser, dto: FraudDecisionDto) {
    const f = await this.prisma.fraudFlag.findUnique({ where: { id }, include: { order: true } });
    if (!f || f.status !== 'OPEN') throw new NotFoundException('Open fraud flag not found.');
    if (dto.decision === 'BLOCK' && f.order.status === 'PAID') {
      await this.refundOrder(f.orderId, f.order.totalCents - f.order.refundedCents, admin, `fraud flag ${id}`);
    }
    const status = dto.decision === 'BLOCK' ? 'BLOCKED' : dto.decision === 'WATCH' ? 'WATCHING' : 'ALLOWED';
    await this.audit.log(admin.id, `fraud.${status.toLowerCase()}`, 'FraudFlag', id);
    return this.prisma.fraudFlag.update({ where: { id }, data: { status, decidedBy: admin.id, decidedAt: new Date() } });
  }

  auditLog(limit = 100) {
    return this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(limit, 500), include: { actor: { select: { email: true } } } });
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @ApiQuery({ name: 'status', required: false, enum: ['IN_REVIEW', 'PUBLISHED', 'REJECTED'] })
  @Get('reviews') reviews(@Query('status') status?: string) {
    return this.svc.reviews(status);
  }
  @Post('events/:id/approve') @HttpCode(200) approve(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.approve(id, u);
  }
  @Post('events/:id/reject') @HttpCode(200) reject(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: RejectDto) {
    return this.svc.reject(id, u, dto.note);
  }

  /** Edits to live events waiting for a check (title, subtitle, cover, photos). */
  @Get('pending-edits') pendingEdits() {
    return this.svc.pendingEdits();
  }
  @Post('events/:id/edit/approve') @HttpCode(200) approveEdit(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.approveEdit(id, u);
  }
  @Post('events/:id/edit/reject') @HttpCode(200) rejectEdit(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: RejectDto) {
    return this.svc.rejectEdit(id, u, dto.note);
  }

  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'APPROVED', 'PARTIAL', 'DENIED'] })
  @Get('refunds') refunds(@Query('status') status?: string) {
    return this.svc.refunds(status);
  }
  @Post('refunds/:id/decide') @HttpCode(200) decideRefund(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: RefundDecisionDto) {
    return this.svc.decideRefund(id, u, dto);
  }

  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'BLOCKED', 'WATCHING', 'ALLOWED'] })
  @Get('fraud') fraud(@Query('status') status?: string) {
    return this.svc.fraud(status);
  }
  @Post('fraud/:id/decide') @HttpCode(200) decideFraud(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: FraudDecisionDto) {
    return this.svc.decideFraud(id, u, dto);
  }

  @Get('audit') audit(@Query('limit') limit?: string) {
    return this.svc.auditLog(Number(limit) || 100);
  }
}

// The Nest module that registers these lives in admin-console.ts (it also needs AdminService).
