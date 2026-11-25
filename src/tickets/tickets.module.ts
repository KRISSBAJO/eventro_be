import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, Min } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { TIER_FIELDS, withLook } from '../domain/tier-look';
import { config } from '../config';
import { QR_SIG_LENGTH, QR_WINDOW_MS, qrSeed, qrToken } from '../domain/qr';
import { permilleOf } from '../domain/money';
import { sectionName, type SeatMap } from '../domain/seatmap';
import { CurrentUser, type AuthUser } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { MailService, render } from '../mail/mail.module';
import { pastCutoff } from '../resale/resale.module';
import { NoticeService } from '../push/notices';
import { GiftService } from '../gifts/gifts.module';
import { guaranteeFor } from '../guarantee/guarantee';
import { byStart, dateView, ticketDates, ticketTimes } from '../domain/event-dates';
import { ScheduleService } from '../schedule/schedule.module';

/** How the phone turns a seed into door codes (also in the README). */
export const QR_SEED_SPEC = {
  windowMs: QR_WINDOW_MS,
  algorithm: 'HMAC-SHA256',
  format: `<ticketId>.<window>.<first ${QR_SIG_LENGTH} chars of base64url(HMAC-SHA256(key = base64url-decoded seed, message = ticketId + "." + window))>, window = floor(unixTimeMs / ${QR_WINDOW_MS})`,
} as const;

/** A ticket's QR seed for its holder's phone (base64url of 32 bytes). */
export const seedFor = (t: { id: string; qrVersion: number }) => qrSeed(config.qrSecret, t.id, t.qrVersion).toString('base64url');

/** A pending transfer goes back to the sender after a week (or at the event's cutoff, if sooner). */
const TRANSFER_DAYS = 7;

export class TransferDto {
  @ApiProperty() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() email: string;
}

