/**
 * The venue directory.
 *
 * Venues are added by organizers when they create an event (the same place is reused, see OrganizerService), kept
 * tidy by Omoshow admins (edit, verify, hide, merge duplicates), and kept up to date by venue managers: people at
 * the venue who claimed its page and were approved. Managers and admins can save an official seat layout, which
 * organizers then start from.
 *
 * Venue owners can also add a venue that isn't on Omoshow yet (POST /me/venues): it's created hidden with a pending
 * claim marked `newVenue`, and approving that claim shows it. The claimant hears about decisions by email and push.
 *
 * Public:   GET /venues (?q= to find one to claim), GET /venues/:slug, GET /venues/:slug/layout
 * Signed in: POST /venues/:slug/claims, POST /me/venues, GET /me/venues, PATCH /me/venues/:id, PUT /me/venues/:id/layout
 * Hiring a venue (listing, availability, booking requests): see venue-bookings.ts.
 * Admin:    GET /admin/venues, PATCH /admin/venues/:id, GET /admin/venues/:id/duplicates, POST /admin/venues/:id/merge,
 *           GET /admin/venue-claims, POST /admin/venue-claims/:id/decide
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Logger,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma, type Venue } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth';
import { MailService, render } from '../mail/mail.module';
import { sectionCapacity, validateSeatMap, type SeatMap } from '../domain/seatmap';
import { randomSuffix, slugify } from '../domain/codes';
import { placeTimezone } from '../geo/geo.module';
import { PushService } from '../push/push.service';
import { LIVE_TYPE, dateRangeWhere, nextDateView } from '../domain/event-dates';
import { OrganizerBookingsController, VenueBookingPublicController, VenueBookingService, VenueManagerBookingsController, publicListing } from './venue-bookings';

const PAGE = 25;
const ROLES = ['owner', 'manager', 'staff'] as const;
const pageOf = (raw?: string) => Math.max(1, Math.min(10_000, Number(raw) || 1));
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'hall', 'centre', 'center'].includes(w));

/* ---------- DTOs ---------- */

export class ClaimDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role: string;
  @ApiProperty({ description: 'Who you are at the venue and how we can check it' }) @IsString() @MinLength(10) @MaxLength(600) message: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(200) website?: string;
}

const PHONE = /^[+\d][\d\s()-]{5,24}$/;

/** POST /me/venues: a venue that isn't on Omoshow yet, added by someone who runs it (hidden until approved). */
/** Photos per venue (the gallery on its page). */
export const VENUE_PHOTOS_MAX = 10;

export class OnboardVenueDto {
  @ApiProperty() @IsString() @MinLength(2, { message: 'Give the venue’s name.' }) @MaxLength(120) name: string;
  @ApiProperty() @IsString() @MinLength(3, { message: 'Give the street address.' }) @MaxLength(200) address: string;
  @ApiProperty() @IsString() @MinLength(2, { message: 'Give the city.' }) @MaxLength(80) city: string;
  @ApiPropertyOptional({ description: 'State, province or region' }) @IsOptional() @IsString() @MaxLength(80) region?: string;
  @ApiProperty({ description: 'ISO 3166-1 alpha-2, e.g. NG' }) @IsString() @Matches(/^[A-Za-z]{2}$/, { message: 'Pick the country.' }) country: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1, { message: 'Capacity has to be at least 1.' }) @Max(500_000) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(PHONE, { message: 'That phone number doesn’t look right.' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }, { message: 'The website should start with https://' }) @MaxLength(200) website?: string;
  @ApiPropertyOptional({ description: 'One photo (older apps); use photos' }) @IsOptional() @IsUrl({ require_protocol: true }, { message: 'The photo link should start with https://' }) @MaxLength(500) imageUrl?: string;
  @ApiPropertyOptional({ type: [String], description: `Photo links, the first is the cover (1 to ${VENUE_PHOTOS_MAX}). At least one photo is needed, here or as imageUrl.` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(VENUE_PHOTOS_MAX, { message: `Up to ${VENUE_PHOTOS_MAX} photos.` })
  @IsUrl({ require_protocol: true }, { each: true, message: 'Each photo link should start with https://' })
  @MaxLength(500, { each: true })
  photos?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) about?: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES, { message: 'Say whether you’re the owner, a manager or staff.' }) role: string;
  @ApiProperty({ description: 'Who you are at the venue and how we can check it' })
  @IsString()
  @MinLength(10, { message: 'Tell us a little more about your role (at least 10 characters).' })
  @MaxLength(600)
  message: string;
}

