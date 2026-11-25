/**
 * The Omoshow Guarantee (the scan guarantee): "If your ticket doesn't scan, you get your money back."
 *
 * Covered: every ticket from a paid order (ticket total above zero, PAID or PARTIALLY_REFUNDED), also after it's
 * transferred on, pay-what-you-want tickets bought for more than $0 included. Free tickets ($0 pay-what-you-want
 * included), comps (Order.kind COMP) and guest-list entries aren't: there's nothing to refund. A donation added at
 * checkout is never part of it: shares come from the ticket total (totalCents - donationCents). Its current holder can claim once, from
 * 3 hours before the event starts until 48 hours after it ends (no end time: start + 6 hours + 48 hours).
 *
 * Who pays an approved claim (`payer`, fixed when the claim is made):
 *   - OMOSHOW   tickets bought on Omoshow fan resale (Ticket.resaleGuarantee). The seller's payout is untouched, since
 *               their ticket was voided at sale.
 *   - ORGANIZER every other paid ticket. Like any refund it comes out of the organizer's payout, but only their share
 *               of the ticket (`organizerCents`): Omoshow returns its own fee and any ticket protection. If the
 *               organizer had already been paid for the order (organizerPaidOut), that share is recorded as owed to
 *               Omoshow (`organizerOwedCents`) and shown in the admin queue. The organizer's admins get an email.
 *
 * Each claim is decided on arrival only when the door's records settle it:
 *   - the ticket was checked in → DECLINED ("This ticket was scanned in at …")
 *   - otherwise                 → PENDING, for Omoshow to review within 24 hours, with the ticket's scan attempts
 *
 * A rejected scan doesn't approve a claim by itself: every rejection a fan can cause on purpose (an old screenshot
 * shows as EXPIRED_CODE, a pre-transfer QR as INVALID, another event's door as WRONG_EVENT) would otherwise turn
 * into a refund on demand. The admin queue shows the door's rejections so those claims are quick to approve.
 *
 * Approval refunds that ticket only, all-in: its share of the order total (ticketShare: every ticket in an order is
 * the same ticket type at the same price, so promo discounts, fees and protection are split evenly and the shares add
 * up to the total), capped at what's still refundable on the order. A resale order holds one ticket and is refunded
 * whole (AdminService.refundOrder, keepSellerPayout); any other order is refunded one ticket at a time
 * (AdminService.refundTicket), which voids just that ticket. A provider failure leaves the claim APPROVED with
 * refundStatus FAILED, and admins retry. Refunds are guarded by a state change (NONE/FAILED → PENDING) and the
 * provider idempotency key `guarantee-<claimId>`, so a claim is never refunded twice.
 *
 *   GET  /tickets/:id/guarantee-claims                  cover, payer, window and claim (holder)
 *   POST /tickets/:id/guarantee-claims                  { reason, details? } (holder)
 *   GET  /organizer/events/:id/guarantee-refunds        approved organizer-paid claims on an event (org admins, managers)
 *   GET  /admin/guarantee-claims                        ?status=&refund=FAILED&payer=&page= (admin)
 *   GET  /admin/guarantee-claims/:id                    one claim (admin)
 *   POST /admin/guarantee-claims/:id/decide             { decision: APPROVE | DECLINE, note? } (admin)
 *   POST /admin/guarantee-claims/:id/retry-refund       (admin)
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Prisma, type FeeMode, type GuaranteeClaim, type GuaranteeClaimStatus, type MemberRole, type OrderStatus, type PayoutSchedule } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { config } from '../config';
import { MailService, formatMoney, render } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { instantToWallClock, wallClockLabel, wallClockToInstant } from '../domain/wallclock';
import { organizerNet } from '../domain/money';
import { ticketLeft, ticketTotal } from '../domain/pwyw';
import { organizerPaidOut } from '../domain/paid-out';
import { AdminService } from '../admin/admin.module';
import { dateView, validDays, type DateRow } from '../domain/event-dates';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Claims open this long before the start… */
export const CLAIM_OPENS_BEFORE_START_MS = 3 * HOUR;
/** …and close this long after the end. */
export const CLAIM_CLOSES_AFTER_END_MS = 48 * HOUR;
/** Events without an end time are taken to last this long. */
export const ASSUMED_EVENT_LENGTH_MS = 6 * HOUR;

export const CLAIM_REASONS = ['DID_NOT_SCAN', 'TURNED_AWAY', 'OTHER'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];
const REASON_LABEL: Record<string, string> = { DID_NOT_SCAN: 'The ticket didn’t scan at the door', TURNED_AWAY: 'They were turned away at the door', OTHER: 'Something else went wrong at the door' };
const STATUSES: GuaranteeClaimStatus[] = ['PENDING', 'APPROVED', 'DECLINED'];
export const PAYERS = ['OMOSHOW', 'ORGANIZER'] as const;
export type GuaranteePayer = (typeof PAYERS)[number];
/** Order statuses whose tickets are covered. */
const COVERED_ORDERS: OrderStatus[] = ['PAID', 'PARTIALLY_REFUNDED'];
/** Organization roles that see an event's guarantee refunds (the roles that manage the event). */
const ORG_VIEW: MemberRole[] = ['ADMIN', 'MANAGER'];
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

/** What a ticket's claim windows depend on when the event has more than one date. */
export type DatedTicket = { mode: string; dates: DateRow[]; tt: { eventDateId: string | null; validDateIds: string[] } };

/**
 * The claim windows of a ticket: one for the event (SINGLE), one for its own date (DATES), or one per valid day
 * (DAYS: a claim is about one day). Each date's window runs from 3 hours before its start to 48 hours after its end.
 */
