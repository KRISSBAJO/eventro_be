/**
 * Hiring a venue on Omoshow (stage 1: the price is shown, payment happens outside Omoshow).
 *
 * A venue's approved managers (VenueClaim APPROVED) list it for hire with terms and weekly hours, and block out
 * times. Organizers (org admins and managers) request a time; the request holds that time for 48 hours (never past
 * the start) while the venue confirms or declines. Listings with instant booking confirm free times at once.
 * Confirming declines every other pending request that overlaps it. Either side can cancel before the start, and
 * both sides can write on the booking; nobody else sees a booking's names or messages (the public availability
 * only shows busy times).
 *
 * Times are the venue's wall-clock time stored as UTC (like event times), with the venue's zone. Each booking keeps
 * blockFrom/blockTo (its times plus the listing's setup/cleanup buffer): another booking's times can't fall inside
 * them. Requests and confirmations take a per-venue lock (pg_advisory_xact_lock) so two requests for the same time
 * can't both get in.
 *
 * An event can be booked at the venue (on create, on request, or later): it stays on hold, and can't be submitted for
 * review, until the booking is CONFIRMED (see OrganizerService.submit). Cancelling the event cancels its pending or
 * confirmed booking too (cancelForEvent, called from EventCancellation).
 *
 * Public:     GET /venue-listings, GET /venues/:slug/availability
 * Managers:   GET|PUT /me/venues/:id/listing, GET|POST /me/venues/:id/blackouts, DELETE /me/venues/:id/blackouts/:blackoutId,
 *             GET /me/venue-bookings, GET /me/venue-bookings/:id, POST /me/venue-bookings/:id/{confirm,decline,cancel},
 *             GET|POST /me/venue-bookings/:id/messages
 * Organizers: POST|GET /organizer/orgs/:orgId/venue-bookings, GET /organizer/venue-bookings/:id,
 *             POST /organizer/venue-bookings/:id/cancel, GET|POST /organizer/venue-bookings/:id/messages
 *
 * Emails and pushes (push choice "orders"; dedupe key `<kind>:<bookingId or messageId>:<userId>`):
 *   venue_booking.request    venue managers   a new request (or an instant booking)
 *   venue_booking.confirmed  organizer        the venue confirmed (or it was booked instantly)
 *   venue_booking.declined   organizer        declined by the venue, or because the venue confirmed another booking
 *   venue_booking.expired    organizer        nobody answered within the hold
 *   venue_booking.cancelled  the other side   cancelled; an organizer whose event is in review or on sale is told to act;
 *                                             the venue also hears when the booking goes because its event was cancelled
 *   venue_booking.message    the other side   a new message
 * "Organizer" means the org's active admins and managers and whoever made the request.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma, type MemberRole, type Venue, type VenueBooking, type VenueListing } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { config } from '../config';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { PushService } from '../push/push.service';
import { bookingCode } from '../domain/codes';
import { CURRENCY_CODES, currencyForCountry, type Currency } from '../domain/currency';
import { instantToWallClock, wallClockLabel, wallClockToInstant } from '../domain/wallclock';
import { placeTimezone } from '../geo/geo.module';
import {
  BOOKING_STATUSES,
  DAY_MS,
  HOUR_MS,
  MAX_AHEAD_DAYS,
  MAX_BOOKING_DAYS,
  PRICE_MODES,
  TIME,
  blockOf,
  effectiveStatus,
  holdUntilFor,
  hoursProblems,
  isLive,
  quoteFor,
  sortHours,
  withinHours,
  type OpeningHours,
} from './booking-rules';

const EDIT: MemberRole[] = ['ADMIN', 'MANAGER'];
const ANY: MemberRole[] = ['ADMIN', 'MANAGER', 'DOOR'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Where each side opens a booking (website paths; the app maps them to its screens). */
export const orgBookingPath = (id: string) => `/organizer/bookings/${id}`;
export const venueBookingPath = (id: string) => `/venues/manage/bookings/${id}`;
const link = (path: string, extra: Record<string, unknown>) => ({ url: `eventro:/${path}`, path, ...extra });

/* ---------- DTOs ---------- */

export class OpeningHoursDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: 'Sunday = 0' }) @IsInt() @Min(0) @Max(6) day: number;
  @ApiProperty({ example: '09:00' }) @IsString() @Matches(TIME, { message: 'open should look like 09:00' }) open: string;
  @ApiProperty({ example: '23:00', description: '24:00 closes at midnight' }) @IsString() @Matches(TIME, { message: 'close should look like 23:00' }) close: string;
}

export class ListingPhotoDto {
  @ApiProperty() @IsUrl({ require_protocol: true, protocols: ['https'] }) @MaxLength(500) url: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) alt?: string;
}

/** PUT /me/venues/:id/listing: every field optional; missing ones keep their value. */
export class ListingDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ enum: PRICE_MODES }) @IsOptional() @IsIn(PRICE_MODES) priceMode?: string;
  @ApiPropertyOptional({ description: 'Per hour or per day, in minor units; null with QUOTE', nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(500_000_000) priceCents?: number | null;
  @ApiPropertyOptional({ enum: CURRENCY_CODES }) @IsOptional() @IsIn(CURRENCY_CODES) currency?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 72 }) @IsOptional() @IsInt() @Min(1) @Max(72) minHours?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 365 }) @IsOptional() @IsInt() @Min(0) @Max(365) noticeDays?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 720 }) @IsOptional() @IsInt() @Min(0) @Max(720) bufferMinutes?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(500_000) capacity?: number | null;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MinLength(2, { each: true }) @MaxLength(40, { each: true }) amenities?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(3000) rules?: string | null;
  @ApiPropertyOptional({ type: [ListingPhotoDto], nullable: true }) @IsOptional() @IsArray() @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => ListingPhotoDto) photos?: ListingPhotoDto[] | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() instantBook?: boolean;
  @ApiPropertyOptional({ type: [OpeningHoursDto], nullable: true, description: 'Null or [] means any time' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursDto)
  hours?: OpeningHoursDto[] | null;
}

export class BlackoutDto {
  @ApiProperty({ description: 'Venue wall-clock time, stored as UTC' }) @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
  @ApiPropertyOptional({ description: 'Only the venue’s managers see it' }) @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class BookingRequestDto {
  @ApiProperty() @IsString() @MaxLength(40) venueId: string;
  @ApiProperty({ description: 'Venue wall-clock time, stored as UTC (like event times)' }) @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(500_000) guests?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) message?: string;
  @ApiPropertyOptional({ description: 'A draft event to hold at the venue until the booking is confirmed' }) @IsOptional() @IsString() @MaxLength(40) eventId?: string;
}

export class ReasonDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class ConfirmBookingDto {
  @ApiPropertyOptional({ description: 'The price agreed, in minor units of the listing currency', nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) quotedCents?: number | null;
  @ApiPropertyOptional({ description: 'Posted on the booking as a message from the venue' }) @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class BookingMessageDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) body: string;
}

/* ---------- views ---------- */

type Hours = OpeningHours[] | null;
const hoursOf = (l: Pick<VenueListing, 'hours'> | null) => (Array.isArray(l?.hours) && (l!.hours as unknown[]).length ? (l!.hours as OpeningHours[]) : null);

/** A venue's zone: its own, else its state's or country's, else UTC. */
export const venueZone = (v: Pick<Venue, 'timezone' | 'country' | 'region'>) => v.timezone ?? placeTimezone(v.country, v.region) ?? 'UTC';

/** The listing as anyone can see it (null when it isn't taking bookings). */
export function publicListing(l: VenueListing | null | undefined, v: Pick<Venue, 'timezone' | 'country' | 'region' | 'capacity'>) {
  if (!l?.active) return null;
  return {
    active: true,
    priceMode: l.priceMode,
    priceCents: l.priceMode === 'QUOTE' ? null : l.priceCents,
    currency: l.currency,
    minHours: l.minHours,
    noticeDays: l.noticeDays,
    bufferMinutes: l.bufferMinutes,
    capacity: l.capacity ?? v.capacity,
    amenities: l.amenities,
    rules: l.rules,
    photos: (l.photos as { url: string; alt?: string }[] | null) ?? [],
    instantBook: l.instantBook,
    hours: hoursOf(l),
    timezone: venueZone(v),
  };
}

