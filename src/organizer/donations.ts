/**
 * Charity donations on an organizer's event: the orders that carry one (normal sales and fan-resale orders alike),
 * and refunding a donation by hand.
 *
 * Refunds are for the org's ADMINs only, like cancelling the event and the payouts screen (money leaves the
 * organizer's payout); managers and door staff can see the list. A refund goes through AdminService.refundDonation,
 * the same path as an Omoshow admin's: a conditional update and the provider idempotency key `donation-<orderId>`,
 * so an admin and an organizer can't both refund it; what's refunded is counted in donationRefundedCents (payouts and
 * donation totals drop by it), recorded as owed to Omoshow if the organizer had already been paid for the order, and
 * the buyer is emailed "Your donation of $X to {cause} was refunded." The tickets are untouched.
 *
 *   GET  /organizer/events/:id/donations                              (ADMIN, MANAGER, DOOR)
 *   POST /organizer/events/:id/orders/:orderId/refund-donation        { reason? } (ADMIN)
 */
import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AdminService } from '../admin/admin.module';
import { CurrentUser, type AuthUser } from '../common/auth';
import { donationLeft } from '../domain/pwyw';
import { DOOR_ROLES, eventForRole } from './access';

export class OrganizerDonationRefundDto {
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Injectable()
export class DonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
  ) {}

  async list(id: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, id, user, DOOR_ROLES);
    const me = await this.prisma.organizationMember.findFirst({ where: { orgId: ev.orgId, userId: user.id, status: 'ACTIVE' }, select: { role: true } });
    const rows = await this.prisma.order.findMany({
      where: { eventId: id, kind: 'SALE', donationCents: { gt: 0 }, status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      orderBy: { paidAt: 'desc' },
      take: 500,
      select: { id: true, buyerName: true, email: true, currency: true, donationCents: true, donationRefundedCents: true, donationCause: true, status: true, paidAt: true, resaleListingId: true },
    });
    const items = rows.map(({ id: orderId, resaleListingId, donationCause, ...o }) => ({ orderId, ...o, cause: donationCause, leftCents: donationLeft(o), resale: !!resaleListingId }));
    const cents = items.reduce((s, o) => s + o.donationCents, 0);
    const refundedCents = items.reduce((s, o) => s + o.donationRefundedCents, 0);
    return { cause: ev.donationCause, canRefund: me?.role === 'ADMIN', summary: { orders: items.length, cents: cents - refundedCents, refundedCents }, items };
  }

  async refund(id: string, orderId: string, user: AuthUser, reason?: string) {
    await eventForRole(this.prisma, id, user, ['ADMIN']);
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { eventId: true, kind: true } });
    if (!o || o.eventId !== id || o.kind !== 'SALE') throw new NotFoundException('Order not found.');
    return this.admin.refundDonation(orderId, user, reason?.trim() || 'Refunded by the organizer', { by: 'organizer' });
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id')
export class DonationController {
  constructor(private readonly svc: DonationService) {}

  /** Orders on this event with a donation, newest first, and whether you can refund them (org admins). */
  @Get('donations') list(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.list(id, u);
  }
  /** Refund what's left of an order's donation (org admins). The tickets are kept; the buyer is emailed. */
  @Post('orders/:orderId/refund-donation') @HttpCode(200) refund(@Param('id') id: string, @Param('orderId') orderId: string, @CurrentUser() u: AuthUser, @Body() dto: OrganizerDonationRefundDto) {
    return this.svc.refund(id, orderId, u, dto.reason);
  }
}
