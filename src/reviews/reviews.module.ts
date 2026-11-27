/**
 * Reviews. Someone who held a ticket to an event can rate it (1 to 5 stars, a few words) once it has ended, for 60
 * days: one review per person and event, which they can change or remove. Complimentary tickets and the organizer's
 * own team don't count. Reviews show on the event and add up to the organizer's rating (the average over all their
 * events' visible reviews).
 *
 * Organizers can reply to a review in public, but can't remove one. Anyone signed in can flag a review; an Omoshow
 * admin then keeps it or hides it with a reason. The day after an event ends, its ticket holders are asked once, by
 * email and push, how it was.
 *
 *   GET    /events/:slug/reviews                    the event's reviews, its summary, the organizer's rating, and (signed
 *                                                   in) your own review and whether you can write one
 *   PUT    /events/:slug/reviews                    { rating, body? }   write or change your review
 *   DELETE /events/:slug/reviews                    remove it
 *   POST   /reviews/:id/flag                        { reason, note? }
 *   GET    /organizers/:slug/reviews                the organizer's rating and latest reviews, across their events
 *   GET    /organizer/events/:id/reviews            the organizer's view (hidden ones marked)
 *   PUT    /organizer/events/:id/reviews/:rid/reply { reply }  ("" removes the reply)
 *   GET    /admin/event-reviews?status=FLAGGED|HIDDEN
 *   POST   /admin/event-reviews/:id/hide { reason } · /restore · /keep
 */
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Global, HttpCode, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Query, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { EventReview, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, OptionalAuth, Public, Roles, type AuthUser } from '../common/auth';
import { MailService, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import { ticketTimes } from '../domain/event-dates';
import { DOOR_ROLES, EDIT_ROLES, eventForRole } from '../organizer/access';

/** Reviews can be written for this long after the event ends. */
export const REVIEW_WINDOW_MS = 60 * 86_400_000;
/** Ticket holders are asked once, from this long after the end (and no later than a week after). */
export const ASK_AFTER_MS = 12 * 3600_000;
export const ASK_UNTIL_MS = 7 * 86_400_000;
export const FLAG_REASONS = ['SPAM', 'OFFENSIVE', 'FAKE', 'OTHER'] as const;
const PAGE = 20;

const tidy = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value;

class ReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) rating: number;
  @ApiPropertyOptional() @IsOptional() @Transform(tidy) @IsString() @MaxLength(1000) body?: string;
}
class FlagDto {
  @ApiProperty({ enum: FLAG_REASONS }) @IsIn(FLAG_REASONS) reason: (typeof FLAG_REASONS)[number];
  @ApiPropertyOptional() @IsOptional() @Transform(tidy) @IsString() @MaxLength(300) note?: string;
}
class ReplyDto {
  @ApiProperty({ description: 'Empty removes the reply' }) @Transform(tidy) @IsString() @MaxLength(1000) reply: string;
}
class HideDto {
  @ApiProperty() @Transform(tidy) @IsString() @MinLength(5) @MaxLength(300) reason: string;
}

/** "Fola Fan" → "Fola F." */
export const publicName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A fan';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

type Summary = { average: number | null; count: number; stars: [number, number, number, number, number] };

