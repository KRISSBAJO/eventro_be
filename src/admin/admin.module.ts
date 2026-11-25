import { previewToken } from '../events/preview';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { effectiveStatus } from '../venues/booking-rules';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { Payments } from '../checkout/payments';
import { MailService, render } from '../mail/mail.module';
import { config } from '../config';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';

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
      include: { ticketTypes: true, venue: true, org: { select: { id: true, name: true, supportEmail: true, _count: { select: { events: true } } } } },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    const published = await this.prisma.event.groupBy({ by: ['orgId'], where: { status: 'PUBLISHED' }, _count: { _all: true } });
    const pub = new Map(published.map((p) => [p.orgId, p._count._all]));
    return events.map((e) => ({ ...e, previewToken: previewToken(e.slug, e.status), flags: this.flags(e, pub.get(e.orgId) ?? 0) }));
  }

  /**
   * An event held at a venue booked on Eventro goes live only while that booking is confirmed (it can be cancelled
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
    await this.audit.log(admin.id, 'event.approve', 'Event', id);
    await this.notifyDecision(id, admin, 'approved');
    return { status: 'PUBLISHED' };
  }

  async reject(id: string, admin: AuthUser, note: string) {
    const { count } = await this.prisma.event.updateMany({ where: { id, status: 'IN_REVIEW' }, data: { status: 'REJECTED', reviewNote: note } });
    if (!count) throw new NotFoundException('No event waiting for review with that id.');
    await this.audit.log(admin.id, 'event.reject', 'Event', id, { note });
    await this.notifyDecision(id, admin, 'rejected', note);
    return { status: 'REJECTED' };
  }

  /**
   * Tells the organizer about a review decision (their admins and managers, plus the support address), and copies the
   * other Eventro admins on rejections so the team sees why. Email trouble never undoes the decision.
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
              paragraphs: ['Your event passed review and is now public on Eventro, with tickets on sale.', 'Share the link to get your first sales.'],
              cta: { label: 'See your event', url: `${config.webUrl}/events/${e.slug}` },
              footer: `You’re getting this because you manage ${e.org.name} on Eventro.`,
            })
          : render({
              preheader: `${e.title} needs a few changes before it can go live.`,
              heading: `${e.title} needs changes`,
              paragraphs: [
                `Eventro’s review team couldn’t approve ${e.title} yet. Their note:`,
                `“${note ?? ''}”`,
                'Make the changes in your dashboard and submit the event again. Resubmitted events go back to the front of the queue.',
              ],
              cta: { label: 'Edit and resubmit', url: manage },
              footer: `You’re getting this because you manage ${e.org.name} on Eventro. Questions? Reply to this email.`,
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
            footer: 'You’re getting this because you’re an Eventro admin.',
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
   * scan guarantee refunds at Eventro's cost, and the seller (whose ticket was voided at sale) is paid as normal.
   */
  async refundOrder(orderId: string, amountCents: number, admin: Pick<AuthUser, 'id'> | null, reason: string, opts: { keepSellerPayout?: boolean; refundKey?: string } = {}) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!o) throw new NotFoundException('Order not found.');
    const remaining = o.totalCents - o.refundedCents;
    if (amountCents > remaining) throw new BadRequestException(`At most ${remaining} cents can still be refunded.`);
    // `refundKey`: a retried refund is a no-op at providers that support idempotency (Stripe), so a retry after a
    // database failure can't refund twice.
    if (o.paymentRef && amountCents > 0) await this.payments.byName(o.provider).refund(o.paymentRef, amountCents, opts.refundKey);
    const full = amountCents === remaining;
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { refundedCents: { increment: amountCents }, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
      });
      if (full) {
        const { count } = await tx.ticket.updateMany({ where: { orderId, status: { not: 'VOID' } }, data: { status: 'VOID', listCents: null, transferTo: null } });
        // A resale order's seat was already counted as sold for the original buyer; hold the seller's payout for review.
        if (o.resaleListingId) {
          if (!opts.keepSellerPayout) await tx.resaleListing.update({ where: { id: o.resaleListingId }, data: { payoutStatus: 'HELD', payoutNote: `Buyer refunded: ${reason}` } });
        } else if (count) await tx.ticketType.update({ where: { id: o.ticketTypeId }, data: { sold: { decrement: count } } });
      }
    });
    await this.audit.log(admin?.id ?? null, full ? 'order.refund' : 'order.partial_refund', 'Order', orderId, { amountCents, currency: o.currency, reason });
  }

  /**
   * Refunds one ticket of an order (the Eventro Guarantee on a normal order): `amountCents` back through the payment
   * provider, and only that ticket voided and returned to sale. The order becomes REFUNDED once none of its tickets
   * is left and its whole total has been refunded; until then it is PARTIALLY_REFUNDED. Not for resale orders, whose
   * seller payout rules live in `refundOrder`.
   */
  async refundTicket(orderId: string, ticketId: string, amountCents: number, admin: Pick<AuthUser, 'id'> | null, reason: string, opts: { refundKey?: string } = {}) {
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
      const { count } = await tx.ticket.updateMany({ where: { id: ticketId, status: { not: 'VOID' } }, data: { status: 'VOID', listCents: null, transferTo: null } });
      if (count) await tx.ticketType.update({ where: { id: t.ticketTypeId }, data: { sold: { decrement: count } } });
      const live = await tx.ticket.count({ where: { orderId, status: { not: 'VOID' } } });
      const next = live === 0 && amountCents === remaining ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await tx.order.update({ where: { id: orderId }, data: { refundedCents: { increment: amountCents }, status: next } });
      return next;
    });
    await this.audit.log(admin?.id ?? null, status === 'REFUNDED' ? 'order.refund' : 'order.partial_refund', 'Order', orderId, { amountCents, currency: o.currency, reason, ticketId });
    return status;
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