export function claimWindows(e: { startsAt: Date; endsAt: Date | null; timezone: string | null }, dated?: DatedTicket): { eventDateId: string | null; opensAt: Date; closesAt: Date }[] {
  if (dated?.mode === 'DATES' && dated.tt.eventDateId) {
    const d = dated.dates.find((x) => x.id === dated.tt.eventDateId);
    if (d) return [{ eventDateId: d.id, ...claimWindow({ ...d, timezone: e.timezone }) }];
  }
  if (dated?.mode === 'DAYS') {
    const days = validDays(dated.dates, dated.tt.validDateIds).filter((d) => d.status === 'ACTIVE');
    if (days.length) return days.map((d) => ({ eventDateId: d.id, ...claimWindow({ ...d, timezone: e.timezone }) }));
  }
  return [{ eventDateId: null, ...claimWindow(e) }];
}

/**
 * A multi-day pass's refund for one day: its share of the order split evenly over its valid days (the days' shares
 * add up to the ticket's share), capped at what's still refundable of the order's tickets.
 */
export function dayShare(o: { totalCents: number; refundedCents: number; quantity: number; donationCents?: number; donationRefundedCents?: number }, ticketId: string, days: string[], dayId: string) {
  const i = Math.max(0, days.indexOf(dayId));
  return Math.max(0, Math.min(splitCents(ticketShare(o, ticketId), days.length, i), ticketLeft(o)));
}

/* ---------- coverage and amounts ---------- */

/** Which ticket of its order this is (codes end in -01, -02…), 0-based; 0 if the code doesn't say. */
export function ticketIndex(ticketId: string, quantity: number) {
  const i = Number(/-(\d+)$/.exec(ticketId)?.[1]) - 1;
  return Number.isInteger(i) && i >= 0 && i < quantity ? i : 0;
}

/** `total` split into `parts` whole cents that add up to it exactly; the first `total % parts` parts get the extra cent. */
export function splitCents(total: number, parts: number, index: number) {
  const n = Math.max(1, parts);
  const base = Math.floor(total / n);
  return base + (index < total - base * n ? 1 : 0);
}

/**
 * A ticket's all-in share of its order. Every ticket in an order is the same ticket type at the same price
 * (Order.ticketTypeId, unitCents; a pay-what-you-want order's chosen amount too), so its proportional share of the
 * ticket total (after any promo discount, with fees and ticket protection) is that total split evenly; the shares of
 * all the order's tickets add up to it. A donation is not part of any ticket's share.
 */
export const ticketShare = (o: { totalCents: number; quantity: number; donationCents?: number }, ticketId: string) => splitCents(ticketTotal(o), o.quantity, ticketIndex(ticketId, o.quantity));

/**
 * The organizer's share of one ticket: what their payout counts for it (OrganizerService.payouts: the ticket's price
 * less Omoshow's fee, less its part of any discount), split the same way, so the shares add up to their net for the order.
 */
export function organizerTicketShare(o: { unitCents: number; quantity: number; discountCents: number }, feeMode: FeeMode, ticketId: string) {
  const net = Math.max(0, organizerNet(o.unitCents, feeMode, config.organizerFeePermille) * o.quantity - o.discountCents);
  return splitCents(net, o.quantity, ticketIndex(ticketId, o.quantity));
}

/** What a claim on this ticket refunds now: its share, capped at what's still refundable of the order's tickets. */
export const refundableShare = (o: { totalCents: number; refundedCents: number; quantity: number; donationCents?: number; donationRefundedCents?: number }, ticketId: string) =>
  Math.max(0, Math.min(ticketShare(o, ticketId), ticketLeft(o)));

/**
 * The organizer's part of a refund of `amountCents` on this ticket (ORGANIZER claims): their share of the ticket,
 * scaled down if the refund was capped. Omoshow covers the rest (its fee and any ticket protection).
 */
export function organizerPart(o: { totalCents: number; unitCents: number; quantity: number; discountCents: number; donationCents?: number }, feeMode: FeeMode, ticketId: string, amountCents: number) {
  const share = ticketShare(o, ticketId);
  if (share <= 0 || amountCents <= 0) return 0;
  const org = organizerTicketShare(o, feeMode, ticketId);
  return Math.min(amountCents, amountCents >= share ? org : Math.round((org * amountCents) / share));
}

/** Whether the organizer has already been paid for an order (src/domain/paid-out.ts; shared with donation refunds). */
export { organizerPaidOut };

export type NotCovered = 'FREE' | 'COMP' | 'REFUNDED';

/**
 * Whether a ticket is covered, and who pays. Resale tickets: Omoshow. Other tickets from a paid order: the organizer.
 * Comps and free tickets ($0 pay what you want too) aren't; a donation on the order doesn't make a free ticket paid.
 * A ticket with a claim stays covered (its order may be refunded since).
 */
export function coverage(
  t: { resaleGuarantee: boolean; guaranteeClaim?: Pick<GuaranteeClaim, 'payer'> | null },
  o: { totalCents: number; status: OrderStatus; donationCents?: number; kind?: string },
): { covered: boolean; payer: GuaranteePayer | null; notCovered: NotCovered | null } {
  if (t.guaranteeClaim) return { covered: true, payer: t.guaranteeClaim.payer as GuaranteePayer, notCovered: null };
  if (o.kind === 'COMP') return { covered: false, payer: null, notCovered: 'COMP' };
  if (ticketTotal(o) <= 0) return { covered: false, payer: null, notCovered: 'FREE' };
  if (!COVERED_ORDERS.includes(o.status)) return { covered: false, payer: null, notCovered: 'REFUNDED' };
  return { covered: true, payer: t.resaleGuarantee ? 'OMOSHOW' : 'ORGANIZER', notCovered: null };
}

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
    eventDateId: c.eventDateId,
    status: c.status,
    reason: c.reason,
    details: c.details,
    auto: c.auto,
    decisionNote: c.decisionNote,
    amountCents: c.amountCents,
    currency: c.currency,
    payer: c.payer as GuaranteePayer,
    refundStatus: c.refundStatus,
    createdAt: c.createdAt,
    decidedAt: c.decidedAt,
    refundedAt: c.refundedAt,
    message: claimMessage(c),
  };
}