export class ListDto {
  @ApiProperty({ description: 'Resale price in cents' }) @IsInt() @Min(100) priceCents: number;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
    private readonly gifts: GiftService,
    private readonly schedule: ScheduleService,
  ) {}

  /** Transfers nobody accepted in time go back to the sender. */
  private async expireTransfers() {
    await this.prisma.ticket.updateMany({ where: { status: 'TRANSFER_PENDING', transferExpiresAt: { lt: new Date() } }, data: { status: 'ACTIVE', transferTo: null, transferExpiresAt: null } });
  }

  private async owned(id: string, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id }, include: { ticketType: true, event: { include: { dates: true } } } });
    if (!t || (t.ownerId !== user.id && t.holderEmail !== user.email)) throw new NotFoundException('Ticket not found.');
    // Multiple dates: transfer and resale cut-offs run from the ticket's own date (DATES) or first valid day (DAYS).
    return { ...t, cutoffEvent: { ...t.event, startsAt: ticketTimes(t.event.dateMode, t.event, t.ticketType, t.event.dates).first.startsAt } };
  }

  /** A multi-day pass used on one day still scans on its other days. */
  private scannable(t: { status: string; event: { dateMode: string } }) {
    return t.status === 'ACTIVE' || (t.status === 'CHECKED_IN' && t.event.dateMode === 'DAYS');
  }

  async mine(user: AuthUser) {
    await this.expireTransfers();
    const rows = await this.prisma.ticket.findMany({
      // Voided tickets stay hidden, except for cancelled events and Omoshow Guarantee claims, so holders see what
      // happened to them.
      where: {
        AND: [
          { OR: [{ ownerId: user.id }, { holderEmail: user.email }] },
          // A ticket for one cancelled date of a multiple-dates event shows like one for a cancelled event.
          { OR: [{ status: { not: 'VOID' } }, { event: { status: 'CANCELLED' }, resoldAt: null }, { eventDate: { status: 'CANCELLED' }, resoldAt: null }, { guaranteeClaim: { isNot: null }, resoldAt: null }] },
          // Tickets waiting for this account (a comp sent to this email) are listed under incoming, not here.
          { OR: [{ status: { not: 'TRANSFER_PENDING' } }, { transferTo: null }, { transferTo: { not: user.email } }] },
        ],
      },
      include: {
        ticketType: { select: { priceCents: true, eventDateId: true, validDateIds: true, ...TIER_FIELDS } },
        order: {
          select: {
            id: true,
            createdAt: true,
            quantity: true,
            totalCents: true,
            refundedCents: true,
            donationCents: true,
            donationRefundedCents: true,
            kind: true,
            compGroup: true,
            status: true,
            currency: true,
            gift: { select: { id: true, recipientName: true, recipientEmail: true, sendAt: true, sentAt: true, claimedAt: true } },
          },
        },
        guaranteeClaim: true,
        event: { select: { slug: true, title: true, subtitle: true, currency: true, status: true, cancelledAt: true, cancelReason: true, startsAt: true, doorsAt: true, endsAt: true, imageUrl: true, seatMap: true, online: true, streamUrl: true, timezone: true, resaleEnabled: true, resaleCapPercent: true, resaleRoyaltyPermille: true, transfersEnabled: true, transferCutoffMinutes: true, dateMode: true, dates: true, venue: { select: { name: true, address: true, city: true } } } },
      },
      orderBy: [{ event: { startsAt: 'asc' } }, { id: 'asc' }],
    });
    // Section names come from the event's seat map ("Lower Level 104"); the map itself stays out of the response.
    // Online events: the stream link goes only with tickets the holder still has (not ones being sold or transferred).
    // Paid tickets carry the Omoshow Guarantee: cover, who pays, the claim window and any claim (see src/guarantee).
    // Booked sessions (bookable schedule items) go with each ticket.
    const sessions = await this.schedule.sessionsByTicket(rows.map((r) => r.id));
    const tickets = rows.map(({ event: { seatMap, streamUrl, dates, ...event }, guaranteeClaim, ...t }) => {
      const s = (seatMap as SeatMap | null)?.sections.find((x) => x.id === t.section);
      const watch = event.online && (t.status === 'ACTIVE' || t.status === 'CHECKED_IN') ? streamUrl : null;
      // Usable tickets carry their QR seed, so the app can show the door code offline (see GET /tickets/:id/qr-seed).
      const seed = this.scannable({ status: t.status, event }) ? { qrSeed: seedFor(t) } : {};
      const dated = { mode: event.dateMode, dates, tt: t.ticketType };
      const guarantee = guaranteeFor({ id: t.id, resaleGuarantee: t.resaleGuarantee, guaranteeClaim }, t.order, event, Date.now(), dated);
      // Multiple dates: the ticket's own date (DATES) or the days it admits on (DAYS); the event's dates for context.
      const when = ticketDates(event.dateMode, t.ticketType, dates);
      return { ...t, ticketType: withLook(t.ticketType), ...seed, event: { ...event, streamUrl: watch, dates: dates.sort(byStart).map(dateView) }, ...when, sectionName: s ? sectionName(s) : null, guarantee, sessions: sessions.get(t.id) ?? [] };
    });
    const incoming = await this.prisma.ticket.findMany({
      where: { transferTo: user.email, status: 'TRANSFER_PENDING' },
      select: {
        id: true,
        holderName: true,
        transferExpiresAt: true,
        event: { select: { title: true, startsAt: true, dateMode: true, dates: true } },
        ticketType: { select: { ...TIER_FIELDS, eventDateId: true, validDateIds: true } },
        order: { select: { buyerName: true, kind: true, compGroup: true, event: { select: { org: { select: { name: true } } } }, gift: { select: { id: true, message: true, claimedAt: true } } } },
      },
    });
    // Gifts are labelled ("A gift from Ada", with the note), so apps don't show them as a plain transfer. Comps come
    // from the organizer.
    const incomingTransfers = incoming.map(({ order, event: { dates, ...event }, ...t }) => {
      const comp = order.kind === 'COMP';
      return {
        ...t,
        event,
        ...ticketDates(event.dateMode, t.ticketType, dates),
        ticketType: withLook(t.ticketType),
        gift: order.gift && !order.gift.claimedAt ? { id: order.gift.id, from: comp ? order.event.org.name : order.buyerName, message: order.gift.message || null, comp, group: comp ? order.compGroup : null } : null,
      };
    });
    // The event rules above and the fee rate let the website show the resale breakdown before listing.
    return { tickets, incomingTransfers, resaleFeePermille: config.resaleFeePermille };
  }

  async qr(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (!this.scannable(t)) throw new BadRequestException(t.status === 'CHECKED_IN' ? 'This ticket has already been used.' : 'This ticket can’t be scanned right now.');
    return qrToken(config.qrSecret, t.id, Date.now(), t.qrVersion);
  }

  /** The seed the phone uses to make door codes offline. Only for usable (ACTIVE) tickets of this account. */
  async qrSeed(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (!this.scannable(t)) throw new BadRequestException(t.status === 'CHECKED_IN' ? 'This ticket has already been used.' : 'This ticket can’t be scanned right now.');
    return { ticketId: t.id, seed: seedFor(t), version: t.qrVersion, ...QR_SEED_SPEC };
  }

  async transfer(id: string, user: AuthUser, email: string) {
    const t = await this.owned(id, user);
    if (email === user.email) throw new BadRequestException('That’s your own email.');
    if (t.status !== 'ACTIVE') throw new BadRequestException('Only active tickets can be transferred.');
    if (!t.event.transfersEnabled) throw new BadRequestException('The organizer doesn’t allow transfers for this event.');
    if (pastCutoff(t.cutoffEvent)) throw new BadRequestException('Transfers have closed for this event.');
    const cutoff = t.cutoffEvent.startsAt.getTime() - t.event.transferCutoffMinutes * 60_000;
    const expires = new Date(Math.min(Date.now() + TRANSFER_DAYS * 86_400_000, cutoff));
    const out = await this.prisma.ticket.update({ where: { id }, data: { status: 'TRANSFER_PENDING', transferTo: email, transferExpiresAt: expires } });
    await this.audit.log(user.id, 'ticket.transfer', 'Ticket', id, { to: email });
    const { html, text } = render({
      preheader: `${user.name} sent you a ticket to ${t.event.title}.`,
      heading: `${user.name.split(' ')[0]} sent you a ticket`,
      paragraphs: [
        `${t.ticketType.name} for ${t.event.title}.`,
        `Sign in to Omoshow with this email (${email}) to accept it. If you don’t accept by ${expires.toUTCString().slice(0, 16)}, it goes back to ${user.name.split(' ')[0]}.`,
      ],
      cta: { label: 'Accept your ticket', url: `${config.webUrl}/signin?next=/tickets` },
      footer: `${user.name} sent this from their Omoshow account. Not expecting it? You can ignore this email.`,
    });
    void this.mail.send('ticket.transfer', { to: email, subject: `${user.name.split(' ')[0]} sent you a ticket to ${t.event.title}`, html, text });
    void this.notices.transferSent(id, user.name);
    return out;
  }

  async cancelTransfer(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (t.status !== 'TRANSFER_PENDING') throw new BadRequestException('There’s no transfer to cancel.');
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ACTIVE', transferTo: null, transferExpiresAt: null } });
  }

  async accept(id: string, user: AuthUser) {
    await this.expireTransfers();
    const before = await this.prisma.ticket.findUnique({
      where: { id },
      select: { ownerId: true, holderEmail: true, status: true, transferTo: true, order: { select: { gift: { select: { id: true, claimedAt: true } } } } },
    });
    // A gift's tickets wait for the recipient like a transfer; accepting one claims the whole gift (marked claimed).
    const gift = before?.order.gift;
    if (gift && !gift.claimedAt && before.status === 'TRANSFER_PENDING' && before.transferTo === user.email) {
      await this.gifts.claimById(gift.id, user);
      return this.prisma.ticket.findUnique({ where: { id } });
    }
    // New holder, new QR seed (qrVersion + 1): codes the sender saved on their phone stop working.
    const { count } = await this.prisma.ticket.updateMany({
      where: { id, status: 'TRANSFER_PENDING', transferTo: user.email },
      data: { status: 'ACTIVE', transferTo: null, transferExpiresAt: null, ownerId: user.id, holderEmail: user.email, holderName: user.name, qrVersion: { increment: 1 } },
    });
    if (!count) throw new NotFoundException('Transfer not found, or it has expired.');
    await this.audit.log(user.id, 'ticket.accept', 'Ticket', id);
    const sender = before?.ownerId ?? (before ? (await this.prisma.user.findUnique({ where: { email: before.holderEmail }, select: { id: true } }))?.id : null) ?? null;
    if (sender && sender !== user.id) void this.notices.transferAccepted(id, sender, user.name);
    return this.prisma.ticket.findUnique({ where: { id } });
  }

  async list(id: string, user: AuthUser, priceCents: number) {
    const t = await this.owned(id, user);
    if (t.ownerId !== user.id) throw new BadRequestException('Accept this ticket into your account before selling it.');
    if (t.status !== 'ACTIVE') throw new BadRequestException('Only active tickets can be listed.');
    if (!t.event.resaleEnabled) throw new BadRequestException('The organizer doesn’t allow resale for this event.');
    if (pastCutoff(t.cutoffEvent)) throw new BadRequestException('Resale has closed for this event.');
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: t.orderId }, select: { kind: true, unitCents: true, resaleListing: { select: { faceCents: true } } } });
    if (order.kind === 'COMP') throw new BadRequestException('Complimentary tickets can’t be resold.');
    // Pay what you want: face value is what the ticket was first bought for (all-in), not the tier's minimum.
    const face = t.ticketType.pricing === 'PWYW' ? (order.resaleListing?.faceCents ?? order.unitCents) : t.ticketType.priceCents;
    const cap = t.event.resaleCapPercent === null ? null : Math.floor((face * t.event.resaleCapPercent) / 100);
    if (cap !== null && priceCents > cap) {
      throw new BadRequestException(`The organizer caps resale at ${t.event.resaleCapPercent}% of face value: at most ${(cap / 100).toFixed(2)} ${t.event.currency}.`);
    }
    const royalty = permilleOf(priceCents, t.event.resaleRoyaltyPermille);
    const fee = permilleOf(priceCents, config.resaleFeePermille);
    const [updated, listing] = await this.prisma.$transaction([
      this.prisma.ticket.update({ where: { id }, data: { status: 'LISTED', listCents: priceCents } }),
      this.prisma.resaleListing.create({ data: { ticketId: id, eventId: t.eventId, sellerId: user.id, priceCents, faceCents: face, currency: t.event.currency } }),
    ]);
    await this.audit.log(user.id, 'resale.list', 'Ticket', id, { priceCents, listingId: listing.id });
    return { ...updated, listingId: listing.id, feeCents: fee, royaltyCents: royalty, payoutCents: priceCents - fee - royalty, capCents: cap };
  }

  async unlist(id: string, user: AuthUser) {
    const t = await this.owned(id, user);
    if (t.status !== 'LISTED') throw new BadRequestException('This ticket isn’t listed.');
    const held = await this.prisma.resaleListing.findFirst({ where: { ticketId: id, status: 'HELD', heldUntil: { gt: new Date() } } });
    if (held) throw new BadRequestException('Someone is buying this ticket right now. Try again in a few minutes.');
    await this.prisma.resaleListing.updateMany({ where: { ticketId: id, status: { in: ['ACTIVE', 'HELD'] } }, data: { status: 'CANCELLED', cancelReason: 'Removed by the seller' } });
    return this.prisma.ticket.update({ where: { id }, data: { status: 'ACTIVE', listCents: null } });
  }
}