type Photo = { url: string; alt?: string };
/** A venue's photos: its gallery, else its single cover photo; then its hire listing's photos; no repeats. */
export function venuePhotos(v: { photos: unknown; imageUrl: string | null }, listing?: { photos: unknown } | null): Photo[] {
  const own = Array.isArray(v.photos) && v.photos.length ? (v.photos as Photo[]) : v.imageUrl ? [{ url: v.imageUrl }] : [];
  const extra = Array.isArray(listing?.photos) ? (listing!.photos as Photo[]) : [];
  const seen = new Set<string>();
  return [...own, ...extra].filter((p) => p?.url && !seen.has(p.url) && seen.add(p.url));
}
const photoRows = (urls: string[]) => [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, VENUE_PHOTOS_MAX).map((url) => ({ url }));

/** How many venues one person can have waiting for approval at once. */
const MAX_WAITING_NEW = 5;

/** What a venue manager can change. */
export class ManagerVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) about?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) imageUrl?: string;
  @ApiPropertyOptional({ type: [String], description: 'The whole gallery, in order; the first becomes the cover. [] clears it.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(VENUE_PHOTOS_MAX)
  @IsUrl({ require_protocol: true }, { each: true })
  @MaxLength(500, { each: true })
  photos?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(200) website?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[+\d][\d\s()-]{5,24}$/) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(500_000) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(200) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
}

/** Admins can change everything, and verify or hide. */
export class AdminVenueDto extends ManagerVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() verified?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hidden?: boolean;
}

export class LayoutDto {
  @ApiProperty({ description: 'Seat map (same shape as an event seat map); ticket type ids are placeholders' }) @IsObject() layout: Record<string, unknown>;
}

export class MergeDto {
  @ApiProperty({ description: 'The venue to keep' }) @IsString() intoId: string;
}

export class ClaimDecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT', 'REVOKE'] }) @IsIn(['APPROVE', 'REJECT', 'REVOKE']) decision: 'APPROVE' | 'REJECT' | 'REVOKE';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/* ---------- service ---------- */

@Injectable()
export class VenuesService {
  private readonly log = new Logger('Venues');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  private layoutInfo(v: Pick<Venue, 'layout'>) {
    const map = v.layout as SeatMap | null;
    return map?.sections?.length ? { sections: map.sections.length, places: map.sections.reduce((n, s) => n + sectionCapacity(s), 0) } : null;
  }

  /* ----- public ----- */

  list() {
    return this.prisma.venue.findMany({
      where: { hiddenAt: null },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
      select: { slug: true, name: true, city: true, region: true, country: true, address: true, capacity: true, lat: true, lng: true, imageUrl: true, verifiedAt: true },
    });
  }

