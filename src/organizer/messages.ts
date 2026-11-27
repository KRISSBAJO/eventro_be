/**
 * Messages from the organizer to ticket holders ("Doors now 7 PM, bring ID"). An org admin or manager writes a short
 * plain-text message to everyone holding a ticket, or to some ticket types, or (multiple dates) one date. It goes by
 * email to each holder (the person who has the ticket now, not just the buyer), by push to holders with the app, and
 * shows on their tickets (GET /me/tickets `updates`).
 *
 * Kept honest by limits: event information only, at most 3 messages per event in 24 hours, from when the event is
 * published until 3 days after it ends, never for a cancelled event. Every message is in the audit log, and each
 * email has a link to stop them for that event.
 *
 *   GET    /organizer/events/:id/messages            sent messages, how many more today, who a new one would reach
 *                                                    (?ticketTypeIds=a,b&dateId=)
 *   POST   /organizer/events/:id/messages            { subject, body, ticketTypeIds?, dateId? }
 *   DELETE /event-messages/stop/:token               a holder stops emails about that event (the link in each one)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { EventMessage, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { MailService, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import { wallClockLabel } from '../domain/wallclock';
import { ticketsMoved } from '../domain/date-changes';
import { EDIT_ROLES, eventForRole } from './access';

/** At most this many messages per event in any 24 hours. */
export const MESSAGES_PER_DAY = 3;
/** Messages can still go out this long after the event ends ("lost property is at the box office"). */
export const AFTER_EVENT_MS = 3 * 86_400_000;
const DAY = 86_400_000;

/** Tidy plain text: no control characters, no trailing spaces, at most one blank line in a row. */
const tidy = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value;
const oneLine = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value);

export class SendMessageDto {
  @ApiProperty({ example: 'Doors now open at 7 PM' })
  @Transform(oneLine)
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  subject: string;

  @ApiProperty({ example: 'Doors open an hour later than planned, at 7 PM. Bring a photo ID that matches your ticket.' })
  @Transform(tidy)
  @IsString()
  @MinLength(10)
  @MaxLength(1500)
  body: string;