/**
 * The `guarantee` block on a ticket in GET /me/tickets: whether it's covered (and if not, why: FREE or REFUNDED),
 * who pays, what a claim would refund now (that ticket's all-in share), the claim window and any claim.
 */
export function guaranteeFor(
  t: { id: string; resaleGuarantee: boolean; guaranteeClaim?: GuaranteeClaim | null },
  o: { totalCents: number; refundedCents: number; quantity: number; status: OrderStatus; donationCents?: number; donationRefundedCents?: number; kind?: string },
  e: { startsAt: Date; endsAt: Date | null; timezone: string | null },
  now = Date.now(),
  dated?: DatedTicket,
) {
  const cover = coverage(t, o);
  const ws = claimWindows(e, dated);
  const w = { opensAt: ws[0].opensAt, closesAt: ws[ws.length - 1].closesAt };
  // Multi-day passes: a claim is about one day and refunds that day's share (one claim per ticket).
  if (dated?.mode === 'DAYS' && ws[0].eventDateId) {
    const ids = ws.map((x) => x.eventDateId!);
    return {
      ...cover,
      refundCents: cover.covered ? (t.guaranteeClaim?.amountCents ?? dayShare(o, t.id, ids, ids[0])) : 0,
      opensAt: w.opensAt,
      closesAt: w.closesAt,
      open: cover.covered && ws.some((x) => windowOpen(x, now)),
      days: ws.map((x) => ({ eventDateId: x.eventDateId!, opensAt: x.opensAt, closesAt: x.closesAt, open: cover.covered && windowOpen(x, now), refundCents: cover.covered ? dayShare(o, t.id, ids, x.eventDateId!) : 0 })),
      claim: t.guaranteeClaim ? claimView(t.guaranteeClaim) : null,
    };
  }
  return {
    ...cover,
    refundCents: cover.covered ? (t.guaranteeClaim?.amountCents ?? refundableShare(o, t.id)) : 0,
    opensAt: w.opensAt,
    closesAt: w.closesAt,
    open: cover.covered && windowOpen(w, now),
    claim: t.guaranteeClaim ? claimView(t.guaranteeClaim) : null,
  };
}

export class GuaranteeClaimDto {
  @ApiProperty({ enum: CLAIM_REASONS }) @IsIn(CLAIM_REASONS) reason: ClaimReason;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) details?: string;
  @ApiPropertyOptional({ description: 'Multi-day passes (required there): the day the ticket didn’t work' }) @IsOptional() @IsString() @MaxLength(40) eventDateId?: string;
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
  event: {
    select: {
      id: true,
      slug: true,
      title: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      feeMode: true,
      dateMode: true,
      dates: true,
      venue: { select: { name: true, city: true } },
      org: { select: { id: true, name: true, payoutSchedule: true, payoutProvider: true, paystackSubaccount: true } },
    },
  },
  order: {
    select: {
      id: true,
      buyerName: true,
      email: true,
      quantity: true,
      unitCents: true,
      subtotalCents: true,
      discountCents: true,
      protectionCents: true,
      promoCode: true,
      totalCents: true,
      refundedCents: true,
      donationCents: true,
      donationRefundedCents: true,
      kind: true,
      status: true,
      provider: true,
      currency: true,
      paidAt: true,
      resaleListingId: true,
    },
  },
  ticket: {
    select: { id: true, status: true, holderName: true, holderEmail: true, section: true, row: true, seat: true, checkedInAt: true, checkedInDevice: true, checkedInBy: true, eventDateId: true, ticketType: { select: { name: true, eventDateId: true, validDateIds: true } } },
  },
} satisfies Prisma.GuaranteeClaimInclude;
type AdminRow = Prisma.GuaranteeClaimGetPayload<{ include: typeof ADMIN_INCLUDE }>;

