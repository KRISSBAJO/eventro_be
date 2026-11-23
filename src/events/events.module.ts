import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InventoryService } from '../common/inventory.service';
import { OptionalAuth, Public } from '../common/auth';
import type { SeatMap } from '../domain/seatmap';

const CATEGORIES = Object.values(Category);

export class EventQueryDto {
  @ApiPropertyOptional({ description: 'Search title, subtitle, venue and city' }) @IsOptional() @IsString() @MaxLength(80) q?: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) @IsOptional() @IsIn(CATEGORIES) category?: Category;
  @ApiPropertyOptional({ example: 'London' }) @IsOptional() @IsString() @MaxLength(60) city?: string;
  @ApiPropertyOptional({ description: 'ISO date, inclusive' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ description: 'ISO date, inclusive' }) @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ description: 'Maximum lowest price, in dollars' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxPrice?: number;
  @ApiPropertyOptional({ enum: ['date', 'price-asc', 'price-desc'] }) @IsOptional() @IsIn(['date', 'price-asc', 'price-desc']) sort?: string;
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
  @ApiProperty({ description: 'Lowest all-in price in cents' }) fromCents: number;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async search(q: EventQueryDto) {
    const where: Prisma.EventWhereInput = {
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      startsAt: { gte: q.from ? new Date(q.from) : new Date(), ...(q.to ? { lte: new Date(`${q.to.slice(0, 10)}T23:59:59Z`) } : {}) },
      ...(q.category ? { category: q.category } : {}),
      ...(q.city ? { venue: { city: { equals: q.city, mode: 'insensitive' } } } : {}),
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
      include: { venue: true, ticketTypes: { select: { priceCents: true } } },
      orderBy: { startsAt: 'asc' },
      take: 1000,
    });
    let cards: EventCardDto[] = rows
      .filter((e) => e.ticketTypes.length)
      .map((e) => ({
        slug: e.slug,
        title: e.title,
        subtitle: e.subtitle,
        category: e.category,
        startsAt: e.startsAt,
        imageUrl: e.imageUrl,
        venue: e.venue?.name ?? (e.online ? 'Online' : null),
        city: e.venue?.city ?? null,
        fromCents: Math.min(...e.ticketTypes.map((t) => t.priceCents)),
      }));
    if (q.maxPrice !== undefined) cards = cards.filter((c) => c.fromCents <= q.maxPrice! * 100);
    if (q.sort === 'price-asc') cards.sort((a, b) => a.fromCents - b.fromCents);
    if (q.sort === 'price-desc') cards.sort((a, b) => b.fromCents - a.fromCents);
    const page = q.page ?? 1;
    const size = q.pageSize ?? 24;
    return { total: cards.length, page, pageSize: size, items: cards.slice((page - 1) * size, page * size) };
  }

  async detail(slug: string) {
    const e = await this.prisma.event.findUnique({
      where: { slug },
      include: { venue: true, org: { select: { name: true } }, ticketTypes: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!e || e.status !== 'PUBLISHED') throw new NotFoundException('Event not found.');
    const avail = await this.inventory.availabilityForEvent(e.id);
    const map = e.seatMap as SeatMap | null;
    const sectionAvail = map ? await this.inventory.availabilityForSections(this.prisma, e.id, map) : null;
    return {
      id: e.id,
      slug: e.slug,
      title: e.title,
      subtitle: e.subtitle,
      description: e.description,
      category: e.category,
      imageUrl: e.imageUrl,
      startsAt: e.startsAt,
      doorsAt: e.doorsAt,
      endsAt: e.endsAt,
      timezone: e.timezone,
      online: e.online,
      salesPaused: e.salesPaused,
      presentedBy: e.org.name,
      venue: e.venue && { slug: e.venue.slug, name: e.venue.name, address: e.venue.address, city: e.venue.city, lat: e.venue.lat, lng: e.venue.lng },
      ticketTypes: e.ticketTypes.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        maxPerOrder: t.maxPerOrder,
        available: avail.get(t.id) ?? 0,
      })),
      seatMap: map && {
        ...map,
        sections: map.sections.map((s) => ({ ...s, available: sectionAvail?.get(s.id) ?? 0 })),
      },
    };
  }
}

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  search(@Query() q: EventQueryDto) {
    return this.events.search(q);
  }

  @OptionalAuth()
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.events.detail(slug);
  }
}

@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  list() {
    return this.prisma.venue.findMany({ orderBy: [{ city: 'asc' }, { name: 'asc' }], select: { slug: true, name: true, city: true, address: true, capacity: true, lat: true, lng: true } });
  }

  @Public()
  @Get(':slug')
  async one(@Param('slug') slug: string) {
    const v = await this.prisma.venue.findUnique({
      where: { slug },
      include: {
        events: {
          where: { status: 'PUBLISHED', visibility: 'PUBLIC', startsAt: { gte: new Date() } },
          orderBy: { startsAt: 'asc' },
          select: { slug: true, title: true, subtitle: true, startsAt: true, imageUrl: true },
        },
      },
    });
    if (!v) throw new NotFoundException('Venue not found.');
    return v;
  }
}

@Module({
  controllers: [EventsController, VenuesController],
  providers: [EventsService],
})
export class EventsModule {}