  @ApiPropertyOptional({ description: 'Only holders of these ticket types (default: everyone).' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ticketTypeIds?: string[];

  @ApiPropertyOptional({ description: 'Multiple dates or days: only holders for this one.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dateId?: string;
}

/** Tickets someone still has (a listed or transferring ticket is still its holder's until it changes hands). */
const HELD: Prisma.TicketWhereInput = { status: { in: ['ACTIVE', 'CHECKED_IN', 'LISTED', 'TRANSFER_PENDING'] } };

const sign = (ticketId: string) => createHmac('sha256', config.jwtSecret).update(`event-message-stop:${ticketId}`).digest('base64url').slice(0, 22);
/** The token in a message's "stop" link: the ticket it was sent for, signed (no email address in the link). */
export const stopToken = (ticketId: string) => `${ticketId}.${sign(ticketId)}`;

type Audience = { ticketTypeIds: string[]; eventDateId: string | null };

@Injectable()
export class EventMessageService {
  private readonly log = new Logger('EventMessages');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  private where(eventId: string, mode: string, a: Audience): Prisma.TicketWhereInput {
    return { AND: [ticketsMoved(eventId, mode, a.eventDateId), HELD, ...(a.ticketTypeIds.length ? [{ ticketTypeId: { in: a.ticketTypeIds } }] : [])] };
  }

  /** Checks the audience against the event: its own ticket types, one of its dates. */
  private audienceOf(ev: { dateMode: string; ticketTypes: { id: string }[]; dates: { id: string }[] }, ticketTypeIds?: string[], dateId?: string): Audience {
    const ids = [...new Set(ticketTypeIds ?? [])];
    if (ids.some((id) => !ev.ticketTypes.some((t) => t.id === id))) throw new BadRequestException('One of those ticket types isn’t part of this event.');
    if (dateId && (ev.dateMode === 'SINGLE' || !ev.dates.some((d) => d.id === dateId))) throw new BadRequestException('That date isn’t part of this event.');
    return { ticketTypeIds: ids, eventDateId: dateId || null };
  }

  /** Why a message can't go out for this event right now, or null. */
  private closedWhy(ev: { status: string; startsAt: Date; endsAt: Date | null; dateMode: string; dates: { startsAt: Date; endsAt: Date | null }[] }, now = new Date()) {
    if (ev.status === 'CANCELLED') return 'This event was cancelled. Ticket holders were told and refunded.';
    if (ev.status !== 'PUBLISHED') return 'Publish the event first. Messages go to people holding tickets.';
    const ends = ev.dateMode === 'SINGLE' || !ev.dates.length ? [ev.endsAt ?? ev.startsAt] : ev.dates.map((d) => d.endsAt ?? d.startsAt);
    const last = Math.max(...ends.map((d) => d.getTime()));
    if (now.getTime() > last + AFTER_EVENT_MS) return 'This event ended more than 3 days ago.';
    return null;
  }

  /** People a message would reach: distinct addresses (minus the ones who stopped them), their tickets, and how many have an account. */
  private async reach(eventId: string, mode: string, a: Audience) {
    const [tickets, out] = await Promise.all([
      this.prisma.ticket.findMany({ where: this.where(eventId, mode, a), select: { id: true, holderEmail: true, holderName: true, ownerId: true }, orderBy: { id: 'asc' } }),
      this.prisma.eventMessageOptOut.findMany({ where: { eventId }, select: { email: true } }),
    ]);
    const stopped = new Set(out.map((o) => o.email));
    const people = new Map<string, { email: string; name: string; ticketId: string; ownerId: string | null }>();
    for (const t of tickets) {
      const email = t.holderEmail.toLowerCase();
      const had = people.get(email);
      if (!had) people.set(email, { email, name: t.holderName, ticketId: t.id, ownerId: t.ownerId });
      else if (!had.ownerId && t.ownerId) had.ownerId = t.ownerId;
    }
    return { tickets: tickets.length, people: [...people.values()], stopped };
  }

  private async sentToday(eventId: string, now = new Date()) {
    const rows = await this.prisma.eventMessage.findMany({ where: { eventId, createdAt: { gt: new Date(now.getTime() - DAY) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const left = Math.max(0, MESSAGES_PER_DAY - rows.length);
    // When the next one can go: a day after the oldest of the last three.
    return { left, nextAt: left ? null : new Date(rows[rows.length - MESSAGES_PER_DAY].createdAt.getTime() + DAY) };
  }

  async list(eventId: string, user: AuthUser, ticketTypeIds?: string, dateId?: string) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const a = this.audienceOf(ev, ticketTypeIds ? ticketTypeIds.split(',').filter(Boolean) : [], dateId);
    const [rows, reach, today] = await Promise.all([
      this.prisma.eventMessage.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.reach(eventId, ev.dateMode, a),
      this.sentToday(eventId),
    ]);
    const senders = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.senderId))] } }, select: { id: true, name: true } });
    const name = new Map(senders.map((s) => [s.id, s.name]));
    const typeName = new Map(ev.ticketTypes.map((t) => [t.id, t.name]));
    const closed = this.closedWhy(ev);
    return {
      messages: rows.map((m) => ({
        id: m.id,
        subject: m.subject,
        body: m.body,
        sentAt: m.createdAt,
        sentBy: name.get(m.senderId) ?? 'A team member',
        // Who it was for, in words: [] = everyone.
        ticketTypes: [...new Set(m.ticketTypeIds.map((id) => typeName.get(id)).filter((x): x is string => !!x))],
        eventDateId: m.eventDateId,
        recipients: m.recipients,
        emailed: m.emailed,
        emailFailed: m.emailFailed,
        pushed: m.pushed,
        delivered: !!m.deliveredAt,
      })),
      // For the audience picker: the event's ticket types (one copy per date when it has several dates).
      ticketTypes: ev.ticketTypes.map((t) => ({ id: t.id, name: t.name, eventDateId: t.eventDateId })),
      audience: { people: reach.people.filter((p) => !reach.stopped.has(p.email)).length, tickets: reach.tickets, stopped: reach.people.filter((p) => reach.stopped.has(p.email)).length },
      limits: { perDay: MESSAGES_PER_DAY, leftToday: today.left, nextAt: today.nextAt },
      canSend: !closed,
      closedWhy: closed,
    };
  }

