import { previewToken } from '../events/preview';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberRole, Prisma, type EventDate, type ScanResult, type TicketCheckIn } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { ScanLog } from '../common/scan-log';
import { config } from '../config';
import { Payments } from '../checkout/payments';
import { randomSuffix, slugify } from '../domain/codes';
import { buyerPrice, organizerNet, type FeeMode } from '../domain/money';
import { DONATION_NOTE, cleanDonationSettings, cleanPwywInput, donationLeft, ticketRefunded } from '../domain/pwyw';
import { GuestListService } from './guest-list';
import { styleInput, withLook } from '../domain/tier-look';
import { QR_WINDOW_MS, parseQr, qrSeed, verifyQr } from '../domain/qr';
import { QR_SEED_SPEC } from '../tickets/tickets.module';
import { arenaTemplate, capacityByTicketType, rowLabel, sectionName, validateSeatMap, type SeatMap } from '../domain/seatmap';
import type { AuthUser } from '../common/auth';
import { mediaUrls, type MediaItem } from '../media/media.module';
import { isTimeZone, placeTimezone, timezoneAt } from '../geo/geo.module';
import { FxService } from '../fx/fx.module';
import { PriceDropService } from '../price-drops/price-drops.module';
import { EventCancellation } from '../admin/cancel-event';
import { VenueChange } from './venue-change';
import { VenueBookingService, assertFits } from '../venues/venue-bookings';
import { isLive } from '../venues/booking-rules';
import { ScheduleService } from '../schedule/schedule.module';
import { EventDatesService, planDates, capacitiesFor, daysFor, resolveRef, type TierInput } from './event-dates';
import { DateChangeService, type Move } from './date-changes';
import { holdLiveEdit, pendingEditJson, readPendingEdit } from '../domain/pending-edit';
import { checkSingleTimes, liveType, dateName, dateRangeWhere, dateView, daysList, doorDate, isActive, nextActive, nextDateView, seatTier, ticketDates, ticketTimes, validDays, type DateMode } from '../domain/event-dates';
import type {
  AttachBookingDto,
  ChangeVenueDto,
  CreateEventDto,
  CreateOrgDto,
  InviteDto,
  PromoDto,
  TemplateDto,
  TicketTypeInputDto,
  UpdateEventDto,
  UpdateOrgDto,
  UpdatePromoDto,
  UpdateTicketTypeDto,
} from './organizer.dto';

const EDIT: MemberRole[] = ['ADMIN', 'MANAGER'];
const DOOR: MemberRole[] = ['ADMIN', 'MANAGER', 'DOOR'];
const ADMIN_ONLY: MemberRole[] = ['ADMIN'];

const DAY = 86_400_000;

/** v1: venue bookings on Omoshow are for one-date events. */
const MULTI_DATE_BOOKING = 'Venue bookings on Omoshow are for single-date events for now. Pick the venue for this event instead.';

/** Offline sync answers as door scan log results. */
const SYNC_SCAN_RESULT: Record<string, ScanResult> = {
  unknown: 'NOT_FOUND',
  'wrong-event': 'WRONG_EVENT',
  'bad-code': 'INVALID',
  'expired-code': 'EXPIRED_CODE',
  void: 'VOID',
  'transfer-pending': 'TRANSFER_PENDING',
  'wrong-date': 'WRONG_DATE',
};
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** What the door needs about a ticket, comps included ("Comp · Press"). */
const DOOR_TICKET = { ticketType: { select: { name: true, validDateIds: true } }, order: { select: { kind: true, compGroup: true } } } as const;
type DoorTicket = Prisma.TicketGetPayload<{ include: typeof DOOR_TICKET }>;
/** What doorView needs about a ticket. */
type DoorViewTicket = { id: string; holderName: string; section: string | null; row: string | null; seat: number | null; eventDateId?: string | null; ticketType: { name: string; validDateIds?: string[] }; order?: { kind: string; compGroup: string | null } };
/** What the door needs about the event (its dates, for DATES and DAYS). */
type DoorEvent = { dateMode: string; timezone: string; dates: EventDate[] };
/** DAYS: the ticket stopped being usable while it was being let in. */
class DoorRefused extends Error {}

/** Trimmed, de-duplicated perks (case-insensitive), at most 8. */
function cleanPerks(perks: string[] | undefined) {
  const out: string[] = [];
  for (const p of perks ?? []) {
    const v = p.trim().replace(/\s+/g, ' ');
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, 8);
}

/** A rule's plain Error as a 400. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
}

/** The pricing fields of a new ticket type: a fixed price, or pay what you want (priceCents = the minimum, all-in). */
function pricingData(t: TicketTypeInputDto, feeMode: FeeMode) {
  if (t.pricing !== 'PWYW') {
    if (t.basePriceCents === undefined) throw new BadRequestException(`Set a price for ${t.name.trim()}.`);
    return { pricing: 'FIXED' as const, priceCents: buyerPrice(t.basePriceCents, feeMode, config.organizerFeePermille), pwywMinCents: null, pwywSuggestedCents: null, pwywMaxCents: null, pwywQuickPicks: [] };
  }
  const p = rule(() => cleanPwywInput(t, t.basePriceCents ?? 0));
  return { pricing: 'PWYW' as const, priceCents: buyerPrice(p.pwywMinCents, feeMode, config.organizerFeePermille), ...p };
}

/** The pricing fields a ticket type's owner sees. */
const PRICING_FIELDS = { pricing: true, pwywMinCents: true, pwywSuggestedCents: true, pwywMaxCents: true, pwywQuickPicks: true } as const;

