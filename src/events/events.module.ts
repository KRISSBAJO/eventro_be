import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, Matches } from 'class-validator';
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InventoryService } from '../common/inventory.service';
import { OptionalAuth, Public } from '../common/auth';
import { assignSeats, sectionCapacity, type SeatMap } from '../domain/seatmap';
import { mediaUrls, type MediaItem } from '../media/media.module';
import { previewOk } from './preview';
import { FxService } from '../fx/fx.module';
import { CURRENCY_CODES } from '../domain/currency';
import { resolveLook } from '../domain/tier-look';
import { pastCutoff } from '../resale/resale.module';
import { donationsView, pwywView } from '../domain/pwyw';
import { config } from '../config';
import { LIVE_TYPE, dateRangeWhere, dateView, liveType, nextActive, nextDateView, ticketTimes, type DateRow } from '../domain/event-dates';

/** The date asked for (DATES), else the next one on sale, else the first. */
const pickDate = <T extends DateRow>(dates: T[], id?: string) => dates.find((d) => d.id === id) ?? nextActive(dates) ?? dates[0] ?? null;

/** "Trending" counts paid tickets from this many days back. */
const TRENDING_DAYS = 14;

const CATEGORIES = Object.values(Category);

/** Great-circle distance in km. */
function km(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export class EventQueryDto {
  @ApiPropertyOptional({ description: 'Search title, subtitle, venue and city' }) @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) @IsOptional() @IsIn(CATEGORIES) category?: Category;
  @ApiPropertyOptional({ example: 'London' }) @IsOptional() @IsString() @MaxLength(60) city?: string;
  @ApiPropertyOptional({ example: 'NG', description: 'ISO country code of the venue' }) @IsOptional() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @ApiPropertyOptional({ example: '6.5244,3.3792', description: 'Visitor position "lat,lng": adds distanceKm and sorts nearest first' })
  @IsOptional()
  @Matches(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
  near?: string;
  @ApiPropertyOptional({ description: 'With near: only events within this many km' }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20000) radiusKm?: number;
  @ApiPropertyOptional({ description: 'ISO date, inclusive' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO date, inclusive' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ description: 'Maximum lowest price in whole units: of `currency` when given, else of each event’s own currency' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;
  @ApiPropertyOptional({ enum: CURRENCY_CODES, example: 'NGN', description: 'Visitor’s currency: maxPrice is compared after converting each price (approximate, GET /fx/rates), and cards get fromCentsIn' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(CURRENCY_CODES)
  currency?: string;
  @ApiPropertyOptional({
    enum: ['date', 'price-asc', 'price-desc', 'distance', 'popular'],
    description: `distance needs near (the default when near is given); popular = most paid tickets in the last ${TRENDING_DAYS} days, then soonest`,
  })
  @IsOptional()
  @IsIn(['date', 'price-asc', 'price-desc', 'distance', 'popular'])
  sort?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 24 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class EventCardDto {
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiProperty() subtitle: string;
  @ApiProperty({ enum: CATEGORIES }) category: Category;
  @ApiProperty() startsAt: Date;
  @ApiProperty({ nullable: true }) imageUrl: string | null;
  @ApiProperty({ nullable: true }) venue: string | null;
  @ApiProperty({ nullable: true }) city: string | null;
  @ApiProperty({ description: 'Lowest all-in price in minor units of `currency`' }) fromCents: number;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({ nullable: true, example: 'NG' }) country: string | null;
  @ApiProperty({ nullable: true }) lat: number | null;
  @ApiProperty({ nullable: true }) lng: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'With near: straight-line km from the visitor (null for online events)' }) distanceKm?: number | null;
  @ApiProperty({ description: `Paid tickets sold in the last ${TRENDING_DAYS} days` }) soldRecent: number;
  @ApiProperty({ description: 'Fan-resale listings on sale now (0 when resale is off or has closed for the event)' }) resaleCount: number;
  @ApiPropertyOptional({ description: 'With currency: fromCents converted to that currency (approximate, for display)', example: { currency: 'USD', cents: 1613 } })
  fromCentsIn?: { currency: string; cents: number };
  @ApiProperty({ enum: ['SINGLE', 'DATES', 'DAYS'] }) dateMode: string;
  @ApiProperty({ nullable: true, description: 'DATES/DAYS: the first upcoming active date ({ id, startsAt }); null for SINGLE' }) nextDate: { id: string; startsAt: Date } | null;
  @ApiProperty({ description: 'Active dates (DATES) or days (DAYS) still to come, for "+N more dates" / "3 days"; 0 for SINGLE' }) dateCount: number;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly fx: FxService,
  ) {}

  /** Paid tickets per event in the last TRENDING_DAYS days (refunded orders don't count). */
  private async soldRecently(eventIds: string[]) {
    if (!eventIds.length) return new Map<string, number>();
    const rows = await this.prisma.order.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds }, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: new Date(Date.now() - TRENDING_DAYS * 86_400_000) } },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.eventId, r._sum.quantity ?? 0]));
  }

  /**
   * Active fan-resale listings per event, in one grouped query. Events with resale switched off or past the
   * organizer's cutoff count 0, since nobody could buy from them (as GET /events/:slug/resale and the hold say).
   * Held listings don't count; a hold that ran out counts again once the resale module tidies it.
   */
  private async resaleListed(events: { id: string; resaleEnabled: boolean; startsAt: Date; transferCutoffMinutes: number }[], lastStart: Map<string, Date>) {
    // With more than one date, resale stays open while the last date's cutoff hasn't passed.
    const open = events.filter((e) => e.resaleEnabled && !pastCutoff({ ...e, startsAt: lastStart.get(e.id) ?? e.startsAt })).map((e) => e.id);
    if (!open.length) return new Map<string, number>();
    const rows = await this.prisma.resaleListing.groupBy({ by: ['eventId'], where: { eventId: { in: open }, status: 'ACTIVE' }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.eventId, r._count._all]));
  }

  /** Event cards (the GET /events item shape) for events loaded with their venue and ticket prices, in the same order. */
  async cards(rows: (Prisma.EventGetPayload<{ include: { venue: true } }> & { ticketTypes: { priceCents: number }[] })[]): Promise<EventCardDto[]> {
    // Multiple dates and multi-day events: their active dates, for nextDate, dateCount and resale.
    const multi = rows.filter((e) => e.dateMode !== 'SINGLE').map((e) => e.id);
    const dateRows = multi.length ? await this.prisma.eventDate.findMany({ where: { eventId: { in: multi }, status: 'ACTIVE' }, orderBy: { startsAt: 'asc' } }) : [];
    const datesOf = new Map<string, typeof dateRows>();
    for (const d of dateRows) datesOf.set(d.eventId, [...(datesOf.get(d.eventId) ?? []), d]);
    const lastStart = new Map([...datesOf].map(([id, ds]) => [id, ds[ds.length - 1].startsAt]));
    const now = new Date();
    const [recent, resale] = await Promise.all([this.soldRecently(rows.map((e) => e.id)), this.resaleListed(rows, lastStart)]);
    return rows.map((e) => ({
      slug: e.slug,
      title: e.title,
      subtitle: e.subtitle,
      category: e.category,
      startsAt: e.startsAt,
      imageUrl: e.imageUrl,
      venue: e.venue?.name ?? (e.online ? 'Online' : null),
      city: e.venue?.city ?? null,
      country: e.venue?.country ?? null,
      lat: e.venue?.lat ?? null,
      lng: e.venue?.lng ?? null,
      currency: e.currency,
      fromCents: e.ticketTypes.length ? Math.min(...e.ticketTypes.map((t) => t.priceCents)) : 0,
      soldRecent: recent.get(e.id) ?? 0,
      resaleCount: resale.get(e.id) ?? 0,
      dateMode: e.dateMode,
      nextDate: nextDateView(e.dateMode, datesOf.get(e.id) ?? [], now),
      dateCount: (datesOf.get(e.id) ?? []).filter((d) => d.startsAt >= now).length,
    }));
  }

  async search(q: EventQueryDto) {
    const where: Prisma.EventWhereInput = {
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      // A date in the range: the event's own (SINGLE), or any active date of a multi-date or multi-day event.
      AND: [dateRangeWhere(q.from ? new Date(q.from) : new Date(), q.to ? new Date(`${q.to.slice(0, 10)}T23:59:59Z`) : undefined)],
      ...(q.category ? { category: q.category } : {}),
      ...(q.city || q.country
        ? { venue: { ...(q.city ? { city: { equals: q.city, mode: 'insensitive' as const } } : {}), ...(q.country ? { country: q.country.toUpperCase() } : {}) } }
        : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { subtitle: { contains: q.q, mode: 'insensitive' } },
              { venue: { name: { contains: q.q, mode: 'insensitive' } } },
              { venue: { city: { contains: q.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.event.findMany({
      where,
      include: { venue: true, ticketTypes: { where: LIVE_TYPE, select: { priceCents: true } } },
      orderBy: { startsAt: 'asc' },
      take: 1000,
    });
    let cards = await this.cards(rows.filter((e) => e.ticketTypes.length));
    // Soonest first by the date fans can still go to (a run whose first show passed sorts by its next one).
    const when = (c: EventCardDto) => (c.nextDate?.startsAt ?? c.startsAt).getTime();
    if (cards.some((c) => c.nextDate)) cards.sort((a, b) => when(a) - when(b));
    // In the visitor's currency: an approximate converted price on every card, and maxPrice compared against it.
    const cur = q.currency;
    if (cur) cards = cards.map((c) => ({ ...c, fromCentsIn: { currency: cur, cents: this.fx.convert(c.fromCents, c.currency, cur) } }));
    // Near me: distance from the visitor, optional radius, nearest first (events without a position go last).
    if (q.near) {
      const [lat, lng] = q.near.split(',').map(Number);
      cards = cards.map((c) => ({ ...c, distanceKm: c.lat !== null && c.lng !== null ? Math.round(km(lat, lng, c.lat, c.lng) * 10) / 10 : null }));
      if (q.radiusKm) cards = cards.filter((c) => c.distanceKm !== null && c.distanceKm! <= q.radiusKm!);
      if (!q.sort || q.sort === 'distance') cards.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    }
    if (q.maxPrice !== undefined) cards = cards.filter((c) => (c.fromCentsIn?.cents ?? c.fromCents) <= q.maxPrice! * 100);
    if (q.sort === 'price-asc') cards.sort((a, b) => a.fromCents - b.fromCents);
    if (q.sort === 'price-desc') cards.sort((a, b) => b.fromCents - a.fromCents);
    // Trending: most tickets sold lately, ties soonest first (the list is already soonest first, and sort is stable).
    if (q.sort === 'popular') cards.sort((a, b) => b.soldRecent - a.soldRecent);
    const page = q.page ?? 1;
    const size = q.pageSize ?? 24;
    return { total: cards.length, page, pageSize: size, items: cards.slice((page - 1) * size, page * size) };
  }

  /**
   * A published event; a cancelled one (with `status: 'CANCELLED'` and the reason, so ticket holders who follow
   * an old link learn what happened; it has nothing on sale); or, with a valid preview token, one that isn't
   * published yet (flagged `preview`).
   */
  async detail(slug: string, preview?: string, dateId?: string) {
    const e = await this.prisma.event.findUnique({
      where: { slug },
      include: { venue: true, org: { select: { name: true } }, ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, dates: { orderBy: { startsAt: 'asc' } } },
    });
    const cancelled = e?.status === 'CANCELLED';
    if (!e || (e.status !== 'PUBLISHED' && !cancelled && !previewOk(e.slug, preview))) throw new NotFoundException('Event not found.');
    const avail = await this.inventory.availabilityForEvent(e.id);
    const map = e.seatMap as SeatMap | null;
    // Multiple dates: section numbers are for one date (?date=, else the next one on sale).
    const seatDate = e.dateMode === 'DATES' ? (e.dates.find((d) => d.id === dateId) ?? nextActive(e.dates) ?? e.dates[0] ?? null) : null;
    const sectionAvail = map ? await this.inventory.availabilityForSections(this.prisma, e.id, map, new Date(), seatDate?.id) : null;
    // From-price: a cancelled date's copies don't count (unless nothing else is left).
    const live = e.ticketTypes.filter((t) => liveType(t, e.dates));
    const priced = live.length ? live : e.ticketTypes;
    const lowest = priced.length ? Math.min(...priced.map((t) => t.priceCents)) : 0;
    // Nothing on sale for a cancelled date, or (with more than one date) a date or pass that has started.
    const now = new Date();
    const onSale = (t: (typeof e.ticketTypes)[number]) => {
      if (e.dateMode === 'SINGLE') return true;
      const d = e.dates.find((x) => x.id === t.eventDateId);
      if (d && d.status === 'CANCELLED') return false;
      return ticketTimes(e.dateMode, e, t, e.dates).first.startsAt > now;
    };
    const left = (t: (typeof e.ticketTypes)[number]) => (cancelled || !onSale(t) ? 0 : (avail.get(t.id) ?? 0));
    return {
      id: e.id,
      slug: e.slug,
      fromCents: lowest,
      title: e.title,
      subtitle: e.subtitle,
      description: e.description,
      category: e.category,
      imageUrl: e.imageUrl,
      startsAt: e.startsAt,
      doorsAt: e.doorsAt,
      endsAt: e.endsAt,
      timezone: e.timezone,
      dateMode: e.dateMode,
      // DATES: tickets left on each date (its copies together); [] for SINGLE.
      dates: e.dates.map((d) => {
        if (e.dateMode !== 'DATES') return dateView(d);
        const copies = e.ticketTypes.filter((t) => t.eventDateId === d.id);
        const available = copies.reduce((s, t) => s + left(t), 0);
        return { ...dateView(d), available, soldOut: d.status === 'ACTIVE' && d.startsAt > now && available === 0 };
      }),
      nextDate: nextDateView(e.dateMode, e.dates, now),
      online: e.online,
      currency: e.currency,
      // Pay what you want: the fee rate, so the page can show what an amount costs all-in.
      feeMode: e.feeMode,
      feePermille: config.organizerFeePermille,
      donations: donationsView(e),
      salesPaused: e.salesPaused,
      ...(cancelled ? { status: e.status, cancelledAt: e.cancelledAt, cancelReason: e.cancelReason } : e.status !== 'PUBLISHED' ? { preview: true, status: e.status } : {}),
      presentedBy: e.org.name,
      venue: e.venue && { slug: e.venue.slug, name: e.venue.name, address: e.venue.address, city: e.venue.city, region: e.venue.region, country: e.venue.country, postalCode: e.venue.postalCode, timezone: e.venue.timezone, lat: e.venue.lat, lng: e.venue.lng },
      ticketTypes: e.ticketTypes.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        maxPerOrder: t.maxPerOrder,
        sortOrder: t.sortOrder,
        perks: t.perks,
        badge: t.badge,
        style: t.style,
        look: resolveLook(t.name, t.style),
        pricing: t.pricing,
        pwyw: pwywView(t, e.feeMode, config.organizerFeePermille),
        available: left(t),
        eventDateId: t.eventDateId,
        tierKey: t.tierKey,
        validDateIds: t.validDateIds,
      })),
      media: ((e.media as MediaItem[] | null) ?? []).map(mediaUrls),
      seatMap: map && {
        ...map,
        sections: map.sections.map((s) => ({ ...s, available: sectionAvail?.get(s.id) ?? 0 })),
      },
      // DATES: the date the seat map's `available` numbers are for
      seatMapDateId: seatDate?.id ?? null,
    };
  }
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * For a group of `qty`: places left in every section and the seats a hold would get right now
   * (side by side, front-most row first). Standing sections have no seat numbers.
   */
  @Public()
  @Get(':slug/availability')
  async availability(@Param('slug') slug: string, @Query('qty') qtyRaw?: string, @Query('date') dateId?: string) {
    const qty = Math.min(20, Math.max(1, Number(qtyRaw) || 1));
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true, seatMap: true, dateMode: true, dates: { orderBy: { startsAt: 'asc' } }, ticketTypes: { select: { id: true, tierKey: true, eventDateId: true } } } });
    if (!e || e.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    const map = e.seatMap as SeatMap | null;
    // Multiple dates: seats for one date (?date=, else the next one on sale); sections point at tiers, so each
    // section's ticket type is that tier's copy on the date.
    const date = e.dateMode === 'DATES' ? pickDate(e.dates, dateId) : null;
    if (!map) return { qty, sections: [], ...(date ? { dateId: date.id } : {}) };
    const typeOf = (tier: string) => (date ? (e.ticketTypes.find((t) => t.tierKey === tier && t.eventDateId === date.id)?.id ?? tier) : tier);
    const [inUse, typeLeft] = await Promise.all([
      this.inventory.seatsInUse(this.prisma, e.id, map.sections.map((s) => s.id), new Date(), undefined, date?.id),
      this.inventory.availabilityForEvent(e.id),
    ]);
    return {
      qty,
      ...(date ? { dateId: date.id } : {}),
      sections: map.sections.map((s) => {
        const used = inUse.get(s.id)!;
        const available = date?.status === 'CANCELLED' ? 0 : Math.max(0, Math.min(sectionCapacity(s) - used.count, typeLeft.get(typeOf(s.ticketTypeId)) ?? 0));
        const seats = s.seating === 'reserved' && available >= qty ? assignSeats(s, used.seats, qty) : null;
        const fits = s.seating === 'ga' ? available >= qty : !!seats;
        // Only side-by-side blocks count as a fit for reserved seating.
        const together = seats && seats.every((x) => x.row === seats[0].row) && seats.every((x, i) => i === 0 || x.seat === seats[i - 1].seat + 1);
        return { id: s.id, available, fits: fits && (s.seating === 'ga' || !!together), row: together ? seats![0].row : null, seats: together ? seats!.map((x) => x.seat) : [] };
      }),
    };
  }

  /** Which seats in a section are sold or held, so fans can see their exact seats before holding. */
  @Public()
  @Get(':slug/sections/:sectionId/seats')
  async seats(@Param('slug') slug: string, @Param('sectionId') sectionId: string, @Query('date') dateId?: string) {
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true, seatMap: true, dateMode: true, dates: { orderBy: { startsAt: 'asc' } } } });
    const s = (e?.seatMap as SeatMap | null)?.sections.find((x) => x.id === sectionId);
    if (!e || e.status !== 'PUBLISHED' || !s) throw new NotFoundException('Section not found.');
    // Multiple dates: taken seats on one date (?date=, else the next one on sale).
    const date = e.dateMode === 'DATES' ? pickDate(e.dates, dateId) : null;
    const used = (await this.inventory.seatsInUse(this.prisma, e.id, [s.id], new Date(), undefined, date?.id)).get(s.id)!;
    return { section: s.id, seating: s.seating, capacity: sectionCapacity(s), inUse: used.count, taken: [...used.seats], ...(date ? { dateId: date.id } : {}) };
  }

  @Public()
  @Get()
  search(@Query() q: EventQueryDto) {
    return this.events.search(q);
  }

  @OptionalAuth()
  @Get(':slug')
  detail(@Param('slug') slug: string, @Query('preview') preview?: string, @Query('date') date?: string) {
    return this.events.detail(slug, preview, date);
  }
}


@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