  async send(eventId: string, user: AuthUser, dto: SendMessageDto) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const closed = this.closedWhy(ev);
    if (closed) throw new BadRequestException(closed);
    const a = this.audienceOf(ev, dto.ticketTypeIds, dto.dateId);
    const today = await this.sentToday(eventId);
    if (!today.left) throw new BadRequestException(`You can send ${MESSAGES_PER_DAY} messages per event in 24 hours. Try again later.`);
    const reach = await this.reach(eventId, ev.dateMode, a);
    const people = reach.people.filter((p) => !reach.stopped.has(p.email));
    if (!people.length) throw new BadRequestException(reach.people.length ? 'Everyone holding those tickets has stopped these emails.' : 'Nobody holds those tickets yet, so there’s no one to message.');
    const m = await this.prisma.eventMessage.create({
      data: { eventId, senderId: user.id, subject: dto.subject, body: dto.body, ticketTypeIds: a.ticketTypeIds, eventDateId: a.eventDateId, recipients: people.length },
    });
    await this.audit.log(user.id, 'event.message', 'Event', eventId, { messageId: m.id, subject: m.subject, recipients: people.length, ticketTypeIds: a.ticketTypeIds, eventDateId: a.eventDateId });
    // Don't hold up the organizer's request while the emails go out.
    void this.deliver(m, { id: ev.id, slug: ev.slug, title: ev.title, startsAt: ev.startsAt, orgName: ev.org.name }, people).catch((e) => this.log.error(`Message ${m.id}: ${(e as Error).message}`));
    return { id: m.id, recipients: people.length, leftToday: today.left - 1 };
  }

  private async deliver(m: EventMessage, e: { id: string; slug: string; title: string; startsAt: Date; orgName: string }, people: { email: string; name: string; ticketId: string; ownerId: string | null }[]) {
    const when = wallClockLabel(e.startsAt, { weekday: 'short', month: 'short', day: 'numeric' });
    const paragraphs = m.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const mails: Mail[] = people.map((p) => {
      const stop = { label: 'Stop messages about this event', url: `${config.webUrl}/updates/stop?t=${stopToken(p.ticketId)}` };
      const { html, text } = render({
        preheader: `${e.orgName} about ${e.title}`,
        heading: m.subject,
        paragraphs: [`From ${e.orgName}, about ${e.title} (${when}):`, ...paragraphs],
        cta: { label: 'View your tickets', url: `${config.webUrl}/tickets` },
        footer: `${e.orgName} sent this to people holding tickets to ${e.title}. Omoshow delivered it; replies to this email aren’t read.`,
        footerLink: stop,
      });
      return { to: p.email, subject: `${m.subject} · ${e.title}`, html, text, unsubscribeUrl: stop.url };
    });
    const sent = await this.mail.sendMany('event_message', mails);
    const ok = sent.filter(Boolean).length;
    // Push: holders with an account (the ticket's owner, or an account with the holder's email).
    const noOwner = people.filter((p) => !p.ownerId).map((p) => p.email);
    const byEmail = noOwner.length ? new Map((await this.prisma.user.findMany({ where: { email: { in: noOwner } }, select: { id: true, email: true } })).map((u) => [u.email, u.id])) : new Map<string, string>();
    const userIds = [...new Set(people.map((p) => p.ownerId ?? byEmail.get(p.email)).filter((x): x is string => !!x))];
    const pushed = await this.notices.organizerMessage({ id: e.id }, { id: m.id, title: `${e.orgName}: ${m.subject}`, body: m.body.replace(/\s+/g, ' ').slice(0, 170) }, userIds);
    await this.prisma.eventMessage.update({ where: { id: m.id }, data: { emailed: ok, emailFailed: this.mail.enabled ? mails.length - ok : 0, pushed, deliveredAt: new Date() } });
  }

  /** The "stop" link in a message: no more emails about that event to the ticket's holder. */
  async stop(t: string) {
    const [ticketId, sig] = t.length <= 120 ? t.split('.') : [];
    const good = ticketId && sig && sig.length === 22 && timingSafeEqual(Buffer.from(sig), Buffer.from(sign(ticketId)));
    const ticket = good ? await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { holderEmail: true, eventId: true, event: { select: { title: true, slug: true } } } }) : null;
    if (!ticket) throw new NotFoundException('That link has expired or was never valid.');
    const email = ticket.holderEmail.toLowerCase();
    await this.prisma.eventMessageOptOut.upsert({ where: { eventId_email: { eventId: ticket.eventId, email } }, create: { eventId: ticket.eventId, email }, update: {} });
    return { stopped: true, event: ticket.event };
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id/messages')
export class EventMessageController {
  constructor(private readonly svc: EventMessageService) {}

  /** Sent messages, how many more can go today, and who a new one would reach. */
  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser, @Query('ticketTypeIds') ticketTypeIds?: string, @Query('dateId') dateId?: string) {
    return this.svc.list(id, u, ticketTypeIds, dateId);
  }
  /** Send a message to ticket holders (admins and managers). */
  @Post() @HttpCode(200) send(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: SendMessageDto) {
    return this.svc.send(id, u, dto);
  }
}

@ApiTags('tickets')
@Controller('event-messages')
export class EventMessageStopController {
  constructor(private readonly svc: EventMessageService) {}

  @Public()
  @Delete('stop/:token')
  stop(@Param('token') t: string) {
    return this.svc.stop(t);
  }
}
