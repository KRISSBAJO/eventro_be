/**
 * The fan resale scan guarantee: "If it doesn't scan, you get your money back."
 *
 * Covered: a ticket bought on Eventro fan resale (Ticket.resaleGuarantee, set when the resale order is fulfilled),
 * also after it's transferred on. Its current holder can claim once, from 3 hours before the event starts until
 * 48 hours after it ends (no end time: start + 6 hours + 48 hours).
 *
 * Each claim is decided on arrival only when the door's records settle it:
 *   - the ticket was checked in → DECLINED ("This ticket was scanned in at …")
 *   - otherwise                 → PENDING, for Eventro to review within 24 hours, with the ticket's scan attempts
 *
 * A rejected scan doesn't approve a claim by itself: every rejection a fan can cause on purpose (an old screenshot
 * shows as EXPIRED_CODE, a pre-transfer QR as INVALID, another event's door as WRONG_EVENT) would otherwise turn
 * into a refund on demand. The admin queue shows the door's rejections so those claims are quick to approve.
 *
 * Approval refunds the whole resale order (all-in) through its payment provider with the same refund code as
 * cancellations (AdminService.refundOrder), which voids the ticket. Eventro pays: the seller's payout is untouched,
 * since their ticket was voided at sale. A provider failure leaves the claim APPROVED with refundStatus FAILED, and
 * admins retry. Refunds are guarded by a state change (NONE/FAILED → PENDING), so a claim is never refunded twice.
 *
 *   GET  /tickets/:id/guarantee-claims             cover, window and claim (holder)
 *   POST /tickets/:id/guarantee-claims             { reason, details? } (holder)
 *   GET  /admin/guarantee-claims                   ?status=&refund=FAILED&page= (admin)
 *   GET  /admin/guarantee-claims/:id               one claim (admin)
 *   POST /admin/guarantee-claims/:id/decide        { decision: APPROVE | DECLINE, note? } (admin)
 *   POST /admin/guarantee-claims/:id/retry-refund  (admin)
 */
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Prisma, type GuaranteeClaim, type GuaranteeClaimStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { config } from '../config';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { instantToWallClock, wallClockLabel, wallClockToInstant } from '../domain/wallclock';
import { AdminService } from '../admin/admin.module';

const HOUR = 3600_000;
/** Claims open this long before the start… */
export const CLAIM_OPENS_BEFORE_START_MS = 3 * HOUR;
/** …and close this long after the end. */
export const CLAIM_CLOSES_AFTER_END_MS = 48 * HOUR;
/** Events without an end time are taken to last this long. */
export const ASSUMED_EVENT_LENGTH_MS = 6 * HOUR;

export const CLAIM_REASONS = ['DID_NOT_SCAN', 'TURNED_AWAY', 'OTHER'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];
const STATUSES: GuaranteeClaimStatus[] = ['PENDING', 'APPROVED', 'DECLINED'];
const PAGE = 25;

export const REFUND_TIMING = 'It usually takes 5–10 business days to reach your card; bank transfer and USSD refunds through Paystack can take longer.';

/** The claim window as real moments (event times are the venue's wall clock stored as UTC). */
export function claimWindow(e: { startsAt: Date; endsAt: Date | null; timezone: string | null }) {
  const start = wallClockToInstant(e.startsAt, e.timezone);
  const end = e.endsAt ? wallClockToInstant(e.endsAt, e.timezone) : new Date(start.getTime() + ASSUMED_EVENT_LENGTH_MS);
  return { opensAt: new Date(start.getTime() - CLAIM_OPENS_BEFORE_START_MS), closesAt: new Date(end.getTime() + CLAIM_CLOSES_AFTER_END_MS) };
}

/** Inside the window, both ends included. */
export const windowOpen = (w: { opensAt: Date; closesAt: Date }, now = Date.now()) => now >= w.opensAt.getTime() && now <= w.closesAt.getTime();

