/**
 * Waitlist: "tell me when tickets come back". A fan joins on a sold-out ticket type (or, when everything is sold out,
 * on any ticket for the event). Tickets come back when an order is refunded, the organizer adds capacity, a checkout
 * is abandoned or a fan lists a ticket for resale. A sweep (every 2 minutes) then tells the people who have waited
 * longest, a few for each ticket that's back: one email each, and a push to those with an account. Being told doesn't
 * hold a ticket: the first to check out gets it. After that the entry is done; the fan can join again.
 *
 *   POST   /events/:slug/waitlist        { email?, ticketTypeId? }  join (signed-in fans can skip the email)
 *   GET    /events/:slug/waitlist        the ticket types this account is waiting on ("" = any ticket)
 *   DELETE /events/:slug/waitlist        leave (?ticketTypeId=; without it, everything on this event)
 *   DELETE /waitlist/:token              leave from the link in the email
 *   GET    /organizer/events/:id/waitlist   how many are waiting, by ticket type (org admins and managers)
 */
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { InventoryService } from '../common/inventory.service';
import { CurrentUser, OptionalAuth, Public, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit, clientIp } from '../common/rate-limit';
import { MailService, formatMoney, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { dateRangeWhere, ticketTimes } from '../domain/event-dates';
import { EDIT_ROLES, eventForRole } from '../organizer/access';
import { pastCutoff } from '../resale/resale.module';

/** How many people hear for each ticket that's back (they won't all buy), and the least told at once. */
export const TOLD_PER_TICKET = 5;
export const TOLD_AT_LEAST = 10;
/** "" stands for "any ticket for this event". */
export const ANY_TICKET = '';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const token = () => randomBytes(24).toString('base64url');

class JoinDto {
  @ApiPropertyOptional({ example: 'ada@example.com', description: 'Optional when signed in.' })
  @IsOptional()
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ description: 'The sold-out ticket type. Leave out to wait for any ticket (only when the whole event is sold out).' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ticketTypeId?: string;
}

const EVENT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  currency: true,
  startsAt: true,
  doorsAt: true,
  endsAt: true,
  dateMode: true,
  dates: true,
  online: true,
  salesPaused: true,
  postponedAt: true,
  resaleEnabled: true,
  transferCutoffMinutes: true,
  venue: { select: { name: true, city: true } },
  ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.EventSelect;

@Injectable()
export class WaitlistService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Waitlist');
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /** The sweep runs every 2 minutes (not in tests, which call `sweep` directly). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`Waitlist sweep: ${(e as Error).message}`)), 2 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------- what's available ---------- */

  /**
   * Tickets a fan could buy right now, per ticket type: from the organizer (`left`: capacity minus sold minus live
   * holds, 0 when the type isn't on sale) and from fans (`resale`: active listings, with the lowest price).
   */
  private async available(eventId: string, now = new Date()) {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: EVENT });
    if (!e) return null;
    const open = e.status === 'PUBLISHED' && !e.salesPaused && !e.postponedAt;
    const avail = open ? await this.inventory.availabilityForEvent(e.id, now) : new Map<string, number>();
    const starts = (t: (typeof e.ticketTypes)[number]) => (e.dateMode === 'SINGLE' ? e.startsAt : ticketTimes(e.dateMode, e, t, e.dates).first.startsAt);
    const onSale = (t: (typeof e.ticketTypes)[number]) => {
      if (!open) return false;
      if ((t.salesStart && t.salesStart > now) || (t.salesEnd && t.salesEnd <= now)) return false;
      const d = e.dates.find((x) => x.id === t.eventDateId);
      if (d && d.status === 'CANCELLED') return false;
      return starts(t) > now;
    };
    const listings =
      e.status === 'PUBLISHED' && e.resaleEnabled
        ? await this.prisma.resaleListing.findMany({ where: { eventId: e.id, status: 'ACTIVE' }, select: { priceCents: true, ticket: { select: { ticketTypeId: true } } } })
        : [];
    const types = e.ticketTypes.map((t) => {
      const mine = pastCutoff({ startsAt: starts(t), transferCutoffMinutes: e.transferCutoffMinutes }) ? [] : listings.filter((l) => l.ticket.ticketTypeId === t.id);
      return { id: t.id, name: t.name, priceCents: t.priceCents, onSale: onSale(t), left: onSale(t) ? (avail.get(t.id) ?? 0) : 0, resale: mine.length, resaleFromCents: mine.length ? Math.min(...mine.map((l) => l.priceCents)) : null, upcoming: starts(t) > now };
    });
    return { event: e, types };
  }

  /* ---------- joining and leaving ---------- */

  async join(slug: string, dto: JoinDto, user: AuthUser | null, ip: string | null) {
    const found = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!found || found.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    const address = dto.email ?? user?.email?.toLowerCase();
    if (!address) throw new BadRequestException('Enter your email address.');
    const a = (await this.available(found.id))!;
    const typeId = dto.ticketTypeId || ANY_TICKET;
    const coming = a.types.filter((t) => t.upcoming);
    if (!coming.length) throw new BadRequestException('This event has already started.');
    if (typeId) {
      const t = a.types.find((x) => x.id === typeId);
      if (!t) throw new BadRequestException('That ticket isn’t part of this event.');
      if (!t.upcoming) throw new BadRequestException('That date has already started.');
      if (t.left > 0) throw new BadRequestException(`${t.name} tickets are on sale right now.`);
    } else if (coming.some((t) => t.left > 0)) {
      throw new BadRequestException('Tickets are on sale right now.');
    }
    const key = { eventId_ticketTypeId_email: { eventId: found.id, ticketTypeId: typeId, email: address } };
    await this.prisma.waitlistEntry.upsert({
      where: key,
      create: { eventId: found.id, ticketTypeId: typeId, email: address, userId: user?.id ?? null, token: token(), clientIp: ip },
      // Joining again after being told (or after leaving) goes to the back of the line.
      update: { ...(user ? { userId: user.id } : {}) },
    });
    const row = await this.prisma.waitlistEntry.findUniqueOrThrow({ where: key });
    if (row.notifiedAt || row.stoppedAt) await this.prisma.waitlistEntry.update({ where: { id: row.id }, data: { notifiedAt: null, stoppedAt: null, createdAt: new Date() } });
    return { waiting: true, email: address, ticketTypeId: typeId };
  }

  /** Entries that belong to this fan: made while signed in, or with the account's email. */
  private mine(user: AuthUser) {
    return { stoppedAt: null, notifiedAt: null, OR: [{ userId: user.id }, { email: user.email.toLowerCase() }] };
  }

  /** The ticket types this account is waiting on for the event ("" = any ticket). Signed out: none. */
  async waiting(slug: string, user: AuthUser | null) {
    if (!user) return { ticketTypeIds: [] as string[] };
    const rows = await this.prisma.waitlistEntry.findMany({ where: { event: { slug }, ...this.mine(user) }, select: { ticketTypeId: true } });
    return { ticketTypeIds: [...new Set(rows.map((r) => r.ticketTypeId))] };
  }

  async leave(slug: string, user: AuthUser, ticketTypeId?: string) {
    await this.prisma.waitlistEntry.updateMany({ where: { event: { slug }, ...(ticketTypeId === undefined ? {} : { ticketTypeId }), ...this.mine(user) }, data: { stoppedAt: new Date() } });
    return this.waiting(slug, user);
  }

  async stop(t: string) {
    const w = t.length <= 64 ? await this.prisma.waitlistEntry.findUnique({ where: { token: t }, include: { event: { select: { title: true, slug: true } } } }) : null;
    if (!w) throw new NotFoundException('That link has expired or was never valid.');
    if (!w.stoppedAt) await this.prisma.waitlistEntry.update({ where: { id: w.id }, data: { stoppedAt: new Date() } });
    return { stopped: true, event: w.event };
  }

  /* ---------- the organizer's view ---------- */

  /** How many people are waiting, by ticket type, and how many have been told so far. */
  async forOrganizer(eventId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const [waiting, told] = await Promise.all([
      this.prisma.waitlistEntry.groupBy({ by: ['ticketTypeId'], where: { eventId, stoppedAt: null, notifiedAt: null }, _count: { _all: true } }),
      this.prisma.waitlistEntry.count({ where: { eventId, notifiedAt: { not: null } } }),
    ]);
    const count = new Map(waiting.map((w) => [w.ticketTypeId, w._count._all]));
    const byType = ev.ticketTypes.map((t) => ({ ticketTypeId: t.id, name: t.name, eventDateId: t.eventDateId, waiting: count.get(t.id) ?? 0 })).filter((t) => t.waiting > 0);
    const any = count.get(ANY_TICKET) ?? 0;
    return { waiting: byType.reduce((s, t) => s + t.waiting, 0) + any, anyTicket: any, byType, told };
  }

  /* ---------- telling people ---------- */

  /** Looks at every event someone is waiting on and tells people where tickets are back. Returns how many were told. */
  async sweep(now = new Date()) {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const events = await this.prisma.waitlistEntry.findMany({
        where: { notifiedAt: null, stoppedAt: null, event: { status: 'PUBLISHED', ...dateRangeWhere(now) } },
        distinct: ['eventId'],
        select: { eventId: true },
        take: 500,
      });
      let told = 0;
      for (const { eventId } of events) {
        try {
          told += await this.release(eventId, now);
        } catch (e) {
          this.log.warn(`Waitlist for event ${eventId}: ${(e as Error).message}`);
        }
      }
      return told;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One event: for each ticket type that's back, the longest-waiting people on that type are told; then, if anything
   * is back, those waiting for any ticket. One email per person, naming everything that's back for them.
   */
  async release(eventId: string, now = new Date()) {
    const a = await this.available(eventId, now);
    if (!a) return 0;
    const back = a.types.filter((t) => t.upcoming && (t.left > 0 || t.resale > 0));
    if (!back.length) return 0;
    const room = (n: number) => Math.max(TOLD_AT_LEAST, n * TOLD_PER_TICKET);
    type Entry = { id: string; email: string; userId: string | null; token: string };
    const picked = new Map<string, { entries: Entry[]; types: typeof back }>();
    const add = (rows: Entry[], types: typeof back) => {
      for (const r of rows) {
        const had = picked.get(r.email) ?? { entries: [], types: [] };
        had.entries.push(r);
        for (const t of types) if (!had.types.includes(t)) had.types.push(t);
        picked.set(r.email, had);
      }
    };
    const pick = (ticketTypeId: string, take: number) =>
      this.prisma.waitlistEntry.findMany({ where: { eventId, ticketTypeId, notifiedAt: null, stoppedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, select: { id: true, email: true, userId: true, token: true } });
    for (const t of back) add(await pick(t.id, room(t.left + t.resale)), [t]);
    add(await pick(ANY_TICKET, room(back.reduce((s, t) => s + t.left + t.resale, 0))), back);
    if (!picked.size) return 0;

    const e = a.event;
    const url = `${config.webUrl}/events/${e.slug}`;
    const mails: Mail[] = [];
    for (const [email, p] of picked) {
      const lines = p.types.map((t) =>
        t.left > 0
          ? `${t.name}: ${formatMoney(t.priceCents, e.currency)} all-in.`
          : `${t.name}: a fan is selling ${t.resale === 1 ? 'one' : `${t.resale}`} from ${formatMoney(t.resaleFromCents ?? t.priceCents, e.currency)}. Resale tickets are reissued in your name by Omoshow.`,
      );
      const stop = { label: 'Leave the waitlist', url: `${config.webUrl}/waitlist/stop?t=${p.entries[0].token}` };
      const { html, text } = render({
        preheader: `${p.types.map((t) => t.name).join(', ')} tickets are available again.`,
        heading: `Tickets are back: ${e.title}`,
        paragraphs: [...lines, 'This doesn’t hold a ticket for you: they go to whoever checks out first.'],
        cta: { label: 'Get tickets', url },
        footer: 'You asked us to tell you when tickets came back.',
        footerLink: stop,
      });
      mails.push({ to: email, subject: `Tickets are back: ${e.title}`, html, text, unsubscribeUrl: stop.url });
    }
    const ids = [...picked.values()].flatMap((p) => p.entries.map((x) => x.id));
    // Marked first, so a slow send can't tell the same people twice.
    await this.prisma.waitlistEntry.updateMany({ where: { id: { in: ids } }, data: { notifiedAt: now } });
    await this.mail.sendMany('waitlist', mails);
    void this.notices.ticketsBack(
      { id: e.id, slug: e.slug, title: e.title },
      [...picked.entries()].map(([email, p]) => ({ email, userId: p.entries.find((x) => x.userId)?.userId ?? null, names: p.types.map((t) => t.name), key: p.entries[0].id })),
      now,
    );
    return picked.size;
  }
}

@ApiTags('waitlist')
@Controller()
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @OptionalAuth()
  @Post('events/:slug/waitlist')
  @HttpCode(200)
  @RateLimit(RATE_RULES.priceWatch)
  join(@Param('slug') slug: string, @Body() dto: JoinDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.waitlist.join(slug, dto, user, clientIp(req));
  }

  @OptionalAuth()
  @Get('events/:slug/waitlist')
  waiting(@Param('slug') slug: string, @CurrentUser() user: AuthUser | null) {
    return this.waitlist.waiting(slug, user);
  }

  @ApiBearerAuth()
  @Delete('events/:slug/waitlist')
  leave(@Param('slug') slug: string, @CurrentUser() user: AuthUser, @Query('ticketTypeId') ticketTypeId?: string) {
    return this.waitlist.leave(slug, user, ticketTypeId);
  }

  @Public()
  @Delete('waitlist/:token')
  stop(@Param('token') t: string) {
    return this.waitlist.stop(t);
  }

  @ApiBearerAuth()
  @Get('organizer/events/:id/waitlist')
  forOrganizer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.waitlist.forOrganizer(id, user);
  }
}

@Global()
@Module({ controllers: [WaitlistController], providers: [WaitlistService], exports: [WaitlistService] })
export class WaitlistModule {}