  /**
   * Finding a venue to claim: visible venues whose name, address or city contains `q` (2+ characters), optionally
   * in one country or city; at most 20, verified first. `managed` says whether someone already manages it.
   */
  async find(q: string, country?: string, city?: string) {
    const s = q.trim().slice(0, 100);
    if (s.length < 2) return [];
    const cc = (country ?? '').trim().toUpperCase();
    const c = (city ?? '').trim().slice(0, 80);
    const rows = await this.prisma.venue.findMany({
      where: {
        hiddenAt: null,
        OR: [{ name: { contains: s, mode: 'insensitive' } }, { address: { contains: s, mode: 'insensitive' } }, { city: { contains: s, mode: 'insensitive' } }],
        ...(/^[A-Z]{2}$/.test(cc) ? { country: cc } : {}),
        ...(c ? { city: { contains: c, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ verifiedAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      take: 20,
      select: {
        slug: true,
        name: true,
        address: true,
        city: true,
        region: true,
        country: true,
        capacity: true,
        imageUrl: true,
        verifiedAt: true,
        _count: { select: { claims: { where: { status: 'APPROVED' } } } },
      },
    });
    return rows.map(({ _count, ...v }) => ({ ...v, verified: !!v.verifiedAt, managed: _count.claims > 0 }));
  }

  async one(slug: string) {
    const v = await this.prisma.venue.findUnique({
      where: { slug },
      include: {
        events: {
          where: { status: 'PUBLISHED', visibility: 'PUBLIC', ...dateRangeWhere(new Date()) },
          orderBy: { startsAt: 'asc' },
          select: { slug: true, title: true, subtitle: true, startsAt: true, imageUrl: true, category: true, currency: true, dateMode: true, dates: { where: { status: 'ACTIVE' }, orderBy: { startsAt: 'asc' } }, ticketTypes: { where: LIVE_TYPE, select: { priceCents: true } } },
        },
        _count: { select: { claims: { where: { status: 'APPROVED' } }, events: true, followers: true } },
        listing: true,
      },
    });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    const { layout, _count, events, listing, photos, ...rest } = v;
    return {
      ...rest,
      /** The venue's photos then its hire listing's ([{ url, alt? }], cover first) */
      photos: venuePhotos({ photos, imageUrl: v.imageUrl }, listing),
      /** Terms for hiring the venue on Omoshow; null when it isn't taking bookings */
      listing: publicListing(listing, v),
      verified: !!v.verifiedAt,
      managed: _count.claims > 0,
      eventsHosted: _count.events,
      followers: _count.followers,
      layout: this.layoutInfo({ layout }),
      // Multiple dates: the next date and how many are still to come ("+N more dates"), like event list items.
      events: events.map(({ ticketTypes, dates, ...e }) => {
        const now = new Date();
        return {
          ...e,
          fromCents: ticketTypes.length ? Math.min(...ticketTypes.map((t) => t.priceCents)) : 0,
          nextDate: nextDateView(e.dateMode, dates, now),
          dateCount: e.dateMode === 'SINGLE' ? 0 : dates.filter((d) => d.startsAt >= now).length,
        };
      }),
    };
  }

  async officialLayout(slug: string) {
    const v = await this.prisma.venue.findUnique({ where: { slug }, select: { name: true, layout: true, hiddenAt: true } });
    if (!v || v.hiddenAt || !v.layout) throw new NotFoundException('This venue has no official layout yet.');
    return { venue: v.name, layout: v.layout, ...this.layoutInfo(v) };
  }

  /* ----- claims and managers ----- */

  async claim(slug: string, user: AuthUser, dto: ClaimDto) {
    const v = await this.prisma.venue.findUnique({ where: { slug } });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    const existing = await this.prisma.venueClaim.findUnique({ where: { venueId_userId: { venueId: v.id, userId: user.id } } });
    if (existing?.status === 'APPROVED') throw new BadRequestException('You already manage this venue.');
    if (existing?.status === 'PENDING') throw new BadRequestException('Your request is already with our team.');
    // A claim on a page that's already public: approving it never changes whether the venue is shown.
    const data = { role: dto.role, message: dto.message.trim(), website: dto.website ?? null, status: 'PENDING', newVenue: false, note: null, decidedBy: null, decidedAt: null };
    const c = existing
      ? await this.prisma.venueClaim.update({ where: { id: existing.id }, data })
      : await this.prisma.venueClaim.create({ data: { ...data, venueId: v.id, userId: user.id } });
    await this.audit.log(user.id, 'venue.claim', 'Venue', v.id, { role: dto.role });
    return { id: c.id, status: c.status };
  }

  /**
   * Adds a venue that isn't on Omoshow yet (POST /me/venues). It's created hidden, in its place's time zone, with a
   * PENDING claim marked `newVenue` for this person; approving the claim shows it. A visible venue with the same
   * name in the same city and country is refused with 409 VENUE_EXISTS, so the person can claim that one instead.
   */
  async onboard(user: AuthUser, dto: OnboardVenueDto) {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const city = dto.city.trim().replace(/\s+/g, ' ');
    const country = dto.country.toUpperCase();
    if (name.length < 2) throw new BadRequestException('Give the venue’s name.');
    if (city.length < 2) throw new BadRequestException('Give the city.');
    const same = await this.prisma.venue.findFirst({
      where: { hiddenAt: null, name: { equals: name, mode: 'insensitive' }, city: { equals: city, mode: 'insensitive' }, OR: [{ country }, { country: null }] },
      select: { slug: true, name: true, city: true, address: true },
    });
    if (same) {
      throw new ConflictException({
        statusCode: 409,
        code: 'VENUE_EXISTS',
        message: `${same.name} in ${same.city} is already on Omoshow. If it’s yours, claim it instead of adding it again.`,
        venue: same,
      });
    }
    const waiting = await this.prisma.venueClaim.findMany({
      where: { userId: user.id, status: 'PENDING', newVenue: true },
      select: { venue: { select: { name: true, city: true } } },
    });
    if (waiting.some((w) => w.venue.name.toLowerCase() === name.toLowerCase() && w.venue.city.toLowerCase() === city.toLowerCase())) {
      throw new BadRequestException(`You’ve already asked to add ${name}. Our team will get back to you, usually within a day.`);
    }
    if (waiting.length >= MAX_WAITING_NEW) throw new BadRequestException('You have several venues waiting for approval already. Wait for our team to get back to you first.');

    // A venue page needs at least one photo of the place.
    const photos = photoRows(dto.photos?.length ? dto.photos : dto.imageUrl ? [dto.imageUrl] : []);
    if (!photos.length) throw new BadRequestException('Add at least one photo of the venue.');
    const region = dto.region?.trim() || null;
    const { venue, claim } = await this.prisma.$transaction(async (tx) => {
      const venue = await tx.venue.create({
        data: {
          slug: `${slugify(name) || 'venue'}-${randomSuffix()}`,
          name,
          address: dto.address.trim(),
          city,
          region,
          country,
          postalCode: dto.postalCode?.trim() || null,
          timezone: placeTimezone(country, region),
          capacity: dto.capacity ?? null,
          phone: dto.phone?.trim() || null,
          website: dto.website || null,
          imageUrl: photos[0].url,
          photos,
          about: dto.about?.trim() || null,
          // Not public or bookable until Omoshow approves the claim below.
          hiddenAt: new Date(),
        },
      });
      const claim = await tx.venueClaim.create({
        data: { venueId: venue.id, userId: user.id, role: dto.role, message: dto.message.trim(), website: dto.website ?? null, status: 'PENDING', newVenue: true },
      });
      return { venue, claim };
    });
    await this.audit.log(user.id, 'venue.onboard', 'Venue', venue.id, { claimId: claim.id, role: dto.role });
    return { id: claim.id, status: claim.status, newVenue: true, venue: { id: venue.id, slug: venue.slug, name: venue.name, city: venue.city } };
  }

  /** Approved claims (venues I manage) and my other requests. */
  async mine(user: AuthUser) {
    const claims = await this.prisma.venueClaim.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { venue: { include: { listing: { select: { active: true, instantBook: true } } } } },
    });
    const managedIds = claims.filter((c) => c.status === 'APPROVED' && !c.venue.hiddenAt).map((c) => c.venueId);
    const waiting = managedIds.length
      ? await this.prisma.venueBooking.groupBy({ by: ['venueId'], where: { venueId: { in: managedIds }, status: 'PENDING', holdUntil: { gt: new Date() } }, _count: { _all: true } })
      : [];
    const pendingOf = new Map(waiting.map((w) => [w.venueId, w._count._all]));
    return {
      managed: claims
        .filter((c) => c.status === 'APPROVED' && !c.venue.hiddenAt)
        .map((c) => {
          const { layout, listing, ...v } = c.venue;
          return {
            role: c.role,
            venue: { ...v, verified: !!v.verifiedAt, layout: this.layoutInfo({ layout }) },
            /** Hiring on Omoshow: whether it's listed, and requests waiting for an answer */
            listing: listing ? { active: listing.active, instantBook: listing.instantBook } : null,
            pendingBookings: pendingOf.get(c.venueId) ?? 0,
          };
        }),
      requests: claims
        .filter((c) => c.status !== 'APPROVED')
        .map((c) => ({
          id: c.id,
          status: c.status,
          role: c.role,
          note: c.note,
          createdAt: c.createdAt,
          decidedAt: c.decidedAt,
          /** they added this venue themselves; while it's waiting it's hidden, so don't link to its page */
          newVenue: c.newVenue,
          venue: { id: c.venue.id, slug: c.venue.slug, name: c.venue.name, city: c.venue.city, address: c.venue.address, country: c.venue.country, hidden: !!c.venue.hiddenAt },
        })),
    };
  }

  private async manageable(id: string, user: AuthUser) {
    const v = await this.prisma.venue.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found.');
    if (user.roles.includes('ADMIN')) return v;
    const c = await this.prisma.venueClaim.findUnique({ where: { venueId_userId: { venueId: id, userId: user.id } } });
    if (c?.status !== 'APPROVED') throw new ForbiddenException('Only this venue’s managers can change it.');
    return v;
  }

  private managerData(dto: ManagerVenueDto): Prisma.VenueUpdateInput {
    return {
      ...(dto.about !== undefined ? { about: dto.about.trim() || null } : {}),
      // The gallery wins over a single photo; its first photo is the cover.
      ...(dto.photos !== undefined
        ? { photos: dto.photos.length ? photoRows(dto.photos) : Prisma.DbNull, imageUrl: photoRows(dto.photos)[0]?.url ?? null }
        : dto.imageUrl !== undefined
          ? { imageUrl: dto.imageUrl || null }
          : {}),
      ...(dto.website !== undefined ? { website: dto.website || null } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
      ...(dto.address !== undefined ? { address: dto.address.trim() } : {}),
      ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode.trim() || null } : {}),
    };
  }

  async managerUpdate(id: string, user: AuthUser, dto: ManagerVenueDto) {
    await this.manageable(id, user);
    const v = await this.prisma.venue.update({ where: { id }, data: this.managerData(dto) });
    await this.audit.log(user.id, 'venue.update', 'Venue', id, { fields: Object.keys(dto) });
    const { layout, ...rest } = v;
    return { ...rest, layout: this.layoutInfo({ layout }) };
  }

  /** Saves the official layout. Ticket type ids in it are placeholders; organizers' tiers are matched by priority. */
  async saveLayout(id: string, user: AuthUser, raw: Record<string, unknown>) {
    await this.manageable(id, user);
    const sections = Array.isArray((raw as { sections?: unknown }).sections) ? ((raw as { sections: { ticketTypeId?: unknown }[] }).sections) : [];
    const ids = new Set(sections.map((s) => String(s?.ticketTypeId ?? '')));
    const result = validateSeatMap(raw, ids);
    if (!result.ok) throw new BadRequestException({ message: 'That layout has problems.', errors: result.errors });
    const places = result.map.sections.reduce((n, s) => n + sectionCapacity(s), 0);
    await this.prisma.venue.update({ where: { id }, data: { layout: result.map as unknown as Prisma.InputJsonValue, capacity: places } });
    await this.audit.log(user.id, 'venue.layout', 'Venue', id, { sections: result.map.sections.length, places });
    return { sections: result.map.sections.length, places };
  }

  /* ----- admin ----- */

  async adminList(q?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = (q ?? '').trim().slice(0, 100);
    const where: Prisma.VenueWhereInput = {
      ...(s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { city: { contains: s, mode: 'insensitive' } }, { address: { contains: s, mode: 'insensitive' } }] } : {}),
      ...(status === 'verified' ? { verifiedAt: { not: null }, hiddenAt: null } : {}),
      ...(status === 'unverified' ? { verifiedAt: null, hiddenAt: null } : {}),
      ...(status === 'hidden' ? { hiddenAt: { not: null } } : {}),
      ...(status === 'claimed' ? { claims: { some: { status: 'APPROVED' } } } : {}),
    };
    if (status === 'duplicates') {
      // Venues sharing a name word in the same city: likely the same place typed twice.
      const all = await this.prisma.venue.findMany({ where: { hiddenAt: null }, select: { id: true, name: true, city: true } });
      const dup = new Set<string>();
      for (const a of all)
        for (const b of all)
          if (a.id < b.id && a.city.toLowerCase() === b.city.toLowerCase() && words(a.name).some((w) => words(b.name).includes(w))) {
            dup.add(a.id);
            dup.add(b.id);
          }
      where.id = { in: [...dup] };
    }
    const [total, rows] = await Promise.all([
      this.prisma.venue.count({ where }),
      this.prisma.venue.findMany({
        where,
        orderBy: status === 'duplicates' ? [{ city: 'asc' }, { name: 'asc' }] : { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { _count: { select: { events: true, claims: { where: { status: 'APPROVED' } } } } },
      }),
    ]);
    // Hidden because an owner added them and their claim is still waiting, not hidden by Omoshow.
    const hiddenIds = rows.filter((v) => v.hiddenAt).map((v) => v.id);
    const awaiting = new Set(
      hiddenIds.length ? (await this.prisma.venueClaim.findMany({ where: { venueId: { in: hiddenIds }, newVenue: true, status: 'PENDING' }, select: { venueId: true } })).map((c) => c.venueId) : [],
    );
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map(({ layout, _count, ...v }) => ({ ...v, events: _count.events, managers: _count.claims, awaitingApproval: awaiting.has(v.id), layout: this.layoutInfo({ layout }) })),
    };
  }

  async adminUpdate(id: string, admin: AuthUser, dto: AdminVenueDto) {
    const v = await this.prisma.venue.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found.');
    const data: Prisma.VenueUpdateInput = {
      ...this.managerData(dto),
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.city !== undefined ? { city: dto.city.trim() } : {}),
      ...(dto.region !== undefined ? { region: dto.region.trim() || null } : {}),
      ...(dto.country !== undefined ? { country: dto.country.toUpperCase() } : {}),
      ...(dto.lat !== undefined ? { lat: dto.lat } : {}),
      ...(dto.lng !== undefined ? { lng: dto.lng } : {}),
      ...(dto.verified !== undefined ? { verifiedAt: dto.verified ? (v.verifiedAt ?? new Date()) : null } : {}),
      ...(dto.hidden !== undefined ? { hiddenAt: dto.hidden ? (v.hiddenAt ?? new Date()) : null } : {}),
    };
    const out = await this.prisma.venue.update({ where: { id }, data });
    await this.audit.log(admin.id, dto.verified === true ? 'venue.verify' : dto.hidden === true ? 'venue.hide' : 'venue.admin_update', 'Venue', id, { fields: Object.keys(dto) });
    const { layout, ...rest } = out;
    return { ...rest, layout: this.layoutInfo({ layout }) };
  }

  async duplicates(id: string) {
    const v = await this.prisma.venue.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found.');
    const mine = words(v.name);
    const d = 0.003; // ~300 m
    const candidates = await this.prisma.venue.findMany({
      where: {
        id: { not: id },
        hiddenAt: null,
        OR: [
          { city: { equals: v.city, mode: 'insensitive' } },
          ...(v.lat !== null && v.lng !== null ? [{ lat: { gte: v.lat - d, lte: v.lat + d }, lng: { gte: v.lng - d, lte: v.lng + d } }] : []),
        ],
      },
      include: { _count: { select: { events: true } } },
      take: 50,
    });
    return candidates
      .filter((c) => words(c.name).some((w) => mine.includes(w)))
      .map(({ layout, _count, ...c }) => ({ ...c, events: _count.events, layout: this.layoutInfo({ layout }) }));
  }

  /** Moves everything from `id` into `intoId` and deletes `id`. Missing details are filled in from the one removed. */
  async merge(id: string, intoId: string, admin: AuthUser) {
    if (id === intoId) throw new BadRequestException('Pick a different venue to merge into.');
    const [from, into] = await Promise.all([this.prisma.venue.findUnique({ where: { id } }), this.prisma.venue.findUnique({ where: { id: intoId } })]);
    if (!from || !into) throw new NotFoundException('Venue not found.');
    const moved = await this.prisma.$transaction(async (tx) => {
      const events = await tx.event.updateMany({ where: { venueId: id }, data: { venueId: intoId } });
      // Claims: keep the kept venue's claim when someone claimed both.
      const theirs = await tx.venueClaim.findMany({ where: { venueId: id } });
      for (const c of theirs) {
        const clash = await tx.venueClaim.findUnique({ where: { venueId_userId: { venueId: intoId, userId: c.userId } } });
        if (clash) await tx.venueClaim.delete({ where: { id: c.id } });
        else await tx.venueClaim.update({ where: { id: c.id }, data: { venueId: intoId } });
      }
      // Bookings and blocked times move too; the kept venue's listing wins when both have one.
      await tx.venueBooking.updateMany({ where: { venueId: id }, data: { venueId: intoId } });
      await tx.venueBlackout.updateMany({ where: { venueId: id }, data: { venueId: intoId } });
      if (!(await tx.venueListing.findUnique({ where: { venueId: intoId }, select: { venueId: true } }))) {
        await tx.venueListing.updateMany({ where: { venueId: id }, data: { venueId: intoId } });
      }
      await tx.venue.update({
        where: { id: intoId },
        data: {
          about: into.about ?? from.about,
          imageUrl: into.imageUrl ?? from.imageUrl,
          website: into.website ?? from.website,
          phone: into.phone ?? from.phone,
          capacity: into.capacity ?? from.capacity,
          layout: (into.layout ?? from.layout ?? undefined) as Prisma.InputJsonValue | undefined,
          lat: into.lat ?? from.lat,
          lng: into.lng ?? from.lng,
          verifiedAt: into.verifiedAt ?? from.verifiedAt,
        },
      });
      await tx.venue.delete({ where: { id } });
      return events.count;
    });
    await this.audit.log(admin.id, 'venue.merge', 'Venue', intoId, { removed: id, removedName: from.name, events: moved });
    return { kept: intoId, removed: id, eventsMoved: moved };
  }

  async claims(status = 'PENDING', pageRaw?: string) {
    const page = pageOf(pageRaw);
    const where: Prisma.VenueClaimWhereInput = ['PENDING', 'APPROVED', 'REJECTED', 'REVOKED'].includes(status) ? { status } : {};
    const [total, items] = await Promise.all([
      this.prisma.venueClaim.count({ where }),
      this.prisma.venueClaim.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          // The whole venue, so a claim for a venue the person added themselves (newVenue) can be checked before it goes public.
          venue: {
            select: {
              id: true,
              slug: true,
              name: true,
              address: true,
              city: true,
              region: true,
              country: true,
              postalCode: true,
              capacity: true,
              phone: true,
              website: true,
              imageUrl: true,
              about: true,
              verifiedAt: true,
              hiddenAt: true,
            },
          },
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    return { total, page, pageSize: PAGE, items };
  }

  async decide(id: string, admin: AuthUser, dto: ClaimDecisionDto) {
    const c = await this.prisma.venueClaim.findUnique({ where: { id }, include: { venue: true, user: true } });
    if (!c) throw new NotFoundException('Request not found.');
    if (dto.decision === 'REVOKE' ? c.status !== 'APPROVED' : c.status !== 'PENDING') throw new BadRequestException('That request has already been decided.');
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : dto.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
    const decidedAt = new Date();
    // A venue the claimant added themselves goes public when their claim is approved; declined, it stays hidden.
    // Venues hidden by Omoshow (no newVenue claim) are left as they are.
    const show = status === 'APPROVED' && c.newVenue && !!c.venue.hiddenAt;
    const out = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.venueClaim.update({ where: { id }, data: { status, note: dto.note?.trim() || null, decidedBy: admin.id, decidedAt } });
      if (show) await tx.venue.update({ where: { id: c.venueId }, data: { hiddenAt: null } });
      return claim;
    });
    await this.audit.log(admin.id, `venue_claim.${status.toLowerCase()}`, 'VenueClaim', id, { venueId: c.venueId, userId: c.userId, newVenue: c.newVenue, venueShown: show });
    if (status !== 'REVOKED') void this.notifyDecision(c, status === 'APPROVED', dto.note?.trim() || null, decidedAt);
    return { ...out, venueShown: show };
  }

  /** The claimant hears about the decision by email and push (push choice "orders"). Never throws. */
  private async notifyDecision(c: { id: string; venueId: string; newVenue: boolean; venue: Venue; user: { id: string; email: string } }, approved: boolean, note: string | null, decidedAt: Date) {
    const kind = `venue_claim.${approved ? 'approved' : 'rejected'}`;
    const name = c.venue.name;
    const path = approved ? '/venues/manage' : '/venues/list';
    try {
      const { html, text } = render({
        preheader: approved ? (c.newVenue ? `${name} is now on Omoshow, and you manage it.` : `You now manage ${name} on Omoshow.`) : `About your request for ${name}.`,
        heading: approved ? (c.newVenue ? `${name} is on Omoshow` : `You now manage ${name}`) : c.newVenue ? `We couldn’t add ${name} yet` : `We couldn’t confirm you manage ${name}`,
        paragraphs: approved
          ? [
              ...(c.newVenue ? [`We checked your details, so ${name} now has its own page on Omoshow and you manage it.`] : []),
              'You can keep the venue’s details, photo and official seat layout up to date. Organizers booking it will start from your layout.',
              'To get booked by organizers, list it for hire: set your price, opening hours and any blocked-out time. Requests wait up to 48 hours for your answer, and payment is arranged directly between you and the organizer.',
            ]
          : [note || (c.newVenue ? 'We couldn’t check that you run this venue. Reply with something we can verify, like an email at the venue’s domain or a link to its official page.' : 'We couldn’t check that you work at this venue. Reply with something we can verify, like an email at the venue’s domain.')],
        cta: approved ? { label: 'Set up your venue', url: `${config.webUrl}${path}` } : { label: 'Try again', url: `${config.webUrl}${path}` },
        footer: c.newVenue ? 'You asked to add a venue to Omoshow.' : 'You asked to manage a venue page on Omoshow.',
      });
      void this.mail.send(kind, { to: c.user.email, subject: approved ? (c.newVenue ? `${name} is on Omoshow` : `You now manage ${name}`) : `Your request for ${name}`, html, text });
      await this.push.send(kind, 'orders', [
        {
          userId: c.user.id,
          title: approved ? (c.newVenue ? `${name} is on Omoshow` : `You now manage ${name}`) : `About your request for ${name}`,
          body: approved ? 'You’re approved. List it for hire: set your price, hours and blocked-out time.' : (note ?? 'We couldn’t confirm it yet. Open Omoshow to see why and try again.'),
          data: { url: `eventro:/${path}`, path, type: kind, claimId: c.id, venueId: c.venueId },
          dedupeKey: `${kind}:${c.id}:${decidedAt.getTime()}`,
        },
      ]);
    } catch (e) {
      this.log.warn(`${kind} ${c.id}: ${(e as Error).message}`);
    }
  }
}