@Injectable()
export class ReviewService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Reviews');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /** Asking for reviews runs hourly (not in tests, which call `askAll` directly). */
  onModuleInit() {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => void this.askAll().catch((e) => this.log.warn(`Review requests: ${(e as Error).message}`)), 60 * 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------- reading ---------- */

  private async summary(where: Prisma.EventReviewWhereInput): Promise<Summary> {
    const rows = await this.prisma.eventReview.groupBy({ by: ['rating'], where: { ...where, status: 'VISIBLE' }, _count: { _all: true } });
    const stars: Summary['stars'] = [0, 0, 0, 0, 0];
    for (const r of rows) if (r.rating >= 1 && r.rating <= 5) stars[r.rating - 1] = r._count._all;
    const count = stars.reduce((a, b) => a + b, 0);
    return { average: count ? Math.round((stars.reduce((s, n, i) => s + n * (i + 1), 0) / count) * 10) / 10 : null, count, stars };
  }

  private view(r: EventReview, userId?: string | null) {
    return { id: r.id, rating: r.rating, body: r.body, name: r.authorName, createdAt: r.createdAt, edited: r.updatedAt.getTime() - r.createdAt.getTime() > 60_000, reply: r.reply, repliedAt: r.repliedAt, mine: !!userId && r.userId === userId };
  }

  /** When the tickets this account holds for the event are over (null: holds none that count), and the event. */
  private async standing(slug: string, user: AuthUser | null) {
    const ev = await this.prisma.event.findUnique({ where: { slug }, include: { dates: true, org: { select: { name: true } } } });
    if (!ev || (ev.status !== 'PUBLISHED' && ev.status !== 'CANCELLED')) throw new NotFoundException('Event not found.');
    if (!user) return { ev, canReview: false, reason: 'Sign in with the account that has your tickets to write a review.' };
    if (ev.status === 'CANCELLED') return { ev, canReview: false, reason: 'This event was cancelled.' };
    const team = await this.prisma.organizationMember.findFirst({ where: { orgId: ev.orgId, userId: user.id, status: 'ACTIVE' }, select: { id: true } });
    if (team) return { ev, canReview: false, reason: 'You’re on this event’s team, so you can’t review it.' };
    // Tickets bought (or registered for free), not complimentary ones, that this account still holds.
    const tickets = await this.prisma.ticket.findMany({
      where: { eventId: ev.id, status: { in: ['ACTIVE', 'CHECKED_IN'] }, order: { kind: 'SALE' }, OR: [{ ownerId: user.id }, { ownerId: null, holderEmail: user.email.toLowerCase() }] },
      select: { ticketType: { select: { eventDateId: true, validDateIds: true } } },
    });
    if (!tickets.length) return { ev, canReview: false, reason: 'Only people who had a ticket can review this event.' };
    const now = Date.now();
    const ends = tickets.map((t) => {
      const last = ticketTimes(ev.dateMode, ev, t.ticketType, ev.dates).last;
      return (last.endsAt ?? new Date(last.startsAt.getTime() + 3 * 3600_000)).getTime();
    });
    const over = ends.filter((e) => e <= now);
    if (!over.length) return { ev, canReview: false, reason: 'You can review this event once it’s over.' };
    if (now > Math.max(...over) + REVIEW_WINDOW_MS) return { ev, canReview: false, reason: 'Reviews for this event have closed.' };
    return { ev, canReview: true, reason: null };
  }

  async forEvent(slug: string, user: AuthUser | null, pageRaw?: string) {
    const { ev, canReview, reason } = await this.standing(slug, user);
    const page = Math.max(1, Number(pageRaw) || 1);
    const [rows, summary, organizer, mine] = await Promise.all([
      this.prisma.eventReview.findMany({ where: { eventId: ev.id, status: 'VISIBLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE, take: PAGE }),
      this.summary({ eventId: ev.id }),
      this.summary({ orgId: ev.orgId }),
      user ? this.prisma.eventReview.findUnique({ where: { eventId_userId: { eventId: ev.id, userId: user.id } } }) : null,
    ]);
    return {
      summary,
      organizer: { name: ev.org.name, average: organizer.average, count: organizer.count },
      reviews: rows.map((r) => this.view(r, user?.id)),
      page,
      more: page * PAGE < summary.count,
      // Your own review, even while an admin has it hidden (`hidden` says so).
      mine: mine ? { ...this.view(mine, user?.id), hidden: mine.status === 'HIDDEN', hideReason: mine.status === 'HIDDEN' ? mine.hideReason : null } : null,
      canReview: canReview || !!mine,
      reason: canReview || mine ? null : reason,
    };
  }

  async forOrganizerPage(slug: string, pageRaw?: string) {
    const org = await this.prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!org) throw new NotFoundException('Organizer not found.');
    const page = Math.max(1, Number(pageRaw) || 1);
    const [rows, summary] = await Promise.all([
      this.prisma.eventReview.findMany({ where: { orgId: org.id, status: 'VISIBLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * PAGE, take: PAGE, include: { event: { select: { slug: true, title: true } } } }),
      this.summary({ orgId: org.id }),
    ]);
    return { summary, reviews: rows.map(({ event, ...r }) => ({ ...this.view(r), event })), page, more: page * PAGE < summary.count };
  }

  /* ---------- writing ---------- */

  async write(slug: string, user: AuthUser, dto: ReviewDto) {
    const { ev, canReview, reason } = await this.standing(slug, user);
    const had = await this.prisma.eventReview.findUnique({ where: { eventId_userId: { eventId: ev.id, userId: user.id } } });
    if (!canReview && !had) throw new ForbiddenException(reason ?? 'You can’t review this event.');
    if (had?.status === 'HIDDEN') throw new ForbiddenException('This review was hidden by Omoshow, so it can’t be changed. Contact support if you think that’s a mistake.');
    const data = { rating: dto.rating, body: dto.body ?? '' };
    const account = await this.prisma.user.findUnique({ where: { id: user.id }, select: { name: true } });
    const r = had
      ? await this.prisma.eventReview.update({ where: { id: had.id }, data })
      : await this.prisma.eventReview.create({ data: { ...data, eventId: ev.id, orgId: ev.orgId, userId: user.id, authorName: publicName(account?.name ?? '') } });
    return this.view(r, user.id);
  }

  async remove(slug: string, user: AuthUser) {
    const ev = await this.prisma.event.findUnique({ where: { slug }, select: { id: true } });
    if (ev) await this.prisma.eventReview.deleteMany({ where: { eventId: ev.id, userId: user.id } });
    return { removed: true };
  }

  async flag(id: string, user: AuthUser, dto: FlagDto) {
    const r = await this.prisma.eventReview.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });
    if (!r || r.status !== 'VISIBLE') throw new NotFoundException('Review not found.');
    if (r.userId === user.id) throw new BadRequestException('That’s your own review. You can change or remove it instead.');
    const had = await this.prisma.eventReviewFlag.findUnique({ where: { reviewId_userId: { reviewId: id, userId: user.id } }, select: { id: true } });
    if (!had) {
      await this.prisma.$transaction([
        this.prisma.eventReviewFlag.create({ data: { reviewId: id, userId: user.id, reason: dto.reason, note: dto.note ?? '' } }),
        this.prisma.eventReview.update({ where: { id }, data: { flags: { increment: 1 }, updatedAt: (await this.prisma.eventReview.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt } }),
      ]);
    }
    return { flagged: true };
  }

  /* ---------- the organizer ---------- */

  async forOrganizer(eventId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const [rows, summary, organizer] = await Promise.all([
      this.prisma.eventReview.findMany({ where: { eventId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }),
      this.summary({ eventId }),
      this.summary({ orgId: ev.orgId }),
    ]);
    return { summary, organizer: { average: organizer.average, count: organizer.count }, reviews: rows.map((r) => ({ ...this.view(r), hidden: r.status === 'HIDDEN', flagged: r.flags > 0 })) };
  }

  async reply(eventId: string, reviewId: string, user: AuthUser, text: string) {
    await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const r = await this.prisma.eventReview.findFirst({ where: { id: reviewId, eventId } });
    if (!r) throw new NotFoundException('Review not found.');
    const updated = await this.prisma.eventReview.update({ where: { id: r.id }, data: { ...(text ? { reply: text, repliedAt: new Date(), repliedBy: user.id } : { reply: null, repliedAt: null, repliedBy: null }), updatedAt: r.updatedAt } });
    await this.audit.log(user.id, text ? 'review.reply' : 'review.reply_removed', 'Event', eventId, { reviewId });
    return this.view(updated);
  }

  /* ---------- admins ---------- */

  async adminList(status = 'FLAGGED') {
    if (status !== 'FLAGGED' && status !== 'HIDDEN') throw new BadRequestException('Unknown status.');
    const rows = await this.prisma.eventReview.findMany({
      where: status === 'HIDDEN' ? { status: 'HIDDEN' } : { status: 'VISIBLE', flags: { gt: 0 } },
      orderBy: [{ flags: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      include: { event: { select: { slug: true, title: true, org: { select: { name: true } } } }, flagged: { orderBy: { createdAt: 'desc' }, take: 10, select: { reason: true, note: true, createdAt: true } } },
    });
    return { reviews: rows.map(({ event, flagged, ...r }) => ({ ...this.view(r), flags: r.flags, hidden: r.status === 'HIDDEN', hideReason: r.hideReason, event, reasons: flagged })) };
  }

  async moderate(id: string, admin: AuthUser, action: 'hide' | 'restore' | 'keep', reason?: string) {
    const r = await this.prisma.eventReview.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Review not found.');
    const data: Prisma.EventReviewUpdateInput = { ...(action === 'hide' ? { status: 'HIDDEN', hideReason: reason, hiddenBy: admin.id, flags: 0 } : action === 'restore' ? { status: 'VISIBLE', hideReason: null, hiddenBy: null, flags: 0 } : { flags: 0 }), updatedAt: r.updatedAt };
    await this.prisma.$transaction([this.prisma.eventReview.update({ where: { id }, data }), this.prisma.eventReviewFlag.deleteMany({ where: { reviewId: id } })]);
    await this.audit.log(admin.id, `review.${action}`, 'Event', r.eventId, { reviewId: id, reason: reason ?? null });
    return { id, status: action === 'hide' ? 'HIDDEN' : 'VISIBLE' };
  }

  /* ---------- asking ticket holders ---------- */

  /** Events that ended between 12 hours and a week ago and haven't asked yet: their ticket holders are asked once. */
  async askAll(now = new Date()) {
    const events = await this.prisma.event.findMany({
      where: { status: 'PUBLISHED', reviewAskedAt: null, startsAt: { gte: new Date(now.getTime() - 60 * 86_400_000), lte: now } },
      include: { dates: true, org: { select: { name: true } } },
      take: 200,
    });
    let asked = 0;
    for (const ev of events) {
      const ends = (ev.dateMode === 'SINGLE' || !ev.dates.length ? [ev] : ev.dates.filter((d) => d.status === 'ACTIVE')).map((d) => (d.endsAt ?? new Date(d.startsAt.getTime() + 3 * 3600_000)).getTime());
      if (!ends.length) continue;
      const end = Math.max(...ends);
      if (now.getTime() < end + ASK_AFTER_MS) continue;
      // Marked first, so a slow send can't ask twice; events found too late are marked and skipped.
      await this.prisma.event.update({ where: { id: ev.id }, data: { reviewAskedAt: now } });
      if (now.getTime() > end + ASK_UNTIL_MS) continue;
      try {
        asked += await this.ask(ev);
      } catch (e) {
        this.log.warn(`Review request for ${ev.id}: ${(e as Error).message}`);
      }
    }
    return asked;
  }

  private async ask(ev: { id: string; slug: string; title: string; org: { name: string } }) {
    const tickets = await this.prisma.ticket.findMany({ where: { eventId: ev.id, status: { in: ['ACTIVE', 'CHECKED_IN'] }, order: { kind: 'SALE' } }, select: { holderEmail: true, ownerId: true } });
    const people = new Map<string, string | null>();
    for (const t of tickets) people.set(t.holderEmail.toLowerCase(), people.get(t.holderEmail.toLowerCase()) ?? t.ownerId);
    if (!people.size) return 0;
    const url = `${config.webUrl}/events/${ev.slug}?review=1#reviews`;
    const mails: Mail[] = [...people.keys()].map((to) => {
      const { html, text } = render({
        preheader: `Tell other fans how ${ev.title} was.`,
        heading: `How was ${ev.title}?`,
        paragraphs: [`You had tickets to ${ev.title} by ${ev.org.name}. A star rating and a few words help other fans decide, and help organizers put on better events.`, 'It takes under a minute. Sign in with the account that has your tickets.'],
        cta: { label: 'Rate this event', url },
        footer: `You’re getting this once because you had tickets to ${ev.title} on Omoshow.`,
      });
      return { to, subject: `How was ${ev.title}?`, html, text };
    });
    await this.mail.sendMany('review_request', mails);
    const noOwner = [...people.entries()].filter(([, id]) => !id).map(([email]) => email);
    const byEmail = noOwner.length ? new Map((await this.prisma.user.findMany({ where: { email: { in: noOwner } }, select: { id: true, email: true } })).map((u) => [u.email, u.id])) : new Map<string, string>();
    const userIds = [...new Set([...people.entries()].map(([email, id]) => id ?? byEmail.get(email)).filter((x): x is string => !!x))];
    void this.notices.reviewRequest(ev, userIds);
    return people.size;
  }
}

@ApiTags('reviews')
@Controller()
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @OptionalAuth()
  @Get('events/:slug/reviews')
  forEvent(@Param('slug') slug: string, @CurrentUser() user: AuthUser | null, @Query('page') page?: string) {
    return this.reviews.forEvent(slug, user, page);
  }
  @ApiBearerAuth()
  @Put('events/:slug/reviews')
  write(@Param('slug') slug: string, @CurrentUser() user: AuthUser, @Body() dto: ReviewDto) {
    return this.reviews.write(slug, user, dto);
  }
  @ApiBearerAuth()
  @Delete('events/:slug/reviews')
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.reviews.remove(slug, user);
  }
  @ApiBearerAuth()
  @Post('reviews/:id/flag')
  @HttpCode(200)
  flag(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: FlagDto) {
    return this.reviews.flag(id, user, dto);
  }
  @Public()
  @Get('organizers/:slug/reviews')
  forOrganizerPage(@Param('slug') slug: string, @Query('page') page?: string) {
    return this.reviews.forOrganizerPage(slug, page);
  }
  @ApiBearerAuth()
  @Get('organizer/events/:id/reviews')
  forOrganizer(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reviews.forOrganizer(id, user);
  }
  @ApiBearerAuth()
  @Put('organizer/events/:id/reviews/:rid/reply')
  reply(@Param('id') id: string, @Param('rid') rid: string, @CurrentUser() user: AuthUser, @Body() dto: ReplyDto) {
    return this.reviews.reply(id, rid, user, dto.reply);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/event-reviews')
export class AdminReviewController {
  constructor(private readonly reviews: ReviewService) {}

  @Get() list(@Query('status') status?: string) {
    return this.reviews.adminList(status || 'FLAGGED');
  }
  @Post(':id/hide') @HttpCode(200) hide(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: HideDto) {
    return this.reviews.moderate(id, u, 'hide', dto.reason);
  }
  @Post(':id/restore') @HttpCode(200) restore(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.reviews.moderate(id, u, 'restore');
  }
  @Post(':id/keep') @HttpCode(200) keep(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.reviews.moderate(id, u, 'keep');
  }
}

@Global()
@Module({ controllers: [ReviewController, AdminReviewController], providers: [ReviewService], exports: [ReviewService] })
export class ReviewModule {}
