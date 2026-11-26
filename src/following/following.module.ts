/**
 * Following organizers and venues. A fan follows from an organizer's page, a venue's page or an event page; their
 * new events then show up in Following, and a push goes out when one goes on sale (NoticeService.newEvent).
 *
 *   GET    /organizers/:slug                    public organizer page: name, about, followers, upcoming events (cards)
 *   GET    /me/following                        who the fan follows, with upcoming counts, and those events (cards)
 *   PUT    /me/following/organizers/:slug       follow (idempotent)
 *   DELETE /me/following/organizers/:slug       unfollow (idempotent)
 *   PUT    /me/following/venues/:slug           follow (idempotent)
 *   DELETE /me/following/venues/:slug           unfollow (idempotent)
 *
 * Organizer pages exist once an organizer has put an event on sale, and go away while it's suspended. Hidden venues
 * can't be followed; a follow made earlier stays and comes back if the venue is shown again.
 */
import { BadRequestException, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { LIVE_TYPE, dateRangeWhere } from '../domain/event-dates';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { EventsModule, EventsService, type EventCardDto } from '../events/events.module';

/** Most follows per account (organizers and venues together). */
export const FOLLOW_MAX = 500;
/** Events in the Following list. */
const FEED_MAX = 60;

const VISIBLE: Prisma.EventWhereInput = { status: 'PUBLISHED', visibility: 'PUBLIC' };
const upcoming = (): Prisma.EventWhereInput => ({ ...VISIBLE, ...dateRangeWhere(new Date()) });
/** An organizer with a public page: not suspended, and something put on sale at least once. */
const PUBLIC_ORG: Prisma.OrganizationWhereInput = { suspendedAt: null, events: { some: { publishedAt: { not: null }, visibility: 'PUBLIC' } } };
const CARD_INCLUDE = { venue: true, ticketTypes: { where: LIVE_TYPE, select: { priceCents: true } } } as const;

type Kind = 'organizers' | 'venues';

@Injectable()
export class FollowingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  /** Cards for events on sale, soonest first by the date fans can still go to. */
  private async cardsOf(where: Prisma.EventWhereInput, take: number) {
    const rows = await this.prisma.event.findMany({ where: { AND: [upcoming(), where] }, include: CARD_INCLUDE, orderBy: { startsAt: 'asc' }, take });
    const cards = await this.events.cards(rows.filter((e) => e.ticketTypes.length));
    const when = (c: EventCardDto) => (c.nextDate?.startsAt ?? c.startsAt).getTime();
    return { rows, cards: cards.sort((a, b) => when(a) - when(b)) };
  }

  async organizerPage(slug: string) {
    const o = await this.prisma.organization.findFirst({
      where: { slug, ...PUBLIC_ORG },
      select: { id: true, slug: true, name: true, about: true, website: true, logoUrl: true, coverUrl: true, verifiedAt: true, createdAt: true, _count: { select: { followers: true } } },
    });
    if (!o) throw new NotFoundException('Organizer not found.');
    const [{ cards }, hosted] = await Promise.all([
      this.cardsOf({ orgId: o.id }, 200),
      this.prisma.event.count({ where: { orgId: o.id, visibility: 'PUBLIC', publishedAt: { not: null }, status: { in: ['PUBLISHED', 'CANCELLED'] } } }),
    ]);
    return {
      slug: o.slug,
      name: o.name,
      about: o.about,
      website: o.website,
      logoUrl: o.logoUrl,
      // Their banner, else the cover of their next event.
      coverUrl: o.coverUrl ?? cards.find((c) => c.imageUrl)?.imageUrl ?? null,
      verified: !!o.verifiedAt,
      since: o.createdAt,
      followers: o._count.followers,
      eventsHosted: hosted,
      events: cards,
    };
  }

  /** Who the fan follows (newest first) with how many events each has on sale, and those events. */
  async list(user: AuthUser) {
    const rows = await this.prisma.follow.findMany({
      where: { userId: user.id, OR: [{ org: PUBLIC_ORG }, { venue: { hiddenAt: null } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FOLLOW_MAX,
      include: {
        org: { select: { id: true, slug: true, name: true, logoUrl: true, coverUrl: true, verifiedAt: true } },
        venue: { select: { id: true, slug: true, name: true, city: true, country: true, imageUrl: true, verifiedAt: true } },
      },
    });
    const orgIds = rows.flatMap((r) => (r.org ? [r.org.id] : []));
    const venueIds = rows.flatMap((r) => (r.venue ? [r.venue.id] : []));
    const { rows: evs, cards } =
      orgIds.length || venueIds.length
        ? await this.cardsOf({ OR: [...(orgIds.length ? [{ orgId: { in: orgIds } }] : []), ...(venueIds.length ? [{ venueId: { in: venueIds } }] : [])] }, 400)
        : { rows: [], cards: [] };
    const bySlug = new Map(evs.map((e) => [e.slug, e]));
    const count = (pick: (e: (typeof evs)[number]) => string | null) => {
      const m = new Map<string, number>();
      for (const c of cards) {
        const id = pick(bySlug.get(c.slug)!);
        if (id) m.set(id, (m.get(id) ?? 0) + 1);
      }
      return m;
    };
    const perOrg = count((e) => e.orgId);
    const perVenue = count((e) => e.venueId);
    const orgs = rows.flatMap((r) => (r.org ? [{ ...r.org, at: r.createdAt }] : []));
    const venues = rows.flatMap((r) => (r.venue ? [{ ...r.venue, at: r.createdAt }] : []));
    // A picture for each: an organizer's banner, else the cover of its soonest event; a venue its own photo, else that.
    const cover = new Map<string, string>();
    for (const c of cards) {
      const e = bySlug.get(c.slug)!;
      if (!c.imageUrl) continue;
      if (!cover.has(e.orgId)) cover.set(e.orgId, c.imageUrl);
      if (e.venueId && !cover.has(e.venueId)) cover.set(e.venueId, c.imageUrl);
    }
    const followedOrg = new Map(orgs.map((o) => [o.id, o]));
    const followedVenue = new Map(venues.map((v) => [v.id, v]));
    return {
      organizers: orgs.map((o) => ({ slug: o.slug, name: o.name, logoUrl: o.logoUrl, imageUrl: o.coverUrl ?? cover.get(o.id) ?? null, verified: !!o.verifiedAt, upcoming: perOrg.get(o.id) ?? 0, followedAt: o.at })),
      venues: venues.map((v) => ({ slug: v.slug, name: v.name, city: v.city, country: v.country, imageUrl: v.imageUrl ?? cover.get(v.id) ?? null, verified: !!v.verifiedAt, upcoming: perVenue.get(v.id) ?? 0, followedAt: v.at })),
      // Why each event is here: the organizer when the fan follows it, else the venue.
      events: cards.slice(0, FEED_MAX).map((c) => {
        const e = bySlug.get(c.slug)!;
        const o = followedOrg.get(e.orgId);
        const v = e.venueId ? followedVenue.get(e.venueId) : undefined;
        return { ...c, via: o ? { kind: 'organizer' as const, slug: o.slug, name: o.name } : { kind: 'venue' as const, slug: v!.slug, name: v!.name } };
      }),
    };
  }

  private async target(kind: Kind, slug: string) {
    if (kind === 'organizers') {
      const o = await this.prisma.organization.findFirst({ where: { slug, ...PUBLIC_ORG }, select: { id: true } });
      if (!o) throw new NotFoundException('Organizer not found.');
      return { orgId: o.id };
    }
    const v = await this.prisma.venue.findUnique({ where: { slug }, select: { id: true, hiddenAt: true } });
    if (!v || v.hiddenAt) throw new NotFoundException('Venue not found.');
    return { venueId: v.id };
  }

  private followers(t: { orgId?: string; venueId?: string }) {
    return this.prisma.follow.count({ where: t });
  }

  async follow(user: AuthUser, kind: Kind, slug: string) {
    const t = await this.target(kind, slug);
    const had = await this.prisma.follow.findFirst({ where: { userId: user.id, ...t }, select: { id: true } });
    if (!had && (await this.prisma.follow.count({ where: { userId: user.id } })) >= FOLLOW_MAX) {
      throw new BadRequestException(`You can follow up to ${FOLLOW_MAX} organizers and venues. Unfollow a few first.`);
    }
    // Following twice (or from two devices at once) is a no-op.
    if (!had) await this.prisma.follow.createMany({ data: [{ userId: user.id, ...t }], skipDuplicates: true });
    return { following: true, slug, followers: await this.followers(t) };
  }

  /** Works even for a page that's gone, so a fan can always unfollow. */
  async unfollow(user: AuthUser, kind: Kind, slug: string) {
    const t =
      kind === 'organizers'
        ? { orgId: (await this.prisma.organization.findUnique({ where: { slug }, select: { id: true } }))?.id }
        : { venueId: (await this.prisma.venue.findUnique({ where: { slug }, select: { id: true } }))?.id };
    const id = t.orgId ?? t.venueId;
    if (id) await this.prisma.follow.deleteMany({ where: { userId: user.id, ...t } });
    return { following: false, slug, followers: id ? await this.followers(t) : 0 };
  }
}

@ApiTags('following')
@Controller()
export class FollowingController {
  constructor(private readonly following: FollowingService) {}

  @Public()
  @Get('organizers/:slug')
  organizer(@Param('slug') slug: string) {
    return this.following.organizerPage(slug);
  }

  @ApiBearerAuth()
  @Get('me/following')
  list(@CurrentUser() user: AuthUser) {
    return this.following.list(user);
  }

  @ApiBearerAuth()
  @Put('me/following/:kind/:slug')
  follow(@CurrentUser() user: AuthUser, @Param('kind') kind: string, @Param('slug') slug: string) {
    return this.following.follow(user, this.kind(kind), slug);
  }

  @ApiBearerAuth()
  @Delete('me/following/:kind/:slug')
  unfollow(@CurrentUser() user: AuthUser, @Param('kind') kind: string, @Param('slug') slug: string) {
    return this.following.unfollow(user, this.kind(kind), slug);
  }

  private kind(k: string): Kind {
    if (k !== 'organizers' && k !== 'venues') throw new NotFoundException('Follow an organizer or a venue.');
    return k;
  }
}

@Module({ imports: [EventsModule], controllers: [FollowingController], providers: [FollowingService] })
export class FollowingModule {}
