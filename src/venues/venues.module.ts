/**
 * The venue directory.
 *
 * Venues are added by organizers when they create an event (the same place is reused, see OrganizerService), kept
 * tidy by Eventro admins (edit, verify, hide, merge duplicates), and kept up to date by venue managers: people at
 * the venue who claimed its page and were approved. Managers and admins can save an official seat layout, which
 * organizers then start from.
 *
 * Public:   GET /venues, GET /venues/:slug, GET /venues/:slug/layout
 * Signed in: POST /venues/:slug/claims, GET /me/venues, PATCH /me/venues/:id, PUT /me/venues/:id/layout
 * Hiring a venue (listing, availability, booking requests): see venue-bookings.ts.
 * Admin:    GET /admin/venues, PATCH /admin/venues/:id, GET /admin/venues/:id/duplicates, POST /admin/venues/:id/merge,
 *           GET /admin/venue-claims, POST /admin/venue-claims/:id/decide
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Prisma, Venue } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { CurrentUser, Public, Roles, type AuthUser } from '../common/auth';
import { MailService, render } from '../mail/mail.module';
import { sectionCapacity, validateSeatMap, type SeatMap } from '../domain/seatmap';
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

/** What a venue manager can change. */
export class ManagerVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) about?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500) imageUrl?: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
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
      select: { slug: true, name: true, city: true, address: true, capacity: true, lat: true, lng: true, imageUrl: true, verifiedAt: true },
    });
  }

  async one(slug: string) {
    const v = await this.prisma.venue.findUnique({
      where: { slug },
      include: {
        events: {
          where: { status: 'PUBLISHED', visibility: 'PUBLIC', startsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' },
          select: { slug: true, title: true, subtitle: true, startsAt: true, imageUrl: true, category: true, currency: true, ticketTypes: { select: { priceCents: true } } },
        },
        _count: { select: { claims: { where: { status: 'APPROVED' } }, events: true } },
        listing: true,
      },
    });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    const { layout, _count, events, listing, ...rest } = v;
    return {
      ...rest,
      /** Terms for hiring the venue on Eventro; null when it isn't taking bookings */
      listing: publicListing(listing, v),
      verified: !!v.verifiedAt,
      managed: _count.claims > 0,
      eventsHosted: _count.events,
      layout: this.layoutInfo({ layout }),
      events: events.map(({ ticketTypes, ...e }) => ({ ...e, fromCents: ticketTypes.length ? Math.min(...ticketTypes.map((t) => t.priceCents)) : 0 })),
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
    const data = { role: dto.role, message: dto.message.trim(), website: dto.website ?? null, status: 'PENDING', note: null, decidedBy: null, decidedAt: null };
    const c = existing
      ? await this.prisma.venueClaim.update({ where: { id: existing.id }, data })
      : await this.prisma.venueClaim.create({ data: { ...data, venueId: v.id, userId: user.id } });
    await this.audit.log(user.id, 'venue.claim', 'Venue', v.id, { role: dto.role });
    return { id: c.id, status: c.status };
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
            /** Hiring on Eventro: whether it's listed, and requests waiting for an answer */
            listing: listing ? { active: listing.active, instantBook: listing.instantBook } : null,
            pendingBookings: pendingOf.get(c.venueId) ?? 0,
          };
        }),
      requests: claims
        .filter((c) => c.status !== 'APPROVED')
        .map((c) => ({ id: c.id, status: c.status, role: c.role, note: c.note, createdAt: c.createdAt, venue: { slug: c.venue.slug, name: c.venue.name, city: c.venue.city } })),
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
      ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl || null } : {}),
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
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map(({ layout, _count, ...v }) => ({ ...v, events: _count.events, managers: _count.claims, layout: this.layoutInfo({ layout }) })),
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
        include: { venue: { select: { id: true, slug: true, name: true, city: true, verifiedAt: true } }, user: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    return { total, page, pageSize: PAGE, items };
  }

  async decide(id: string, admin: AuthUser, dto: ClaimDecisionDto) {
    const c = await this.prisma.venueClaim.findUnique({ where: { id }, include: { venue: true, user: true } });
    if (!c) throw new NotFoundException('Request not found.');
    if (dto.decision === 'REVOKE' ? c.status !== 'APPROVED' : c.status !== 'PENDING') throw new BadRequestException('That request has already been decided.');
    const status = dto.decision === 'APPROVE' ? 'APPROVED' : dto.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
    const out = await this.prisma.venueClaim.update({ where: { id }, data: { status, note: dto.note?.trim() || null, decidedBy: admin.id, decidedAt: new Date() } });
    await this.audit.log(admin.id, `venue_claim.${status.toLowerCase()}`, 'VenueClaim', id, { venueId: c.venueId, userId: c.userId });
    if (status !== 'REVOKED') {
      const approved = status === 'APPROVED';
      const { html, text } = render({
        preheader: approved ? `You now manage ${c.venue.name} on Eventro.` : `About your request to manage ${c.venue.name}.`,
        heading: approved ? `You now manage ${c.venue.name}` : `We couldn’t confirm you manage ${c.venue.name}`,
        paragraphs: approved
          ? ['You can now keep the venue’s details, photo and official seat layout up to date. Organizers booking it will start from your layout.']
          : [dto.note?.trim() || 'We couldn’t check that you work at this venue. Reply with something we can verify, like an email at the venue’s domain.'],
        ...(approved ? { cta: { label: 'Manage your venue', url: `${config.webUrl}/venues/manage` } } : {}),
        footer: 'You asked to manage a venue page on Eventro.',
      });
      void this.mail.send(`venue_claim.${status.toLowerCase()}`, { to: c.user.email, subject: approved ? `You now manage ${c.venue.name}` : `Your request for ${c.venue.name}`, html, text });
    }
    return out;
  }
}

/* ---------- routes ---------- */

@ApiTags('venues')
@Controller()
export class VenueDirectoryController {
  constructor(private readonly venues: VenuesService) {}

  @Public() @Get('venues') list() {
    return this.venues.list();
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