/** "8:14 PM on Sat, Nov 28": a real moment on the venue's clock. */
function venueTime(at: Date, tz: string | null) {
  const wall = instantToWallClock(at, tz);
  return `${wallClockLabel(wall, { hour: 'numeric', minute: '2-digit' })} on ${wallClockLabel(wall, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

/** The status line fans see on the website and in the app (they add the refund timing, REFUND_TIMING, themselves). */
export function claimMessage(c: Pick<GuaranteeClaim, 'status' | 'auto' | 'decisionNote' | 'amountCents' | 'currency' | 'refundStatus'>) {
  const amount = formatMoney(c.amountCents, c.currency);
  if (c.status === 'PENDING') return 'We’ve got your claim. We’ll get back to you within 24 hours.';
  if (c.status === 'DECLINED') return c.decisionNote || 'Your claim was declined.';
  const lead = c.auto ? 'Approved automatically: the door’s scan log shows this ticket was turned down.' : 'Approved.';
  return c.refundStatus === 'REFUNDED'
    ? `${lead} We’ve refunded ${amount} to the original payment method.`
    : `${lead} Your refund of ${amount} is being processed by our team. We’ll email you as soon as it’s sent.`;
}

/** A claim as its holder sees it. */
export function claimView(c: GuaranteeClaim) {
  return {
    id: c.id,
    ticketId: c.ticketId,
    status: c.status,
    reason: c.reason,
    details: c.details,
    auto: c.auto,
    decisionNote: c.decisionNote,
    amountCents: c.amountCents,
    currency: c.currency,
    refundStatus: c.refundStatus,
    createdAt: c.createdAt,
    decidedAt: c.decidedAt,
    refundedAt: c.refundedAt,
    message: claimMessage(c),
  };
}

/** The `guarantee` block on a ticket in GET /me/tickets (null when the ticket isn't covered). */
export function guaranteeFor(t: { resaleGuarantee: boolean; guaranteeClaim?: GuaranteeClaim | null }, e: { startsAt: Date; endsAt: Date | null; timezone: string | null }, now = Date.now()) {
  if (!t.resaleGuarantee) return null;
  const w = claimWindow(e);
  return { covered: true as const, opensAt: w.opensAt, closesAt: w.closesAt, open: windowOpen(w, now), claim: t.guaranteeClaim ? claimView(t.guaranteeClaim) : null };
}

export class GuaranteeClaimDto {
  @ApiProperty({ enum: CLAIM_REASONS }) @IsIn(CLAIM_REASONS) reason: ClaimReason;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) details?: string;
}

export class GuaranteeDecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'DECLINE'] }) @IsIn(['APPROVE', 'DECLINE']) decision: 'APPROVE' | 'DECLINE';
  @ApiPropertyOptional({ description: 'Required to decline (5–500 characters; sent to the fan). Optional when approving.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

type Notice = 'received' | 'approved' | 'declined' | 'refunded';

const ADMIN_INCLUDE = {
  event: { select: { id: true, slug: true, title: true, startsAt: true, endsAt: true, timezone: true, venue: { select: { name: true, city: true } } } },
  order: { select: { id: true, buyerName: true, email: true, totalCents: true, refundedCents: true, status: true, provider: true, currency: true } },
  ticket: {
    select: { id: true, status: true, holderName: true, holderEmail: true, section: true, row: true, seat: true, checkedInAt: true, checkedInDevice: true, checkedInBy: true, ticketType: { select: { name: true } } },
  },
} satisfies Prisma.GuaranteeClaimInclude;
type AdminRow = Prisma.GuaranteeClaimGetPayload<{ include: typeof ADMIN_INCLUDE }>;

@Injectable()
export class GuaranteeService {
  private readonly log = new Logger('Guarantee');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /** The ticket, if this account holds it (same rule as the rest of /tickets/:id). */
  private async held(id: string, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        event: { select: { id: true, title: true, status: true, startsAt: true, endsAt: true, timezone: true } },
        order: { select: { id: true, status: true, totalCents: true, refundedCents: true, currency: true, email: true } },
        guaranteeClaim: true,
      },
    });
    if (!t || (t.ownerId !== user.id && t.holderEmail !== user.email)) throw new NotFoundException('Ticket not found.');
    return t;
  }

  async status(id: string, user: AuthUser) {
    const t = await this.held(id, user);
    const w = claimWindow(t.event);
    return { covered: t.resaleGuarantee, opensAt: w.opensAt, closesAt: w.closesAt, open: t.resaleGuarantee && windowOpen(w), claim: t.guaranteeClaim ? claimView(t.guaranteeClaim) : null };
  }

  async create(id: string, user: AuthUser, dto: GuaranteeClaimDto) {
    const t = await this.held(id, user);
    if (!t.resaleGuarantee) throw new BadRequestException('This ticket isn’t covered by the resale guarantee. It covers tickets bought on Eventro fan resale.');
    if (t.guaranteeClaim) throw new ConflictException('You’ve already made a claim for this ticket.');
    if (t.resoldAt) throw new BadRequestException('You sold this ticket on resale, so there’s nothing to claim.');
    if (t.event.status === 'CANCELLED') throw new BadRequestException('This event was cancelled, so your order is refunded in full automatically.');
    if (t.order.status === 'REFUNDED' || t.order.status === 'CANCELLED') throw new BadRequestException('This order has already been cancelled or refunded, so there’s nothing to claim.');
    if (t.status === 'VOID') throw new BadRequestException('This ticket has been cancelled, so there’s nothing to claim.');
    if (t.status === 'TRANSFER_PENDING') throw new BadRequestException('This ticket is being transferred. Cancel the transfer to make a claim.');
    if (t.status === 'LISTED') throw new BadRequestException('This ticket is listed for resale. Remove the listing to make a claim.');
    const w = claimWindow(t.event);
    const now = Date.now();
    if (now < w.opensAt.getTime()) throw new BadRequestException(`Claims open 3 hours before the event starts: from ${venueTime(w.opensAt, t.event.timezone)}.`);
    if (now > w.closesAt.getTime()) throw new BadRequestException(`The claim window closed at ${venueTime(w.closesAt, t.event.timezone)}. Claims are open until 48 hours after the event ends.`);

    // The automatic decision, from the door's own records: only a check-in settles a claim on arrival (see the top).
    let status: GuaranteeClaimStatus = 'PENDING';
    let decisionNote: string | null = null;
    if (t.status === 'CHECKED_IN' || t.checkedInAt) {
      status = 'DECLINED';
      decisionNote = `This ticket was scanned in at ${venueTime(t.checkedInAt ?? new Date(), t.event.timezone)}.`;
    }
    const decided = status !== 'PENDING';
    let claim: GuaranteeClaim;
    try {
      claim = await this.prisma.guaranteeClaim.create({
        data: {
          ticketId: t.id,
          orderId: t.orderId,
          eventId: t.eventId,
          userId: user.id,
          reason: dto.reason,
          details: dto.details?.trim() || null,
          status,
          auto: decided,
          decidedAt: decided ? new Date() : null,
          decisionNote,
          amountCents: t.order.totalCents - t.order.refundedCents,
          currency: t.order.currency,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('You’ve already made a claim for this ticket.');
      throw e;
    }
    await this.audit.log(user.id, 'guarantee.claim', 'GuaranteeClaim', claim.id, { ticketId: t.id, orderId: t.orderId, reason: dto.reason });
    if (decided) await this.audit.log(null, 'guarantee.auto_decline', 'GuaranteeClaim', claim.id, { ticketId: t.id, why: 'ticket was checked in' });
    this.notify(claim.id, decided ? 'declined' : 'received');
    return claimView(await this.prisma.guaranteeClaim.findUniqueOrThrow({ where: { id: claim.id } }));
  }

  /**
   * Refunds an approved claim: the whole resale order back through its provider, voiding the ticket, with the
   * seller's payout left alone. Only one call can move NONE/FAILED → PENDING, so double clicks refund once.
   */
  private async refund(claimId: string, actor: AuthUser | null) {
    const { count } = await this.prisma.guaranteeClaim.updateMany({ where: { id: claimId, status: 'APPROVED', refundStatus: { in: ['NONE', 'FAILED'] } }, data: { refundStatus: 'PENDING', refundError: null } });
    if (!count) return;
    const c = await this.prisma.guaranteeClaim.findUniqueOrThrow({ where: { id: claimId }, include: { order: true } });
    const left = c.order.totalCents - c.order.refundedCents;
    const amount = Math.min(c.amountCents, left);
    try {
      await this.admin.refundOrder(c.orderId, amount, actor, `Resale guarantee claim ${claimId}`, { keepSellerPayout: true, refundKey: `guarantee-${claimId}` });
      await this.prisma.guaranteeClaim.update({ where: { id: claimId }, data: { refundStatus: 'REFUNDED', refundedAt: new Date(), amountCents: amount } });
      await this.audit.log(actor?.id ?? null, 'guarantee.refund', 'GuaranteeClaim', claimId, { orderId: c.orderId, amountCents: amount, currency: c.currency, provider: c.order.provider });
    } catch (e) {
      const message = ((e as Error).message || 'Refund failed').slice(0, 300);
      this.log.warn(`Guarantee refund for claim ${claimId} (order ${c.orderId}) failed: ${message}`);
      await this.prisma.guaranteeClaim.update({ where: { id: claimId }, data: { refundStatus: 'FAILED', refundError: message } });
      await this.audit.log(actor?.id ?? null, 'guarantee.refund_failed', 'GuaranteeClaim', claimId, { orderId: c.orderId, amountCents: amount, message });
    }
  }

  /* ----- admin ----- */

  async adminList(statusRaw?: string, refund?: string, pageRaw?: string) {
    const page = Math.max(1, Math.min(10_000, Number(pageRaw) || 1));
    const status = STATUSES.find((s) => s === statusRaw);
    const where: Prisma.GuaranteeClaimWhereInput = { ...(status ? { status } : {}), ...(refund === 'FAILED' ? { refundStatus: 'FAILED' } : {}) };
    const [total, rows, byStatus, refundFailed, costs] = await Promise.all([
      this.prisma.guaranteeClaim.count({ where }),
      this.prisma.guaranteeClaim.findMany({ where, include: ADMIN_INCLUDE, orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
      this.prisma.guaranteeClaim.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.guaranteeClaim.count({ where: { refundStatus: 'FAILED' } }),
      this.prisma.guaranteeClaim.groupBy({ by: ['currency'], where: { refundStatus: 'REFUNDED' }, _sum: { amountCents: true }, _count: { _all: true } }),
    ]);
    const counts = { PENDING: 0, APPROVED: 0, DECLINED: 0, refundFailed };
    for (const s of byStatus) counts[s.status] = s._count._all;
    return {
      total,
      page,
      pageSize: PAGE,
      counts,
      costs: costs.map((c) => ({ currency: c.currency, cents: c._sum.amountCents ?? 0, claims: c._count._all })),
      items: await this.adminViews(rows),
    };
  }

  async adminOne(id: string) {
    const row = await this.prisma.guaranteeClaim.findUnique({ where: { id }, include: ADMIN_INCLUDE });
    if (!row) throw new NotFoundException('Claim not found.');
    return (await this.adminViews([row]))[0];
  }

  private async adminViews(rows: AdminRow[]) {
    const scans = rows.length ? await this.prisma.scanAttempt.findMany({ where: { ticketId: { in: rows.map((r) => r.ticketId) } }, orderBy: { at: 'asc' } }) : [];
    const ids = new Set<string>();
    for (const r of rows) for (const u of [r.userId, r.decidedById, r.ticket.checkedInBy]) if (u) ids.add(u);
    for (const s of scans) if (s.userId) ids.add(s.userId);
    const people = ids.size ? await this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } }) : [];
    const who = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => {
      const { checkedInBy, ticketType, ...ticket } = r.ticket;
      const checker = checkedInBy ? (who.get(checkedInBy) ?? null) : null;
      return {
        id: r.id,
        status: r.status,
        reason: r.reason,
        details: r.details,
        auto: r.auto,
        decisionNote: r.decisionNote,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedById ? (who.get(r.decidedById) ?? { id: r.decidedById, name: null, email: null }) : null,
        createdAt: r.createdAt,
        amountCents: r.amountCents,
        currency: r.currency,
        refundStatus: r.refundStatus,
        refundError: r.refundError,
        refundedAt: r.refundedAt,
        message: claimMessage(r),
        event: r.event,
        claimant: r.userId ? (who.get(r.userId) ?? null) : null,
        order: r.order,
        ticket: { ...ticket, ticketType: ticketType.name, checkedInBy: checkedInBy ? { id: checkedInBy, name: checker?.name ?? null } : null },
        scans: scans
          .filter((s) => s.ticketId === r.ticketId)
          .map((s) => ({ id: s.id, at: s.at, eventId: s.eventId, result: s.result, method: s.method, deviceId: s.deviceId, staff: s.userId ? { id: s.userId, name: who.get(s.userId)?.name ?? null } : null })),
        window: claimWindow(r.event),
      };
    });
  }

  async decide(id: string, admin: AuthUser, dto: GuaranteeDecisionDto) {
    const note = dto.note?.trim() || null;
    const c = await this.prisma.guaranteeClaim.findUnique({ where: { id }, include: { order: { select: { status: true, totalCents: true, refundedCents: true } } } });
    if (!c) throw new NotFoundException('Claim not found.');
    if (dto.decision === 'DECLINE') {
      if (!note || note.length < 5) throw new BadRequestException('Give the fan a reason (at least 5 characters) to decline.');
      const { count } = await this.prisma.guaranteeClaim.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DECLINED', auto: false, decidedById: admin.id, decidedAt: new Date(), decisionNote: note } });
      if (!count) throw new ConflictException('Only pending claims can be declined.');
      await this.audit.log(admin.id, 'guarantee.decline', 'GuaranteeClaim', id, { note });
      this.notify(id, 'declined');
      return this.adminOne(id);
    }
    // Approving also overrides an automatic decline (e.g. it was scanned, but they were still turned away).
    if (c.status === 'APPROVED') throw new ConflictException('This claim is already approved.');
    if (c.order.status === 'REFUNDED' || c.order.totalCents - c.order.refundedCents <= 0) throw new BadRequestException('This order has already been refunded in full, so there’s nothing left to refund.');
    const { count } = await this.prisma.guaranteeClaim.updateMany({
      where: { id, status: { in: ['PENDING', 'DECLINED'] } },
      data: { status: 'APPROVED', auto: false, decidedById: admin.id, decidedAt: new Date(), decisionNote: note },
    });
    if (!count) throw new ConflictException('This claim was decided a moment ago. Refresh to see it.');
    await this.audit.log(admin.id, 'guarantee.approve', 'GuaranteeClaim', id, { note, overrode: c.status === 'DECLINED' ? 'auto_decline' : null });
    await this.refund(id, admin);
    this.notify(id, 'approved');
    return this.adminOne(id);
  }

  async retryRefund(id: string, admin: AuthUser) {
    const c = await this.prisma.guaranteeClaim.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Claim not found.');
    if (c.status !== 'APPROVED' || c.refundStatus !== 'FAILED') throw new BadRequestException('Only approved claims whose refund failed can be retried.');
    await this.audit.log(admin.id, 'guarantee.refund_retry', 'GuaranteeClaim', id, { lastError: c.refundError });
    await this.refund(id, admin);
    const after = await this.prisma.guaranteeClaim.findUniqueOrThrow({ where: { id }, select: { refundStatus: true } });
    if (after.refundStatus === 'REFUNDED') this.notify(id, 'refunded');
    return this.adminOne(id);
  }

  /* ----- telling the fan ----- */

  /** Email and push to the claimant, once per kind (emails are guarded by `noticesSent`, pushes by their dedupe key). */
  private notify(claimId: string, kind: Notice) {
    void this.send(claimId, kind).catch((e) => this.log.warn(`Guarantee ${kind} notice for ${claimId}: ${(e as Error).message}`));
  }

  private async send(claimId: string, kind: Notice) {
    const c = await this.prisma.guaranteeClaim.findUnique({
      where: { id: claimId },
      include: { event: { select: { title: true } }, order: { select: { id: true, email: true } }, ticket: { select: { holderEmail: true, holderName: true } } },
    });
    if (!c) return;
    const amount = formatMoney(c.amountCents, c.currency);
    const refunded = c.refundStatus === 'REFUNDED';
    const toCard = `It goes back to the card or account that paid for order ${c.order.id}.`;
    const copy: Record<Notice, { subject: string; heading: string; paragraphs: string[]; push: string; highlight?: { label: string; value: string } }> = {
      received: {
        subject: `We’ve got your claim: ${c.event.title}`,
        heading: 'We’ve got your claim',
        paragraphs: [`Thanks for telling us your resale ticket for ${c.event.title} didn’t work at the door.`, 'Our team will look at what the door recorded and get back to you within 24 hours.'],
        push: `${c.event.title}: we’ll get back to you within 24 hours.`,
      },
      approved: refunded
        ? {
            subject: `Refund on its way: ${amount} for ${c.event.title}`,
            heading: 'Your money is on its way back',
            paragraphs: [
              `Your resale guarantee claim for ${c.event.title} was approved${c.auto ? ': the door’s scan log shows your ticket was turned down' : ''}.`,
              `We’ve refunded ${amount}, everything you paid, fees included. ${toCard}`,
              REFUND_TIMING,
              'The ticket has been cancelled, so its QR code no longer works.',
            ],
            highlight: { label: 'Refunded', value: amount },
            push: `${c.event.title}: we’ve refunded ${amount}. ${REFUND_TIMING}`,
          }
        : {
            subject: `Claim approved: ${c.event.title}`,
            heading: 'Your claim was approved',
            paragraphs: [
              `Your resale guarantee claim for ${c.event.title} was approved.`,
              `Your refund of ${amount} is being processed by our team. We’ll email you again as soon as it’s sent. ${toCard}`,
            ],
            highlight: { label: 'Refund due', value: amount },
            push: `${c.event.title}: your refund of ${amount} is being processed.`,
          },
      declined: {
        subject: `About your claim: ${c.event.title}`,
        heading: 'We couldn’t approve your claim',
        paragraphs: [`We looked at your resale guarantee claim for ${c.event.title}.`, c.decisionNote ?? 'It wasn’t approved.', 'If something doesn’t look right, contact us through the help centre and a person will take another look.'],
        push: `${c.event.title}: ${c.decisionNote ?? 'your claim wasn’t approved.'}`,
      },
      refunded: {
        subject: `Refund sent: ${amount} for ${c.event.title}`,
        heading: 'Your refund has been sent',
        paragraphs: [`We’ve sent your resale guarantee refund for ${c.event.title}: ${amount}. ${toCard}`, REFUND_TIMING],
        highlight: { label: 'Refunded', value: amount },
        push: `${c.event.title}: we’ve sent ${amount}. ${REFUND_TIMING}`,
      },
    };
    const m = copy[kind];
    const user = c.userId ? await this.prisma.user.findUnique({ where: { id: c.userId }, select: { email: true } }) : null;
    const to = user?.email ?? c.ticket.holderEmail;
    // Only the call that records this kind sends the email.
    const key = `claim.${kind}`;
    const { count } = await this.prisma.guaranteeClaim.updateMany({ where: { id: claimId, NOT: { noticesSent: { has: key } } }, data: { noticesSent: { push: key } } });
    if (count) {
      const { html, text } = render({
        preheader: m.paragraphs[0],
        heading: m.heading,
        paragraphs: m.paragraphs,
        ...(m.highlight ? { highlight: m.highlight } : {}),
        cta: { label: 'View my tickets', url: `${config.webUrl}/tickets` },
        footer: 'You made a claim under Eventro’s fan resale guarantee.',
        footerLink: { label: 'Guarantee terms', url: `${config.webUrl}/guarantee#fan-resale` },
      });
      await this.mail.send(`guarantee.${kind}`, { to, subject: m.subject, html, text });
    }
    if (c.userId) await this.notices.guaranteeClaim(kind, { userId: c.userId, claimId, ticketId: c.ticketId, title: m.heading, body: m.push });
  }
}