const SCAN_LABEL: Record<string, string> = {
  WRONG_DATE: 'wrong date',
  ALREADY_USED: 'already used',
  VOID: 'cancelled ticket',
  WRONG_EVENT: 'wrong event',
  INVALID: 'invalid code',
  EXPIRED_CODE: 'expired code',
  NOT_FOUND: 'not found',
  TRANSFER_PENDING: 'mid-transfer',
};

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
        event: { select: { id: true, title: true, status: true, startsAt: true, endsAt: true, timezone: true, dateMode: true, dates: true } },
        order: { select: { id: true, status: true, quantity: true, totalCents: true, refundedCents: true, donationCents: true, donationRefundedCents: true, kind: true, currency: true, email: true } },
        ticketType: { select: { eventDateId: true, validDateIds: true } },
        guaranteeClaim: true,
      },
    });
    if (!t || (t.ownerId !== user.id && t.holderEmail !== user.email)) throw new NotFoundException('Ticket not found.');
    return t;
  }

  async status(id: string, user: AuthUser) {
    const t = await this.held(id, user);
    return guaranteeFor(t, t.order, t.event, Date.now(), { mode: t.event.dateMode, dates: t.event.dates, tt: t.ticketType });
  }

  async create(id: string, user: AuthUser, dto: GuaranteeClaimDto) {
    const t = await this.held(id, user);
    if (t.guaranteeClaim) throw new ConflictException('You’ve already made a claim for this ticket.');
    if (t.resoldAt) throw new BadRequestException('You sold this ticket on resale, so there’s nothing to claim.');
    if (t.event.status === 'CANCELLED') throw new BadRequestException('This event was cancelled, so your order is refunded in full automatically.');
    const cover = coverage(t, t.order);
    if (cover.notCovered === 'COMP') throw new BadRequestException('This is a complimentary ticket, so there’s nothing to refund. The Omoshow Guarantee covers paid tickets.');
    if (cover.notCovered === 'FREE') throw new BadRequestException('This ticket was free, so there’s nothing to refund. The Omoshow Guarantee covers paid tickets.');
    if (!cover.covered) throw new BadRequestException('This order has already been cancelled or refunded, so there’s nothing to claim.');
    if (t.status === 'VOID') throw new BadRequestException('This ticket has been cancelled, so there’s nothing to claim.');
    if (t.status === 'TRANSFER_PENDING') throw new BadRequestException('This ticket is being transferred. Cancel the transfer to make a claim.');
    if (t.status === 'LISTED') throw new BadRequestException('This ticket is listed for resale. Remove the listing to make a claim.');
    // Multiple dates: the window is the ticket's own date's (DATES) or the claimed day's (DAYS, which must say which).
    const dated = { mode: t.event.dateMode, dates: t.event.dates, tt: t.ticketType };
    const windows = claimWindows(t.event, dated);
    const days = t.event.dateMode === 'DAYS' ? windows.map((x) => x.eventDateId!).filter(Boolean) : [];
    let dayId: string | null = null;
    if (t.event.dateMode === 'DATES' && t.eventDateId && t.event.dates.some((d) => d.id === t.eventDateId && d.status === 'CANCELLED')) {
      throw new BadRequestException('This date was cancelled, so your order is refunded in full automatically.');
    }
    if (days.length) {
      if (!dto.eventDateId) throw new BadRequestException('Pick the day your ticket didn’t work (eventDateId).');
      if (!days.includes(dto.eventDateId)) throw new BadRequestException('This ticket isn’t valid on that day.');
      dayId = dto.eventDateId;
    }
    const amountCents = dayId ? dayShare(t.order, t.id, days, dayId) : refundableShare(t.order, t.id);
    if (amountCents <= 0) throw new BadRequestException('This order has already been refunded in full, so there’s nothing to claim.');
    const w = windows.find((x) => x.eventDateId === dayId) ?? windows[0];
    const now = Date.now();
    const what = dayId ? 'that day' : t.event.dateMode === 'DATES' ? 'your date' : 'the event';
    if (now < w.opensAt.getTime()) throw new BadRequestException(`Claims open 3 hours before ${what} starts: from ${venueTime(w.opensAt, t.event.timezone)}.`);
    if (now > w.closesAt.getTime()) throw new BadRequestException(`The claim window closed at ${venueTime(w.closesAt, t.event.timezone)}. Claims are open until 48 hours after ${what} ends.`);

    // The automatic decision, from the door's own records: only a check-in settles a claim on arrival (see the top).
    // A multi-day pass: a check-in on the claimed day (other days don't count).
    let status: GuaranteeClaimStatus = 'PENDING';
    let decisionNote: string | null = null;
    if (dayId) {
      const entry = await this.prisma.ticketCheckIn.findFirst({ where: { ticketId: t.id, eventDateId: dayId } });
      if (entry) {
        status = 'DECLINED';
        decisionNote = `This ticket was scanned in at ${venueTime(entry.at, t.event.timezone)}.`;
      }
    } else if (t.status === 'CHECKED_IN' || t.checkedInAt) {
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
          eventDateId: dayId,
          userId: user.id,
          reason: dto.reason,
          details: dto.details?.trim() || null,
          status,
          auto: decided,
          decidedAt: decided ? new Date() : null,
          decisionNote,
          amountCents,
          currency: t.order.currency,
          payer: cover.payer!,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('You’ve already made a claim for this ticket.');
      throw e;
    }
    await this.audit.log(user.id, 'guarantee.claim', 'GuaranteeClaim', claim.id, { ticketId: t.id, orderId: t.orderId, reason: dto.reason, payer: claim.payer, amountCents, ...(dayId ? { eventDateId: dayId } : {}) });
    if (decided) await this.audit.log(null, 'guarantee.auto_decline', 'GuaranteeClaim', claim.id, { ticketId: t.id, why: 'ticket was checked in' });
    this.notify(claim.id, decided ? 'declined' : 'received');
    return claimView(await this.prisma.guaranteeClaim.findUniqueOrThrow({ where: { id: claim.id } }));
  }

  /**
   * Refunds an approved claim back through the order's provider. Resale orders (one ticket, Omoshow pays) are refunded
   * whole with the seller's payout left alone; any other order refunds just this ticket's share and voids just this
   * ticket, and the organizer's part is recorded (owed, if they'd already been paid for the order). Only one call can
   * move NONE/FAILED → PENDING, so double clicks refund once.
   */
  private async refund(claimId: string, actor: AuthUser | null) {
    const { count } = await this.prisma.guaranteeClaim.updateMany({ where: { id: claimId, status: 'APPROVED', refundStatus: { in: ['NONE', 'FAILED'] } }, data: { refundStatus: 'PENDING', refundError: null } });
    if (!count) return;
    const c = await this.prisma.guaranteeClaim.findUniqueOrThrow({
      where: { id: claimId },
      include: { order: true, ticket: { select: { ticketType: { select: { validDateIds: true } } } }, event: { select: { feeMode: true, dateMode: true, org: { select: { payoutSchedule: true, payoutProvider: true, paystackSubaccount: true } } } } },
    });
    // A multi-day pass refunded for one of several days keeps working on the others.
    const keepTicket = c.event.dateMode === 'DAYS' && !!c.eventDateId && c.ticket.ticketType.validDateIds.length > 1;
    // Only the tickets: a donation on the order is never refunded by the guarantee.
    const left = ticketLeft(c.order);
    const amount = Math.min(c.amountCents, left);
    const organizer = c.payer === 'ORGANIZER';
    const organizerCents = organizer ? organizerPart(c.order, c.event.feeMode, c.ticketId, amount) : 0;
    const organizerOwedCents = organizer && organizerPaidOut(c.order, c.event.org) ? organizerCents : 0;
    const why = `Omoshow Guarantee claim ${claimId}`;
    const refundKey = `guarantee-${claimId}`;
    try {
      if (c.order.resaleListingId) await this.admin.refundOrder(c.orderId, amount, actor, why, { keepSellerPayout: true, refundKey });
      else await this.admin.refundTicket(c.orderId, c.ticketId, amount, actor, why, { refundKey, keepTicket });
      await this.prisma.guaranteeClaim.update({ where: { id: claimId }, data: { refundStatus: 'REFUNDED', refundedAt: new Date(), amountCents: amount, organizerCents, organizerOwedCents } });
      await this.audit.log(actor?.id ?? null, 'guarantee.refund', 'GuaranteeClaim', claimId, {
        orderId: c.orderId,
        ticketId: c.ticketId,
        amountCents: amount,
        currency: c.currency,
        provider: c.order.provider,
        payer: c.payer,
        organizerCents,
        organizerOwedCents,
      });
      if (organizer) this.notifyOrganizer(claimId);
    } catch (e) {
      const message = ((e as Error).message || 'Refund failed').slice(0, 300);
      this.log.warn(`Guarantee refund for claim ${claimId} (order ${c.orderId}) failed: ${message}`);
      await this.prisma.guaranteeClaim.update({ where: { id: claimId }, data: { refundStatus: 'FAILED', refundError: message } });
      await this.audit.log(actor?.id ?? null, 'guarantee.refund_failed', 'GuaranteeClaim', claimId, { orderId: c.orderId, amountCents: amount, message });
    }
  }

  /* ----- organizers ----- */

  /** Approved organizer-paid claims on one of their events, newest first (org admins and managers; read-only). */
  async organizerRefunds(eventId: string, user: AuthUser) {
    const ev = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, orgId: true, currency: true } });
    if (!ev) throw new NotFoundException('Event not found.');
    const m = await this.prisma.organizationMember.findFirst({ where: { orgId: ev.orgId, userId: user.id, status: 'ACTIVE' }, select: { role: true } });
    if (!m) throw new NotFoundException('Event not found.');
    if (!ORG_VIEW.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
    const rows = await this.prisma.guaranteeClaim.findMany({
      where: { eventId, payer: 'ORGANIZER', status: 'APPROVED' },
      orderBy: { decidedAt: 'desc' },
      take: 500,
      include: { ticket: { select: { section: true, row: true, seat: true, ticketType: { select: { name: true } } } } },
    });
    const refunded = rows.filter((r) => r.refundStatus === 'REFUNDED');
    return {
      currency: ev.currency,
      count: refunded.length,
      refundedCents: refunded.reduce((s, r) => s + r.amountCents, 0),
      payoutReductionCents: refunded.reduce((s, r) => s + r.organizerCents, 0),
      owedCents: refunded.reduce((s, r) => s + r.organizerOwedCents, 0),
      items: rows.map((r) => ({
        id: r.id,
        ticketId: r.ticketId,
        orderId: r.orderId,
        ticketType: r.ticket.ticketType.name,
        section: r.ticket.section,
        row: r.ticket.row,
        seat: r.ticket.seat,
        reason: r.reason,
        amountCents: r.amountCents,
        organizerCents: r.organizerCents,
        organizerOwedCents: r.organizerOwedCents,
        currency: r.currency,
        refundStatus: r.refundStatus,
        decidedAt: r.decidedAt,
        refundedAt: r.refundedAt,
      })),
    };
  }

  /* ----- admin ----- */

  async adminList(statusRaw?: string, refund?: string, pageRaw?: string, payerRaw?: string) {
    const page = Math.max(1, Math.min(10_000, Number(pageRaw) || 1));
    const status = STATUSES.find((s) => s === statusRaw);
    const payer = PAYERS.find((p) => p === payerRaw);
    const where: Prisma.GuaranteeClaimWhereInput = { ...(status ? { status } : {}), ...(refund === 'FAILED' ? { refundStatus: 'FAILED' } : {}), ...(payer ? { payer } : {}) };
    const [total, rows, byStatus, refundFailed, costs, byPayer] = await Promise.all([
      this.prisma.guaranteeClaim.count({ where }),
      this.prisma.guaranteeClaim.findMany({ where, include: ADMIN_INCLUDE, orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
      this.prisma.guaranteeClaim.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.guaranteeClaim.count({ where: { refundStatus: 'FAILED' } }),
      this.prisma.guaranteeClaim.groupBy({ by: ['currency'], where: { refundStatus: 'REFUNDED' }, _sum: { amountCents: true }, _count: { _all: true } }),
      this.prisma.guaranteeClaim.groupBy({ by: ['currency', 'payer'], where: { refundStatus: 'REFUNDED' }, _sum: { amountCents: true, organizerCents: true, organizerOwedCents: true }, _count: { _all: true } }),
    ]);
    const counts = { PENDING: 0, APPROVED: 0, DECLINED: 0, refundFailed };
    for (const s of byStatus) counts[s.status] = s._count._all;
    return {
      total,
      page,
      pageSize: PAGE,
      counts,
      costs: costs.map((c) => ({ currency: c.currency, cents: c._sum.amountCents ?? 0, claims: c._count._all })),
      // Refunded claims by who paid: `cents` went back to fans, `organizerCents` came out of organizers' payouts,
      // `eventroCents` was Omoshow's (resale claims in full; its fee and protection on organizer claims), and
      // `owedCents` is what organizers who'd already been paid owe Omoshow.
      costsByPayer: byPayer.map((c) => {
        const cents = c._sum.amountCents ?? 0;
        const organizerCents = c._sum.organizerCents ?? 0;
        return { currency: c.currency, payer: c.payer as GuaranteePayer, claims: c._count._all, cents, organizerCents, eventroCents: cents - organizerCents, owedCents: c._sum.organizerOwedCents ?? 0 };
      }),
      items: await this.adminViews(rows),
    };
  }

  async adminOne(id: string) {
    const row = await this.prisma.guaranteeClaim.findUnique({ where: { id }, include: ADMIN_INCLUDE });
    if (!row) throw new NotFoundException('Claim not found.');
    return (await this.adminViews([row]))[0];
  }

  private async adminViews(rows: AdminRow[]) {
    const ticketIds = rows.map((r) => r.ticketId);
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const [scans, siblings] = await Promise.all([
      ticketIds.length ? this.prisma.scanAttempt.findMany({ where: { ticketId: { in: ticketIds } }, orderBy: { at: 'asc' } }) : [],
      orderIds.length
        ? this.prisma.ticket.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, status: true, resoldAt: true, guaranteeClaim: { select: { id: true, status: true, refundStatus: true } } }, orderBy: { id: 'asc' } })
        : [],
    ]);
    const ids = new Set<string>();
    for (const r of rows) for (const u of [r.userId, r.decidedById, r.ticket.checkedInBy]) if (u) ids.add(u);
    for (const s of scans) if (s.userId) ids.add(s.userId);
    const people = ids.size ? await this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } }) : [];
    const who = new Map(people.map((p) => [p.id, p]));
    return rows.map((r) => {
      const { checkedInBy, ticketType, ...ticket } = r.ticket;
      const { org, feeMode, dates, ...event } = r.event;
      // Multiple dates: the window of the ticket's date (DATES) or the claimed day (DAYS).
      const windows = claimWindows(r.event, { mode: r.event.dateMode, dates, tt: ticketType });
      const window = windows.find((x) => x.eventDateId === r.eventDateId) ?? windows[0];
      const claimDate = dates.find((d) => d.id === (r.eventDateId ?? ticketType.eventDateId));
      const checker = checkedInBy ? (who.get(checkedInBy) ?? null) : null;
      const left = ticketLeft(r.order);
      const share = ticketShare(r.order, r.ticketId);
      const organizer = r.payer === 'ORGANIZER';
      // Before the refund: what approving would cost the organizer now (after it, what it did cost).
      const done = r.refundStatus === 'REFUNDED';
      const due = done ? r.amountCents : Math.min(r.amountCents, left);
      const organizerCents = done ? r.organizerCents : organizer ? organizerPart(r.order, feeMode, r.ticketId, due) : 0;
      const organizerOwedCents = done ? r.organizerOwedCents : organizer && organizerPaidOut(r.order, org) ? organizerCents : 0;
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
        payer: r.payer as GuaranteePayer,
        // The refund split: `refundCents` back to the fan (what approving refunds now, or what it did), of which
        // `organizerCents` comes out of the organizer's payout and `eventroCents` is Omoshow's.
        cost: { refundCents: due, organizerCents, eventroCents: due - organizerCents, organizerOwedCents, organizerPaidOut: organizer && organizerPaidOut(r.order, org) },
        refundStatus: r.refundStatus,
        refundError: r.refundError,
        refundedAt: r.refundedAt,
        message: claimMessage(r),
        event: { ...event, org: { id: org.id, name: org.name } },
        claimant: r.userId ? (who.get(r.userId) ?? null) : null,
        order: r.order,
        // This ticket's share of the order and the rest of it (other tickets, what's left to refund).
        share: {
          ticketCents: share,
          restCents: ticketTotal(r.order) - share,
          // a donation on the order: never part of a guarantee refund
          donationCents: r.order.donationCents,
          remainingCents: left,
          tickets: siblings
            .filter((s) => s.orderId === r.orderId)
            .map((s) => ({ id: s.id, status: s.status, resold: !!s.resoldAt, claim: s.guaranteeClaim, thisClaim: s.id === r.ticketId })),
        },
        ticket: { ...ticket, ticketType: ticketType.name, checkedInBy: checkedInBy ? { id: checkedInBy, name: checker?.name ?? null } : null },
        // The date the claim is about (DATES: the ticket's; DAYS: the claimed day), else null
        eventDateId: r.eventDateId,
        date: claimDate ? dateView(claimDate) : null,
        scans: scans
          .filter((s) => s.ticketId === r.ticketId)
          .map((s) => ({ id: s.id, at: s.at, eventId: s.eventId, result: s.result, method: s.method, deviceId: s.deviceId, staff: s.userId ? { id: s.userId, name: who.get(s.userId)?.name ?? null } : null })),
        window: { opensAt: window.opensAt, closesAt: window.closesAt },
      };
    });
  }

  async decide(id: string, admin: AuthUser, dto: GuaranteeDecisionDto) {
    const note = dto.note?.trim() || null;
    const c = await this.prisma.guaranteeClaim.findUnique({
      where: { id },
      include: { order: { select: { status: true, totalCents: true, refundedCents: true, donationCents: true, donationRefundedCents: true } }, ticket: { select: { status: true, resoldAt: true } } },
    });
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
    if (c.order.status === 'REFUNDED' || ticketLeft(c.order) <= 0) throw new BadRequestException('This order has already been refunded in full, so there’s nothing left to refund.');
    // The ticket may have moved on since the claim was made.
    if (c.ticket.resoldAt) throw new BadRequestException('This ticket was sold on resale after the claim, so there’s nothing to refund.');
    if (c.ticket.status === 'VOID') throw new BadRequestException('This ticket has been cancelled, so there’s nothing to refund.');
    if (c.ticket.status === 'LISTED') throw new BadRequestException('This ticket is listed for resale now. The fan needs to remove the listing first.');
    if (c.ticket.status === 'TRANSFER_PENDING') throw new BadRequestException('This ticket is being transferred now. The transfer needs to be cancelled first.');
    const { count } = await this.prisma.guaranteeClaim.updateMany({
      where: { id, status: { in: ['PENDING', 'DECLINED'] } },
      data: { status: 'APPROVED', auto: false, decidedById: admin.id, decidedAt: new Date(), decisionNote: note },
    });
    if (!count) throw new ConflictException('This claim was decided a moment ago. Refresh to see it.');
    await this.audit.log(admin.id, 'guarantee.approve', 'GuaranteeClaim', id, { note, overrode: c.status === 'DECLINED' ? 'auto_decline' : null, payer: c.payer });
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
      include: { event: { select: { title: true } }, order: { select: { id: true, email: true, resaleListingId: true } }, ticket: { select: { holderEmail: true, holderName: true, status: true } } },
    });
    if (!c) return;
    const amount = formatMoney(c.amountCents, c.currency);
    const refunded = c.refundStatus === 'REFUNDED';
    const toCard = `It goes back to the card or account that paid for order ${c.order.id}.`;
    // A normal order can hold more tickets: the refund is for this one, and the rest still work.
    const others = c.order.resaleListingId ? 0 : await this.prisma.ticket.count({ where: { orderId: c.orderId, id: { not: c.ticketId }, status: { not: 'VOID' } } });
    const what = c.order.resaleListingId ? 'everything you paid, fees included' : 'everything you paid for this ticket, fees included';
    const rest = others ? ` Your other ${others === 1 ? 'ticket' : `${others} tickets`} on this order still ${others === 1 ? 'works' : 'work'}.` : '';
    const copy: Record<Notice, { subject: string; heading: string; paragraphs: string[]; push: string; highlight?: { label: string; value: string } }> = {
      received: {
        subject: `We’ve got your claim: ${c.event.title}`,
        heading: 'We’ve got your claim',
        paragraphs: [`Thanks for telling us your ticket for ${c.event.title} didn’t work at the door.`, 'Our team will look at what the door recorded and get back to you within 24 hours.'],
        push: `${c.event.title}: we’ll get back to you within 24 hours.`,
      },
      approved: refunded
        ? {
            subject: `Refund on its way: ${amount} for ${c.event.title}`,
            heading: 'Your money is on its way back',
            paragraphs: [
              `Your Omoshow Guarantee claim for ${c.event.title} was approved${c.auto ? ': the door’s scan log shows your ticket was turned down' : ''}.`,
              `We’ve refunded ${amount}, ${what}. ${toCard}`,
              REFUND_TIMING,
              // A multi-day pass refunded for one day still works on its other days.
              c.ticket.status !== 'VOID' ? 'This was a refund for that day: your pass still works on its other days.' : `The ticket has been cancelled, so its QR code no longer works.${rest}`,
            ],
            highlight: { label: 'Refunded', value: amount },
            push: `${c.event.title}: we’ve refunded ${amount}. ${REFUND_TIMING}`,
          }
        : {
            subject: `Claim approved: ${c.event.title}`,
            heading: 'Your claim was approved',
            paragraphs: [
              `Your Omoshow Guarantee claim for ${c.event.title} was approved.`,
              `Your refund of ${amount} is being processed by our team. We’ll email you again as soon as it’s sent. ${toCard}`,
            ],
            highlight: { label: 'Refund due', value: amount },
            push: `${c.event.title}: your refund of ${amount} is being processed.`,
          },
      declined: {
        subject: `About your claim: ${c.event.title}`,
        heading: 'We couldn’t approve your claim',
        paragraphs: [`We looked at your Omoshow Guarantee claim for ${c.event.title}.`, c.decisionNote ?? 'It wasn’t approved.', 'If something doesn’t look right, contact us through the help centre and a person will take another look.'],
        push: `${c.event.title}: ${c.decisionNote ?? 'your claim wasn’t approved.'}`,
      },
      refunded: {
        subject: `Refund sent: ${amount} for ${c.event.title}`,
        heading: 'Your refund has been sent',
        paragraphs: [`We’ve sent your Omoshow Guarantee refund for ${c.event.title}: ${amount}, ${what}. ${toCard}`, REFUND_TIMING],
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
        footer: 'You made a claim under the Omoshow Guarantee.',
        footerLink: { label: 'Guarantee terms', url: `${config.webUrl}/guarantee` },
      });
      await this.mail.send(`guarantee.${kind}`, { to, subject: m.subject, html, text });
    }
    if (c.userId) await this.notices.guaranteeClaim(kind, { userId: c.userId, claimId, ticketId: c.ticketId, title: m.heading, body: m.push });
  }

  /* ----- telling the organizer ----- */

  /** Emails the organization's admins once an organizer-paid claim is refunded, since it reduces their payout. */
  private notifyOrganizer(claimId: string) {
    void this.sendOrganizer(claimId).catch((e) => this.log.warn(`Guarantee organizer notice for ${claimId}: ${(e as Error).message}`));
  }

  private async sendOrganizer(claimId: string) {
    const c = await this.prisma.guaranteeClaim.findUnique({
      where: { id: claimId },
      include: {
        event: { select: { id: true, title: true, timezone: true, org: { select: { name: true, members: { where: { status: 'ACTIVE', role: 'ADMIN' }, select: { email: true } } } } } },
        ticket: { select: { section: true, row: true, seat: true, checkedInAt: true, status: true, ticketType: { select: { name: true } } } },
      },
    });
    if (!c || c.payer !== 'ORGANIZER' || c.refundStatus !== 'REFUNDED') return;
    // The dedupe key: only the call that records it sends.
    const key = 'org.refunded';
    const { count } = await this.prisma.guaranteeClaim.updateMany({ where: { id: claimId, NOT: { noticesSent: { has: key } } }, data: { noticesSent: { push: key } } });
    if (!count) return;
    const to = [...new Set(c.event.org.members.map((m) => m.email.trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return;
    const money = (cents: number) => formatMoney(cents, c.currency);
    const seat = [c.ticket.section && `Section ${c.ticket.section}`, c.ticket.row && `Row ${c.ticket.row}`, c.ticket.seat != null && `Seat ${c.ticket.seat}`].filter(Boolean).join(', ');
    const scans = await this.prisma.scanAttempt.findMany({ where: { ticketId: c.ticketId }, orderBy: { at: 'asc' }, select: { at: true, result: true, deviceId: true } });
    const rejected = scans.filter((s) => s.result !== 'ADMITTED');
    const tally = new Map<string, number>();
    for (const s of rejected) tally.set(SCAN_LABEL[s.result] ?? s.result, (tally.get(SCAN_LABEL[s.result] ?? s.result) ?? 0) + 1);
    const evidence = !scans.length
      ? 'The door recorded no scans of this ticket.'
      : `The door recorded ${scans.length} ${scans.length === 1 ? 'scan' : 'scans'} of this ticket${rejected.length ? `, ${rejected.length} turned down (${[...tally].map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}; the last at ${venueTime(scans[scans.length - 1].at, c.event.timezone)}${scans[scans.length - 1].deviceId ? ` on scanner ${scans[scans.length - 1].deviceId}` : ''}.`;
    const checkedIn = c.ticket.checkedInAt ? ` It was checked in at ${venueTime(c.ticket.checkedInAt, c.event.timezone)}, and our team approved the claim after review.` : ' It was never checked in.';
    const eventro = c.amountCents - c.organizerCents;
    const paragraphs = [
      `A fan’s ticket for ${c.event.title} didn’t get them in, and Omoshow approved their claim under the Omoshow Guarantee (“if your ticket doesn’t scan, you get your money back”).`,
      `Ticket ${c.ticketId}: ${c.ticket.ticketType.name}${seat ? `, ${seat}` : ''}.`,
      `What the fan told us: ${REASON_LABEL[c.reason] ?? c.reason}${c.details ? `. “${c.details}”` : '.'}${c.decisionNote ? ` Our reviewer’s note: “${c.decisionNote}”` : ''}`,
      `${evidence}${checkedIn}`,
      `We refunded the fan ${money(c.amountCents)} for this ticket. Your payout is reduced by ${money(c.organizerCents)}, your share of the ticket${eventro > 0 ? `; Omoshow covered the other ${money(eventro)} (its fee and any ticket protection)` : ''}. ${c.ticket.status === 'VOID' ? 'The ticket has been cancelled.' : 'This was one day of a multi-day pass, which still works on its other days.'}`,
      ...(c.organizerOwedCents > 0
        ? [`You’d already been paid for this order, so ${money(c.organizerOwedCents)} is recorded as owed to Omoshow. Our team will be in touch about it.`]
        : []),
    ];
    const { html, text } = render({
      preheader: `A ticket for ${c.event.title} was refunded under the Omoshow Guarantee.`,
      heading: 'A guarantee refund on your event',
      paragraphs,
      highlight: { label: 'Payout reduced by', value: money(c.organizerCents) },
      cta: { label: 'See your event', url: `${config.webUrl}/organizer/events/${c.event.id}` },
      footer: `You’re getting this because you’re an admin of ${c.event.org.name} on Omoshow.`,
      footerLink: { label: 'How the guarantee works', url: `${config.webUrl}/guarantee` },
    });
    const subject = `Guarantee refund: ${money(c.amountCents)} for ${c.event.title}`;
    await this.mail.sendMany('guarantee.organizer', to.map((addr) => ({ to: addr, subject, html, text })));
  }
}

/* ---------- routes ---------- */

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets/:id/guarantee-claims')
export class GuaranteeController {
  constructor(private readonly svc: GuaranteeService) {}

  /** Whether this ticket is covered by the Omoshow Guarantee (and who pays), its claim window, and its claim (current holder). */
  @Get() status(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.status(id, u);
  }

  /** "It didn't scan": a claim, decided straight away when the door's records settle it (current holder, once). */
  @Post() create(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: GuaranteeClaimDto) {
    return this.svc.create(id, u, dto);
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id/guarantee-refunds')
export class OrganizerGuaranteeController {
  constructor(private readonly svc: GuaranteeService) {}

  /** Approved Omoshow Guarantee claims on this event that the organizer pays for (org admins and managers). */
  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.organizerRefunds(id, u);
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
  @ApiQuery({ name: 'payer', required: false, enum: PAYERS })
  @Get()
  list(@Query('status') status?: string, @Query('refund') refund?: string, @Query('page') page?: string, @Query('payer') payer?: string) {
    return this.svc.adminList(status, refund, page, payer);
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