/** A new listing is priced in the venue country's currency (when Omoshow takes it), else US dollars. */
const LOCAL_CURRENCY: Record<string, Currency> = { NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR', GB: 'GBP', CA: 'CAD', AU: 'AUD' };
export const listingCurrency = (country: string | null | undefined) => (country ? LOCAL_CURRENCY[country.toUpperCase()] : undefined) ?? currencyForCountry(country);

const DEFAULT_LISTING = {
  active: false,
  priceMode: 'QUOTE',
  priceCents: null as number | null,
  currency: 'USD',
  minHours: 1,
  noticeDays: 7,
  bufferMinutes: 60,
  capacity: null as number | null,
  amenities: [] as string[],
  rules: null as string | null,
  photos: null as { url: string; alt?: string }[] | null,
  instantBook: false,
  hours: null as Hours,
};

const BOOKING_INCLUDE = {
  venue: { select: { id: true, slug: true, name: true, address: true, city: true, region: true, country: true, timezone: true, imageUrl: true, phone: true, website: true } },
  org: { select: { id: true, name: true, supportEmail: true } },
  event: { select: { id: true, slug: true, title: true, status: true, startsAt: true, endsAt: true } },
} satisfies Prisma.VenueBookingInclude;
type BookingRow = Prisma.VenueBookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;
type Side = 'ORGANIZER' | 'VENUE';

type Recipient = { id: string; email: string; name: string };
type Note = { subject: string; heading: string; preheader: string; paragraphs: string[]; highlight?: { label: string; value: string }; cta: string; title: string; body: string };

/* ---------- service ---------- */

@Injectable()
export class VenueBookingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('VenueBookings');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  /** Requests past their hold expire within 5 minutes (tests call `expireDue` directly). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.expireDue().catch((e) => this.log.error((e as Error).message)), 5 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ----- access ----- */

  /** The venue, when this person is one of its approved managers. */
  private async managed(venueId: string, user: AuthUser) {
    const v = await this.prisma.venue.findUnique({ where: { id: venueId }, include: { listing: true } });
    if (!v) throw new NotFoundException('Venue not found.');
    const c = await this.prisma.venueClaim.findUnique({ where: { venueId_userId: { venueId, userId: user.id } } });
    if (c?.status !== 'APPROVED') throw new ForbiddenException('Only this venue’s managers can do this.');
    return v;
  }

  private async managedIds(user: AuthUser) {
    const claims = await this.prisma.venueClaim.findMany({ where: { userId: user.id, status: 'APPROVED' }, select: { venueId: true } });
    return claims.map((c) => c.venueId);
  }

  private async member(orgId: string, user: AuthUser, roles: MemberRole[]) {
    const m = await this.prisma.organizationMember.findFirst({ where: { orgId, userId: user.id, status: 'ACTIVE' } });
    if (!m) throw new NotFoundException('Organization not found.');
    if (!roles.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
    return m;
  }

  /** A booking seen from one side; anyone else gets "not found". */
  private async bookingFor(id: string, user: AuthUser, side: Side, roles: MemberRole[] = ANY) {
    const b = await this.prisma.venueBooking.findUnique({ where: { id }, include: BOOKING_INCLUDE });
    if (!b) throw new NotFoundException('Booking not found.');
    if (side === 'ORGANIZER') {
      const m = await this.prisma.organizationMember.findFirst({ where: { orgId: b.orgId, userId: user.id, status: 'ACTIVE' } });
      if (!m) throw new NotFoundException('Booking not found.');
      if (!roles.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
    } else {
      const c = await this.prisma.venueClaim.findUnique({ where: { venueId_userId: { venueId: b.venueId, userId: user.id } } });
      if (c?.status !== 'APPROVED') throw new NotFoundException('Booking not found.');
    }
    return b;
  }

  /** Only one request or confirmation per venue at a time; released when the transaction ends. */
  private lock(tx: Prisma.TransactionClient, venueId: string) {
    return tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`venue-booking:${venueId}`}::text))`;
  }

  /** A live booking (confirmed, or pending and still held) whose kept-free time clashes with these times. */
  private clash(tx: Prisma.TransactionClient, venueId: string, t: { startsAt: Date; endsAt: Date; blockFrom: Date; blockTo: Date }, opts: { exclude?: string; confirmedOnly?: boolean } = {}) {
    const now = new Date();
    return tx.venueBooking.findFirst({
      where: {
        venueId,
        ...(opts.exclude ? { id: { not: opts.exclude } } : {}),
        OR: opts.confirmedOnly ? [{ status: 'CONFIRMED' }] : [{ status: 'CONFIRMED' }, { status: 'PENDING', holdUntil: { gt: now } }],
        AND: [{ OR: [{ blockFrom: { lt: t.endsAt }, blockTo: { gt: t.startsAt } }, { startsAt: { lt: t.blockTo }, endsAt: { gt: t.blockFrom } }] }],
      },
      select: { id: true, status: true },
    });
  }

  /* ----- listing (managers) ----- */

  private listingOut(v: Venue & { listing: VenueListing | null }) {
    const l = v.listing;
    const base = l
      ? { ...DEFAULT_LISTING, ...l, photos: (l.photos as { url: string; alt?: string }[] | null) ?? null, hours: hoursOf(l) }
      : { ...DEFAULT_LISTING, currency: listingCurrency(v.country), venueId: v.id, createdAt: null, updatedAt: null };
    return { ...base, venueId: v.id, exists: !!l, timezone: venueZone(v), venueCapacity: v.capacity, hidden: !!v.hiddenAt };
  }

  async listing(venueId: string, user: AuthUser) {
    return this.listingOut(await this.managed(venueId, user));
  }

  async saveListing(venueId: string, user: AuthUser, dto: ListingDto) {
    const v = await this.managed(venueId, user);
    const cur = v.listing ? { ...DEFAULT_LISTING, ...v.listing, photos: v.listing.photos as ListingDto['photos'], hours: hoursOf(v.listing) } : { ...DEFAULT_LISTING, currency: listingCurrency(v.country) };
    const next = {
      active: dto.active ?? cur.active,
      priceMode: dto.priceMode ?? cur.priceMode,
      priceCents: dto.priceCents !== undefined ? dto.priceCents : cur.priceCents,
      currency: dto.currency ?? cur.currency,
      minHours: dto.minHours ?? cur.minHours,
      noticeDays: dto.noticeDays ?? cur.noticeDays,
      bufferMinutes: dto.bufferMinutes ?? cur.bufferMinutes,
      capacity: dto.capacity !== undefined ? dto.capacity : cur.capacity,
      amenities: dto.amenities !== undefined ? cleanList(dto.amenities) : cur.amenities,
      rules: dto.rules !== undefined ? dto.rules?.trim() || null : cur.rules,
      photos: dto.photos !== undefined ? (dto.photos?.length ? dto.photos.map((p) => ({ url: p.url, ...(p.alt?.trim() ? { alt: p.alt.trim() } : {}) })) : null) : cur.photos,
      instantBook: dto.instantBook ?? cur.instantBook,
      hours: dto.hours !== undefined ? (dto.hours?.length ? sortHours(dto.hours.map((h) => ({ day: h.day, open: h.open, close: h.close }))) : null) : cur.hours,
    };
    const problems = next.hours ? hoursProblems(next.hours) : [];
    if (problems.length) throw new BadRequestException({ message: problems[0], errors: problems });
    if (next.priceMode === 'QUOTE') next.priceCents = null;
    else if (next.priceCents === null) throw new BadRequestException(`Set a price per ${next.priceMode === 'HOUR' ? 'hour' : 'day'}, or choose “Ask for a quote”.`);
    if (next.capacity !== null && v.capacity !== null && next.capacity > v.capacity) throw new BadRequestException(`Guests can’t be more than the venue holds (${v.capacity.toLocaleString('en-US')}).`);
    if (next.active && v.hiddenAt) throw new BadRequestException('This venue is hidden on Omoshow, so it can’t take bookings. Contact Omoshow support.');
    if (next.minHours > MAX_BOOKING_DAYS * 24) throw new BadRequestException('That minimum is longer than the longest booking.');
    const data = { ...next, photos: next.photos ?? Prisma.DbNull, hours: next.hours ?? Prisma.DbNull } as Prisma.VenueListingUncheckedCreateInput;
    await this.prisma.venueListing.upsert({ where: { venueId }, create: { ...data, venueId }, update: { ...data, venueId: undefined } });
    await this.audit.log(user.id, 'venue.listing', 'Venue', venueId, { fields: Object.keys(dto), active: next.active });
    return this.listing(venueId, user);
  }

  /* ----- blackouts (managers) ----- */

  async blackouts(venueId: string, user: AuthUser, from?: string, to?: string) {
    await this.managed(venueId, user);
    const range = rangeOf(from, to, 366);
    return this.prisma.venueBlackout.findMany({ where: { venueId, startsAt: { lt: range.to }, endsAt: { gt: range.from } }, orderBy: { startsAt: 'asc' }, take: 500 });
  }

  async addBlackout(venueId: string, user: AuthUser, dto: BlackoutDto) {
    await this.managed(venueId, user);
    const startsAt = minute(dto.startsAt);
    const endsAt = minute(dto.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException('The end has to be after the start.');
    if (endsAt.getTime() - startsAt.getTime() > 366 * DAY_MS) throw new BadRequestException('Block out at most a year at a time.');
    if (endsAt.getTime() < Date.now() - DAY_MS) throw new BadRequestException('That time is already over.');
    const b = await this.prisma.venueBlackout.create({ data: { venueId, startsAt, endsAt, note: dto.note?.trim() || null, createdById: user.id } });
    // Confirmed bookings are kept (cancel them if you must); the answer says which ones are affected.
    const confirmed = await this.prisma.venueBooking.findMany({ where: { venueId, status: 'CONFIRMED', startsAt: { lt: endsAt }, endsAt: { gt: startsAt } }, select: { code: true } });
    await this.audit.log(user.id, 'venue.blackout', 'Venue', venueId, { blackoutId: b.id });
    return { ...b, conflicts: confirmed.map((c) => c.code) };
  }

  async removeBlackout(venueId: string, blackoutId: string, user: AuthUser) {
    await this.managed(venueId, user);
    const { count } = await this.prisma.venueBlackout.deleteMany({ where: { id: blackoutId, venueId } });
    if (!count) throw new NotFoundException('Blocked time not found.');
    await this.audit.log(user.id, 'venue.blackout.remove', 'Venue', venueId, { blackoutId });
    return { removed: true };
  }

  /* ----- public ----- */

  /** Venues taking bookings: by name, city, country, guests, and open (and far enough ahead) on a date. */
  async search(q: { q?: string; city?: string; country?: string; guests?: string; date?: string }) {
    const s = (q.q ?? '').trim().slice(0, 80);
    const city = (q.city ?? '').trim().slice(0, 80);
    const country = (q.country ?? '').trim().toUpperCase();
    const guests = Math.max(0, Math.min(500_000, Math.floor(Number(q.guests) || 0)));
    const date = q.date && DATE.test(q.date) ? new Date(`${q.date}T00:00:00.000Z`) : null;
    const rows = await this.prisma.venueListing.findMany({
      where: {
        active: true,
        venue: {
          hiddenAt: null,
          ...(s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { city: { contains: s, mode: 'insensitive' } }, { address: { contains: s, mode: 'insensitive' } }] } : {}),
          ...(city ? { city: { contains: city, mode: 'insensitive' } } : {}),
          ...(/^[A-Z]{2}$/.test(country) ? { country } : {}),
        },
      },
      include: {
        venue: {
          include: date ? { blackouts: { where: { startsAt: { lte: date }, endsAt: { gte: new Date(date.getTime() + DAY_MS) } }, select: { id: true } } } : undefined,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const now = Date.now();
    const out = rows.filter((l) => {
      const cap = l.capacity ?? l.venue.capacity;
      if (guests && cap !== null && cap < guests) return false;
      if (date) {
        const hours = hoursOf(l);
        if (hours && !hours.some((h) => h.day === date.getUTCDay())) return false;
        if ((l.venue as { blackouts?: unknown[] }).blackouts?.length) return false;
        // The whole day is too soon for the notice the venue needs.
        const dayEnd = wallClockToInstant(new Date(date.getTime() + DAY_MS), venueZone(l.venue)).getTime();
        if (dayEnd - now < l.noticeDays * DAY_MS) return false;
      }
      return true;
    });
    out.sort((a, b) => Number(!!b.venue.verifiedAt) - Number(!!a.venue.verifiedAt) || a.venue.city.localeCompare(b.venue.city) || a.venue.name.localeCompare(b.venue.name));
    return out.slice(0, 60).map((l) => ({
      venue: { id: l.venue.id, slug: l.venue.slug, name: l.venue.name, address: l.venue.address, city: l.venue.city, region: l.venue.region, country: l.venue.country, imageUrl: l.venue.imageUrl, verified: !!l.venue.verifiedAt, capacity: l.venue.capacity, timezone: venueZone(l.venue) },
      listing: publicListing(l, l.venue)!,
    }));
  }

  /**
   * Busy times at a venue between two dates (venue wall-clock days, at most 120): confirmed bookings and requests
   * still on hold (with their setup and cleanup time), and blocked-out time. Only the times, never who.
   */
  async availability(slug: string, from?: string, to?: string) {
    const v = await this.prisma.venue.findUnique({ where: { slug }, include: { listing: true } });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    const listing = publicListing(v.listing, v);
    if (!listing) throw new NotFoundException('This venue isn’t taking bookings on Omoshow.');
    const zone = venueZone(v);
    const today = instantToWallClock(new Date(), zone).toISOString().slice(0, 10);
    const range = rangeOf(from ?? today, to, 120);
    const now = new Date();
    const [bookings, blackouts] = await Promise.all([
      this.prisma.venueBooking.findMany({
        where: { venueId: v.id, blockFrom: { lt: range.to }, blockTo: { gt: range.from }, OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', holdUntil: { gt: now } }] },
        select: { blockFrom: true, blockTo: true, status: true },
        orderBy: { blockFrom: 'asc' },
      }),
      this.prisma.venueBlackout.findMany({ where: { venueId: v.id, startsAt: { lt: range.to }, endsAt: { gt: range.from } }, select: { startsAt: true, endsAt: true }, orderBy: { startsAt: 'asc' } }),
    ]);
    const busy = [
      ...bookings.map((b) => ({ from: b.blockFrom, to: b.blockTo, kind: b.status === 'CONFIRMED' ? ('booked' as const) : ('held' as const) })),
      ...blackouts.map((b) => ({ from: b.startsAt, to: b.endsAt, kind: 'closed' as const })),
    ].sort((a, b) => a.from.getTime() - b.from.getTime());
    return {
      venue: { id: v.id, slug: v.slug, name: v.name },
      timezone: zone,
      from: range.from,
      to: range.to,
      /** the earliest start the venue's notice allows, in venue wall-clock time */
      earliestStart: instantToWallClock(new Date(now.getTime() + listing.noticeDays * DAY_MS), zone),
      hours: listing.hours,
      minHours: listing.minHours,
      bufferMinutes: listing.bufferMinutes,
      busy,
    };
  }

  /* ----- requests (organizers) ----- */

  async request(orgId: string, user: AuthUser, dto: BookingRequestDto) {
    await this.member(orgId, user, EDIT);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { suspendedAt: true } });
    if (org.suspendedAt) throw new ForbiddenException('This organizer account is suspended. Contact Omoshow support.');
    const v = await this.prisma.venue.findUnique({ where: { id: dto.venueId }, include: { listing: true } });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    const l = v.listing;
    if (!l?.active) throw new BadRequestException(`${v.name} isn’t taking bookings on Omoshow right now.`);
    const zone = venueZone(v);
    const startsAt = minute(dto.startsAt);
    const endsAt = minute(dto.endsAt);
    this.checkTimes(v, l, zone, startsAt, endsAt, dto.guests);

    const event = dto.eventId ? await this.eventToHold(dto.eventId, orgId, startsAt, endsAt) : null;
    const { blockFrom, blockTo } = blockOf(startsAt, endsAt, l.bufferMinutes);
    const instant = l.instantBook;
    const now = new Date();

    const booking = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, v.id);
        const closed = await tx.venueBlackout.findFirst({ where: { venueId: v.id, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } });
        if (closed) throw new ConflictException({ statusCode: 409, code: 'VENUE_CLOSED', message: `${v.name} is closed for part of that time. Pick another time.` });
        if (await this.clash(tx, v.id, { startsAt, endsAt, blockFrom, blockTo })) {
          throw new ConflictException({ statusCode: 409, code: 'VENUE_TIME_TAKEN', message: `That time isn’t free at ${v.name} (it’s booked or on hold, including ${l.bufferMinutes} minutes for setup and cleanup). Pick another time.` });
        }
        let code = bookingCode();
        while (await tx.venueBooking.findUnique({ where: { code }, select: { id: true } })) code = bookingCode();
        const b = await tx.venueBooking.create({
          data: {
            code,
            venueId: v.id,
            orgId,
            requestedById: user.id,
            startsAt,
            endsAt,
            blockFrom,
            blockTo,
            guests: dto.guests ?? null,
            message: dto.message?.trim() || null,
            status: instant ? 'CONFIRMED' : 'PENDING',
            holdUntil: holdUntilFor(startsAt, zone, now),
            quotedCents: quoteFor(l.priceMode, l.priceCents, startsAt, endsAt),
            currency: l.currency,
            ...(instant ? { decidedAt: now } : {}),
          },
        });
        if (event) {
          // A booking that fell through stays in the history, no longer tied to the event.
          await tx.venueBooking.updateMany({ where: { eventId: event.id, NOT: { id: b.id } }, data: { eventId: null } });
          await tx.venueBooking.update({ where: { id: b.id }, data: { eventId: event.id } });
          await tx.event.update({ where: { id: event.id }, data: { venueId: v.id, timezone: zone } });
        }
        return b;
      },
      { timeout: 20_000, maxWait: 15_000 },
    );
    await this.audit.log(user.id, instant ? 'venue_booking.instant' : 'venue_booking.request', 'VenueBooking', booking.id, { venueId: v.id, orgId, eventId: event?.id ?? null });
    const full = await this.prisma.venueBooking.findUniqueOrThrow({ where: { id: booking.id }, include: BOOKING_INCLUDE });
    void this.notifyRequest(full, user);
    if (instant) void this.notifyOrganizer(full, 'confirmed');
    return this.view(full, 'ORGANIZER', user);
  }

  /** The request rules that don't need the lock: hours, notice, length, guests. */
  private checkTimes(v: Venue, l: VenueListing, zone: string, startsAt: Date, endsAt: Date, guests?: number) {
    if (endsAt <= startsAt) throw new BadRequestException('The end has to be after the start.');
    const ms = endsAt.getTime() - startsAt.getTime();
    if (ms < l.minHours * HOUR_MS) throw new BadRequestException(`${v.name} is booked for at least ${l.minHours} ${l.minHours === 1 ? 'hour' : 'hours'}.`);
    if (ms > MAX_BOOKING_DAYS * DAY_MS) throw new BadRequestException(`Book at most ${MAX_BOOKING_DAYS} days at a time.`);
    const start = wallClockToInstant(startsAt, zone).getTime();
    const now = Date.now();
    if (start <= now) throw new BadRequestException('That time has already passed.');
    if (start - now < l.noticeDays * DAY_MS) throw new BadRequestException(`${v.name} needs at least ${l.noticeDays} ${l.noticeDays === 1 ? 'day' : 'days'}’ notice. Pick a later date.`);
    if (start - now > MAX_AHEAD_DAYS * DAY_MS) throw new BadRequestException('That’s too far ahead to book.');
    if (!withinHours(startsAt, endsAt, hoursOf(l))) throw new BadRequestException(`${v.name} isn’t open for all of that time. Check its opening hours.`);
    const cap = l.capacity ?? v.capacity;
    if (guests !== undefined && cap !== null && guests > cap) throw new BadRequestException(`${v.name} takes at most ${cap.toLocaleString('en-US')} guests.`);
  }

  /** A draft (or rejected) event of the org that a request can hold at the venue. */
  private async eventToHold(eventId: string, orgId: string, startsAt: Date, endsAt: Date) {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId }, include: { venueBooking: true } });
    if (!ev || ev.orgId !== orgId) throw new NotFoundException('Event not found.');
    if (ev.online) throw new BadRequestException('This is an online event, so it doesn’t need a venue.');
    // v1: only one-date events are booked through Omoshow (multiple dates and multi-day events pick a venue instead).
    if (ev.dateMode !== 'SINGLE') throw new BadRequestException('Venue bookings on Omoshow are for single-date events for now. Pick the venue for this event instead.');
    if (ev.status !== 'DRAFT' && ev.status !== 'REJECTED') throw new BadRequestException('Only draft events can wait for a venue. Request the booking on its own, then attach it to the event once the venue confirms.');
    if (ev.venueBooking && isLive(ev.venueBooking)) throw new ConflictException({ statusCode: 409, code: 'EVENT_ALREADY_BOOKED', message: `This event already has a venue booking (${ev.venueBooking.code}). Cancel it first.` });
    assertFits({ startsAt, endsAt }, ev);
    return ev;
  }

  async orgBookings(orgId: string, user: AuthUser, status?: string) {
    await this.member(orgId, user, ANY);
    const rows = await this.prisma.venueBooking.findMany({ where: { orgId, ...statusWhere(status) }, include: BOOKING_INCLUDE, orderBy: [{ startsAt: 'asc' }], take: 300 });
    const sides = await this.cancelSides(rows);
    return rows.map((b) => this.viewSync(b, 'ORGANIZER', sides));
  }

  async orgBooking(id: string, user: AuthUser) {
    const b = await this.bookingFor(id, user, 'ORGANIZER');
    return this.view(b, 'ORGANIZER', user, true);
  }

  /* ----- venue managers ----- */

  async inbox(user: AuthUser, status?: string, venueId?: string, from?: string, to?: string) {
    const ids = await this.managedIds(user);
    const venueIds = venueId ? ids.filter((x) => x === venueId) : ids;
    if (venueId && !venueIds.length) throw new ForbiddenException('Only this venue’s managers can see its bookings.');
    const range = from || to ? rangeOf(from, to, 400) : null;
    const rows = venueIds.length
      ? await this.prisma.venueBooking.findMany({
          where: { venueId: { in: venueIds }, ...statusWhere(status), ...(range ? { startsAt: { lt: range.to }, endsAt: { gt: range.from } } : {}) },
          include: BOOKING_INCLUDE,
          orderBy: [{ startsAt: 'asc' }],
          take: 500,
        })
      : [];
    const sides = await this.cancelSides(rows);
    const now = new Date();
    const pending = venueIds.length ? await this.prisma.venueBooking.count({ where: { venueId: { in: venueIds }, status: 'PENDING', holdUntil: { gt: now } } }) : 0;
    return { venues: venueIds, pending, items: rows.map((b) => this.viewSync(b, 'VENUE', sides)) };
  }

  async venueBooking(id: string, user: AuthUser) {
    const b = await this.bookingFor(id, user, 'VENUE');
    return this.view(b, 'VENUE', user, true);
  }

  async confirm(id: string, user: AuthUser, dto: ConfirmBookingDto) {
    const b = await this.bookingFor(id, user, 'VENUE');
    const now = new Date();
    if (b.status !== 'PENDING') throw new BadRequestException(`This booking is ${b.status.toLowerCase()}, so it can’t be confirmed.`);
    if (b.holdUntil <= now) {
      await this.expireOne(b.id, now);
      throw new BadRequestException('This request expired before it was confirmed. The organizer can ask again.');
    }
    const declined = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, b.venueId);
        if (await this.clash(tx, b.venueId, b, { exclude: b.id, confirmedOnly: true })) {
          throw new ConflictException({ statusCode: 409, code: 'VENUE_TIME_TAKEN', message: 'Another confirmed booking already overlaps this time. Decline this request instead.' });
        }
        const { count } = await tx.venueBooking.updateMany({
          where: { id: b.id, status: 'PENDING', holdUntil: { gt: now } },
          data: { status: 'CONFIRMED', decidedById: user.id, decidedAt: now, ...(dto.quotedCents !== undefined ? { quotedCents: dto.quotedCents } : {}) },
        });
        if (!count) throw new ConflictException('This request changed a moment ago. Refresh and try again.');
        // Every other request still waiting for an overlapping time can't happen now.
        const others = await tx.venueBooking.findMany({
          where: { venueId: b.venueId, id: { not: b.id }, status: 'PENDING', AND: [{ OR: [{ blockFrom: { lt: b.endsAt }, blockTo: { gt: b.startsAt } }, { startsAt: { lt: b.blockTo }, endsAt: { gt: b.blockFrom } }] }] },
          select: { id: true },
        });
        if (others.length) {
          await tx.venueBooking.updateMany({
            where: { id: { in: others.map((o) => o.id) }, status: 'PENDING' },
            data: { status: 'DECLINED', decidedById: user.id, decidedAt: now, declineReason: 'The venue confirmed another booking for this time.' },
          });
        }
        if (dto.note?.trim()) await tx.venueBookingMessage.create({ data: { bookingId: b.id, userId: user.id, side: 'VENUE', body: dto.note.trim() } });
        return others.map((o) => o.id);
      },
      { timeout: 20_000, maxWait: 15_000 },
    );
    await this.audit.log(user.id, 'venue_booking.confirm', 'VenueBooking', b.id, { autoDeclined: declined });
    const full = await this.prisma.venueBooking.findUniqueOrThrow({ where: { id: b.id }, include: BOOKING_INCLUDE });
    void this.notifyOrganizer(full, 'confirmed');
    for (const d of declined) {
      void this.prisma.venueBooking
        .findUnique({ where: { id: d }, include: BOOKING_INCLUDE })
        .then((x) => x && this.notifyOrganizer(x, 'declined'))
        .catch(() => undefined);
    }
    return { ...(await this.view(full, 'VENUE', user)), autoDeclined: declined.length };
  }

  async decline(id: string, user: AuthUser, reason: string) {
    const b = await this.bookingFor(id, user, 'VENUE');
    if (b.status !== 'PENDING') throw new BadRequestException(`This booking is ${b.status.toLowerCase()}, so it can’t be declined.`);
    const now = new Date();
    const { count } = await this.prisma.venueBooking.updateMany({ where: { id: b.id, status: 'PENDING' }, data: { status: 'DECLINED', decidedById: user.id, decidedAt: now, declineReason: reason.trim() } });
    if (!count) throw new ConflictException('This request changed a moment ago. Refresh and try again.');
    await this.audit.log(user.id, 'venue_booking.decline', 'VenueBooking', b.id, { reason: reason.trim() });
    const full = await this.prisma.venueBooking.findUniqueOrThrow({ where: { id: b.id }, include: BOOKING_INCLUDE });
    void this.notifyOrganizer(full, 'declined');
    return this.view(full, 'VENUE', user);
  }

  /**
   * Either side cancels, with a reason. Organizers can withdraw a request or cancel a confirmed booking; the venue
   * cancels confirmed bookings (it declines requests). Never once the booking has started.
   */
  async cancel(id: string, user: AuthUser, side: Side, reason: string) {
    const b = await this.bookingFor(id, user, side, side === 'ORGANIZER' ? EDIT : ANY);
    const now = new Date();
    const status = effectiveStatus(b, now);
    const allowed = side === 'ORGANIZER' ? ['PENDING', 'CONFIRMED'] : ['CONFIRMED'];
    if (!allowed.includes(status)) {
      throw new BadRequestException(side === 'VENUE' && status === 'PENDING' ? 'Decline the request instead.' : `This booking is ${status.toLowerCase()}, so it can’t be cancelled.`);
    }
    const zone = venueZone(b.venue);
    if (wallClockToInstant(b.startsAt, zone) <= now) throw new BadRequestException('This booking has already started, so it can’t be cancelled here. Talk to the other side directly.');
    const { count } = await this.prisma.venueBooking.updateMany({
      where: { id: b.id, status: b.status },
      data: { status: 'CANCELLED', cancelledById: user.id, cancelledAt: now, cancelReason: reason.trim() },
    });
    if (!count) throw new ConflictException('This booking changed a moment ago. Refresh and try again.');
    await this.audit.log(user.id, 'venue_booking.cancel', 'VenueBooking', b.id, { side, reason: reason.trim(), was: b.status });
    const full = await this.prisma.venueBooking.findUniqueOrThrow({ where: { id: b.id }, include: BOOKING_INCLUDE });
    if (side === 'ORGANIZER') void this.notifyVenueCancelled(full, user);
    else void this.notifyOrganizer(full, 'cancelled');
    return this.view(full, side, user);
  }

  /* ----- messages ----- */

  async messages(id: string, user: AuthUser, side: Side) {
    const b = await this.bookingFor(id, user, side);
    return this.thread(b.id, user);
  }

  async postMessage(id: string, user: AuthUser, side: Side, body: string) {
    const b = await this.bookingFor(id, user, side, side === 'ORGANIZER' ? EDIT : ANY);
    const text = body.trim();
    if (!text) throw new BadRequestException('Write a message first.');
    const recent = await this.prisma.venueBookingMessage.count({ where: { bookingId: b.id, userId: user.id, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= 10) throw new BadRequestException('That’s a lot of messages in a minute. Wait a moment.');
    const m = await this.prisma.venueBookingMessage.create({ data: { bookingId: b.id, userId: user.id, side, body: text } });
    void this.notifyMessage(b, m.id, side, user, text);
    return { id: m.id, side: m.side, body: m.body, createdAt: m.createdAt, author: user.name, mine: true };
  }

  private async thread(bookingId: string, user: AuthUser) {
    const rows = await this.prisma.venueBookingMessage.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' }, take: 500 });
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const name = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => ({ id: r.id, side: r.side, body: r.body, createdAt: r.createdAt, author: r.userId ? (name.get(r.userId) ?? null) : null, mine: r.userId === user.id }));
  }

  /* ----- expiry ----- */

  /** Requests nobody answered in time become EXPIRED, and the organizer hears. Safe to run as often as you like. */
  async expireDue(now = new Date()) {
    const due = await this.prisma.venueBooking.findMany({ where: { status: 'PENDING', holdUntil: { lte: now } }, select: { id: true }, take: 500 });
    let expired = 0;
    for (const d of due) if (await this.expireOne(d.id, now)) expired++;
    return { expired };
  }

  private async expireOne(id: string, now: Date) {
    const { count } = await this.prisma.venueBooking.updateMany({ where: { id, status: 'PENDING', holdUntil: { lte: now } }, data: { status: 'EXPIRED' } });
    if (!count) return false;
    const b = await this.prisma.venueBooking.findUnique({ where: { id }, include: BOOKING_INCLUDE });
    if (b) void this.notifyOrganizer(b, 'expired');
    return true;
  }

  /* ----- events (used by OrganizerService) ----- */

  /** A booking of this org that an event can be held at (pending or confirmed, not used by another event). */
  async attachable(bookingId: string, orgId: string, eventId?: string) {
    const b = await this.prisma.venueBooking.findUnique({ where: { id: bookingId }, include: { venue: true } });
    if (!b || b.orgId !== orgId) throw new NotFoundException('Venue booking not found.');
    const status = effectiveStatus(b);
    if (status !== 'PENDING' && status !== 'CONFIRMED') throw new BadRequestException(`Booking ${b.code} was ${status.toLowerCase()}. Request another time or venue.`);
    if (b.eventId && b.eventId !== eventId) throw new ConflictException({ statusCode: 409, code: 'BOOKING_IN_USE', message: `Booking ${b.code} is already used by another event.` });
    if (b.venue.hiddenAt) throw new BadRequestException('That venue is no longer on Omoshow.');
    return { ...b, status, timezone: venueZone(b.venue) };
  }

  /**
   * Why an event can't be submitted for review because of its venue booking (null when it can): still waiting for
   * the venue (VENUE_BOOKING_PENDING), or the booking fell through (VENUE_BOOKING_UNAVAILABLE).
   */
  async submitBlock(eventId: string) {
    const b = await this.prisma.venueBooking.findUnique({ where: { eventId }, include: { venue: { select: { name: true } } } });
    if (!b) return null;
    const status = effectiveStatus(b);
    if (status === 'CONFIRMED') return null;
    if (status === 'PENDING') {
      return { statusCode: 409, code: 'VENUE_BOOKING_PENDING', bookingCode: b.code, bookingStatus: status, message: `Waiting for ${b.venue.name} to confirm booking ${b.code}. You can submit the event once they confirm.` };
    }
    const what = status === 'DECLINED' ? 'declined' : status === 'EXPIRED' ? 'expired (the venue didn’t answer in time)' : 'cancelled';
    return { statusCode: 409, code: 'VENUE_BOOKING_UNAVAILABLE', bookingCode: b.code, bookingStatus: status, message: `Booking ${b.code} at ${b.venue.name} was ${what}. Pick another venue or time, then submit again.` };
  }

  /**
   * The event was cancelled (by its organizer or by Omoshow): its venue booking, if it's still pending or confirmed
   * and hasn't ended, is cancelled too, with the reason "The event was cancelled", and the venue's managers hear.
   * Answers with the booking's code, or null when there was nothing to cancel. Safe to call again.
   */
  async cancelForEvent(eventId: string, actor: AuthUser) {
    const b = await this.prisma.venueBooking.findUnique({ where: { eventId }, include: BOOKING_INCLUDE });
    if (!b) return null;
    const now = new Date();
    const status = effectiveStatus(b, now);
    if (status !== 'PENDING' && status !== 'CONFIRMED') return null;
    if (wallClockToInstant(b.endsAt, venueZone(b.venue)) <= now) return null;
    const reason = 'The event was cancelled';
    const { count } = await this.prisma.venueBooking.updateMany({
      where: { id: b.id, status: b.status },
      data: { status: 'CANCELLED', cancelledById: actor.id, cancelledAt: now, cancelReason: reason },
    });
    if (!count) return null;
    await this.audit.log(actor.id, 'venue_booking.cancel', 'VenueBooking', b.id, { side: 'ORGANIZER', reason, was: b.status, eventId });
    void this.notifyVenueEventCancelled({ ...b, status: 'CANCELLED', cancelReason: reason });
    return b.code;
  }

  /** The booking summary shown on the organizer's event screens. */
  static eventSummary(b: Pick<VenueBooking, 'id' | 'code' | 'status' | 'startsAt' | 'endsAt' | 'holdUntil' | 'quotedCents' | 'currency' | 'declineReason' | 'cancelReason'> | null) {
    if (!b) return null;
    return { id: b.id, code: b.code, status: effectiveStatus(b), startsAt: b.startsAt, endsAt: b.endsAt, holdUntil: b.holdUntil, quotedCents: b.quotedCents, currency: b.currency, declineReason: b.declineReason, cancelReason: b.cancelReason };
  }

  /* ----- views ----- */

  /** Who cancelled each cancelled booking: one of the venue's managers, or the organizer. */
  private async cancelSides(rows: { id: string; venueId: string; cancelledById: string | null }[]) {
    const cancelled = rows.filter((r) => r.cancelledById);
    if (!cancelled.length) return new Map<string, Side>();
    const claims = await this.prisma.venueClaim.findMany({
      where: { status: 'APPROVED', userId: { in: [...new Set(cancelled.map((r) => r.cancelledById!))] }, venueId: { in: [...new Set(cancelled.map((r) => r.venueId))] } },
      select: { userId: true, venueId: true },
    });
    const venueSide = new Set(claims.map((c) => `${c.venueId}:${c.userId}`));
    return new Map(cancelled.map((r) => [r.id, venueSide.has(`${r.venueId}:${r.cancelledById}`) ? ('VENUE' as const) : ('ORGANIZER' as const)]));
  }

  private viewSync(b: BookingRow, side: Side, sides: Map<string, Side>) {
    const zone = venueZone(b.venue);
    return {
      id: b.id,
      code: b.code,
      status: effectiveStatus(b),
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      blockFrom: b.blockFrom,
      blockTo: b.blockTo,
      timezone: zone,
      guests: b.guests,
      message: b.message,
      holdUntil: b.holdUntil,
      quotedCents: b.quotedCents,
      currency: b.currency,
      decidedAt: b.decidedAt,
      declineReason: b.declineReason,
      cancelledAt: b.cancelledAt,
      cancelReason: b.cancelReason,
      cancelledBy: b.cancelledById ? (sides.get(b.id) ?? null) : null,
      createdAt: b.createdAt,
      venue: { id: b.venue.id, slug: b.venue.slug, name: b.venue.name, address: b.venue.address, city: b.venue.city, region: b.venue.region, country: b.venue.country, imageUrl: b.venue.imageUrl, ...(side === 'ORGANIZER' ? { phone: b.venue.phone, website: b.venue.website } : {}) },
      org: { id: b.org.id, name: b.org.name, ...(side === 'VENUE' ? { supportEmail: b.org.supportEmail } : {}) },
      event: b.event ? { id: b.event.id, title: b.event.title, ...(side === 'ORGANIZER' ? { slug: b.event.slug, status: b.event.status } : {}) } : null,
      side,
    };
  }

  private async view(b: BookingRow, side: Side, user: AuthUser, withThread = false) {
    const sides = await this.cancelSides([b]);
    const base = this.viewSync(b, side, sides);
    if (!withThread) return base;
    const [messages, requester, listing] = await Promise.all([
      this.thread(b.id, user),
      b.requestedById ? this.prisma.user.findUnique({ where: { id: b.requestedById }, select: { name: true } }) : null,
      this.prisma.venueListing.findUnique({ where: { venueId: b.venueId } }),
    ]);
    const now = new Date();
    const started = wallClockToInstant(b.startsAt, base.timezone) <= now;
    const status = base.status;
    return {
      ...base,
      requestedBy: requester?.name ?? null,
      terms: listing ? { priceMode: listing.priceMode, priceCents: listing.priceMode === 'QUOTE' ? null : listing.priceCents, currency: listing.currency, rules: listing.rules, bufferMinutes: listing.bufferMinutes } : null,
      can: {
        confirm: side === 'VENUE' && status === 'PENDING',
        decline: side === 'VENUE' && status === 'PENDING',
        cancel: !started && (side === 'ORGANIZER' ? status === 'PENDING' || status === 'CONFIRMED' : status === 'CONFIRMED'),
        message: true,
      },
      messages,
    };
  }

  /* ----- who hears ----- */

  private async managers(venueId: string): Promise<Recipient[]> {
    const claims = await this.prisma.venueClaim.findMany({ where: { venueId, status: 'APPROVED', user: { suspendedAt: null } }, select: { user: { select: { id: true, email: true, name: true } } } });
    return claims.map((c) => c.user);
  }

  private async organizers(b: Pick<VenueBooking, 'orgId' | 'requestedById'>): Promise<Recipient[]> {
    const members = await this.prisma.organizationMember.findMany({
      where: { orgId: b.orgId, status: 'ACTIVE', userId: { not: null }, OR: [{ role: { in: ['ADMIN', 'MANAGER'] } }, ...(b.requestedById ? [{ userId: b.requestedById }] : [])] },
      select: { user: { select: { id: true, email: true, name: true, suspendedAt: true } } },
    });
    const out = new Map<string, Recipient>();
    for (const m of members) if (m.user && !m.user.suspendedAt) out.set(m.user.id, { id: m.user.id, email: m.user.email, name: m.user.name });
    return [...out.values()];
  }

  /** One email and one push per person. Never throws. */
  private async tell(kind: string, key: string, to: Recipient[], note: Note, path: string, data: Record<string, unknown>, footer: string) {
    try {
      if (!to.length) return;
      const { html, text } = render({
        preheader: note.preheader,
        heading: note.heading,
        paragraphs: note.paragraphs,
        ...(note.highlight ? { highlight: note.highlight } : {}),
        cta: { label: note.cta, url: `${config.webUrl}${path}` },
        footer,
      });
      await this.mail.sendMany(kind, to.map((r) => ({ to: r.email, subject: note.subject, html, text })));
      await this.push.send(
        kind,
        'orders',
        to.map((r) => ({ userId: r.id, title: note.title, body: note.body, data: link(path, { type: kind, ...data }), dedupeKey: `${kind}:${key}:${r.id}` })),
      );
    } catch (e) {
      this.log.warn(`${kind} ${key}: ${(e as Error).message}`);
    }
  }

  private when(b: Pick<VenueBooking, 'startsAt' | 'endsAt'>) {
    const day = (d: Date) => wallClockLabel(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = (d: Date) => wallClockLabel(d, { hour: 'numeric', minute: '2-digit' });
    return day(b.startsAt) === day(b.endsAt) ? `${day(b.startsAt)}, ${time(b.startsAt)} – ${time(b.endsAt)}` : `${day(b.startsAt)} ${time(b.startsAt)} – ${day(b.endsAt)} ${time(b.endsAt)}`;
  }

  private price(b: Pick<VenueBooking, 'quotedCents' | 'currency'>) {
    return b.quotedCents !== null && b.currency ? formatMoney(b.quotedCents, b.currency) : null;
  }

  private async notifyRequest(b: BookingRow, by: AuthUser) {
    const to = await this.managers(b.venueId);
    const instant = b.status === 'CONFIRMED';
    const when = this.when(b);
    const price = this.price(b);
    await this.tell(
      'venue_booking.request',
      b.id,
      to,
      {
        subject: instant ? `New booking at ${b.venue.name}: ${b.org.name}` : `Booking request for ${b.venue.name}: ${when}`,
        heading: instant ? `${b.org.name} booked ${b.venue.name}` : `${b.org.name} wants to book ${b.venue.name}`,
        preheader: `${when}${b.guests ? ` · ${b.guests.toLocaleString('en-US')} guests` : ''}`,
        paragraphs: [
          `${by.name} at ${b.org.name} ${instant ? 'booked' : 'asked to book'} ${b.venue.name} for ${when} (the venue’s local time)${b.guests ? `, for ${b.guests.toLocaleString('en-US')} guests` : ''}.`,
          ...(b.message ? [`Their message: “${b.message}”`] : []),
          ...(price ? [`Price shown: ${price}. Payment is arranged between you and the organizer, outside Omoshow.`] : ['You quote the price; payment is arranged between you and the organizer, outside Omoshow.']),
          instant
            ? 'Your listing confirms free times instantly, so this booking is confirmed.'
            : `The time is held for them until ${b.holdUntil.toUTCString().slice(0, 22)} UTC. Confirm or decline before then.`,
        ],
        highlight: { label: 'Booking', value: b.code },
        cta: instant ? 'See the booking' : 'Confirm or decline',
        title: instant ? `New booking: ${b.venue.name}` : `Booking request: ${b.venue.name}`,
        body: `${b.org.name} · ${when}${b.guests ? ` · ${b.guests} guests` : ''}`,
      },
      venueBookingPath(b.id),
      { bookingId: b.id, venueId: b.venueId },
      `You’re getting this because you manage ${b.venue.name} on Omoshow.`,
    );
  }

  private async notifyOrganizer(b: BookingRow, what: 'confirmed' | 'declined' | 'expired' | 'cancelled') {
    const to = await this.organizers(b);
    const when = this.when(b);
    const price = this.price(b);
    const ev = b.event;
    const live = !!ev && (ev.status === 'PUBLISHED' || ev.status === 'IN_REVIEW');
    const notes: Record<typeof what, Note> = {
      confirmed: {
        subject: `Confirmed: ${b.venue.name}, ${when}`,
        heading: `${b.venue.name} confirmed your booking`,
        preheader: `${when} is yours.${ev ? ` You can submit ${ev.title} for review now.` : ''}`,
        paragraphs: [
          `${b.venue.name} confirmed booking ${b.code} for ${when} (the venue’s local time).`,
          ...(price ? [`Price: ${price}. Pay the venue directly, the way you agree with them; Omoshow doesn’t take this payment.`] : ['The venue will tell you the price. Pay them directly; Omoshow doesn’t take this payment.']),
          ev ? `${ev.title} is no longer on hold: submit it for review when it’s ready.` : 'You can attach this booking to an event from the event’s venue settings.',
        ],
        highlight: { label: 'Booking', value: b.code },
        cta: 'See the booking',
        title: `Confirmed: ${b.venue.name}`,
        body: `${when} is booked.${ev ? ` ${ev.title} can be submitted now.` : ''}`,
      },
      declined: {
        subject: `Not available: ${b.venue.name}, ${when}`,
        heading: `${b.venue.name} can’t host this booking`,
        preheader: b.declineReason ?? 'Pick another time or venue.',
        paragraphs: [
          `${b.venue.name} declined booking ${b.code} for ${when}.`,
          ...(b.declineReason ? [`Their reason: “${b.declineReason}”`] : []),
          ev ? `${ev.title} stays on hold until it has a venue. Pick another time or venue for it.` : 'Pick another time or venue.',
        ],
        cta: 'Find another time',
        title: `Declined: ${b.venue.name}`,
        body: b.declineReason ?? `${when} isn’t available. Pick another time or venue.`,
      },
      expired: {
        subject: `Request expired: ${b.venue.name}, ${when}`,
        heading: `Your request to ${b.venue.name} expired`,
        preheader: 'The venue didn’t answer in time, so the time is free again.',
        paragraphs: [
          `${b.venue.name} didn’t answer booking request ${b.code} for ${when} in time, so it expired and the time is no longer held for you.`,
          ev ? `${ev.title} stays on hold until it has a venue. Ask again, or pick another venue.` : 'You can ask again, or pick another venue.',
        ],
        cta: 'See the booking',
        title: `Expired: ${b.venue.name}`,
        body: `No answer in time for ${when}. Ask again or pick another venue.`,
      },
      cancelled: {
        subject: live ? `Action needed: ${b.venue.name} cancelled your booking for ${ev!.title}` : `Cancelled: ${b.venue.name}, ${when}`,
        heading: live ? `${b.venue.name} cancelled. ${ev!.title} needs a venue` : `${b.venue.name} cancelled your booking`,
        preheader: b.cancelReason ?? `Booking ${b.code} was cancelled.`,
        paragraphs: [
          `${b.venue.name} cancelled booking ${b.code} for ${when}.`,
          ...(b.cancelReason ? [`Their reason: “${b.cancelReason}”`] : []),
          ...(live
            ? [
                `${ev!.title} is ${ev!.status === 'PUBLISHED' ? 'on sale' : 'in review'} at this venue. It hasn’t been cancelled: move it to another venue, or talk to ${b.venue.name}, and tell your ticket holders what happens next.`,
              ]
            : []),
        ],
        cta: live ? 'Fix the event' : 'See the booking',
        title: live ? `Action needed: ${ev!.title}` : `Cancelled: ${b.venue.name}`,
        body: live ? `${b.venue.name} cancelled your booking. ${ev!.title} needs a venue.` : `${b.venue.name} cancelled ${when}.`,
      },
    };
    const path = what === 'cancelled' && live ? `/organizer/events/${ev!.id}` : orgBookingPath(b.id);
    await this.tell(`venue_booking.${what}`, b.id, to, notes[what], path, { bookingId: b.id, eventId: ev?.id ?? null }, `You’re getting this because you manage ${b.org.name} on Omoshow.`);
  }

  private async notifyVenueCancelled(b: BookingRow, by: AuthUser) {
    const to = await this.managers(b.venueId);
    const when = this.when(b);
    await this.tell(
      'venue_booking.cancelled',
      b.id,
      to,
      {
        subject: `Cancelled: ${b.org.name}, ${when}`,
        heading: `${b.org.name} cancelled their booking`,
        preheader: `${when} at ${b.venue.name} is free again.`,
        paragraphs: [`${by.name} at ${b.org.name} cancelled booking ${b.code} for ${when}. The time is free again.`, ...(b.cancelReason ? [`Their reason: “${b.cancelReason}”`] : [])],
        cta: 'See your bookings',
        title: `Cancelled: ${b.org.name}`,
        body: `${when} at ${b.venue.name} is free again.`,
      },
      venueBookingPath(b.id),
      { bookingId: b.id, venueId: b.venueId },
      `You’re getting this because you manage ${b.venue.name} on Omoshow.`,
    );
  }

  private async notifyVenueEventCancelled(b: BookingRow) {
    const to = await this.managers(b.venueId);
    const when = this.when(b);
    const title = b.event?.title ?? 'their event';
    await this.tell(
      'venue_booking.cancelled',
      b.id,
      to,
      {
        subject: `Cancelled: ${b.org.name}, ${when}`,
        heading: `${title} was cancelled`,
        preheader: `${when} at ${b.venue.name} is free again.`,
        paragraphs: [`${b.org.name}’s event ${title} was cancelled, so booking ${b.code} for ${when} is cancelled too. The time is free again.`, 'If any payment was arranged for this booking, settle it directly with the organizer.'],
        cta: 'See your bookings',
        title: `Cancelled: ${b.org.name}`,
        body: `${title} was cancelled. ${when} at ${b.venue.name} is free again.`,
      },
      venueBookingPath(b.id),
      { bookingId: b.id, venueId: b.venueId },
      `You’re getting this because you manage ${b.venue.name} on Omoshow.`,
    );
  }

  private async notifyMessage(b: BookingRow, messageId: string, side: Side, by: AuthUser, text: string) {
    const to = (side === 'ORGANIZER' ? await this.managers(b.venueId) : await this.organizers(b)).filter((r) => r.id !== by.id);
    const from = side === 'ORGANIZER' ? b.org.name : b.venue.name;
    const short = text.length > 140 ? `${text.slice(0, 137)}…` : text;
    await this.tell(
      'venue_booking.message',
      messageId,
      to,
      {
        subject: `New message from ${from} about ${b.code}`,
        heading: `${from} wrote about booking ${b.code}`,
        preheader: short,
        paragraphs: [`${by.name} (${from}) wrote:`, `“${text}”`, `Booking ${b.code}: ${b.venue.name}, ${this.when(b)}.`],
        cta: 'Reply',
        title: `${from} · ${b.code}`,
        body: short,
      },
      side === 'ORGANIZER' ? venueBookingPath(b.id) : orgBookingPath(b.id),
      { bookingId: b.id, messageId },
      side === 'ORGANIZER' ? `You’re getting this because you manage ${b.venue.name} on Omoshow.` : `You’re getting this because you manage ${b.org.name} on Omoshow.`,
    );
  }
}

/* ---------- helpers ---------- */

/** A time to the minute (seconds dropped). */
function minute(raw: string) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Pick a valid date and time.');
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

/** Days `from`..`to` (YYYY-MM-DD, inclusive), at most `max` days; defaults to 60 days from `from` (or today). */
function rangeOf(from: string | undefined, to: string | undefined, max: number) {
  const start = from && DATE.test(from) ? new Date(`${from}T00:00:00.000Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  if (Number.isNaN(start.getTime())) throw new BadRequestException('Dates look like 2026-12-31.');
  let end = to && DATE.test(to) ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS) : new Date(start.getTime() + 60 * DAY_MS);
  if (Number.isNaN(end.getTime()) || end <= start) throw new BadRequestException('The end date has to be on or after the start date.');
  if (end.getTime() - start.getTime() > max * DAY_MS) end = new Date(start.getTime() + max * DAY_MS);
  return { from: start, to: end };
}

