/**
 * Price drops. When an organizer lowers a ticket price on a published event, the drop is recorded and, if it's
 * worth telling people about, emailed to:
 *   1. everyone who asked to be told on that event ("Tell me if the price drops"), and
 *   2. newsletter subscribers whose categories and city match the event.
 * Each address gets one email per drop. Small cuts (under 5%) and repeat cuts within 12 hours are recorded but
 * not emailed, so organizers can't spam fans by nudging prices.
 *
 *   POST   /events/:slug/price-watch   { email? }  watch an event (signed-in fans can skip the email)
 *   GET    /events/:slug/price-drop    the latest drop still in effect, for the event page badge
 *   DELETE /price-watch/:token         stop watching (the link in every alert)
 *   GET    /me/watching                the signed-in fan's watched upcoming events (Watching), newest first
 *   DELETE /me/watching/:eventId       stop watching from that list (the event's id or slug)
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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { CurrentUser, OptionalAuth, Public, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit, clientIp } from '../common/rate-limit';
import { MailService, formatMoney, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { LIVE_TYPE, dateRangeWhere } from '../domain/event-dates';
import { EventsModule, EventsService } from '../events/events.module';

/** Smallest cut worth an email, as a fraction of the old price. */
export const MIN_DROP = 0.05;
/** At most one alert per event in this window. */
export const QUIET_HOURS = 12;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
/** CONCERTS → Concerts (how newsletter interests are stored). */
const categoryName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const token = () => randomBytes(24).toString('base64url');

class WatchDto {
  @ApiPropertyOptional({ example: 'ada@example.com', description: 'Optional when signed in.' })
  @IsOptional()
  @Transform(lower)
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

type EventForDrop = {
  id: string;
  slug: string;
  title: string;
  category: string;
  currency: string;
  startsAt: Date;
  status: string;
  venue: { name: string; city: string } | null;
  online: boolean;
};

@Injectable()
export class PriceDropService {
  private readonly log = new Logger('PriceDrops');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
    private readonly events: EventsService,
  ) {}

  /**
   * Called after a ticket type's price changes. Records drops on published events and sends the alerts in the
   * background. Returns what happened, so the organizer screen can say so.
   */
  async record(event: EventForDrop, tt: { id: string; name: string }, fromCents: number, toCents: number, userId: string | null) {
    if (event.status !== 'PUBLISHED' || toCents >= fromCents) return null;
    const cut = (fromCents - toCents) / fromCents;
    const since = new Date(Date.now() - QUIET_HOURS * 3600_000);
    // Any drop that started an alert counts (not just finished ones), so two quick cuts can't both email.
    const recent = await this.prisma.priceDrop.count({ where: { eventId: event.id, skipReason: null, createdAt: { gte: since } } });
    const skipReason = cut < MIN_DROP ? `Less than ${MIN_DROP * 100}% off` : recent ? `An alert already went out in the last ${QUIET_HOURS} hours` : event.startsAt < new Date() ? 'Event already started' : null;

    const drop = await this.prisma.priceDrop.create({
      data: { eventId: event.id, ticketTypeId: tt.id, ticketName: tt.name, fromCents, toCents, currency: event.currency, skipReason, createdBy: userId },
    });
    if (skipReason) return { id: drop.id, alerting: false, reason: skipReason, audience: 0 };

    const audience = await this.audience(event);
    // Don't hold up the organizer's request while the emails go out.
    void this.notify(drop.id, event, tt.name, fromCents, toCents, audience).catch((e) => this.log.error(`Price drop ${drop.id}: ${(e as Error).message}`));
    return { id: drop.id, alerting: true, reason: null, audience: audience.length };
  }

  /** Who hears about a drop: watchers first, then matching subscribers; one entry per address. */
  async audience(event: EventForDrop) {
    const [watchers, subs] = await Promise.all([
      this.prisma.priceWatch.findMany({ where: { eventId: event.id, stoppedAt: null }, select: { email: true, token: true } }),
      this.prisma.subscriber.findMany({
        where: {
          unsubscribedAt: null,
          OR: [{ interests: { isEmpty: true } }, { interests: { has: categoryName(event.category) } }],
          ...(event.online || !event.venue ? {} : { AND: [{ OR: [{ city: null }, { city: slugify(event.venue.city.split(',')[0]) }] }] }),
        },
        select: { email: true, token: true },
      }),
    ]);
    const seen = new Set<string>();
    const out: { email: string; via: 'watch' | 'newsletter'; token: string }[] = [];
    for (const w of watchers) if (!seen.has(w.email)) seen.add(w.email), out.push({ email: w.email, via: 'watch', token: w.token });
    for (const s of subs) if (!seen.has(s.email)) seen.add(s.email), out.push({ email: s.email, via: 'newsletter', token: s.token });
    return out;
  }

