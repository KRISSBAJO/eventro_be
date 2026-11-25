/**
 * Official fan resale.
 *
 * A ticket holder lists a ticket (POST /tickets/:id/listing, in the tickets module) within the organizer's rules:
 * resale switched on, at most the price cap (% of face value), and not too close to the start. Fans see active
 * listings on the event page and buy them like any ticket: hold the listing for 10 minutes, then pay
 * (POST /resale/:id/orders, in checkout). On payment the seller's ticket is cancelled and the buyer gets a new ticket
 * for the same seat, so an old screenshot or QR is useless.
 *
 * The seller's money (price − Eventro's fee − the organizer's cut) is held until a day after the event, then
 * becomes available; an admin pays it out or holds it (e.g. a dispute).
 *
 *   GET  /events/:slug/resale          active listings for an event (public)
 *   POST /resale/:id/hold              hold a listing for checkout (10 minutes)
 *   GET  /me/resale                    my listings and payouts
 *   GET  /admin/resale                 listings (admin)
 *   POST /admin/resale/:id/delist      take a listing down (admin)
 *   GET  /admin/resale/payouts         seller payouts (admin)
 *   POST /admin/resale/:id/payout      { action: PAY | HOLD | RELEASE, note? } (admin)
 */
import { randomBytes } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Global, HttpCode, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { TIER_FIELDS, withLook } from '../domain/tier-look';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { CurrentUser, OptionalAuth, Public, Roles, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit } from '../common/rate-limit';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { sectionName, type SeatMap } from '../domain/seatmap';
import { ticketDates, ticketTimes } from '../domain/event-dates';

const HOLD_MINUTES = 10;
const PAGE = 25;
const pageOf = (raw?: string) => Math.max(1, Math.min(10_000, Number(raw) || 1));

/** Resale and transfers stop this long before the start (the organizer's setting, in minutes). */
export function pastCutoff(e: { startsAt: Date; transferCutoffMinutes: number }) {
  // Event times are the venue's wall-clock time stored as UTC, so this is approximate by the zone offset.
  return Date.now() > e.startsAt.getTime() - e.transferCutoffMinutes * 60_000;
}

export class DelistDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason: string;
}
export class PayoutDto {
  @ApiProperty({ enum: ['PAY', 'HOLD', 'RELEASE'] }) @IsIn(['PAY', 'HOLD', 'RELEASE']) action: 'PAY' | 'HOLD' | 'RELEASE';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

@Injectable()
export class ResaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  /** Lets go of holds that ran out, and makes payouts available once their date has passed. */
  async tidy() {
    const now = new Date();
    await this.prisma.resaleListing.updateMany({ where: { status: 'HELD', heldUntil: { lt: now }, order: { is: null } }, data: { status: 'ACTIVE', heldUntil: null, heldBy: null } });
    // A hold whose order was abandoned (still pending) is released too.
    await this.prisma.resaleListing.updateMany({ where: { status: 'HELD', heldUntil: { lt: now }, order: { is: { status: { in: ['PENDING', 'CANCELLED'] } } } }, data: { status: 'ACTIVE', heldUntil: null, heldBy: null } });
    await this.prisma.resaleListing.updateMany({ where: { payoutStatus: 'PENDING', payoutAvailableAt: { lte: now } }, data: { payoutStatus: 'AVAILABLE' } });
  }