/** Status filter, where PENDING means still on hold and EXPIRED includes requests past their hold. */
function statusWhere(status?: string): Prisma.VenueBookingWhereInput {
  const s = (status ?? '').toUpperCase();
  if (!BOOKING_STATUSES.includes(s as (typeof BOOKING_STATUSES)[number])) return {};
  const now = new Date();
  if (s === 'PENDING') return { status: 'PENDING', holdUntil: { gt: now } };
  if (s === 'EXPIRED') return { OR: [{ status: 'EXPIRED' }, { status: 'PENDING', holdUntil: { lte: now } }] };
  return { status: s };
}

/** Trimmed, de-duplicated (case-insensitive). */
function cleanList(list: string[]) {
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/**
 * An event held at a booked venue happens within the booking's times (doors included).
 * Throws 400 OUTSIDE_VENUE_BOOKING otherwise.
 */
export function assertFits(b: { startsAt: Date; endsAt: Date }, ev: { startsAt: Date; doorsAt?: Date | null; endsAt?: Date | null }) {
  const first = ev.doorsAt && ev.doorsAt < ev.startsAt ? ev.doorsAt : ev.startsAt;
  const last = ev.endsAt ?? ev.startsAt;
  if (first < b.startsAt || last > b.endsAt || ev.startsAt >= b.endsAt) {
    const t = (d: Date) => wallClockLabel(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    throw new BadRequestException({
      statusCode: 400,
      code: 'OUTSIDE_VENUE_BOOKING',
      message: `The event has to happen within the venue booking (${t(b.startsAt)} – ${t(b.endsAt)}), doors included.`,
    });
  }
}

/* ---------- routes ---------- */

@ApiTags('venue bookings')
@Controller()
export class VenueBookingPublicController {
  constructor(private readonly svc: VenueBookingService) {}

  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'guests', required: false })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD' })
  @Public()
  @Get('venue-listings')
  search(@Query('q') q?: string, @Query('city') city?: string, @Query('country') country?: string, @Query('guests') guests?: string, @Query('date') date?: string) {
    return this.svc.search({ q, city, country, guests, date });
  }

  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD (venue time); default today' })
  @ApiQuery({ name: 'to', required: false, description: 'YYYY-MM-DD; default 60 days on, at most 120' })
  @Public()
  @Get('venues/:slug/availability')
  availability(@Param('slug') slug: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.availability(slug, from, to);
  }
}