/* ---------- routes ---------- */

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets/:id/guarantee-claims')
export class GuaranteeController {
  constructor(private readonly svc: GuaranteeService) {}

  /** Whether this ticket is covered by the resale guarantee, its claim window, and its claim (current holder). */
  @Get() status(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.status(id, u);
  }

  /** "It didn't scan": a claim, decided straight away when the door's records settle it (current holder, once). */
  @Post() create(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: GuaranteeClaimDto) {
    return this.svc.create(id, u, dto);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/guarantee-claims')
export class AdminGuaranteeController {
  constructor(private readonly svc: GuaranteeService) {}

  @ApiQuery({ name: 'status', required: false, enum: STATUSES })
  @ApiQuery({ name: 'refund', required: false, enum: ['FAILED'] })
  @Get()
  list(@Query('status') status?: string, @Query('refund') refund?: string, @Query('page') page?: string) {
    return this.svc.adminList(status, refund, page);
  }
  @Get(':id') one(@Param('id') id: string) {
    return this.svc.adminOne(id);
  }
  @Post(':id/decide') @HttpCode(200) decide(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: GuaranteeDecisionDto) {
    return this.svc.decide(id, u, dto);
  }
  @Post(':id/retry-refund') @HttpCode(200) retry(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.retryRefund(id, u);
  }
}