@ApiTags('tickets')
@ApiBearerAuth()
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('me/tickets')
  mine(@CurrentUser() user: AuthUser) {
    return this.tickets.mine(user);
  }

  /** Rotating QR token for the door. Refresh when `expiresInMs` runs out. */
  @Get('tickets/:id/qr')
  qr(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.qr(id, user);
  }

  /**
   * Mobile app: the ticket's QR seed, to make the same rotating codes offline. Changes when the ticket changes
   * hands (`version`). Keep it in secure storage.
   */
  @Get('tickets/:id/qr-seed')
  @Header('Cache-Control', 'no-store')
  qrSeed(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.qrSeed(id, user);
  }

  @Post('tickets/:id/transfer')
  @HttpCode(200)
  transfer(@Param('id') id: string, @Body() dto: TransferDto, @CurrentUser() user: AuthUser) {
    return this.tickets.transfer(id, user, dto.email);
  }

  @Delete('tickets/:id/transfer')
  cancelTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.cancelTransfer(id, user);
  }

  @Post('tickets/:id/accept')
  @HttpCode(200)
  accept(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.accept(id, user);
  }

  @Post('tickets/:id/listing')
  @HttpCode(200)
  list(@Param('id') id: string, @Body() dto: ListDto, @CurrentUser() user: AuthUser) {
    return this.tickets.list(id, user, dto.priceCents);
  }

  @Delete('tickets/:id/listing')
  unlist(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.unlist(id, user);
  }
}

@Module({ controllers: [TicketsController], providers: [TicketsService] })
export class TicketsModule {}