  async forEvent(slug: string) {
    await this.tidy();
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true, resaleEnabled: true, seatMap: true, currency: true, startsAt: true, doorsAt: true, endsAt: true, transferCutoffMinutes: true, dateMode: true, dates: true } });
    if (!e || e.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    if (!e.resaleEnabled) return { enabled: false, listings: [] };
    const rows = await this.prisma.resaleListing.findMany({
      where: { eventId: e.id, status: 'ACTIVE' },
      orderBy: { priceCents: 'asc' },
      include: { ticket: { select: { section: true, row: true, seat: true, ticketType: { select: { id: true, eventDateId: true, validDateIds: true, ...TIER_FIELDS } } } } },
      take: 200,
    });
    const map = e.seatMap as SeatMap | null;
    // Multiple dates: each listing shows its date (DATES) or days (DAYS); ones past their own cutoff aren't buyable.
    const open = (l: (typeof rows)[number]) => e.dateMode === 'SINGLE' || !pastCutoff({ ...e, startsAt: ticketTimes(e.dateMode, e, l.ticket.ticketType, e.dates).first.startsAt });
    return {
      enabled: true,
      listings: rows.filter(open).map((l) => {
        const sec = map?.sections.find((s) => s.id === l.ticket.section);
        return {
          id: l.id,
          priceCents: l.priceCents,
          faceCents: l.faceCents,
          currency: l.currency,
          ticketType: withLook(l.ticket.ticketType),
          ...ticketDates(e.dateMode, l.ticket.ticketType, e.dates),
          section: l.ticket.section,
          sectionName: sec ? sectionName(sec) : l.ticket.section,
          row: l.ticket.row,
          seat: l.ticket.seat,
          listedAt: l.createdAt,
        };
      }),
    };
  }

  /** Holds a listing for one buyer for 10 minutes. The returned key is needed to create the order. */
  async hold(id: string, user: AuthUser | null) {
    await this.tidy();
    const l = await this.prisma.resaleListing.findUnique({ where: { id }, include: { event: { include: { dates: true } }, ticket: { select: { ticketType: { select: { eventDateId: true, validDateIds: true } } } } } });
    if (!l || l.event.status !== 'PUBLISHED' || !l.event.resaleEnabled) throw new NotFoundException('That listing isn’t available.');
    if (user && user.id === l.sellerId) throw new BadRequestException('That’s your own listing.');
    // The ticket's own date (DATES) or first valid day (DAYS) sets the cutoff.
    if (pastCutoff({ ...l.event, startsAt: ticketTimes(l.event.dateMode, l.event, l.ticket.ticketType, l.event.dates).first.startsAt })) throw new BadRequestException('Resale has closed for this event.');
    const key = randomBytes(16).toString('base64url');
    const heldUntil = new Date(Date.now() + HOLD_MINUTES * 60_000);
    const { count } = await this.prisma.resaleListing.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'HELD', heldUntil, heldBy: key } });
    if (!count) throw new BadRequestException('Someone else is buying that ticket right now. Try another one.');
    return { listingId: id, holdKey: key, heldUntil, priceCents: l.priceCents, currency: l.currency };
  }

  async mine(user: AuthUser) {
    await this.tidy();
    const rows = await this.prisma.resaleListing.findMany({
      where: { sellerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { event: { select: { slug: true, title: true, startsAt: true, seatMap: true, dateMode: true, dates: true } }, ticket: { select: { id: true, section: true, row: true, seat: true, ticketType: { select: { ...TIER_FIELDS, eventDateId: true, validDateIds: true } } } } },
      take: 100,
    });
    const pending = rows.filter((r) => r.payoutStatus === 'PENDING' || r.payoutStatus === 'AVAILABLE' || r.payoutStatus === 'HELD');
    return {
      // Section names come from the event's seat map ("Lower Level 104"), like GET /me/tickets; the map stays out.
      listings: rows.map(({ heldBy: _k, event: { seatMap, dates, ...event }, ticket, ...r }) => {
        const sec = (seatMap as SeatMap | null)?.sections.find((s) => s.id === ticket.section);
        return { ...r, event, ticket: { ...ticket, ticketType: withLook(ticket.ticketType), sectionName: sec ? sectionName(sec) : null, ...ticketDates(event.dateMode, ticket.ticketType, dates) } };
      }),
      totals: { owedCents: pending.reduce((n, r) => n + (r.payoutCents ?? 0), 0), paidCents: rows.filter((r) => r.payoutStatus === 'PAID').reduce((n, r) => n + (r.payoutCents ?? 0), 0) },
    };
  }

  /* ----- admin ----- */

  async adminListings(status?: string, q?: string, pageRaw?: string) {
    await this.tidy();
    const page = pageOf(pageRaw);
    const s = (q ?? '').trim().slice(0, 100);
    const where: Prisma.ResaleListingWhereInput = {
      ...(status && ['ACTIVE', 'HELD', 'SOLD', 'CANCELLED'].includes(status) ? { status } : {}),
      ...(s ? { OR: [{ event: { title: { contains: s, mode: 'insensitive' } } }, { ticketId: { contains: s.toUpperCase() } }] } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.resaleListing.count({ where }),
      this.prisma.resaleListing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { event: { select: { slug: true, title: true } }, ticket: { select: { id: true, holderEmail: true, section: true, row: true, seat: true } } },
      }),
    ]);
    const sellers = await this.prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.sellerId))] } }, select: { id: true, email: true, name: true } });
    const who = new Map(sellers.map((u) => [u.id, u]));
    return { total, page, pageSize: PAGE, items: items.map(({ heldBy: _k, ...i }) => ({ ...i, seller: who.get(i.sellerId) ?? null })) };
  }

  async delist(id: string, admin: AuthUser, reason: string) {
    const l = await this.prisma.resaleListing.findUnique({ where: { id }, include: { event: { select: { title: true } } } });
    if (!l || l.status !== 'ACTIVE') throw new BadRequestException('Only active listings can be taken down.');
    await this.prisma.$transaction([
      this.prisma.resaleListing.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason } }),
      this.prisma.ticket.updateMany({ where: { id: l.ticketId, status: 'LISTED' }, data: { status: 'ACTIVE', listCents: null } }),
    ]);
    await this.audit.log(admin.id, 'resale.delist', 'ResaleListing', id, { reason });
    const seller = await this.prisma.user.findUnique({ where: { id: l.sellerId }, select: { email: true } });
    if (seller) {
      const { html, text } = render({
        preheader: `Your resale listing for ${l.event.title} was taken down.`,
        heading: 'Your listing was taken down',
        paragraphs: [`We removed your resale listing for ${l.event.title}: ${reason}`, 'The ticket is back in your account and works as normal.'],
        cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
        footer: 'Questions? Reply to this email or visit the help centre.',
      });
      void this.mail.send('resale.delisted', { to: seller.email, subject: `Your listing for ${l.event.title} was taken down`, html, text });
    }
    return { status: 'CANCELLED' };
  }

  async payouts(status?: string, pageRaw?: string) {
    await this.tidy();
    const page = pageOf(pageRaw);
    const where: Prisma.ResaleListingWhereInput = status && ['PENDING', 'AVAILABLE', 'HELD', 'PAID'].includes(status) ? { payoutStatus: status } : { payoutStatus: { not: 'NONE' } };
    const [total, items, sums] = await Promise.all([
      this.prisma.resaleListing.count({ where }),
      this.prisma.resaleListing.findMany({ where, orderBy: { soldAt: 'asc' }, skip: (page - 1) * PAGE, take: PAGE, include: { event: { select: { slug: true, title: true, startsAt: true } } } }),
      this.prisma.resaleListing.groupBy({ by: ['payoutStatus', 'currency'], where: { payoutStatus: { not: 'NONE' } }, _sum: { payoutCents: true }, _count: { _all: true } }),
    ]);
    const sellers = await this.prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.sellerId))] } }, select: { id: true, email: true, name: true } });
    const who = new Map(sellers.map((u) => [u.id, u]));
    return {
      total,
      page,
      pageSize: PAGE,
      summary: sums.map((s) => ({ status: s.payoutStatus, currency: s.currency, count: s._count._all, payoutCents: s._sum.payoutCents ?? 0 })),
      items: items.map(({ heldBy: _k, ...i }) => ({ ...i, seller: who.get(i.sellerId) ?? null })),
    };
  }

  async payout(id: string, admin: AuthUser, dto: PayoutDto) {
    const l = await this.prisma.resaleListing.findUnique({ where: { id } });
    if (!l || l.status !== 'SOLD') throw new NotFoundException('Sold listing not found.');
    const next =
      dto.action === 'PAY' ? (l.payoutStatus === 'AVAILABLE' ? 'PAID' : null) : dto.action === 'HOLD' ? (['PENDING', 'AVAILABLE'].includes(l.payoutStatus) ? 'HELD' : null) : l.payoutStatus === 'HELD' ? ((l.payoutAvailableAt ?? new Date()) <= new Date() ? 'AVAILABLE' : 'PENDING') : null;
    if (!next) {
      throw new BadRequestException(
        dto.action === 'PAY' ? 'Only payouts that are available (the event has happened) can be marked paid.' : dto.action === 'HOLD' ? 'Only pending or available payouts can be held.' : 'Only held payouts can be released.',
      );
    }
    const out = await this.prisma.resaleListing.update({ where: { id }, data: { payoutStatus: next, payoutNote: dto.note?.trim() || l.payoutNote, ...(next === 'PAID' ? { paidOutAt: new Date() } : {}) } });
    await this.audit.log(admin.id, `resale.payout_${dto.action.toLowerCase()}`, 'ResaleListing', id, { payoutCents: l.payoutCents, currency: l.currency, note: dto.note ?? null });
    return { id, payoutStatus: out.payoutStatus };
  }

  /** Email to the seller after a sale. */
  async soldEmail(listingId: string) {
    const l = await this.prisma.resaleListing.findUnique({ where: { id: listingId }, include: { event: { select: { title: true } } } });
    if (!l) return;
    const seller = await this.prisma.user.findUnique({ where: { id: l.sellerId }, select: { email: true } });
    if (!seller || l.payoutCents === null) return;
    const { html, text } = render({
      preheader: `Your ticket for ${l.event.title} sold for ${formatMoney(l.priceCents, l.currency)}.`,
      heading: 'Your ticket sold',
      highlight: { label: 'You’ll receive', value: formatMoney(l.payoutCents, l.currency) },
      paragraphs: [
        `${l.event.title}: sold for ${formatMoney(l.priceCents, l.currency)}. After Eventro’s fee${l.royaltyCents ? ' and the organizer’s share' : ''}, you’ll receive ${formatMoney(l.payoutCents, l.currency)}.`,
        'We pay sellers once the event has taken place, so buyers are protected. Your old ticket no longer works; the buyer has a new one.',
      ],
      cta: { label: 'See your sales', url: `${config.webUrl}/tickets` },
      footer: 'You listed this ticket on Eventro resale.',
    });
    await this.mail.send('resale.sold', { to: seller.email, subject: `Sold: your ticket for ${l.event.title}`, html, text });
  }
}