/* ---------- routes ---------- */

@ApiTags('venues')
@Controller()
export class VenueDirectoryController {
  constructor(private readonly venues: VenuesService) {}

  /** Every visible venue; with `q` (2+ characters), up to 20 matches to claim (optionally in a country or city). */
  @ApiQuery({ name: 'q', required: false, description: 'Name, address or city (2+ characters)' })
  @ApiQuery({ name: 'country', required: false, description: 'ISO 3166-1 alpha-2, with q' })
  @ApiQuery({ name: 'city', required: false, description: 'With q' })
  @Public()
  @Get('venues')
  list(@Query('q') q?: string, @Query('country') country?: string, @Query('city') city?: string) {
    return q !== undefined ? this.venues.find(q, country, city) : this.venues.list();
  }
  @Public() @Get('venues/:slug') one(@Param('slug') slug: string) {
    return this.venues.one(slug);
  }
  @Public() @Get('venues/:slug/layout') layout(@Param('slug') slug: string) {
    return this.venues.officialLayout(slug);
  }

  @ApiBearerAuth() @Post('venues/:slug/claims') claim(@Param('slug') slug: string, @CurrentUser() u: AuthUser, @Body() dto: ClaimDto) {
    return this.venues.claim(slug, u, dto);
  }
  /** Add a venue that isn't on Omoshow yet: hidden, with a pending claim, until Omoshow approves it. */
  @ApiBearerAuth() @Post('me/venues') onboard(@CurrentUser() u: AuthUser, @Body() dto: OnboardVenueDto) {
    return this.venues.onboard(u, dto);
  }
  @ApiBearerAuth() @Get('me/venues') mine(@CurrentUser() u: AuthUser) {
    return this.venues.mine(u);
  }
  @ApiBearerAuth() @Patch('me/venues/:id') update(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ManagerVenueDto) {
    return this.venues.managerUpdate(id, u, dto);
  }
  @ApiBearerAuth() @Put('me/venues/:id/layout') saveLayout(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: LayoutDto) {
    return this.venues.saveLayout(id, u, dto.layout);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminVenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get('venues') list(@Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.venues.adminList(q, status, page);
  }
  @Patch('venues/:id') update(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: AdminVenueDto) {
    return this.venues.adminUpdate(id, u, dto);
  }
  @Get('venues/:id/duplicates') duplicates(@Param('id') id: string) {
    return this.venues.duplicates(id);
  }
  @Post('venues/:id/merge') @HttpCode(200) merge(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: MergeDto) {
    return this.venues.merge(id, dto.intoId, u);
  }
  @Get('venue-claims') claims(@Query('status') status?: string, @Query('page') page?: string) {
    return this.venues.claims(status, page);
  }
  @Post('venue-claims/:id/decide') @HttpCode(200) decide(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ClaimDecisionDto) {
    return this.venues.decide(id, u, dto);
  }
}

@Module({
  // The booking routes go first: `venues/:slug/availability` is more specific than the directory's routes.
  controllers: [VenueBookingPublicController, VenueManagerBookingsController, OrganizerBookingsController, VenueDirectoryController, AdminVenuesController],
  providers: [VenuesService, VenueBookingService],
  exports: [VenueBookingService],
})
export class VenuesModule {}