  private async notify(dropId: string, e: EventForDrop, ticketName: string, from: number, to: number, audience: Awaited<ReturnType<PriceDropService['audience']>>) {
    const off = Math.round(((from - to) / from) * 100);
    // Watchers with an account also get a push (if they allow price drops).
    void this.notices.priceDrop(dropId, e, ticketName, to, off);
    const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(e.startsAt);
    const where = e.online ? 'Online' : e.venue ? `${e.venue.name}, ${e.venue.city}` : '';
    const url = `${config.webUrl}/events/${e.slug}`;
    const mails: Mail[] = audience.map((a) => {
      const stop =
        a.via === 'watch'
          ? { label: 'Stop price alerts for this event', url: `${config.webUrl}/price-alerts/stop?t=${a.token}` }
          : { label: 'Change your email preferences', url: `${config.webUrl}/newsletter/manage?t=${a.token}` };
      const { html, text } = render({
        preheader: `${ticketName} is now ${formatMoney(to, e.currency)}, ${off}% less than before.`,
        heading: `${e.title}: price dropped ${off}%`,
        highlight: { label: `${ticketName} · all-in`, value: formatMoney(to, e.currency), was: formatMoney(from, e.currency) },
        paragraphs: [`${when}${where ? ` · ${where}` : ''}.`, 'The new price is the full price: fees are included, and nothing is added at checkout.'],
        cta: { label: 'See tickets', url },
        footer: a.via === 'watch' ? 'You asked us to tell you when this event got cheaper.' : 'You get drops and presales from Omoshow.',
        footerLink: stop,
      });
      return { to: a.email, subject: `Price drop: ${e.title} is now ${formatMoney(to, e.currency)}`, html, text, unsubscribeUrl: stop.url };
    });
    const sent = await this.mail.sendMany('price_drop', mails);
    const ok = sent.filter(Boolean).length;
    await this.prisma.priceDrop.update({ where: { id: dropId }, data: { notified: ok } });
    await this.prisma.priceWatch.updateMany({ where: { eventId: e.id, stoppedAt: null }, data: { notifiedAt: new Date() } });
  }