@Injectable()
export class OrganizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: Payments,
    private readonly fx: FxService,
    private readonly priceDrops: PriceDropService,
    private readonly cancellation: EventCancellation,
    private readonly venues: VenueChange,
    private readonly bookings: VenueBookingService,
    private readonly scans: ScanLog,
    private readonly guests: GuestListService,
    private readonly dates: EventDatesService,
    private readonly schedule: ScheduleService,
    private readonly dateChanges: DateChangeService,
  ) {}

  /* ---------- access ---------- */

  private async member(orgId: string, user: AuthUser, roles: MemberRole[]) {
    const m = await this.prisma.organizationMember.findFirst({ where: { orgId, userId: user.id, status: 'ACTIVE' } });
    if (!m) throw new NotFoundException('Organization not found.');
    if (!roles.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
    return m;
  }

  private async eventFor(id: string, user: AuthUser, roles: MemberRole[]) {
    const ev = await this.prisma.event.findUnique({ where: { id }, include: { ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, dates: { orderBy: { startsAt: 'asc' } } } });
    if (!ev) throw new NotFoundException('Event not found.');
    await this.member(ev.orgId, user, roles);
    return ev;
  }

  /* ---------- organizations & team ---------- */

  async createOrg(user: AuthUser, dto: CreateOrgDto) {
    const org = await this.prisma.organization.create({
      data: {
        name: dto.name.trim(),
        // The public organizer page's address; it stays the same if the org is renamed.
        slug: `${slugify(dto.name) || 'organizer'}-${randomSuffix()}`,
        supportEmail: dto.supportEmail ?? user.email,
        members: { create: { userId: user.id, email: user.email, role: 'ADMIN', status: 'ACTIVE' } },
      },
    });
    if (!user.roles.includes('ORGANIZER')) {
      await this.prisma.user.update({ where: { id: user.id }, data: { roles: { push: 'ORGANIZER' } } });
    }
    return org;
  }

  myOrgs(user: AuthUser) {
    return this.prisma.organizationMember.findMany({
      where: { userId: user.id, status: 'ACTIVE' },
      select: { role: true, org: { select: { id: true, name: true, supportEmail: true, website: true, about: true, logoUrl: true, coverUrl: true, payoutSchedule: true, bankLast4: true, bankName: true } } },
    });
  }

  async updateOrg(orgId: string, user: AuthUser, dto: UpdateOrgDto) {
    await this.member(orgId, user, ADMIN_ONLY);
    return this.prisma.organization.update({ where: { id: orgId }, data: dto });
  }

  async team(orgId: string, user: AuthUser) {
    await this.member(orgId, user, DOOR);
    return this.prisma.organizationMember.findMany({
      where: { orgId },
      select: { id: true, email: true, role: true, status: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async invite(orgId: string, user: AuthUser, dto: InviteDto) {
    await this.member(orgId, user, ADMIN_ONLY);
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    try {
      // Invites wait until the person accepts (POST /organizer/invites/accept) after signing in.
      return await this.prisma.organizationMember.create({ data: { orgId, email: dto.email, role: dto.role, userId: existing?.id ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That person is already on the team.');
      throw e;
    }
  }

  async acceptInvites(user: AuthUser) {
    const { count } = await this.prisma.organizationMember.updateMany({
      where: { email: user.email, status: 'INVITED' },
      data: { userId: user.id, status: 'ACTIVE' },
    });
    if (count && !user.roles.includes('ORGANIZER')) {
      await this.prisma.user.update({ where: { id: user.id }, data: { roles: { push: 'ORGANIZER' } } });
    }
    return { accepted: count };
  }

  async setRole(orgId: string, memberId: string, user: AuthUser, role: MemberRole) {
    const me = await this.member(orgId, user, ADMIN_ONLY);
    if (me.id === memberId) throw new BadRequestException('You can’t change your own role.');
    const { count } = await this.prisma.organizationMember.updateMany({ where: { id: memberId, orgId }, data: { role } });
    if (!count) throw new NotFoundException('Team member not found.');
    return { updated: true };
  }

  async removeMember(orgId: string, memberId: string, user: AuthUser) {
    const me = await this.member(orgId, user, ADMIN_ONLY);
    if (me.id === memberId) throw new BadRequestException('You can’t remove yourself.');
    const { count } = await this.prisma.organizationMember.deleteMany({ where: { id: memberId, orgId } });
    if (!count) throw new NotFoundException('Team member not found.');
    return { removed: true };
  }

  /* ---------- events ---------- */

  private ticketTypeData(t: TicketTypeInputDto, feeMode: FeeMode, i: number) {
    return {
      name: t.name.trim(),
      description: t.description?.trim() ?? '',
      ...pricingData(t, feeMode),
      capacity: t.capacity,
      maxPerOrder: t.maxPerOrder ?? 8,
      sortOrder: i,
      perks: cleanPerks(t.perks),
      badge: t.badge?.trim() || null,
      style: styleInput(t.style),
    };
  }

  /** The same place picked again is the venue already on Omoshow (see VenueChange.sameVenue). */
  private sameVenue(v: { name: string; city: string; lat?: number; lng?: number }, country: string | undefined) {
    return this.venues.sameVenue(v, country);
  }

  /** Creates an event; an optional `schedule` is checked first (nothing is created if it's wrong) and stored after. */
  async createEvent(orgId: string, user: AuthUser, dto: CreateEventDto) {
    if (!dto.schedule?.length) return this.createEventCore(orgId, user, dto);
    await this.member(orgId, user, EDIT);
    const plan = this.schedule.planForCreate(dto);
    const created = await this.createEventCore(orgId, user, dto);
    return { ...created, schedule: await this.schedule.insertCreated(created.id, plan) };
  }

  private async createEventCore(orgId: string, user: AuthUser, dto: CreateEventDto) {
    await this.member(orgId, user, EDIT);
    if (!dto.online && !dto.venueId && !dto.venue && !dto.venueBookingId) throw new BadRequestException('Add a venue, or mark the event as online.');
    // Times are wall-clock times in this zone, so an unknown zone would show the wrong time to everyone.
    if (dto.timezone && !isTimeZone(dto.timezone)) throw new BadRequestException(`Unknown time zone "${dto.timezone}". Use an IANA name such as Africa/Lagos.`);
    const feeMode: FeeMode = dto.feeMode ?? 'BUYER';
    const donations = rule(() => cleanDonationSettings({ donationsEnabled: false, donationCause: null, donationDescription: null, donationSuggestedCents: [], donationMinCents: null }, dto));
    // Multiple dates or a multi-day event: the dates are checked first; the event's times are their summary.
    const mode: DateMode = dto.dateMode ?? 'SINGLE';
    const planned = mode === 'SINGLE' ? null : planDates(mode, dto.dates);
    if (mode === 'SINGLE') {
      if (dto.dates?.length) throw new BadRequestException('Set dateMode to DATES or DAYS to give this event more than one date.');
      // A draft may start in the past (it can't be submitted until it doesn't), but its times have to make sense.
      checkSingleTimes({ startsAt: new Date(dto.startsAt), doorsAt: dto.doorsAt ? new Date(dto.doorsAt) : null, endsAt: dto.endsAt ? new Date(dto.endsAt) : null }, false);
      const extra = dto.ticketTypes.find((t) => t.capacityByDate || t.validDates);
      if (extra) throw new BadRequestException(`${extra.name.trim()}: capacityByDate and validDates are for events with more than one date.`);
    }
    if (planned && dto.venueBookingId) throw new BadRequestException(MULTI_DATE_BOOKING);
    let venueId = dto.venueId ?? null;
    let timezone = dto.timezone ?? 'UTC';
    // A venue booked on Omoshow: the event is held there, in the venue's zone, within the booking's times.
    const booking = dto.venueBookingId ? await this.bookings.attachable(dto.venueBookingId, orgId) : null;
    if (booking) {
      if (dto.online) throw new BadRequestException('An online event doesn’t need a venue booking.');
      assertFits(booking, { startsAt: new Date(dto.startsAt), doorsAt: dto.doorsAt ? new Date(dto.doorsAt) : null, endsAt: dto.endsAt ? new Date(dto.endsAt) : null });
      venueId = booking.venueId;
      timezone = booking.timezone;
    } else if (!venueId && dto.venue) {
      const country = dto.venue.country?.toUpperCase();
      // The venue's time zone: from its map position, else its state or province, else its country's main zone.
      const tz = (dto.venue.lat !== undefined && dto.venue.lng !== undefined ? timezoneAt(dto.venue.lat, dto.venue.lng) : null) ?? placeTimezone(country, dto.venue.region);
      // The same place picked again (same name in the same city, or within ~150 m on the map) reuses its venue,
      // so a venue keeps one page and one history of events instead of a copy per event.
      const v = (await this.sameVenue(dto.venue, country)) ?? (await this.prisma.venue.create({ data: { ...dto.venue, country, timezone: tz, slug: `${slugify(dto.venue.name)}-${randomSuffix()}` } }));
      venueId = v.id;
      timezone = dto.timezone ?? tz ?? 'UTC';
    } else if (venueId && !dto.timezone) {
      // An existing venue: its own zone (else its state's or country's), never UTC by accident.
      const v = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true, country: true, region: true } });
      if (!v) throw new BadRequestException('That venue doesn’t exist.');
      timezone = v.timezone ?? placeTimezone(v.country, v.region) ?? 'UTC';
    }
    const data = {
      orgId,
      venueId,
      slug: `${slugify(dto.title)}-${randomSuffix()}`,
      title: dto.title.trim(),
      subtitle: dto.subtitle?.trim() ?? '',
      description: dto.description?.trim() ?? '',
      category: dto.category,
      imageUrl: dto.imageUrl,
      // DATES/DAYS: a placeholder until the dates are in (EventDatesService.syncSummary sets the summary).
      startsAt: planned ? planned[0].startsAt : new Date(dto.startsAt),
      doorsAt: planned ? null : dto.doorsAt ? new Date(dto.doorsAt) : null,
      endsAt: planned ? null : dto.endsAt ? new Date(dto.endsAt) : null,
      dateMode: mode,
      timezone,
      currency: dto.currency ?? 'USD',
      online: !!dto.online,
      streamUrl: dto.streamUrl,
      feeMode,
      visibility: dto.visibility ?? 'PUBLIC',
      ...donations,
      compLimit: dto.compLimit ?? null,
      ticketTypes: { create: planned ? [] : dto.ticketTypes.map((t, i) => this.ticketTypeData(t, feeMode, i)) },
    } satisfies Prisma.EventUncheckedCreateInput;
    if (planned) {
      const tiers: TierInput[] = dto.ticketTypes.map((t, i) => ({ data: this.ticketTypeData(t, feeMode, i), capacityByDate: t.capacityByDate, validDates: t.validDates }));
      const id = await this.prisma.$transaction(
        async (tx) => {
          const e = await tx.event.create({ data });
          await this.dates.create(tx, e.id, mode, planned, tiers);
          return e.id;
        },
        { timeout: 30_000 },
      );
      const created = await this.prisma.event.findUniqueOrThrow({ where: { id }, include: { ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, dates: { orderBy: { startsAt: 'asc' } } } });
      return { ...created, ticketTypes: created.ticketTypes.map(withLook), dates: created.dates.map(dateView) };
    }
    if (!booking) {
      const created = await this.prisma.event.create({ data, include: { ticketTypes: true } });
      return { ...created, ticketTypes: created.ticketTypes.map(withLook), dates: [] };
    }
    const ev = await this.prisma.$transaction(async (tx) => {
      const e = await tx.event.create({ data, include: { ticketTypes: true } });
      const { count } = await tx.venueBooking.updateMany({ where: { id: booking.id, orgId, eventId: null }, data: { eventId: e.id } });
      if (!count) throw new ConflictException({ statusCode: 409, code: 'BOOKING_IN_USE', message: `Booking ${booking.code} is already used by another event.` });
      return e;
    });
    await this.audit.log(user.id, 'event.venue_booking', 'Event', ev.id, { bookingId: booking.id, status: booking.status });
    return { ...ev, ticketTypes: ev.ticketTypes.map(withLook), venueBooking: VenueBookingService.eventSummary(booking) };
  }

  /** The organizer's events with ticket types and 60 days of daily sales (for the dashboard). */
  async listEvents(orgId: string, user: AuthUser) {
    await this.member(orgId, user, DOOR);
    const events = await this.prisma.event.findMany({
      where: { orgId },
      include: { ticketTypes: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, dates: { orderBy: { startsAt: 'asc' } }, venue: { select: { name: true, city: true, address: true, country: true, region: true } }, venueBooking: true },
      orderBy: { startsAt: 'asc' },
    });
    const days = 60;
    const since = new Date(Date.now() - days * DAY);
    const orders = await this.prisma.order.findMany({
      where: { event: { orgId }, kind: 'SALE', status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since } },
      select: { eventId: true, paidAt: true, quantity: true, subtotalCents: true, discountCents: true },
    });
    const money = await this.salesMoney(events.map((e) => e.id));
    const keys = Array.from({ length: days }, (_, i) => dayKey(new Date(Date.now() - (days - 1 - i) * DAY)));
    const index = new Map(keys.map((k, i) => [k, i]));
    const daily = new Map<string, { tickets: number[]; cents: number[] }>();
    for (const o of orders) {
      const i = index.get(dayKey(o.paidAt!));
      if (i === undefined) continue;
      const d = daily.get(o.eventId) ?? { tickets: Array(days).fill(0), cents: Array(days).fill(0) };
      d.tickets[i] += o.quantity;
      d.cents[i] += o.subtotalCents - o.discountCents;
      daily.set(o.eventId, d);
    }
    return events.map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      subtitle: e.subtitle,
      description: e.description,
      category: e.category,
      status: e.status,
      /** when it first went on sale (null until approved) */
      publishedAt: e.publishedAt,
      previewToken: previewToken(e.slug, e.status),
      reviewNote: e.reviewNote,
      salesPaused: e.salesPaused,
      feeMode: e.feeMode,
      currency: e.currency,
      timezone: e.timezone,
      startsAt: e.startsAt,
      dateMode: e.dateMode,
      dates: e.dates.map(dateView),
      nextDate: nextDateView(e.dateMode, e.dates),
      venue: e.venue,
      online: e.online,
      imageUrl: e.imageUrl,
      hasSeatMap: !!e.seatMap,
      venueBooking: VenueBookingService.eventSummary(e.venueBooking),
      ticketTypes: e.ticketTypes.map((t) =>
        withLook({
          id: t.id,
          name: t.name,
          description: t.description,
          priceCents: t.priceCents,
          capacity: t.capacity,
          // sales only: comps are counted apart (both count against capacity)
          sold: t.sold - (money.compsByType.get(t.id) ?? 0),
          comps: money.compsByType.get(t.id) ?? 0,
          maxPerOrder: t.maxPerOrder,
          sortOrder: t.sortOrder,
          perks: t.perks,
          badge: t.badge,
          style: t.style,
          pricing: t.pricing,
          pwywMinCents: t.pwywMinCents,
          pwywSuggestedCents: t.pwywSuggestedCents,
          pwywMaxCents: t.pwywMaxCents,
          pwywQuickPicks: t.pwywQuickPicks,
          eventDateId: t.eventDateId,
          tierKey: t.tierKey,
          validDateIds: t.validDateIds,
        }),
      ),
      sold: e.ticketTypes.reduce((s, t) => s + t.sold, 0) - (money.comps.get(e.id) ?? 0),
      comps: money.comps.get(e.id) ?? 0,
      // a cancelled date's tier copies no longer count
      capacity: e.ticketTypes.filter((t) => liveType(t, e.dates)).reduce((s, t) => s + t.capacity, 0),
      // face value of the live sold tickets (what each was bought for; comps excluded), and donations apart
      grossCents: money.gross.get(e.id) ?? 0,
      donationsCents: money.donations.get(e.id) ?? 0,
      daily: daily.get(e.id) ?? { tickets: Array(days).fill(0), cents: Array(days).fill(0) },
    }));
  }

  /**
   * Ticket money per event from the tickets that still count (not void) on sales (comps excluded): `gross` is their
   * face value (each order's all-in unitCents, so pay-what-you-want amounts count as paid), `net` the organizer's
   * share of it. Also live comps per event and ticket type, and net donations per event.
   */
  private async salesMoney(eventIds: string[]) {
    const gross = new Map<string, number>();
    const net = new Map<string, number>();
    const comps = new Map<string, number>();
    const compsByType = new Map<string, number>();
    const grossByType = new Map<string, number>();
    const donations = new Map<string, number>();
    if (!eventIds.length) return { gross, net, comps, compsByType, grossByType, donations };
    const rows = await this.prisma.$queryRaw<{ eventId: string; ticketTypeId: string; kind: string; unitCents: number; feeMode: FeeMode; n: bigint }[]>`
      SELECT t."eventId", t."ticketTypeId", o."kind"::text AS kind, o."unitCents", e."feeMode"::text AS "feeMode", COUNT(*) AS n
      FROM "Ticket" t JOIN "Order" o ON o.id = t."orderId" JOIN "Event" e ON e.id = t."eventId"
      WHERE t."eventId" IN (${Prisma.join(eventIds)}) AND t.status <> 'VOID' AND o."resaleListingId" IS NULL
      GROUP BY t."eventId", t."ticketTypeId", o."kind", o."unitCents", e."feeMode"`;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.kind === 'COMP') {
        comps.set(r.eventId, (comps.get(r.eventId) ?? 0) + n);
        compsByType.set(r.ticketTypeId, (compsByType.get(r.ticketTypeId) ?? 0) + n);
        continue;
      }
      gross.set(r.eventId, (gross.get(r.eventId) ?? 0) + r.unitCents * n);
      grossByType.set(r.ticketTypeId, (grossByType.get(r.ticketTypeId) ?? 0) + r.unitCents * n);
      net.set(r.eventId, (net.get(r.eventId) ?? 0) + organizerNet(r.unitCents, r.feeMode, config.organizerFeePermille) * n);
    }
    const d = await this.prisma.order.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds }, kind: 'SALE', status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, donationCents: { gt: 0 } },
      _sum: { donationCents: true, donationRefundedCents: true },
    });
    for (const x of d) donations.set(x.eventId, (x._sum.donationCents ?? 0) - (x._sum.donationRefundedCents ?? 0));
    return { gross, net, comps, compsByType, grossByType, donations };
  }

  /**
   * The door scanner's event picker: events from 2 days ago to 60 days ahead, soonest first, with how many tickets
   * are out (non-void) and how many are in. Same access as check-in (DOOR and up). Drafts have no tickets and are left out.
   */
  async doorEvents(orgId: string, user: AuthUser) {
    await this.member(orgId, user, DOOR);
    const now = Date.now();
    const events = await this.prisma.event.findMany({
      // DATES/DAYS: any active date in the window (a run whose first show has passed is still at the door).
      where: { orgId, status: { not: 'DRAFT' }, ...dateRangeWhere(new Date(now - 2 * DAY), new Date(now + 60 * DAY)) },
      select: { id: true, slug: true, title: true, startsAt: true, doorsAt: true, timezone: true, online: true, status: true, dateMode: true, dates: { orderBy: { startsAt: 'asc' } }, venue: { select: { name: true, city: true } } },
      orderBy: { startsAt: 'asc' },
    });
    const ids = events.map((e) => e.id);
    const counts = ids.length
      ? await this.prisma.ticket.groupBy({ by: ['eventId', 'status'], where: { eventId: { in: ids }, status: { not: 'VOID' } }, _count: { _all: true } })
      : [];
    const issued = new Map<string, number>();
    const inside = new Map<string, number>();
    for (const c of counts) {
      issued.set(c.eventId, (issued.get(c.eventId) ?? 0) + c._count._all);
      if (c.status === 'CHECKED_IN') inside.set(c.eventId, (inside.get(c.eventId) ?? 0) + c._count._all);
    }
    // Per date: entries through the door that date (TicketCheckIn), so the picker can show "312 in" for today.
    const dateIds = events.flatMap((e) => e.dates.map((d) => d.id));
    const perDate = dateIds.length ? await this.prisma.ticketCheckIn.groupBy({ by: ['eventDateId'], where: { eventDateId: { in: dateIds } }, _count: { _all: true } }) : [];
    const inOn = new Map(perDate.map((c) => [c.eventDateId, c._count._all]));
    return events.map(({ dates, dateMode, ...e }) => ({
      ...e,
      ticketsIssued: issued.get(e.id) ?? 0,
      checkedIn: inside.get(e.id) ?? 0,
      // Multiple dates and multi-day events only (one-date events keep today's shape): the dates with entries on each,
      // and the date the door works on by default (today's at the venue, else the next).
      ...(dateMode === 'SINGLE'
        ? {}
        : { dateMode, dates: dates.map((d) => ({ ...dateView(d), checkedIn: inOn.get(d.id) ?? 0 })), currentDateId: doorDate(dates, e.timezone)?.id ?? null }),
    }));
  }

  /** Latest paid orders across the organization's events. */
  async recentOrders(orgId: string, user: AuthUser) {
    await this.member(orgId, user, EDIT);
    return this.prisma.order.findMany({
      where: { event: { orgId }, kind: 'SALE', status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      orderBy: { paidAt: 'desc' },
      take: 8,
      select: { id: true, buyerName: true, quantity: true, totalCents: true, currency: true, paidAt: true, ticketType: { select: { name: true } }, event: { select: { title: true } } },
    });
  }

  async getEvent(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, DOOR);
    const promos = await this.prisma.promo.findMany({ where: { eventId: id }, orderBy: { code: 'asc' } });
    const venue = ev.venueId ? await this.prisma.venue.findUnique({ where: { id: ev.venueId } }) : null;
    const booking = await this.prisma.venueBooking.findUnique({ where: { eventId: id } });
    return {
      ...ev,
      ticketTypes: ev.ticketTypes.map(withLook),
      dates: ev.dates.map(dateView),
      venue,
      promos,
      media: ((ev.media as MediaItem[] | null) ?? []).map(mediaUrls),
      previewToken: previewToken(ev.slug, ev.status),
      /** The venue booked on Omoshow for this event (status, code); the event can't be submitted until it's CONFIRMED */
      venueBooking: VenueBookingService.eventSummary(booking),
    };
  }

  async updateEvent(id: string, user: AuthUser, dto: UpdateEventDto) {
    const ev = await this.eventFor(id, user, EDIT);
    const mode = dto.dateMode ?? ev.dateMode;
    if (mode !== 'SINGLE' && (dto.dateMode !== undefined || dto.dates !== undefined)) {
      if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
      const booking = await this.prisma.venueBooking.findUnique({ where: { eventId: id } });
      if (booking && isLive(booking)) throw new BadRequestException(MULTI_DATE_BOOKING.replace('Pick the venue for this event instead.', 'Detach the venue booking first.'));
    }
    // DATES/DAYS: the event's times come from its dates (sent times are ignored).
    if (mode !== 'SINGLE') {
      dto.startsAt = undefined;
      dto.doorsAt = undefined;
      dto.endsAt = undefined;
    }
    if (dto.startsAt || dto.doorsAt || dto.endsAt) {
      // Switching back to one date: the times sent with it (the old dates' summary doesn't apply).
      const switching = ev.dateMode !== 'SINGLE';
      const next = {
        startsAt: dto.startsAt ? new Date(dto.startsAt) : ev.startsAt,
        doorsAt: dto.doorsAt ? new Date(dto.doorsAt) : switching ? null : ev.doorsAt,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : switching ? null : ev.endsAt,
      };
      checkSingleTimes(next, next.startsAt.getTime() !== ev.startsAt.getTime());
      // Held at a booked venue: the new times still have to sit within the booking.
      const booking = await this.prisma.venueBooking.findUnique({ where: { eventId: id } });
      if (booking && isLive(booking)) {
        assertFits(booking, {
          startsAt: dto.startsAt ? new Date(dto.startsAt) : ev.startsAt,
          doorsAt: dto.doorsAt ? new Date(dto.doorsAt) : ev.doorsAt,
          endsAt: dto.endsAt ? new Date(dto.endsAt) : ev.endsAt,
        });
      }
    }
    const data: Prisma.EventUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
      ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
      ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
      ...(dto.doorsAt ? { doorsAt: new Date(dto.doorsAt) } : {}),
      ...(dto.endsAt ? { endsAt: new Date(dto.endsAt) } : {}),
      // Back to one date with a new start: the old dates' doors and end go if they no longer fit it.
      ...(ev.dateMode !== 'SINGLE' && dto.startsAt && !dto.endsAt && ev.endsAt && ev.endsAt <= new Date(dto.startsAt) ? { endsAt: null } : {}),
      ...(ev.dateMode !== 'SINGLE' && dto.startsAt && !dto.doorsAt && ev.doorsAt && ev.doorsAt > new Date(dto.startsAt) ? { doorsAt: null } : {}),
      ...(dto.visibility ? { visibility: dto.visibility } : {}),
      ...(dto.resaleEnabled !== undefined ? { resaleEnabled: dto.resaleEnabled } : {}),
      ...(dto.resaleCapPercent !== undefined ? { resaleCapPercent: dto.resaleCapPercent } : {}),
      ...(dto.resaleRoyaltyPermille !== undefined ? { resaleRoyaltyPermille: dto.resaleRoyaltyPermille } : {}),
      ...(dto.transfersEnabled !== undefined ? { transfersEnabled: dto.transfersEnabled } : {}),
      ...(dto.transferCutoffMinutes !== undefined ? { transferCutoffMinutes: dto.transferCutoffMinutes } : {}),
      ...(dto.compLimit !== undefined ? { compLimit: dto.compLimit } : {}),
    };
    // A live event's title, subtitle and cover wait for Omoshow to check them (see domain/pending-edit); fans keep
    // seeing the approved ones. Before it's live they change at once (the event's own review covers them), and any
    // older waiting change to the same field is dropped.
    let heldForReview: string[] = [];
    const reviewed = { title: dto.title?.trim(), subtitle: dto.subtitle?.trim(), imageUrl: dto.imageUrl };
    if (Object.values(reviewed).some((v) => v !== undefined)) {
      const live = ev.status === 'PUBLISHED' ? ev : { ...ev, ...Object.fromEntries(Object.entries(reviewed).filter(([, v]) => v !== undefined)) };
      const { held, next } = holdLiveEdit(live, reviewed, user.id);
      if (ev.status === 'PUBLISHED') {
        heldForReview = held;
        for (const k of ['title', 'subtitle', 'imageUrl'] as const) delete (data as Record<string, unknown>)[k];
      }
      if (next || readPendingEdit(ev.pendingEdit)) data.pendingEdit = pendingEditJson(next) ?? Prisma.DbNull;
      if (held.length) data.pendingEditNote = null;
    }
    const donationKeys = ['donationsEnabled', 'donationCause', 'donationDescription', 'donationSuggestedCents', 'donationMinCents'] as const;
    if (donationKeys.some((k) => dto[k] !== undefined)) {
      Object.assign(data, rule(() => cleanDonationSettings(ev, dto)));
      await this.audit.log(user.id, 'event.donations', 'Event', id, Object.fromEntries(donationKeys.map((k) => [k, (data as Record<string, unknown>)[k]])) as Prisma.InputJsonValue);
    }
    if (dto.dateMode !== undefined || dto.dates !== undefined) {
      const before = ev.dates.map(dateView);
      const dates = await this.prisma.$transaction((tx) => this.dates.update(tx, ev, dto.dateMode, dto.dates), { timeout: 30_000 });
      if (dto.dateMode !== undefined && dto.dateMode !== ev.dateMode) await this.audit.log(user.id, 'event.date_mode', 'Event', id, { from: ev.dateMode, to: dto.dateMode });
      else await this.audit.log(user.id, 'event.dates', 'Event', id, { before: before.map((d) => ({ id: d.id, startsAt: d.startsAt.toISOString(), label: d.label })), after: dates.map((d) => ({ id: d.id, startsAt: d.startsAt.toISOString(), label: d.label })) });
    }
    const updated = await this.prisma.event.update({ where: { id }, data, include: { dates: { orderBy: { startsAt: 'asc' } } } });
    // A live event moved after tickets were sold: holders hear, and buyers can take a refund (see DateChangeService).
    const moves: Move[] =
      updated.dateMode === 'SINGLE'
        ? ev.dateMode === 'SINGLE' && updated.startsAt.getTime() !== ev.startsAt.getTime()
          ? [{ eventDateId: null, from: ev.startsAt, to: updated.startsAt }]
          : []
        : updated.dates.flatMap((d) => {
            const old = ev.dates.find((x) => x.id === d.id);
            return old && isActive(old) && isActive(d) && old.startsAt.getTime() !== d.startsAt.getTime() ? [{ eventDateId: d.id, from: old.startsAt, to: d.startsAt }] : [];
          });
    const dateChanges = moves.length ? await this.dateChanges.record(id, moves, dto.changeReason, user) : [];
    if (heldForReview.length) await this.audit.log(user.id, 'event.edit_submit', 'Event', id, { fields: heldForReview });
    return { ...updated, dates: updated.dates.map(dateView), dateChanges, heldForReview };
  }

  /** Moves an in-person event to another venue; see VenueChange. Admins and managers, like editing. */
  async changeVenue(id: string, user: AuthUser, dto: ChangeVenueDto) {
    const ev = await this.eventFor(id, user, EDIT);
    // A venue booked on Omoshow stays until the booking is cancelled or detached; one that fell through is let go.
    const booking = await this.prisma.venueBooking.findUnique({ where: { eventId: id } });
    if (booking && isLive(booking)) {
      throw new ConflictException({ statusCode: 409, code: 'VENUE_BOOKED', message: `This event is booked at its venue on Omoshow (${booking.code}). Cancel the booking, or detach it from the event, before moving it.` });
    }
    const out = await this.venues.change(ev, user, dto);
    if (booking) await this.prisma.venueBooking.updateMany({ where: { id: booking.id, eventId: id }, data: { eventId: null } });
    return out;
  }

  /**
   * Holds the event at a venue booked on Omoshow (PUT /organizer/events/:id/venue-booking). The event moves to the
   * booking's venue (through VenueChange, so ticket holders of a published event hear about it) and has to happen
   * within the booking's times. Events in review or on sale only take a confirmed booking.
   */
  async attachBooking(id: string, user: AuthUser, dto: AttachBookingDto) {
    const ev = await this.eventFor(id, user, EDIT);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    if (ev.online) throw new BadRequestException('This is an online event, so it doesn’t need a venue booking.');
    if (ev.dateMode !== 'SINGLE') throw new BadRequestException(MULTI_DATE_BOOKING);
    const current = await this.prisma.venueBooking.findUnique({ where: { eventId: id } });
    if (current && current.id !== dto.bookingId && isLive(current)) {
      throw new ConflictException({ statusCode: 409, code: 'EVENT_ALREADY_BOOKED', message: `This event already has a venue booking (${current.code}). Cancel or detach it first.` });
    }
    const b = await this.bookings.attachable(dto.bookingId, ev.orgId, id);
    assertFits(b, ev);
    const onSale = ev.status === 'IN_REVIEW' || ev.status === 'PUBLISHED';
    if (onSale && b.status !== 'CONFIRMED') {
      throw new ConflictException({
        statusCode: 409,
        code: 'VENUE_BOOKING_PENDING',
        message: `This event is already ${ev.status === 'PUBLISHED' ? 'on sale' : 'in review'}, so it can only move to a confirmed booking. Wait for the venue to confirm ${b.code}.`,
      });
    }
    let change: Awaited<ReturnType<VenueChange['change']>> | null = null;
    if (ev.venueId !== b.venueId) change = await this.venues.change(ev, user, { venueId: b.venueId });
    else if (ev.timezone !== b.timezone) await this.prisma.event.update({ where: { id }, data: { timezone: b.timezone } });
    await this.prisma.$transaction(async (tx) => {
      await tx.venueBooking.updateMany({ where: { eventId: id, NOT: { id: b.id } }, data: { eventId: null } });
      const { count } = await tx.venueBooking.updateMany({ where: { id: b.id, OR: [{ eventId: null }, { eventId: id }] }, data: { eventId: id } });
      if (!count) throw new ConflictException({ statusCode: 409, code: 'BOOKING_IN_USE', message: `Booking ${b.code} is already used by another event.` });
    });
    await this.audit.log(user.id, 'event.venue_booking', 'Event', id, { bookingId: b.id, status: b.status });
    return { venueBooking: VenueBookingService.eventSummary(b), venueChange: change };
  }

  /** Lets go of the event's venue booking (the booking itself stays; cancel it separately). The venue stays. */
  async detachBooking(id: string, user: AuthUser) {
    await this.eventFor(id, user, EDIT);
    const { count } = await this.prisma.venueBooking.updateMany({ where: { eventId: id }, data: { eventId: null } });
    if (!count) throw new NotFoundException('This event has no venue booking.');
    await this.audit.log(user.id, 'event.venue_booking.detach', 'Event', id);
    return { detached: true };
  }

  async addTicketType(id: string, user: AuthUser, dto: TicketTypeInputDto) {
    const ev = await this.eventFor(id, user, EDIT);
    if (ev.dateMode === 'SINGLE') {
      if (dto.capacityByDate || dto.validDates) throw new BadRequestException('capacityByDate and validDates are for events with more than one date.');
      return withLook(await this.prisma.ticketType.create({ data: { eventId: id, ...this.ticketTypeData(dto, ev.feeMode, ev.ticketTypes.length) } }));
    }
    // DATES: one copy per active date (returned as `copies`, the first one being the answer itself); DAYS: one type.
    const tiers = new Set(ev.ticketTypes.map((t) => seatTier(t))).size;
    const made = await this.prisma.$transaction((tx) => this.dates.addTier(tx, ev, { data: this.ticketTypeData(dto, ev.feeMode, tiers), capacityByDate: dto.capacityByDate, validDates: dto.validDates }));
    if (!made.length) throw new BadRequestException('This event has no active dates to sell on.');
    return { ...withLook(made[0]), copies: made.map(withLook) };
  }

  async updateTicketType(id: string, ttId: string, user: AuthUser, dto: UpdateTicketTypeDto) {
    const ev = await this.eventFor(id, user, EDIT);
    const tt = ev.ticketTypes.find((t) => t.id === ttId);
    if (!tt) throw new NotFoundException('Ticket type not found.');
    // DATES: the edit goes to every copy of the tier (one per date); capacity is per copy.
    const copies = ev.dateMode === 'DATES' && tt.tierKey ? ev.ticketTypes.filter((t) => t.tierKey === tt.tierKey) : [tt];
    if (ev.dateMode !== 'DATES' && dto.capacityByDate) throw new BadRequestException('capacityByDate is for events with multiple dates.');
    if (ev.dateMode !== 'DAYS' && dto.validDates) throw new BadRequestException('validDates is for multi-day events.');
    const caps = new Map<string, number>();
    if (dto.capacity !== undefined) for (const c of copies) caps.set(c.id, dto.capacity);
    if (dto.capacityByDate) {
      const byDate = capacitiesFor(tt.name, -1, dto.capacityByDate, ev.dates);
      for (const c of copies) if ((byDate.get(c.eventDateId ?? '') ?? -1) >= 0) caps.set(c.id, byDate.get(c.eventDateId!)!);
    }
    for (const c of copies) {
      const n = caps.get(c.id);
      if (n !== undefined && n < c.sold) {
        const d = ev.dates.find((x) => x.id === c.eventDateId);
        throw new BadRequestException(`Capacity can’t be below the ${c.sold} already sold${d ? ` for ${dateName(d)}` : ''}.`);
      }
    }
    let validDateIds: string[] | undefined;
    if (dto.validDates) {
      validDateIds = daysFor(tt.name, dto.validDates, ev.dates);
      if (tt.sold > 0 && tt.validDateIds.some((d) => !validDateIds!.includes(d))) throw new BadRequestException('Tickets of this type have been sold, so its days can only be added to, not taken away.');
    }
    if (caps.size && ev.seatMap && (ev.seatMap as SeatMap).sections.some((s) => s.ticketTypeId === seatTier(tt))) {
      throw new BadRequestException('This ticket type’s capacity comes from the seat map. Change the sections instead.');
    }
    // Pricing: switching to (or changing) pay what you want, or back to a fixed price.
    const pricing = dto.pricing ?? tt.pricing;
    const pwywTouched = dto.pricing !== undefined || dto.pwywMinCents !== undefined || dto.pwywSuggestedCents !== undefined || dto.pwywMaxCents !== undefined || dto.pwywQuickPicks !== undefined;
    let pricingData: Prisma.TicketTypeUpdateInput = {};
    if (pricing === 'PWYW' && pwywTouched) {
      const merged = {
        pwywMinCents: dto.pwywMinCents !== undefined ? dto.pwywMinCents : (tt.pwywMinCents ?? dto.basePriceCents ?? 0),
        pwywSuggestedCents: dto.pwywSuggestedCents !== undefined ? dto.pwywSuggestedCents : tt.pwywSuggestedCents,
        pwywMaxCents: dto.pwywMaxCents !== undefined ? dto.pwywMaxCents : tt.pwywMaxCents,
        pwywQuickPicks: dto.pwywQuickPicks !== undefined ? dto.pwywQuickPicks : tt.pwywQuickPicks,
      };
      const p = rule(() => cleanPwywInput(merged));
      pricingData = { pricing: 'PWYW', ...p, priceCents: buyerPrice(p.pwywMinCents, ev.feeMode, config.organizerFeePermille) };
    } else if (pricing === 'FIXED' && tt.pricing === 'PWYW') {
      if (dto.basePriceCents === undefined) throw new BadRequestException('Set a price to switch this ticket type back to a fixed price.');
      pricingData = { pricing: 'FIXED', pwywMinCents: null, pwywSuggestedCents: null, pwywMaxCents: null, pwywQuickPicks: [] };
    } else if (pricing === 'PWYW' && dto.basePriceCents !== undefined) {
      throw new BadRequestException('This ticket type is pay what you want: change its minimum (pwywMinCents) instead of the price.');
    }
    const shared: Prisma.TicketTypeUpdateManyMutationInput = {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
        ...(dto.basePriceCents !== undefined && pricing === 'FIXED' ? { priceCents: buyerPrice(dto.basePriceCents, ev.feeMode, config.organizerFeePermille) } : {}),
        ...(pricingData as Prisma.TicketTypeUpdateManyMutationInput),
        ...(dto.maxPerOrder !== undefined ? { maxPerOrder: dto.maxPerOrder } : {}),
        ...(dto.perks !== undefined ? { perks: cleanPerks(dto.perks) } : {}),
        ...(dto.badge !== undefined ? { badge: dto.badge.trim() || null } : {}),
        // null or "auto" goes back to the look from the name.
        ...(dto.style !== undefined ? { style: styleInput(dto.style) } : {}),
        ...(validDateIds ? { validDateIds } : {}),
    };
    const updated = await this.prisma.$transaction(async (tx) => {
      if (Object.keys(shared).length) await tx.ticketType.updateMany({ where: { id: { in: copies.map((c) => c.id) } }, data: shared });
      for (const [cid, capacity] of caps) await tx.ticketType.update({ where: { id: cid }, data: { capacity } });
      return tx.ticketType.findUniqueOrThrow({ where: { id: ttId } });
    });
    let priceDrop: Awaited<ReturnType<PriceDropService['record']>> = null;
    if (updated.priceCents !== tt.priceCents || pwywTouched) {
      await this.audit.log(user.id, 'ticket_type.price', 'TicketType', ttId, { eventId: id, fromCents: tt.priceCents, toCents: updated.priceCents, currency: ev.currency, pricing: updated.pricing, pwywMinCents: updated.pwywMinCents, pwywMaxCents: updated.pwywMaxCents });
      // A pay-what-you-want minimum isn't a price fans pay, so a lower one isn't announced as a price drop.
      if (updated.priceCents !== tt.priceCents && updated.pricing === 'FIXED' && tt.pricing === 'FIXED') {
        const venue = ev.venueId ? await this.prisma.venue.findUnique({ where: { id: ev.venueId }, select: { name: true, city: true } }) : null;
        // Multiple dates: the drop is about the edited copy's date (or the pass's first day), not the event's first date.
        priceDrop = await this.priceDrops.record({ ...ev, venue, startsAt: ticketTimes(ev.dateMode, ev, updated, ev.dates).first.startsAt }, updated, tt.priceCents, updated.priceCents, user.id);
      }
    }
    if (copies.length > 1) {
      const all = await this.prisma.ticketType.findMany({ where: { id: { in: copies.map((c) => c.id) } } });
      return { ...withLook(updated), copies: all.map(withLook), priceDrop };
    }
    return { ...withLook(updated), priceDrop };
  }

  /** Puts the event's ticket types in a new order, top tier first (it's the order fans see them in). */
  async orderTicketTypes(id: string, user: AuthUser, ids: string[]) {
    const ev = await this.eventFor(id, user, EDIT);
    // DATES: one id per tier (any of its copies, or its tierKey); every copy moves with it.
    const tierOf = (x: string) => {
      const t = ev.ticketTypes.find((y) => y.id === x || (ev.dateMode === 'DATES' && y.tierKey === x));
      return t ? seatTier(t) : null;
    };
    const known = new Set(ev.ticketTypes.map((t) => seatTier(t)));
    const tiers = ids.map(tierOf);
    if (ids.length !== known.size || new Set(tiers).size !== ids.length || tiers.some((x) => !x)) {
      throw new BadRequestException(ev.dateMode === 'DATES' ? 'Send every ticket tier of this event exactly once.' : 'Send every ticket type of this event exactly once.');
    }
    await this.prisma.$transaction(tiers.map((k, i) => this.prisma.ticketType.updateMany({ where: { eventId: id, OR: [{ id: k! }, { tierKey: k! }] }, data: { sortOrder: i } })));
    await this.audit.log(user.id, 'ticket_type.order', 'Event', id, { ids });
    return (await this.prisma.ticketType.findMany({ where: { eventId: id }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map(withLook);
  }

  /** How many people a price drop on this event would reach right now (for the organizer's price screen). */
  async priceDropAudience(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    const venue = ev.venueId ? await this.prisma.venue.findUnique({ where: { id: ev.venueId }, select: { name: true, city: true } }) : null;
    const audience = await this.priceDrops.audience({ ...ev, venue });
    const watchers = audience.filter((a) => a.via === 'watch').length;
    const drops = await this.prisma.priceDrop.findMany({ where: { eventId: id }, orderBy: { createdAt: 'desc' }, take: 10 });
    return { watchers, subscribers: audience.length - watchers, total: audience.length, published: ev.status === 'PUBLISHED', drops };
  }

  async deleteTicketType(id: string, ttId: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    const tt = ev.ticketTypes.find((t) => t.id === ttId);
    if (!tt) throw new NotFoundException('Ticket type not found.');
    // DATES: the whole tier goes (every date’s copy).
    const copies = ev.dateMode === 'DATES' && tt.tierKey ? ev.ticketTypes.filter((t) => t.tierKey === tt.tierKey) : [tt];
    if (copies.some((c) => c.sold > 0)) throw new BadRequestException('Tickets of this type have been sold, so it can’t be deleted.');
    if (new Set(ev.ticketTypes.map((t) => seatTier(t))).size === 1) throw new BadRequestException('An event needs at least one ticket type.');
    if (ev.seatMap && (ev.seatMap as SeatMap).sections.some((s) => s.ticketTypeId === seatTier(tt))) throw new BadRequestException('Remove this ticket type from the seat map first.');
    await this.prisma.ticketType.deleteMany({ where: { id: { in: copies.map((c) => c.id) } } });
    return { deleted: true };
  }

  /** Suspended organizers can't put events in front of fans. */
  private async notSuspended(orgId: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { suspendedAt: true, suspendReason: true } });
    if (org?.suspendedAt) throw new ForbiddenException(`This organizer account is suspended${org.suspendReason ? `: ${org.suspendReason}` : '.'} Contact Omoshow support.`);
  }

  async submit(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    await this.notSuspended(ev.orgId);
    if (ev.status !== 'DRAFT' && ev.status !== 'REJECTED') throw new BadRequestException('Only drafts and rejected events can be submitted.');
    if (ev.dateMode === 'SINGLE' ? ev.startsAt <= new Date() : !nextActive(ev.dates)) throw new BadRequestException(ev.dateMode === 'SINGLE' ? 'The event date is in the past.' : 'Every date of this event is in the past.');
    // Held at a venue booked on Omoshow: only once the venue has confirmed.
    const held = await this.bookings.submitBlock(id);
    if (held) throw new ConflictException(held);
    // A change that was waiting while it was live (it was taken down since) goes into this full review.
    const pe = readPendingEdit(ev.pendingEdit);
    const folded = pe
      ? {
          ...(pe.title !== undefined ? { title: pe.title } : {}),
          ...(pe.subtitle !== undefined ? { subtitle: pe.subtitle } : {}),
          ...(pe.imageUrl !== undefined ? { imageUrl: pe.imageUrl } : {}),
          ...(pe.media !== undefined ? { media: pe.media as Prisma.InputJsonValue } : {}),
          pendingEdit: Prisma.DbNull,
        }
      : {};
    return this.prisma.event.update({ where: { id }, data: { status: 'IN_REVIEW', reviewNote: null, ...folded } });
  }

  /** Withdraws a change waiting for Omoshow's check (fans keep seeing the live version). */
  async withdrawEdit(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    if (!readPendingEdit(ev.pendingEdit)) throw new NotFoundException('There’s no change waiting for review.');
    await this.prisma.event.update({ where: { id }, data: { pendingEdit: Prisma.DbNull } });
    await this.audit.log(user.id, 'event.edit_withdraw', 'Event', id);
    return { withdrawn: true };
  }

  /** What cancelling would refund. Org admins only, like cancelling itself. */
  async cancelPreview(id: string, user: AuthUser) {
    await this.eventFor(id, user, ADMIN_ONLY);
    return this.cancellation.preview(id);
  }

  /** Cancels the event and refunds every paid order (see EventCancellation). The title must be typed to confirm. */
  async cancelEvent(id: string, user: AuthUser, reason: string, confirmTitle: string) {
    const ev = await this.eventFor(id, user, ADMIN_ONLY);
    if (confirmTitle.trim() !== ev.title.trim()) throw new BadRequestException('Type the event title exactly as it appears to confirm.');
    // Once it has started, fans may already have been in: only Omoshow can cancel and refund it then. A retry of an
    // event already cancelled (refunds that failed) is always allowed.
    const now = new Date();
    const started = ev.dateMode === 'SINGLE' ? ev.startsAt <= now : ev.dates.some((d) => isActive(d) && d.startsAt <= now);
    if (ev.status !== 'CANCELLED' && started) {
      throw new ConflictException({
        statusCode: 409,
        code: 'EVENT_STARTED',
        message:
          ev.dateMode === 'SINGLE'
            ? 'This event has already started, so it can’t be cancelled from here. Contact Omoshow if it needs to be called off and refunded.'
            : 'Part of this event has already happened, so it can’t be cancelled as a whole. Cancel the dates still to come one at a time, or contact Omoshow.',
      });
    }
    return this.cancellation.cancel(id, user, reason, 'organizer');
  }

  /** What cancelling one date (DATES) would refund. Org admins only, like cancelling. */
  async cancelDatePreview(id: string, dateId: string, user: AuthUser) {
    await this.eventFor(id, user, ADMIN_ONLY);
    return this.cancellation.previewDate(id, dateId);
  }

  /** Cancels one date of a multiple-dates event and refunds its orders (see EventCancellation.cancelDate). Org admins only. */
  async cancelDate(id: string, dateId: string, user: AuthUser, reason: string | undefined) {
    const ev = await this.eventFor(id, user, ADMIN_ONLY);
    const d = ev.dates.find((x) => x.id === dateId);
    if (d && isActive(d) && d.startsAt <= new Date()) {
      throw new ConflictException({ statusCode: 409, code: 'DATE_STARTED', message: `${dateName(d)} has already started, so it can’t be cancelled from here. Contact Omoshow if it needs to be called off and refunded.` });
    }
    return this.cancellation.cancelDate(id, dateId, user, reason, 'organizer');
  }

  async setPaused(id: string, user: AuthUser, paused: boolean) {
    const ev = await this.eventFor(id, user, EDIT);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    if (!paused) await this.notSuspended(ev.orgId);
    await this.audit.log(user.id, paused ? 'event.pause' : 'event.resume', 'Event', id);
    return this.prisma.event.update({ where: { id }, data: { salesPaused: paused } });
  }

  /* ---------- seat map ---------- */

  async saveSeatMap(id: string, user: AuthUser, input: unknown) {
    const ev = await this.eventFor(id, user, EDIT);
    // DATES: one seat map for every date. Sections point at tiers (tierKey); any copy's id is accepted and stored as
    // its tier. Seats are sold per date, so each copy's capacity is the tier's places on the map.
    const tierIds = new Map(ev.ticketTypes.flatMap((t) => (t.tierKey ? [[t.id, t.tierKey], [t.tierKey, t.tierKey]] : [[t.id, t.id]])) as [string, string][]);
    const result = validateSeatMap(input, new Set(tierIds.keys()));
    if (!result.ok) throw new BadRequestException({ message: 'The seat map has problems.', errors: result.errors });
    result.map.sections = result.map.sections.map((s) => ({ ...s, ticketTypeId: tierIds.get(s.ticketTypeId) ?? s.ticketTypeId }));
    const tierCaps = capacityByTicketType(result.map);
    const caps = new Map<string, number>();
    for (const t of ev.ticketTypes) {
      const cap = tierCaps.get(seatTier(t));
      if (cap === undefined) continue;
      caps.set(t.id, cap);
      if (cap < t.sold) {
        const d = ev.dates.find((x) => x.id === t.eventDateId);
        throw new BadRequestException(`${t.name}${d ? ` (${dateName(d)})` : ''}: the seat map has ${cap} places but ${t.sold} are already sold.`);
      }
    }
    // Every sold seat must still exist in the new layout: its section, and for reserved seating its row and seat
    // number (shrinking rows or seats under a sold seat would leave a fan with a seat that isn't on the map).
    const sold = await this.prisma.ticket.findMany({ where: { eventId: id, section: { not: null }, status: { not: 'VOID' } }, select: { section: true, row: true, seat: true } });
    if (sold.length) {
      const byId = new Map(result.map.sections.map((s) => [s.id, s]));
      const missing = [...new Set(sold.map((t) => t.section!).filter((s) => !byId.has(s)))];
      if (missing.length) throw new BadRequestException(`Sections with sold tickets can’t be removed: ${missing.join(', ')}`);
      const lost = new Set<string>();
      for (const t of sold) {
        const s = byId.get(t.section!)!;
        if (s.seating !== 'reserved' || !t.row || t.seat === null) continue;
        const rows = new Set(Array.from({ length: s.rows ?? 0 }, (_, i) => rowLabel(i)));
        if (!rows.has(t.row) || t.seat > (s.seatsPerRow ?? 0)) lost.add(`${t.section} row ${t.row} seat ${t.seat}`);
      }
      if (lost.size) {
        const list = [...lost];
        throw new BadRequestException(`Sold seats would no longer be on the map: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. Keep those rows and seats.`);
      }
    }
    await this.prisma.$transaction([
      this.prisma.event.update({ where: { id }, data: { seatMap: result.map as unknown as Prisma.InputJsonValue } }),
      ...[...caps.entries()].map(([ttId, capacity]) => this.prisma.ticketType.update({ where: { id: ttId }, data: { capacity } })),
    ]);
    return { seatMap: result.map, capacities: Object.fromEntries(ev.dateMode === 'DATES' ? tierCaps : caps) };
  }

  async applyTemplate(id: string, user: AuthUser, dto: TemplateDto) {
    return this.saveSeatMap(id, user, arenaTemplate({ floor: dto.floor, lower: dto.lower, upper: dto.upper }));
  }

  /* ---------- stats & attendees ---------- */

  async stats(id: string, user: AuthUser, days = 30) {
    const ev = await this.eventFor(id, user, DOOR);
    const since = new Date(Date.now() - days * DAY);
    const orders = await this.prisma.order.findMany({
      where: { eventId: id, kind: 'SALE', status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since } },
      select: { paidAt: true, quantity: true, subtotalCents: true, discountCents: true },
    });
    const byDay = new Map<string, { tickets: number; cents: number }>();
    for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(new Date(Date.now() - i * DAY)), { tickets: 0, cents: 0 });
    for (const o of orders) {
      const k = dayKey(o.paidAt!);
      const cur = byDay.get(k);
      if (cur) {
        cur.tickets += o.quantity;
        cur.cents += o.subtotalCents - o.discountCents;
      }
    }
    const checkedIn = await this.prisma.ticket.count({ where: { eventId: id, status: 'CHECKED_IN' } });
    const money = await this.salesMoney([id]);
    const comps = money.comps.get(id) ?? 0;
    const [compRows, donation, guestList] = await Promise.all([
      this.prisma.order.findMany({ where: { eventId: id, kind: 'COMP' }, select: { status: true, gift: { select: { claimedAt: true } }, tickets: { select: { status: true } } } }),
      this.prisma.order.aggregate({
        where: { eventId: id, kind: 'SALE', status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, donationCents: { gt: 0 } },
        _sum: { donationCents: true, donationRefundedCents: true },
        _count: { _all: true },
      }),
      this.guests.summary(id),
    ]);
    const live = compRows.filter((c) => c.status === 'PAID');
    return {
      // tickets sold (comps are counted apart; both count against capacity)
      sold: ev.ticketTypes.reduce((s, t) => s + t.sold, 0) - comps,
      capacity: ev.ticketTypes.filter((t) => liveType(t, ev.dates)).reduce((s, t) => s + t.capacity, 0),
      // ticket revenue only: face value of live sold tickets (pay what you want at what was paid), no comps, no donations
      grossCents: money.gross.get(id) ?? 0,
      netCents: money.net.get(id) ?? 0,
      checkedIn,
      byTicketType: ev.ticketTypes.map((t) => ({
        id: t.id,
        name: t.name,
        sold: t.sold - (money.compsByType.get(t.id) ?? 0),
        comps: money.compsByType.get(t.id) ?? 0,
        capacity: t.capacity,
        priceCents: t.priceCents,
        pricing: t.pricing,
        eventDateId: t.eventDateId,
        tierKey: t.tierKey,
        validDateIds: t.validDateIds,
      })),
      daily: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
      comps: {
        issued: live.length,
        claimed: live.filter((c) => c.gift?.claimedAt).length,
        checkedIn: live.filter((c) => c.tickets.some((t) => t.status === 'CHECKED_IN')).length,
        revoked: compRows.length - live.length,
        limit: ev.compLimit,
      },
      guestList,
      // Multiple dates and multi-day events: sold / capacity / in per date (see byDate)
      byDate: await this.byDate(ev, money),
      // Bookable schedule items: places booked and checked in ([] without any)
      sessions: await this.schedule.statsSessions(id, ev.dates),
      donations: {
        orders: donation._count._all,
        cents: (donation._sum.donationCents ?? 0) - (donation._sum.donationRefundedCents ?? 0),
        refundedCents: donation._sum.donationRefundedCents ?? 0,
        cause: ev.donationCause,
      },
    };
  }

  /**
   * Per date (DATES/DAYS; [] for one-date events): tickets sold (comps apart), capacity, entries through the door that
   * date, and ticket revenue. DATES: the date's tier copies. DAYS: every type valid that day, a pass's revenue split
   * evenly over its days.
   */
  private async byDate(ev: { id: string; dateMode: string; dates: EventDate[]; ticketTypes: { id: string; sold: number; capacity: number; eventDateId: string | null; validDateIds: string[] }[] }, money: { compsByType: Map<string, number>; grossByType: Map<string, number> }) {
    if (ev.dateMode === 'SINGLE' || !ev.dates.length) return [];
    const entries = await this.prisma.ticketCheckIn.groupBy({ by: ['eventDateId'], where: { eventDateId: { in: ev.dates.map((d) => d.id) } }, _count: { _all: true } });
    const inOn = new Map(entries.map((e) => [e.eventDateId, e._count._all]));
    return ev.dates.map((d) => {
      const types = ev.ticketTypes.filter((t) => (ev.dateMode === 'DATES' ? t.eventDateId === d.id : t.validDateIds.includes(d.id)));
      const comps = types.reduce((s, t) => s + (money.compsByType.get(t.id) ?? 0), 0);
      const gross = types.reduce((s, t) => s + (ev.dateMode === 'DAYS' ? Math.round((money.grossByType.get(t.id) ?? 0) / Math.max(1, t.validDateIds.length)) : (money.grossByType.get(t.id) ?? 0)), 0);
      return {
        dateId: d.id,
        startsAt: d.startsAt,
        label: d.label,
        status: d.status,
        sold: types.reduce((s, t) => s + t.sold, 0) - comps,
        comps,
        capacity: types.reduce((s, t) => s + t.capacity, 0),
        checkedIn: inOn.get(d.id) ?? 0,
        grossCents: gross,
      };
    });
  }

  async attendees(id: string, user: AuthUser, q?: string, status?: string, type?: string, dateId?: string) {
    const ev = await this.eventFor(id, user, DOOR);
    const s = q?.trim();
    // Multiple dates: ?date= keeps that date's tickets (DATES) or the tickets valid that day (DAYS); "checked in" is
    // then about that date.
    const day = dateId && ev.dateMode !== 'SINGLE' ? ev.dates.find((d) => d.id === dateId) : null;
    if (dateId && ev.dateMode !== 'SINGLE' && !day) throw new BadRequestException('That date isn’t part of this event.');
    const onDay: Prisma.TicketWhereInput = !day ? {} : ev.dateMode === 'DATES' ? { eventDateId: day.id } : { ticketType: { validDateIds: { has: day.id } } };
    const inThatDay = day && ev.dateMode === 'DAYS';
    const rows = await this.prisma.ticket.findMany({
      where: {
        eventId: id,
        ...onDay,
        ...(inThatDay && status === 'checked-in' ? { checkIns: { some: { eventDateId: day.id } } } : {}),
        ...(inThatDay && status === 'not-checked-in' ? { checkIns: { none: { eventDateId: day.id } } } : {}),
        status: inThatDay ? { not: 'VOID' } : status === 'checked-in' ? 'CHECKED_IN' : status === 'not-checked-in' ? { in: ['ACTIVE', 'TRANSFER_PENDING', 'LISTED'] } : { not: 'VOID' },
        ...(type === 'comp' ? { order: { kind: 'COMP' } } : type === 'paid' ? { order: { kind: 'SALE' } } : {}),
        ...(s
          ? { OR: [{ holderName: { contains: s, mode: 'insensitive' } }, { holderEmail: { contains: s, mode: 'insensitive' } }, { id: { contains: s.toUpperCase() } }] }
          : {}),
      },
      select: {
        id: true,
        holderName: true,
        holderEmail: true,
        section: true,
        row: true,
        seat: true,
        status: true,
        checkedInAt: true,
        eventDateId: true,
        ticketType: { select: { name: true } },
        order: { select: { kind: true, compGroup: true } },
        checkIns: { select: { eventDateId: true }, orderBy: { at: 'asc' } },
      },
      orderBy: { id: 'asc' },
      take: 5000,
    });
    // Paid = sold at checkout (free registrations included); Comp = complimentary, issued by the organizer.
    // Multiple dates add the ticket's date (DATES) and the dates it has been checked in on (`checkedInDates`).
    const multi = ev.dateMode !== 'SINGLE';
    return rows.map(({ order, checkIns, eventDateId, ...r }) => ({
      ...r,
      type: order.kind === 'COMP' ? ('COMP' as const) : ('PAID' as const),
      compGroup: order.compGroup,
      ...(multi ? { eventDateId, checkedInDates: checkIns.map((c) => c.eventDateId).filter((x): x is string => !!x) } : {}),
    }));
  }

  async attendeesCsv(id: string, user: AuthUser) {
    const rows = await this.attendees(id, user);
    // Multiple dates: a last column with the ticket's date (DATES) or the days it was checked in on (DAYS).
    const ev = await this.prisma.event.findUniqueOrThrow({ where: { id }, select: { dateMode: true, dates: true } });
    const name = (dateId: string | null | undefined) => {
      const d = ev.dates.find((x) => x.id === dateId);
      return d ? dateName(d) : '';
    };
    const dateCol = (r: (typeof rows)[number]) =>
      ev.dateMode === 'SINGLE' ? [] : [ev.dateMode === 'DATES' ? name(r.eventDateId) : (r.checkedInDates ?? []).map(name).join('; ')];
    const guests = await this.prisma.guestListEntry.findMany({ where: { eventId: id }, orderBy: { name: 'asc' }, take: 5000 });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Ticket', 'Name', 'Email', 'Ticket type', 'Section', 'Row', 'Seat', 'Status', 'Checked in at', 'Type', 'Group', ...(ev.dateMode === 'DATES' ? ['Date'] : ev.dateMode === 'DAYS' ? ['Checked in on'] : [])];
    const tickets = rows.map((r) => [r.id, r.holderName, r.holderEmail, r.ticketType.name, r.section, r.row, r.seat, r.status, r.checkedInAt?.toISOString(), r.type === 'COMP' ? 'Comp' : 'Paid', r.compGroup, ...dateCol(r)]);
    const list = guests.map((g) => [
      '',
      g.plusOnes ? `${g.name} +${g.plusOnes}` : g.name,
      g.email,
      'Guest list',
      '',
      '',
      '',
      g.arrived ? `${g.arrived} of ${1 + g.plusOnes} here` : 'Not arrived',
      g.firstArrivedAt?.toISOString(),
      'Guest list',
      g.group,
    ]);
    return [head, ...tickets, ...list]
      .map((r) => r.map(esc).join(','))
      .join('\r\n');
  }

  /* ---------- door check-in ---------- */

  /**
   * The date the door works on (DATES/DAYS): the one asked for, else the date running today at the venue, else the
   * next one. Null for one-date events.
   */
  private doorDay(ev: DoorEvent, eventDateId?: string | null, at = new Date()) {
    if (ev.dateMode === 'SINGLE') return null;
    if (eventDateId) {
      const d = ev.dates.find((x) => x.id === eventDateId);
      if (!d) throw new BadRequestException('That date isn’t part of this event.');
      if (d.status === 'CANCELLED') throw new BadRequestException(`${dateName(d)} was cancelled, so nobody can check in for it.`);
      return d;
    }
    return doorDate(ev.dates, ev.timezone, at);
  }

  /** Why a ticket can't come in on `day` (DATES: it's for another date; DAYS: not valid that day), or null. */
  private wrongDate(ev: DoorEvent, t: DoorViewTicket & { eventDateId: string | null; ticketType: { validDateIds: string[] } }, day: EventDate | null) {
    if (!day) return null;
    if (ev.dateMode === 'DATES') {
      if (t.eventDateId === day.id) return null;
      const own = ev.dates.find((d) => d.id === t.eventDateId);
      return { result: 'wrong-date', message: own ? `This ticket is for ${dateName(own)}.` : 'This ticket is for another date.', ticket: this.doorView(t, ev) };
    }
    if (t.ticketType.validDateIds.includes(day.id)) return null;
    const days = validDays(ev.dates, t.ticketType.validDateIds);
    return { result: 'wrong-date', message: days.length ? `Not valid today. Valid ${daysList(days)}.` : 'This ticket isn’t valid on this day.', ticket: this.doorView(t, ev) };
  }

  /** One entry through the door (TicketCheckIn). For one-date and DATES tickets it never breaks a check-in. */
  private async recordEntry(ticketId: string, eventDateId: string | null, at: Date, userId: string, deviceId: string | null) {
    try {
      await this.prisma.ticketCheckIn.create({ data: { ticketId, eventDateId, at, byUserId: userId, deviceId } });
    } catch {
      /* the ticket's own status is the record that counts here */
    }
  }

  /**
   * DAYS: lets a ticket in on one day. The first entry ever also marks the ticket CHECKED_IN (it keeps today's meaning
   * for resale, transfers and stats); entries on other valid days are re-entries. Two scanners can't admit it twice
   * on one day: the (ticket, day) row is unique.
   */
  private async admitDay(ticketId: string, dayId: string, at: Date, userId: string, deviceId: string | null): Promise<{ admitted: true } | { admitted: false; prior: TicketCheckIn | null; status: string | null }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.ticketCheckIn.create({ data: { ticketId, eventDateId: dayId, at, byUserId: userId, deviceId } });
        const first = await tx.ticket.updateMany({ where: { id: ticketId, status: { in: ['ACTIVE', 'LISTED'] } }, data: { status: 'CHECKED_IN', checkedInAt: at, checkedInBy: userId, checkedInDevice: deviceId, listCents: null } });
        if (!first.count && !(await tx.ticket.count({ where: { id: ticketId, status: 'CHECKED_IN' } }))) throw new DoorRefused();
      });
      return { admitted: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { admitted: false, prior: await this.prisma.ticketCheckIn.findFirst({ where: { ticketId, eventDateId: dayId } }), status: 'CHECKED_IN' };
      }
      if (e instanceof DoorRefused) return { admitted: false, prior: null, status: (await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } }))?.status ?? null };
      throw e;
    }
  }

  async checkIn(id: string, user: AuthUser, code: string, deviceId?: string, eventDateId?: string) {
    const ev = await this.eventFor(id, user, DOOR);
    const device = deviceId?.trim() || null;
    const day = this.doorDay(ev, eventDateId);
    // A signed QR from the camera, or a ticket code typed in by the door staff (manual check-in).
    const method = code.includes('.') ? 'QR' : 'MANUAL';
    // Every answer goes into the door scan log too (what the resale guarantee checks claims against).
    const logged = async <T>(result: ScanResult, ticketId: string | null, answer: T) => {
      await this.scans.record({ eventId: id, ticketId, result, method, deviceId: device, userId: user.id, at: new Date() });
      return day ? { ...answer, date: dateView(day) } : answer;
    };
    let ticketId = code.trim().toUpperCase();
    const invalidCode = { result: 'invalid', message: 'Not a valid Omoshow code.' };
    let t: DoorTicket | null = null;
    if (code.includes('.')) {
      // Codes are signed with the ticket's own seed (its qrVersion), so find the ticket first, then check.
      const p = parseQr(code);
      if (!p.ok) return logged('INVALID', null, invalidCode);
      t = await this.prisma.ticket.findUnique({ where: { id: p.ticketId }, include: DOOR_TICKET });
      if (!t) return logged('NOT_FOUND', null, invalidCode);
      const v = verifyQr(config.qrSecret, code.trim(), Date.now(), t.qrVersion);
      if (!v.ok) {
        // Logged against the ticket the code names: a real ticket's code failing is what "it didn't scan" means.
        return logged(v.reason === 'expired' ? 'EXPIRED_CODE' : 'INVALID', t.id, {
          result: v.reason === 'expired' ? 'expired-code' : 'invalid',
          message: v.reason === 'expired' ? 'This code has expired. Ask them to reopen the ticket.' : 'Not a valid Omoshow code.',
        });
      }
      ticketId = v.ticketId;
    } else {
      t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: DOOR_TICKET });
    }
    if (!t) return logged('NOT_FOUND', null, { result: 'invalid', message: 'Ticket not found.' });
    if (t.eventId !== id) return logged('WRONG_EVENT', t.id, { result: 'wrong-event', message: 'This ticket is for a different event.' });
    if (t.status === 'VOID') return logged('VOID', t.id, { result: 'invalid', message: 'This ticket was refunded or cancelled.' });
    if (t.status === 'TRANSFER_PENDING') {
      return logged('TRANSFER_PENDING', t.id, { result: 'invalid', message: t.order.kind === 'COMP' && t.transferTo === t.holderEmail ? 'This complimentary ticket hasn’t been claimed yet.' : 'This ticket is being transferred.' });
    }
    // Another date (DATES) or a day the pass doesn't cover (DAYS).
    const wrong = this.wrongDate(ev, t, day);
    if (wrong) return logged('WRONG_DATE', t.id, wrong);

    if (ev.dateMode === 'DAYS' && day) {
      // Once per valid day: in on another day is fine (re-entry), in today already is a duplicate.
      const now = new Date();
      const r = await this.admitDay(t.id, day.id, now, user.id, device);
      if (r.admitted) return logged('ADMITTED', t.id, { result: 'ok', message: 'Valid: let them in.', ticket: this.doorView(t, ev) });
      if (r.prior) return logged('ALREADY_USED', t.id, await this.duplicate({ ...t, checkedInAt: r.prior.at, checkedInBy: r.prior.byUserId, checkedInDevice: r.prior.deviceId }, ev));
      return logged(r.status === 'VOID' ? 'VOID' : 'TRANSFER_PENDING', t.id, { result: 'invalid', message: r.status === 'VOID' ? 'This ticket was refunded or cancelled.' : 'This ticket is being transferred.' });
    }

    if (t.status === 'CHECKED_IN') return logged('ALREADY_USED', t.id, await this.duplicate(t, ev));
    // Conditional update so two scanners can't admit the same ticket twice.
    const at = new Date();
    const { count } = await this.prisma.ticket.updateMany({
      where: { id: t.id, status: { in: ['ACTIVE', 'LISTED'] } },
      data: { status: 'CHECKED_IN', checkedInAt: at, checkedInBy: user.id, checkedInDevice: device, listCents: null },
    });
    if (!count) {
      // Another scanner got there a moment ago: report theirs.
      const fresh = await this.prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { status: true, checkedInAt: true, checkedInBy: true, checkedInDevice: true } });
      if (fresh.status !== 'CHECKED_IN') {
        return logged(fresh.status === 'VOID' ? 'VOID' : 'TRANSFER_PENDING', t.id, { result: 'invalid', message: fresh.status === 'VOID' ? 'This ticket was refunded or cancelled.' : 'This ticket is being transferred.' });
      }
      return logged('ALREADY_USED', t.id, await this.duplicate({ ...t, ...fresh }, ev));
    }
    await this.recordEntry(t.id, t.eventDateId, at, user.id, device);
    return logged('ADMITTED', t.id, { result: 'ok', message: 'Valid: let them in.', ticket: this.doorView(t, ev) });
  }

  /** "Already checked in", with when, by whom and on which scanner (like the offline sync's `already`). */
  private async duplicate(t: DoorViewTicket & { checkedInAt: Date | null; checkedInBy: string | null; checkedInDevice: string | null }, ev: DoorEvent) {
    const by = t.checkedInBy ? await this.prisma.user.findUnique({ where: { id: t.checkedInBy }, select: { id: true, name: true } }) : null;
    return {
      result: 'duplicate',
      message: ev.dateMode === 'DAYS' ? 'Already checked in today.' : 'Already checked in.',
      ticket: this.doorView(t, ev),
      checkedInAt: t.checkedInAt,
      checkedInBy: t.checkedInBy ? { id: t.checkedInBy, name: by?.name ?? null } : null,
      checkedInDevice: t.checkedInDevice,
    };
  }

  /* ---------- offline door scanning ---------- */

  /**
   * Every non-void ticket with its QR seed, for scanners that work without a connection. Audited. Multiple dates and
   * multi-day events also get the dates, the door's default date, and per ticket its date (`eventDateId`, DATES),
   * the days it's valid (`validDateIds`, DAYS) and its entries so far (`checkIns`, one per day for DAYS).
   */
  async doorPack(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, DOOR);
    const rows = await this.prisma.ticket.findMany({
      where: { eventId: id, status: { not: 'VOID' } },
      select: {
        id: true,
        qrVersion: true,
        status: true,
        checkedInAt: true,
        checkedInDevice: true,
        holderName: true,
        section: true,
        row: true,
        seat: true,
        eventDateId: true,
        ticketType: { select: { name: true, validDateIds: true } },
        order: { select: { kind: true, compGroup: true } },
        checkIns: { select: { eventDateId: true, at: true, deviceId: true }, orderBy: { at: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });
    const guestList = await this.guests.packEntries(id);
    const map = ev.seatMap as SeatMap | null;
    const names = new Map((map?.sections ?? []).map((s) => [s.id, sectionName(s)]));
    await this.audit.log(user.id, 'door_pack.download', 'Event', id, { tickets: rows.length });
    const multi = ev.dateMode !== 'SINGLE';
    return {
      eventId: id,
      title: ev.title,
      startsAt: ev.startsAt,
      doorsAt: ev.doorsAt,
      timezone: ev.timezone,
      dateMode: ev.dateMode,
      dates: ev.dates.map(dateView),
      currentDateId: multi ? (doorDate(ev.dates, ev.timezone)?.id ?? null) : null,
      generatedAt: new Date(),
      ...QR_SEED_SPEC,
      tickets: rows.map((t) => ({
        id: t.id,
        seed: qrSeed(config.qrSecret, t.id, t.qrVersion).toString('base64url'),
        version: t.qrVersion,
        status: t.status,
        checkedInAt: t.checkedInAt,
        checkedInDevice: t.checkedInDevice,
        holderName: t.holderName,
        ticketType: t.ticketType.name,
        section: t.section,
        sectionName: t.section ? (names.get(t.section) ?? t.section) : null,
        row: t.row,
        seat: t.seat,
        comp: t.order.kind === 'COMP',
        compGroup: t.order.kind === 'COMP' ? t.order.compGroup : null,
        ...(multi ? { eventDateId: t.eventDateId, validDateIds: t.ticketType.validDateIds, checkIns: t.checkIns } : {}),
      })),
      // The guest list (no tickets), so guests can be found and checked in offline (see GuestListService.sync).
      guestList,
    };
  }

  /**
   * Applies scans a door scanner made offline, oldest first. Each ticket is admitted once (DAYS: once per valid day):
   * the first scan wins and later ones come back `already` (with when, by whom and on which scanner). Sending the same
   * batch again gives the same answers. With `code`, the scanned QR must match the ticket's current seed (a code from
   * before a transfer is refused) and be within 2 minutes of `scannedAt` (scanner clocks drift). Multiple dates and
   * multi-day events: each scan is for its `eventDateId` (else the batch's, else the date of `scannedAt` at the venue);
   * a ticket for another date, or a day it isn't valid, comes back invalid with reason `wrong-date`.
   */
  async syncCheckIns(id: string, user: AuthUser, deviceIdRaw: string, scans: { ticketId: string; scannedAt: string; code?: string; eventDateId?: string }[], batchDateId?: string) {
    const ev = await this.eventFor(id, user, DOOR);
    if (batchDateId) this.doorDay(ev, batchDateId);
    const deviceId = deviceIdRaw.trim();
    const now = Date.now();
    // A scan can't be in the future; the scanner's clock is ahead, so it counts as now.
    const ordered = scans
      .map((s, index) => ({ index, ticketId: s.ticketId.trim().toUpperCase(), code: s.code?.trim() || null, at: new Date(Math.min(new Date(s.scannedAt).getTime(), now)), dateId: s.eventDateId?.trim() || batchDateId || null }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);
    const tickets = await this.prisma.ticket.findMany({
      where: { id: { in: [...new Set(ordered.map((s) => s.ticketId))] } },
      select: { id: true, eventId: true, status: true, qrVersion: true, checkedInAt: true, checkedInBy: true, checkedInDevice: true, holderName: true, section: true, row: true, seat: true, eventDateId: true, ticketType: { select: { name: true, validDateIds: true } }, order: { select: { kind: true, compGroup: true } } },
    });
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const SKEW_WINDOWS = 8;

    type Result = {
      index: number;
      ticketId: string;
      scannedAt: Date;
      eventDateId?: string | null;
      result: 'checked_in' | 'already' | 'invalid';
      reason?: string;
      replay?: boolean;
      checkedInAt?: Date | null;
      checkedInBy?: { id: string; name: string | null } | null;
      checkedInDevice?: string | null;
      ticket?: ReturnType<OrganizerService['doorView']>;
    };
    const results: Result[] = [];
    const checkerIds = new Set<string>();
    for (const s of ordered) {
      // The date this scan was for (DATES/DAYS): an unknown one can't be applied.
      const day = ev.dateMode === 'SINGLE' ? null : s.dateId ? (ev.dates.find((d) => d.id === s.dateId) ?? null) : doorDate(ev.dates, ev.timezone, s.at);
      const base = { index: s.index, ticketId: s.ticketId, scannedAt: s.at, ...(ev.dateMode === 'SINGLE' ? {} : { eventDateId: day?.id ?? s.dateId }) };
      const t = byId.get(s.ticketId);
      if (!t) {
        results.push({ ...base, result: 'invalid', reason: 'unknown' });
        continue;
      }
      if (t.eventId !== id) {
        results.push({ ...base, result: 'invalid', reason: 'wrong-event' });
        continue;
      }
      if (s.code) {
        const p = parseQr(s.code);
        // Signature against the ticket's current seed, then the code's window against the scan time.
        const v = p.ok && p.ticketId === t.id ? verifyQr(config.qrSecret, s.code, p.window * QR_WINDOW_MS, t.qrVersion) : null;
        if (!p.ok || !v?.ok) {
          results.push({ ...base, result: 'invalid', reason: 'bad-code' });
          continue;
        }
        if (Math.abs(p.window - Math.floor(s.at.getTime() / QR_WINDOW_MS)) > SKEW_WINDOWS) {
          results.push({ ...base, result: 'invalid', reason: 'expired-code' });
          continue;
        }
      }
      if (t.status === 'VOID') {
        results.push({ ...base, result: 'invalid', reason: 'void' });
        continue;
      }
      if (t.status === 'TRANSFER_PENDING') {
        results.push({ ...base, result: 'invalid', reason: 'transfer-pending' });
        continue;
      }
      if (ev.dateMode !== 'SINGLE' && (!day || this.wrongDate(ev, t, day))) {
        results.push({ ...base, result: 'invalid', reason: 'wrong-date', ticket: this.doorView(t, ev) });
        continue;
      }
      if (ev.dateMode === 'DAYS' && day) {
        const r = await this.admitDay(t.id, day.id, s.at, user.id, deviceId);
        if (r.admitted) {
          Object.assign(t, t.checkedInAt ? {} : { status: 'CHECKED_IN', checkedInAt: s.at, checkedInBy: user.id, checkedInDevice: deviceId });
          checkerIds.add(user.id);
          results.push({ ...base, result: 'checked_in', checkedInAt: s.at, checkedInBy: { id: user.id, name: null }, checkedInDevice: deviceId, ticket: this.doorView(t, ev) });
          continue;
        }
        if (!r.prior) {
          results.push({ ...base, result: 'invalid', reason: r.status === 'VOID' ? 'void' : 'transfer-pending' });
          continue;
        }
        // In already that day. The same scan sent again (same scanner, same time) is reported as it was the first time.
        const replay = r.prior.deviceId === deviceId && r.prior.at.getTime() === s.at.getTime();
        if (r.prior.byUserId) checkerIds.add(r.prior.byUserId);
        results.push({
          ...base,
          result: replay ? 'checked_in' : 'already',
          ...(replay ? { replay: true } : {}),
          checkedInAt: r.prior.at,
          checkedInBy: r.prior.byUserId ? { id: r.prior.byUserId, name: null } : null,
          checkedInDevice: r.prior.deviceId,
          ticket: this.doorView(t, ev),
        });
        continue;
      }
      if (t.status !== 'CHECKED_IN') {
        const { count } = await this.prisma.ticket.updateMany({
          where: { id: t.id, status: { in: ['ACTIVE', 'LISTED'] } },
          data: { status: 'CHECKED_IN', checkedInAt: s.at, checkedInBy: user.id, checkedInDevice: deviceId, listCents: null },
        });
        if (count) {
          Object.assign(t, { status: 'CHECKED_IN', checkedInAt: s.at, checkedInBy: user.id, checkedInDevice: deviceId });
          await this.recordEntry(t.id, t.eventDateId, s.at, user.id, deviceId);
          checkerIds.add(user.id);
          results.push({ ...base, result: 'checked_in', checkedInAt: s.at, checkedInBy: { id: user.id, name: null }, checkedInDevice: deviceId, ticket: this.doorView(t, ev) });
          continue;
        }
        // Someone else admitted it a moment ago: report theirs.
        const fresh = await this.prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { status: true, checkedInAt: true, checkedInBy: true, checkedInDevice: true } });
        Object.assign(t, fresh);
        if (fresh.status !== 'CHECKED_IN') {
          results.push({ ...base, result: 'invalid', reason: fresh.status === 'VOID' ? 'void' : 'transfer-pending' });
          continue;
        }
      }
      // Already in. The same scan sent again (same scanner, same time) is reported as it was the first time.
      const replay = t.checkedInDevice === deviceId && t.checkedInAt?.getTime() === s.at.getTime();
      if (t.checkedInBy) checkerIds.add(t.checkedInBy);
      results.push({
        ...base,
        result: replay ? 'checked_in' : 'already',
        ...(replay ? { replay: true } : {}),
        checkedInAt: t.checkedInAt,
        checkedInBy: t.checkedInBy ? { id: t.checkedInBy, name: null } : null,
        checkedInDevice: t.checkedInDevice,
        ticket: this.doorView(t, ev),
      });
    }
    const people = checkerIds.size ? await this.prisma.user.findMany({ where: { id: { in: [...checkerIds] } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    for (const r of results) if (r.checkedInBy) r.checkedInBy.name = nameOf.get(r.checkedInBy.id) ?? null;
    // The door scan log, with each scan's own time. A batch sent again adds nothing (see ScanLog.recordSynced).
    await this.scans.recordSynced(
      results.map((r) => ({
        eventId: id,
        ticketId: r.reason === 'unknown' ? null : r.ticketId,
        result: r.result === 'invalid' ? (SYNC_SCAN_RESULT[r.reason ?? ''] ?? 'INVALID') : r.result === 'already' ? 'ALREADY_USED' : 'ADMITTED',
        method: 'OFFLINE' as const,
        deviceId,
        userId: user.id,
        at: r.scannedAt,
        scanned: `${r.ticketId}|${scans[r.index].scannedAt}`,
      })),
    );
    const summary = { checked_in: 0, already: 0, invalid: 0 };
    for (const r of results) summary[r.result]++;
    await this.audit.log(user.id, 'checkin.sync', 'Event', id, { deviceId, scans: scans.length, ...summary });
    return { eventId: id, deviceId, summary, results };
  }

  /** What the door shows about a ticket; multiple dates add its date (DATES) or the days it's valid (DAYS). */
  private doorView(t: DoorViewTicket, ev?: DoorEvent) {
    const comp = t.order?.kind === 'COMP';
    const base = { id: t.id, holderName: t.holderName, ticketType: t.ticketType.name, section: t.section, row: t.row, seat: t.seat, comp, compGroup: comp ? (t.order?.compGroup ?? null) : null };
    if (!ev || ev.dateMode === 'SINGLE') return base;
    return { ...base, ...ticketDates(ev.dateMode, { eventDateId: t.eventDateId ?? null, validDateIds: t.ticketType.validDateIds ?? [] }, ev.dates) };
  }

  /** Undoes a check-in. DAYS: that day's entry (`eventDateId`, default the door's date); the ticket is ACTIVE again once it has none. */
  async undoCheckIn(id: string, ticketId: string, user: AuthUser, eventDateId?: string) {
    const ev = await this.eventFor(id, user, DOOR);
    if (ev.dateMode === 'DAYS') {
      const day = this.doorDay(ev, eventDateId);
      const t = await this.prisma.ticket.findFirst({ where: { id: ticketId, eventId: id, status: 'CHECKED_IN' }, select: { id: true } });
      const { count } = t && day ? await this.prisma.ticketCheckIn.deleteMany({ where: { ticketId, eventDateId: day.id } }) : { count: 0 };
      if (!count) throw new NotFoundException('Checked-in ticket not found.');
      const left = await this.prisma.ticketCheckIn.findFirst({ where: { ticketId }, orderBy: { at: 'asc' } });
      await this.prisma.ticket.updateMany({
        where: { id: ticketId, status: 'CHECKED_IN' },
        data: left ? { checkedInAt: left.at, checkedInBy: left.byUserId, checkedInDevice: left.deviceId } : { status: 'ACTIVE', checkedInAt: null, checkedInBy: null, checkedInDevice: null },
      });
      await this.audit.log(user.id, 'checkin.undo', 'Ticket', ticketId, { eventDateId: day!.id });
      return { undone: true };
    }
    const { count } = await this.prisma.ticket.updateMany({
      where: { id: ticketId, eventId: id, status: 'CHECKED_IN' },
      data: { status: 'ACTIVE', checkedInAt: null, checkedInBy: null, checkedInDevice: null },
    });
    if (!count) throw new NotFoundException('Checked-in ticket not found.');
    await this.prisma.ticketCheckIn.deleteMany({ where: { ticketId } });
    await this.audit.log(user.id, 'checkin.undo', 'Ticket', ticketId);
    return { undone: true };
  }

  /* ---------- promos ---------- */

  async promos(id: string, user: AuthUser) {
    await this.eventFor(id, user, EDIT);
    return this.prisma.promo.findMany({ where: { eventId: id }, orderBy: { code: 'asc' } });
  }

  async createPromo(id: string, user: AuthUser, dto: PromoDto) {
    await this.eventFor(id, user, EDIT);
    try {
      return await this.prisma.promo.create({ data: { eventId: id, code: dto.code, percent: dto.percent, limit: dto.limit ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That code already exists.');
      throw e;
    }
  }

  async updatePromo(id: string, code: string, user: AuthUser, dto: UpdatePromoDto) {
    await this.eventFor(id, user, EDIT);
    const { count } = await this.prisma.promo.updateMany({ where: { eventId: id, code: code.toUpperCase() }, data: dto });
    if (!count) throw new NotFoundException('Promo code not found.');
    return { updated: true };
  }

  async deletePromo(id: string, code: string, user: AuthUser) {
    await this.eventFor(id, user, EDIT);
    const { count } = await this.prisma.promo.deleteMany({ where: { eventId: id, code: code.toUpperCase() } });
    if (!count) throw new NotFoundException('Promo code not found.');
    return { deleted: true };
  }

  /* ---------- payouts ---------- */

  async payouts(orgId: string, user: AuthUser) {
    const m = await this.member(orgId, user, ADMIN_ONLY);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: m.orgId } });
    // What they owe Omoshow (refunds of orders they'd already been paid for), oldest first: it comes out of their
    // payouts from the day it was recorded on, so sales from then on are loaded too.
    const debts = await this.prisma.organizerDebt.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const window = new Date(Date.now() - 31 * DAY);
    const since = debts.length && debts[0].createdAt < window ? new Date(`${dayKey(debts[0].createdAt)}T00:00:00.000Z`) : window;
    const orders = await this.prisma.order.findMany({
      where: {
        event: { orgId },
        paidAt: { gte: since },
        // Refunded after being paid out: still part of the day they were paid for (the refund is a debt, taken later).
        OR: [{ status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } }, { status: 'REFUNDED', OR: [{ refundOwedCents: { gt: 0 } }, { donationOwedCents: { gt: 0 } }] }],
      },
      select: {
        id: true,
        paidAt: true,
        quantity: true,
        unitCents: true,
        discountCents: true,
        refundedCents: true,
        donationCents: true,
        donationRefundedCents: true,
        currency: true,
        event: { select: { feeMode: true } },
        guaranteeClaims: { where: { payer: 'ORGANIZER', refundStatus: 'REFUNDED' }, select: { amountCents: true, organizerCents: true } },
        resaleListing: { select: { royaltyCents: true } },
      },
    });
    // Donation refunds made after the organizer had been paid for those orders (any time): owed to Omoshow.
    const owed = await this.prisma.order.groupBy({ by: ['currency'], where: { event: { orgId }, donationOwedCents: { gt: 0 } }, _sum: { donationOwedCents: true } });
    // Refunds (an event or date cancelled or moved) of orders they'd already been paid for: their share, owed to Omoshow.
    const refundOwed = await this.prisma.order.groupBy({ by: ['currency'], where: { event: { orgId }, refundOwedCents: { gt: 0 } }, _sum: { refundOwedCents: true } });
    // Payouts are shown in the organization's main currency (the one most of its sales are in);
    // sales in other currencies are converted at today's rate and marked as approximate.
    const counts = new Map<string, number>();
    for (const o of orders) counts.set(o.currency, (counts.get(o.currency) ?? 0) + 1);
    const latest = await this.prisma.event.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { currency: true } });
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? latest?.currency ?? 'USD';
    // What was refunded on each order after it had been paid out (it's a debt now, so its day keeps what was paid).
    const after = new Map<string, { refund: number; donation: number }>();
    for (const d of debts) {
      if (!d.orderId) continue;
      const a = after.get(d.orderId) ?? { refund: 0, donation: 0 };
      if (d.kind === 'DONATION') a.donation += d.refundedCents;
      else a.refund += d.refundedCents;
      after.set(d.orderId, a);
    }
    const byDay = new Map<string, number>();
    const donationsByDay = new Map<string, number>();
    for (const o of orders) {
      const k = dayKey(o.paidAt!);
      // Organizer share of the tickets (protection is Omoshow's), after discounts and refunds. A refund comes out of
      // it in full, except an Omoshow Guarantee refund: only the organizer's share of that ticket (`organizerCents`),
      // as Omoshow returns its own fee and protection (see src/guarantee).
      const eventroReturned = o.guaranteeClaims.reduce((s, g) => s + (g.amountCents - g.organizerCents), 0);
      // A donation is its own line: paid to the organizer in full (no fee), less any donation refund; ticket refunds
      // don't touch it, and refunds of it don't touch the tickets' share.
      // A fan-resale order's ticket money is the seller's (paid out by Omoshow from the listing): the organizer's part
      // of it is only the event's resale royalty. Its donation, like any, is the organizer's in full.
      // Refunds made after this day was paid out (`refundOwedCents`, `donationOwedCents`) stay in it: they were paid,
      // and come back as debts from the payouts after (below).
      const late = after.get(o.id) ?? { refund: 0, donation: 0 };
      const refunded = ticketRefunded(o);
      const lateTickets = Math.min(late.refund, refunded);
      const net = o.resaleListing
        ? (o.resaleListing.royaltyCents ?? 0)
        : organizerNet(o.unitCents, o.event.feeMode, config.organizerFeePermille) * o.quantity - o.discountCents - (refunded - lateTickets - eventroReturned);
      const ticketCents = Math.max(0, this.fx.convert(net, o.currency, currency));
      const donationCents = Math.max(0, this.fx.convert(donationLeft(o) + (late.refund - lateTickets) + late.donation, o.currency, currency));
      byDay.set(k, (byDay.get(k) ?? 0) + ticketCents + donationCents);
      donationsByDay.set(k, (donationsByDay.get(k) ?? 0) + donationCents);
    }
    const today = dayKey(new Date());
    // Debts come out of each day's payout from the day they were recorded on, oldest debt first, never below zero.
    const takenByDay = new Map<string, number>();
    const days = [...byDay.keys()].sort();
    let outstanding = 0;
    for (const d of debts) {
      let left = this.fx.convert(d.cents, d.currency, currency);
      for (const k of days) {
        if (left <= 0) break;
        if (k < dayKey(d.createdAt)) continue;
        const room = (byDay.get(k) ?? 0) - (takenByDay.get(k) ?? 0);
        const take = Math.min(room, left);
        if (take > 0) {
          takenByDay.set(k, (takenByDay.get(k) ?? 0) + take);
          left -= take;
        }
      }
      outstanding += Math.max(0, left);
    }
    const net = (k: string) => (byDay.get(k) ?? 0) - (takenByDay.get(k) ?? 0);
    const taken = (k: string) => takenByDay.get(k) ?? 0;
    const donationsOn = (k: string) => donationsByDay.get(k) ?? 0;
    const shown = dayKey(window);
    const history = [...byDay.keys()]
      .filter((d) => d < today && d >= shown)
      .sort((a, b) => b.localeCompare(a))
      .map((date) => ({ salesDate: date, amountCents: net(date), ticketCents: (byDay.get(date) ?? 0) - donationsOn(date), donationCents: donationsOn(date), owedCents: taken(date), status: 'PAID' as const }));
    const yesterday = dayKey(new Date(Date.now() - DAY));
    const recent = history.slice(0, 7);
    return {
      currency,
      converted: counts.size > 1,
      schedule: org.payoutSchedule,
      pendingCents: net(today),
      nextPayoutCents: org.payoutSchedule === 'DAILY' ? net(yesterday) : recent.reduce((s, h) => s + h.amountCents, 0),
      // Donations collected on the organizer's behalf, inside the amounts above and shown as their own line.
      pendingDonationCents: donationsOn(today),
      nextPayoutDonationCents: org.payoutSchedule === 'DAILY' ? donationsOn(yesterday) : recent.reduce((s, h) => s + h.donationCents, 0),
      donationsCents: [...donationsByDay.entries()].filter(([d]) => d >= shown).reduce((a, [, b]) => a + b, 0),
      donationNote: DONATION_NOTE,
      // Donations refunded after the organizer had already been paid for them: owed to Omoshow (in the payout currency).
      donationOwedCents: owed.reduce((s, g) => s + this.fx.convert(g._sum.donationOwedCents ?? 0, g.currency, currency), 0),
      refundOwedCents: refundOwed.reduce((s, g) => s + this.fx.convert(g._sum.refundOwedCents ?? 0, g.currency, currency), 0),
      // Owed to Omoshow: what's coming out of today's and the next payouts (`pendingOwedCents`, `nextPayoutOwedCents`),
      // and what's still owed after every sale so far (it comes out of future sales).
      pendingOwedCents: taken(today),
      nextPayoutOwedCents: org.payoutSchedule === 'DAILY' ? taken(yesterday) : recent.reduce((s, h) => s + h.owedCents, 0),
      owedOutstandingCents: outstanding,
      payoutMethod:
        org.payoutProvider === 'paystack' && org.paystackSubaccount
          ? { provider: 'paystack', bankLast4: org.bankLast4, bankName: org.bankName, accountName: org.bankAccountName, country: org.bankCountry, updatedAt: org.payoutUpdatedAt }
          : org.stripeAccountId
            ? { provider: 'stripe', bankLast4: org.bankLast4, bankName: org.bankName, accountName: null, country: org.bankCountry, updatedAt: org.payoutUpdatedAt }
            : null,
      // After a bank change, payouts wait 24 hours.
      holdUntil: org.payoutHoldUntil && org.payoutHoldUntil > new Date() ? org.payoutHoldUntil : null,
      history,
    };
  }

  async setPayoutSchedule(orgId: string, user: AuthUser, schedule?: 'DAILY' | 'WEEKLY') {
    await this.member(orgId, user, ADMIN_ONLY);
    return this.prisma.organization.update({ where: { id: orgId }, data: schedule ? { payoutSchedule: schedule } : {}, select: { payoutSchedule: true } });
  }

  /**
   * Bank details are collected by Stripe Connect, never by Omoshow.
   * Returns a Stripe-hosted onboarding link (or explains that Stripe isn't configured).
   */
  async payoutOnboarding(orgId: string, user: AuthUser, returnUrl: string) {
    await this.member(orgId, user, ADMIN_ONLY);
    const stripe = this.payments.stripe;
    if (!stripe) return { url: null, message: 'Stripe is not configured on this server (set STRIPE_SECRET_KEY).' };
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    let accountId = org.stripeAccountId;
    if (!accountId) {
      const acct = await stripe.accounts.create({ type: 'express', email: org.supportEmail, business_profile: { name: org.name } });
      accountId = acct.id;
      await this.prisma.organization.update({ where: { id: orgId }, data: { stripeAccountId: accountId } });
    }
    const link = await stripe.accountLinks.create({ account: accountId, refresh_url: returnUrl, return_url: returnUrl, type: 'account_onboarding' });
    return { url: link.url };
  }
}