/* ---------- routes ---------- */

@ApiTags('resale')
@Controller()
export class ResaleController {
  constructor(private readonly resale: ResaleService) {}

  @Public() @Get('events/:slug/resale') forEvent(@Param('slug') slug: string) {
    return this.resale.forEvent(slug);
  }
  @OptionalAuth() @Post('resale/:id/hold') @HttpCode(200) @RateLimit(RATE_RULES.resaleHold) hold(@Param('id') id: string, @CurrentUser() u: AuthUser | null) {
    return this.resale.hold(id, u);
  }
  @ApiBearerAuth() @Get('me/resale') mine(@CurrentUser() u: AuthUser) {
    return this.resale.mine(u);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/resale')
export class AdminResaleController {
  constructor(private readonly resale: ResaleService) {}

  @Get() listings(@Query('status') status?: string, @Query('q') q?: string, @Query('page') page?: string) {
    return this.resale.adminListings(status, q, page);
  }
  @Get('payouts') payouts(@Query('status') status?: string, @Query('page') page?: string) {
    return this.resale.payouts(status, page);
  }
  @Post(':id/delist') @HttpCode(200) delist(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: DelistDto) {
    return this.resale.delist(id, u, dto.reason);
  }
  @Post(':id/payout') @HttpCode(200) payout(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: PayoutDto) {
    return this.resale.payout(id, u, dto);
  }
}

@Global()
@Module({ controllers: [ResaleController, AdminResaleController], providers: [ResaleService], exports: [ResaleService] })
export class ResaleModule {}