  private async publishedEvent(slug: string) {
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, title: true, slug: true, status: true, startsAt: true } });
    if (!e || e.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    return e;
  }

  async watch(slug: string, email: string | undefined, user: AuthUser | null, clientIp: string | null) {
    const e = await this.publishedEvent(slug);
    const address = email ?? user?.email;
    if (!address) throw new BadRequestException('Enter your email address.');
    // Today's lowest price, so Watching can tell when it drops (a watch that's already on keeps its starting price).
    const types = await this.prisma.ticketType.findMany({ where: { eventId: e.id, ...LIVE_TYPE }, select: { priceCents: true } });
    const fromCents = types.length ? Math.min(...types.map((t) => t.priceCents)) : null;
    const had = await this.prisma.priceWatch.findUnique({ where: { eventId_email: { eventId: e.id, email: address } }, select: { stoppedAt: true } });
    await this.prisma.priceWatch.upsert({
      where: { eventId_email: { eventId: e.id, email: address } },
      create: { eventId: e.id, email: address, userId: user?.id ?? null, token: token(), clientIp, fromCents },
      update: { stoppedAt: null, ...(had?.stoppedAt ? { fromCents, createdAt: new Date() } : {}), ...(user ? { userId: user.id } : {}) },
    });
    return { watching: true, email: address };
  }

  /** Watches that belong to this fan: made while signed in, or with the account's email. */
  private mine(user: AuthUser) {
    return { stoppedAt: null, OR: [{ userId: user.id }, { email: user.email.toLowerCase() }] };
  }

  /**
   * Watching: the fan's watched events that are still to come and on sale (published, public), newest watch first,
   * as event cards plus when watching started, the price then, and whether today's lowest price is below it.
   */
  async watching(user: AuthUser) {
    const rows = await this.prisma.priceWatch.findMany({
      where: { ...this.mine(user), event: { status: 'PUBLISHED', visibility: 'PUBLIC', ...dateRangeWhere(new Date()) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 300,
      include: { event: { include: { venue: true, ticketTypes: { where: LIVE_TYPE, select: { priceCents: true } } } } },
    });
    // One entry per event (a fan may have watched with two addresses): the earliest watch, the highest starting price.
    const byEvent = new Map<string, { since: Date; fromCents: number | null; event: (typeof rows)[number]['event'] }>();
    for (const r of rows) {
      const had = byEvent.get(r.eventId);
      if (!had) byEvent.set(r.eventId, { since: r.createdAt, fromCents: r.fromCents, event: r.event });
      else byEvent.set(r.eventId, { since: r.createdAt < had.since ? r.createdAt : had.since, fromCents: Math.max(had.fromCents ?? 0, r.fromCents ?? 0) || null, event: had.event });
    }
    const list = [...byEvent.values()].filter((w) => w.event.ticketTypes.length);
    const cards = await this.events.cards(list.map((w) => w.event));
    const items = cards.map((c, i) => {
      const started = list[i].fromCents;
      return { ...c, watchingSince: list[i].since, startedFromCents: started, dropped: started !== null && c.fromCents < started };
    });
    return { slugs: items.map((c) => c.slug), items };
  }

  /** Stops every watch this fan has on the event (any of their addresses). Works for events no longer shown. */
  async unwatch(user: AuthUser, key: string) {
    const e = await this.prisma.event.findFirst({ where: { OR: [{ id: key }, { slug: key }] }, select: { id: true, slug: true } });
    if (e) await this.prisma.priceWatch.updateMany({ where: { eventId: e.id, ...this.mine(user) }, data: { stoppedAt: new Date() } });
    return { watching: false, eventId: e?.id ?? null, slug: e?.slug ?? key };
  }

  async stop(t: string) {
    const w = t.length <= 64 ? await this.prisma.priceWatch.findUnique({ where: { token: t }, include: { event: { select: { title: true, slug: true } } } }) : null;
    if (!w) throw new NotFoundException('That link has expired or was never valid.');
    if (!w.stoppedAt) await this.prisma.priceWatch.update({ where: { id: w.id }, data: { stoppedAt: new Date() } });
    return { stopped: true, event: w.event };
  }

  /** The latest drop on this event whose lower price is still the current price. */
  async latest(slug: string) {
    const e = await this.publishedEvent(slug);
    const drops = await this.prisma.priceDrop.findMany({ where: { eventId: e.id, createdAt: { gte: new Date(Date.now() - 14 * 86400_000) } }, orderBy: { createdAt: 'desc' }, take: 10 });
    if (!drops.length) return { drop: null };
    const types = await this.prisma.ticketType.findMany({ where: { id: { in: drops.map((d) => d.ticketTypeId) } }, select: { id: true, priceCents: true } });
    const price = new Map(types.map((t) => [t.id, t.priceCents]));
    const live = drops.find((d) => price.get(d.ticketTypeId) === d.toCents);
    if (!live) return { drop: null };
    // "was" is the highest price before the run of cuts that led here
    const was = Math.max(...drops.filter((d) => d.ticketTypeId === live.ticketTypeId).map((d) => d.fromCents));
    return {
      drop: { ticketTypeId: live.ticketTypeId, ticketName: live.ticketName, fromCents: was, toCents: live.toCents, currency: live.currency, percentOff: Math.round(((was - live.toCents) / was) * 100), at: live.createdAt },
    };
  }
}

@ApiTags('price drops')
@Controller()
export class PriceDropController {
  constructor(private readonly drops: PriceDropService) {}

  @OptionalAuth()
  @Post('events/:slug/price-watch')
  @HttpCode(200)
  @RateLimit(RATE_RULES.priceWatch)
  watch(@Param('slug') slug: string, @Body() dto: WatchDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.drops.watch(slug, dto.email, user, clientIp(req));
  }

  @Public()
  @Get('events/:slug/price-drop')
  latest(@Param('slug') slug: string) {
    return this.drops.latest(slug);
  }

  @Public()
  @Delete('price-watch/:token')
  stop(@Param('token') t: string) {
    return this.drops.stop(t);
  }
}

@ApiTags('price drops')
@ApiBearerAuth()
@Controller('me/watching')
export class WatchingController {
  constructor(private readonly drops: PriceDropService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.drops.watching(user);
  }

  @Delete(':eventId')
  unwatch(@CurrentUser() user: AuthUser, @Param('eventId') eventId: string) {
    return this.drops.unwatch(user, eventId);
  }
}

@Global()
@Module({ imports: [EventsModule], controllers: [PriceDropController, WatchingController], providers: [PriceDropService], exports: [PriceDropService] })
export class PriceDropModule {}
