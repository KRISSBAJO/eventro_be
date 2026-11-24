/**
 * Gifted tickets. A buyer ticks "This is a gift" at checkout and gives the recipient's name and email, a message,
 * and when to deliver it (now, or a date before the event). The order's tickets are created held for the gift
 * (TRANSFER_PENDING), so nobody can use them until the recipient claims them.
 *
 * At the delivery time the recipient gets a gift email with a private link (/gift/:token). Opening it shows the gift;
 * claiming it (signed in, any email: the link is the proof) moves the tickets into their account.
 *
 *   GET  /gifts/:token          the gift, as the recipient sees it (details only once it's been delivered)
 *   POST /gifts/:token/claim    put the tickets in the signed-in account
 *   POST /gifts/:id/resend      the buyer sends the gift email again (or delivers a scheduled gift now)
 */
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Controller,
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
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { sectionName, type SeatMap } from '../domain/seatmap';
import { NoticeService } from '../push/notices';

export type GiftInput = { name: string; email: string; message?: string; sendAt?: string; hidePrice?: boolean };

const token = () => randomBytes(24).toString('base64url');
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

@Injectable()
export class GiftService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Gifts');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly notices: NoticeService,
  ) {}

  /** Scheduled gifts go out within a minute of their time. */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.deliverDue().catch((e) => this.log.error((e as Error).message)), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Checks a gift at checkout; returns the cleaned values. */
  validate(g: GiftInput, buyerEmail: string, eventStartsAt: Date) {
    const email = g.email.trim().toLowerCase();
    if (email === buyerEmail.trim().toLowerCase()) throw new BadRequestException('A gift needs to go to someone else’s email.');
    const now = Date.now();
    let sendAt = new Date(now);
    if (g.sendAt) {
      const at = new Date(g.sendAt);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('Pick a valid delivery date.');
      // Event times are the venue's wall-clock time; a day's margin covers every time zone.
      if (at.getTime() > eventStartsAt.getTime() + 86_400_000) throw new BadRequestException('The gift has to arrive before the event.');
      if (at.getTime() > now) sendAt = at;
    }
    return { recipientName: g.name.trim(), recipientEmail: email, message: (g.message ?? '').trim().slice(0, 300), hidePrice: g.hidePrice ?? true, sendAt, token: token() };
  }

  /** After payment: deliver now if it's due (otherwise the timer will). */
  async afterPaid(orderId: string) {
    const g = await this.prisma.gift.findUnique({ where: { orderId } });
    if (g && !g.sentAt && g.sendAt <= new Date()) await this.deliver(g.id);
  }

  async deliverDue() {
    const due = await this.prisma.gift.findMany({ where: { sentAt: null, sendAt: { lte: new Date() }, order: { status: 'PAID' } }, select: { id: true }, take: 100 });
    for (const g of due) await this.deliver(g.id);
  }

  /** Points the held tickets at the recipient and sends the gift email. Safe to call again (resend). */
  async deliver(id: string) {
    const g = await this.prisma.gift.findUnique({
      where: { id },
      include: { order: { include: { event: { include: { venue: true } }, ticketType: true, tickets: { select: { id: true, status: true } } } } },
    });
    if (!g || g.claimedAt || g.order.status !== 'PAID') return false;
    // Tickets the buyer took back (cancelled the transfer) stay theirs. If they took them all back, there's no gift
    // left: mark it done without emailing the recipient a link to nothing.
    const held = g.order.tickets.filter((t) => t.status === 'TRANSFER_PENDING').length;
    if (!held) {
      if (!g.sentAt) await this.prisma.gift.update({ where: { id }, data: { sentAt: new Date() } });
      this.log.log(`Gift ${id} skipped: the buyer took the tickets back`);
      return false;
    }
    await this.prisma.ticket.updateMany({ where: { orderId: g.orderId, status: 'TRANSFER_PENDING' }, data: { transferTo: g.recipientEmail } });
    const e = g.order.event;
    const when = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(e.startsAt);
    const where = e.online ? 'Online' : e.venue ? `${e.venue.name}, ${e.venue.city}` : '';
    const link = `${config.webUrl}/gift/${g.token}`;
    const from = firstName(g.order.buyerName);
    const { html, text } = render({
      preheader: `${from} sent you ${g.order.quantity === 1 ? 'a ticket' : `${g.order.quantity} tickets`} to ${e.title}.`,
      heading: `${from} sent you tickets to ${e.title}`,
      ...(g.hidePrice ? {} : { highlight: { label: `${g.order.quantity} × ${g.order.ticketType.name}`, value: formatMoney(g.order.totalCents, g.order.currency) } }),
      paragraphs: [
        ...(g.message ? [`“${g.message}” — ${from}`] : []),
        `${g.order.quantity} × ${g.order.ticketType.name} · ${when}${where ? ` · ${where}` : ''}`,
        'Open your gift to add the tickets to your Eventro account. Your QR code appears there before the event.',
      ],
      cta: { label: 'Open your gift', url: link },
      footer: `${g.order.buyerName} bought this for ${g.recipientName} on Eventro. Not you? Just ignore this email.`,
    });
    const ok = await this.mail.send('gift.delivered', { to: g.recipientEmail, subject: `🎁 ${from} sent you tickets to ${e.title}`, html, text });
    await this.prisma.gift.update({ where: { id }, data: { sentAt: g.sentAt ?? new Date() } });
    void this.notices.giftDelivered(id);
    this.log.log(`Gift ${id} delivered to the recipient (${ok ? 'email sent' : 'email not sent'})`);
    return true;
  }

  async view(t: string) {
    const g = t.length <= 64 ? await this.prisma.gift.findUnique({
      where: { token: t },
      include: {
        order: {
          include: {
            event: { select: { slug: true, title: true, subtitle: true, startsAt: true, imageUrl: true, online: true, timezone: true, seatMap: true, venue: { select: { name: true, city: true } } } },
            ticketType: { select: { name: true, perks: true } },
            tickets: { select: { id: true, section: true, row: true, seat: true, status: true } },
          },
        },
      },
    }) : null;
    if (!g || g.order.status !== 'PAID') throw new NotFoundException('That gift link isn’t valid.');
    const opened = !!g.sentAt;
    return {
      from: g.order.buyerName,
      to: g.recipientName,
      status: g.claimedAt ? 'claimed' : opened ? 'ready' : 'scheduled',
      sendAt: g.sendAt,
      // Nothing about the tickets before the delivery time, so an early peek doesn't spoil it.
      ...(opened
        ? {
            message: g.message,
            event: (({ seatMap: _map, ...ev }) => ev)(g.order.event),
            ticketType: g.order.ticketType,
            quantity: g.order.quantity,
            seats: g.order.tickets
              .filter((x) => x.seat !== null)
              .map((x) => {
                const sec = (g.order.event.seatMap as SeatMap | null)?.sections.find((s) => s.id === x.section);
                return { section: x.section, sectionName: sec ? sectionName(sec) : x.section, row: x.row, seat: x.seat };
              }),
            ...(g.hidePrice ? {} : { totalCents: g.order.totalCents, currency: g.order.currency }),
          }
        : {}),
    };
  }

  async claim(t: string, user: AuthUser) {
    const g = t.length <= 64 ? await this.prisma.gift.findUnique({ where: { token: t }, include: { order: { select: { status: true, buyerId: true, email: true } } } }) : null;
    if (!g || g.order.status !== 'PAID') throw new NotFoundException('That gift link isn’t valid.');
    if (!g.sentAt) throw new BadRequestException('This gift hasn’t been delivered yet.');
    if (g.claimedAt) {
      if (g.claimedBy === user.id) return { claimed: true, already: true };
      throw new BadRequestException('This gift has already been claimed.');
    }
    if (g.order.buyerId === user.id || g.order.email === user.email) throw new BadRequestException('You bought this gift, so it can’t go into your own account. Send the link to the person it’s for.');
    const result = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { orderId: g.orderId, status: 'TRANSFER_PENDING' },
        // New holder, new QR seed: codes made before the claim stop working.
        data: { status: 'ACTIVE', transferTo: null, ownerId: user.id, holderEmail: user.email, holderName: user.name, qrVersion: { increment: 1 } },
      });
      if (!count) throw new BadRequestException('There are no tickets left in this gift.');
      await tx.gift.update({ where: { id: g.id }, data: { claimedAt: new Date(), claimedBy: user.id } });
      return count;
    });
    await this.audit.log(user.id, 'gift.claim', 'Gift', g.id, { tickets: result });
    return { claimed: true, tickets: result };
  }

  /** The buyer resends the email, or delivers a scheduled gift right away. */
  async resend(id: string, user: AuthUser) {
    const g = await this.prisma.gift.findUnique({ where: { id }, include: { order: { select: { buyerId: true, email: true, status: true } } } });
    if (!g || (g.order.buyerId !== user.id && g.order.email !== user.email)) throw new NotFoundException('Gift not found.');
    if (g.claimedAt) throw new BadRequestException('This gift has already been claimed.');
    if (g.order.status !== 'PAID') throw new ForbiddenException('This order isn’t paid.');
    const held = await this.prisma.ticket.count({ where: { orderId: g.orderId, status: 'TRANSFER_PENDING' } });
    if (!held) throw new BadRequestException('You took these tickets back, so there’s nothing left to send.');
    await this.prisma.gift.update({ where: { id }, data: { sendAt: g.sentAt ? g.sendAt : new Date() } });
    await this.deliver(id);
    return { sent: true };
  }
}

@ApiTags('gifts')
@Controller('gifts')
export class GiftController {
  constructor(private readonly gifts: GiftService) {}

  @Public()
  @Get(':token')
  view(@Param('token') t: string) {
    return this.gifts.view(t);
  }

  @Post(':token/claim')
  @HttpCode(200)
  claim(@Param('token') t: string, @CurrentUser() user: AuthUser) {
    return this.gifts.claim(t, user);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.gifts.resend(id, user);
  }
}

@Global()
@Module({ controllers: [GiftController], providers: [GiftService], exports: [GiftService] })
export class GiftModule {}
