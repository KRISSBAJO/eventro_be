/**
 * Saved events: the hearts on event cards, kept on the server so they follow a fan between the website and the app.
 *
 *   GET    /me/saved               the signed-in fan's saved events as event cards (GET /events items), newest saved first
 *   PUT    /me/saved/:eventId      save one (idempotent); the event's id or slug
 *   DELETE /me/saved/:eventId      forget one (idempotent)
 *   POST   /me/saved/sync          merge hearts made while signed out { eventIds: (id or slug)[] }, at most 200
 *
 * Only published, public events can be saved or come back in the list: drafts, events in review, taken down,
 * cancelled or unlisted ones are never shown (a save made earlier stays in the table and reappears if the event
 * is published again). Events that have already started drop off the list, like GET /events.
 */
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { LIVE_TYPE, dateRangeWhere } from '../domain/event-dates';
import { CurrentUser, type AuthUser } from '../common/auth';
import { EventsModule, EventsService } from '../events/events.module';

/** Most saves kept per account (a heart is cheap; this only stops abuse). */
export const SAVED_MAX = 500;
const SYNC_MAX = 200;

export class SyncSavedDto {
  @ApiProperty({ type: [String], maxItems: SYNC_MAX, description: 'Event ids or slugs saved on this device while signed out' })
  @IsArray()
  @ArrayMaxSize(SYNC_MAX)
  @IsString({ each: true })
  @MaxLength(160, { each: true })
  eventIds: string[];
}

/** What a fan may see: published and listed publicly. */
const VISIBLE: Prisma.EventWhereInput = { status: 'PUBLISHED', visibility: 'PUBLIC' };

@Injectable()
export class SavedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  /** Visible events matching ids or slugs. */
  private visible(keys: string[]) {
    const k = [...new Set(keys.map((s) => s.trim()).filter(Boolean))];
    if (!k.length) return Promise.resolve([] as { id: string; slug: string }[]);
    return this.prisma.event.findMany({ where: { ...VISIBLE, OR: [{ id: { in: k } }, { slug: { in: k } }] }, select: { id: true, slug: true } });
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.savedEvent.findMany({
      // Upcoming: the event's own date, or (multiple dates, multi-day) any active date still to come.
      where: { userId: user.id, event: { ...VISIBLE, ...dateRangeWhere(new Date()) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: SAVED_MAX,
      include: { event: { include: { venue: true, ticketTypes: { where: LIVE_TYPE, select: { priceCents: true } } } } },
    });
    const events = rows.map((r) => r.event);
    return { ids: events.map((e) => e.id), slugs: events.map((e) => e.slug), items: await this.events.cards(events) };
  }

  async save(user: AuthUser, key: string) {
    const [e] = await this.visible([key]);
    if (!e) throw new NotFoundException('Event not found.');
    const had = await this.prisma.savedEvent.findUnique({ where: { userId_eventId: { userId: user.id, eventId: e.id } }, select: { id: true } });
    if (!had && (await this.prisma.savedEvent.count({ where: { userId: user.id } })) >= SAVED_MAX) {
      throw new BadRequestException(`You can save up to ${SAVED_MAX} events. Remove a few first.`);
    }
    // A second save of the same event (or a race between two devices) is a no-op.
    await this.prisma.savedEvent.createMany({ data: [{ userId: user.id, eventId: e.id }], skipDuplicates: true });
    return { saved: true, eventId: e.id, slug: e.slug };
  }

  /** Works for any event, even one no longer shown, so a fan can always take a heart back. */
  async unsave(user: AuthUser, key: string) {
    const e = await this.prisma.event.findFirst({ where: { OR: [{ id: key }, { slug: key }] }, select: { id: true, slug: true } });
    if (e) await this.prisma.savedEvent.deleteMany({ where: { userId: user.id, eventId: e.id } });
    return { saved: false, eventId: e?.id ?? null, slug: e?.slug ?? key };
  }

  /** Adds the device's hearts to the account's (unknown and hidden events are skipped), then answers like GET. */
  async sync(user: AuthUser, keys: string[]) {
    const found = await this.visible(keys);
    if (found.length) {
      const have = await this.prisma.savedEvent.count({ where: { userId: user.id } });
      const room = Math.max(0, SAVED_MAX - have);
      // Earlier hearts first, so the last one in the list ends up newest.
      const order = new Map(keys.map((k, i) => [k.trim(), i]));
      const ranked = found.map((e) => ({ e, i: Math.min(order.get(e.id) ?? Infinity, order.get(e.slug) ?? Infinity) })).sort((a, b) => a.i - b.i);
      const now = Date.now();
      await this.prisma.savedEvent.createMany({
        data: ranked.slice(0, room).map(({ e }, i) => ({ userId: user.id, eventId: e.id, createdAt: new Date(now + i) })),
        skipDuplicates: true,
      });
    }
    return this.list(user);
  }
}

@ApiTags('saved events')
@ApiBearerAuth()
@Controller('me/saved')
export class SavedController {
  constructor(private readonly saved: SavedService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.saved.list(user);
  }

  @Post('sync')
  @HttpCode(200)
  sync(@CurrentUser() user: AuthUser, @Body() dto: SyncSavedDto) {
    return this.saved.sync(user, dto.eventIds);
  }

  @Put(':eventId')
  save(@CurrentUser() user: AuthUser, @Param('eventId') eventId: string) {
    return this.saved.save(user, eventId);
  }

  @Delete(':eventId')
  unsave(@CurrentUser() user: AuthUser, @Param('eventId') eventId: string) {
    return this.saved.unsave(user, eventId);
  }
}

@Module({ imports: [EventsModule], controllers: [SavedController], providers: [SavedService] })
export class SavedModule {}