@ApiTags('venue bookings')
@ApiBearerAuth()
@Controller('me')
export class VenueManagerBookingsController {
  constructor(private readonly svc: VenueBookingService) {}

  @Get('venues/:id/listing') listing(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.listing(id, u);
  }
  @Put('venues/:id/listing') saveListing(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ListingDto) {
    return this.svc.saveListing(id, u, dto);
  }
  @Get('venues/:id/blackouts') blackouts(@Param('id') id: string, @CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.blackouts(id, u, from, to);
  }
  @Post('venues/:id/blackouts') addBlackout(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: BlackoutDto) {
    return this.svc.addBlackout(id, u, dto);
  }
  @Delete('venues/:id/blackouts/:blackoutId') removeBlackout(@Param('id') id: string, @Param('blackoutId') blackoutId: string, @CurrentUser() u: AuthUser) {
    return this.svc.removeBlackout(id, blackoutId, u);
  }

  @ApiQuery({ name: 'status', required: false, enum: BOOKING_STATUSES })
  @ApiQuery({ name: 'venueId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @Get('venue-bookings')
  inbox(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('venueId') venueId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.inbox(u, status, venueId, from, to);
  }
  @Get('venue-bookings/:id') one(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.venueBooking(id, u);
  }
  @Post('venue-bookings/:id/confirm') @HttpCode(200) confirm(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ConfirmBookingDto) {
    return this.svc.confirm(id, u, dto);
  }
  @Post('venue-bookings/:id/decline') @HttpCode(200) decline(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ReasonDto) {
    return this.svc.decline(id, u, dto.reason);
  }
  @Post('venue-bookings/:id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ReasonDto) {
    return this.svc.cancel(id, u, 'VENUE', dto.reason);
  }
  @Get('venue-bookings/:id/messages') messages(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.messages(id, u, 'VENUE');
  }
  @Post('venue-bookings/:id/messages') post(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: BookingMessageDto) {
    return this.svc.postMessage(id, u, 'VENUE', dto.body);
  }
}

@ApiTags('venue bookings')
@ApiBearerAuth()
@Controller('organizer')
export class OrganizerBookingsController {
  constructor(private readonly svc: VenueBookingService) {}

  /** Org admins and managers: ask a venue for a time (instant-book listings confirm at once). */
  @Post('orgs/:orgId/venue-bookings') request(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: BookingRequestDto) {
    return this.svc.request(orgId, u, dto);
  }
  @ApiQuery({ name: 'status', required: false, enum: BOOKING_STATUSES })
  @Get('orgs/:orgId/venue-bookings') list(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.svc.orgBookings(orgId, u, status);
  }
  @Get('venue-bookings/:id') one(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.orgBooking(id, u);
  }
  @Post('venue-bookings/:id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ReasonDto) {
    return this.svc.cancel(id, u, 'ORGANIZER', dto.reason);
  }
  @Get('venue-bookings/:id/messages') messages(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.messages(id, u, 'ORGANIZER');
  }
  @Post('venue-bookings/:id/messages') post(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: BookingMessageDto) {
    return this.svc.postMessage(id, u, 'ORGANIZER', dto.body);
  }
}
