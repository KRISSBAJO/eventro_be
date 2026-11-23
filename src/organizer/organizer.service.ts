import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { Payments } from '../checkout/payments';
import { randomSuffix, slugify } from '../domain/codes';
import { buyerPrice, organizerNet, type FeeMode } from '../domain/money';
import { verifyQr } from '../domain/qr';
import { arenaTemplate, capacityByTicketType, validateSeatMap, type SeatMap } from '../domain/seatmap';
import type { AuthUser } from '../common/auth';
import type {
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
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class OrganizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: Payments,
  ) {}

  /* ---------- access ---------- */

  private async member(orgId: string, user: AuthUser, roles: MemberRole[]) {
    const m = await this.prisma.organizationMember.findFirst({ where: { orgId, userId: user.id, status: 'ACTIVE' } });
    if (!m) throw new NotFoundException('Organization not found.');
    if (!roles.includes(m.role)) throw new ForbiddenException('Your role can’t do this.');
    return m;
  }

  private async eventFor(id: string, user: AuthUser, roles: MemberRole[]) {
    const ev = await this.prisma.event.findUnique({ where: { id }, include: { ticketTypes: { orderBy: { sortOrder: 'asc' } } } });
    if (!ev) throw new NotFoundException('Event not found.');
    await this.member(ev.orgId, user, roles);
    return ev;
  }

  /* ---------- organizations & team ---------- */

  async createOrg(user: AuthUser, dto: CreateOrgDto) {
    const org = await this.prisma.organization.create({
      data: {
        name: dto.name.trim(),
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
      select: { role: true, org: { select: { id: true, name: true, supportEmail: true, website: true, about: true, payoutSchedule: true, bankLast4: true, bankName: true } } },
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
      priceCents: buyerPrice(t.basePriceCents, feeMode, config.organizerFeePermille),
      capacity: t.capacity,
      maxPerOrder: t.maxPerOrder ?? 8,
      sortOrder: i,
    };
  }

  async createEvent(orgId: string, user: AuthUser, dto: CreateEventDto) {
    await this.member(orgId, user, EDIT);
    if (!dto.online && !dto.venueId && !dto.venue) throw new BadRequestException('Add a venue, or mark the event as online.');
    const feeMode: FeeMode = dto.feeMode ?? 'BUYER';
    let venueId = dto.venueId ?? null;
    if (!venueId && dto.venue) {
      const v = await this.prisma.venue.create({ data: { ...dto.venue, slug: `${slugify(dto.venue.name)}-${randomSuffix()}` } });
      venueId = v.id;
    }
    const ev = await this.prisma.event.create({
      data: {
        orgId,
        venueId,
        slug: `${slugify(dto.title)}-${randomSuffix()}`,
        title: dto.title.trim(),
        subtitle: dto.subtitle?.trim() ?? '',
        description: dto.description?.trim() ?? '',
        category: dto.category,
        imageUrl: dto.imageUrl,
        startsAt: new Date(dto.startsAt),
        doorsAt: dto.doorsAt ? new Date(dto.doorsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        timezone: dto.timezone ?? 'UTC',
        online: !!dto.online,
        streamUrl: dto.streamUrl,
        feeMode,
        visibility: dto.visibility ?? 'PUBLIC',
        ticketTypes: { create: dto.ticketTypes.map((t, i) => this.ticketTypeData(t, feeMode, i)) },
      },
      include: { ticketTypes: true },
    });
    return ev;
  }

  /** The organizer's events with ticket types and 60 days of daily sales (for the dashboard). */
  async listEvents(orgId: string, user: AuthUser) {
    await this.member(orgId, user, DOOR);
    const events = await this.prisma.event.findMany({
      where: { orgId },
      include: { ticketTypes: { orderBy: { sortOrder: 'asc' } }, venue: { select: { name: true, city: true, address: true } } },
      orderBy: { startsAt: 'asc' },
    });
    const days = 60;
    const since = new Date(Date.now() - days * DAY);
    const orders = await this.prisma.order.findMany({
      where: { event: { orgId }, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since } },
      select: { eventId: true, paidAt: true, quantity: true, subtotalCents: true, discountCents: true },
    });
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
      reviewNote: e.reviewNote,
      salesPaused: e.salesPaused,
      feeMode: e.feeMode,
      startsAt: e.startsAt,
      venue: e.venue,
      online: e.online,
      imageUrl: e.imageUrl,
      hasSeatMap: !!e.seatMap,
      ticketTypes: e.ticketTypes.map((t) => ({ id: t.id, name: t.name, description: t.description, priceCents: t.priceCents, capacity: t.capacity, sold: t.sold, maxPerOrder: t.maxPerOrder })),
      sold: e.ticketTypes.reduce((s, t) => s + t.sold, 0),
      capacity: e.ticketTypes.reduce((s, t) => s + t.capacity, 0),
      grossCents: e.ticketTypes.reduce((s, t) => s + t.sold * t.priceCents, 0),
      daily: daily.get(e.id) ?? { tickets: Array(days).fill(0), cents: Array(days).fill(0) },
    }));
  }

  /** Latest paid orders across the organization's events. */
  async recentOrders(orgId: string, user: AuthUser) {
    await this.member(orgId, user, EDIT);
    return this.prisma.order.findMany({
      where: { event: { orgId }, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      orderBy: { paidAt: 'desc' },
      take: 8,
      select: { id: true, buyerName: true, quantity: true, totalCents: true, paidAt: true, ticketType: { select: { name: true } }, event: { select: { title: true } } },
    });
  }

  async getEvent(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, DOOR);
    const promos = await this.prisma.promo.findMany({ where: { eventId: id }, orderBy: { code: 'asc' } });
    const venue = ev.venueId ? await this.prisma.venue.findUnique({ where: { id: ev.venueId } }) : null;
    return { ...ev, venue, promos };
  }

  async updateEvent(id: string, user: AuthUser, dto: UpdateEventDto) {
    await this.eventFor(id, user, EDIT);
    const data: Prisma.EventUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.subtitle !== undefined ? { subtitle: dto.subtitle.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
      ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
      ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
      ...(dto.doorsAt ? { doorsAt: new Date(dto.doorsAt) } : {}),
      ...(dto.endsAt ? { endsAt: new Date(dto.endsAt) } : {}),
      ...(dto.visibility ? { visibility: dto.visibility } : {}),
    };
    return this.prisma.event.update({ where: { id }, data });
  }

  async addTicketType(id: string, user: AuthUser, dto: TicketTypeInputDto) {
    const ev = await this.eventFor(id, user, EDIT);
    return this.prisma.ticketType.create({ data: { eventId: id, ...this.ticketTypeData(dto, ev.feeMode, ev.ticketTypes.length) } });
  }

  async updateTicketType(id: string, ttId: string, user: AuthUser, dto: UpdateTicketTypeDto) {
    const ev = await this.eventFor(id, user, EDIT);
    const tt = ev.ticketTypes.find((t) => t.id === ttId);
    if (!tt) throw new NotFoundException('Ticket type not found.');
    if (dto.capacity !== undefined && dto.capacity < tt.sold) throw new BadRequestException(`Capacity can’t be below the ${tt.sold} already sold.`);
    if (dto.capacity !== undefined && ev.seatMap && (ev.seatMap as SeatMap).sections.some((s) => s.ticketTypeId === ttId)) {
      throw new BadRequestException('This ticket type’s capacity comes from the seat map. Change the sections instead.');
    }
    return this.prisma.ticketType.update({
      where: { id: ttId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() } : {}),
        ...(dto.basePriceCents !== undefined ? { priceCents: buyerPrice(dto.basePriceCents, ev.feeMode, config.organizerFeePermille) } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.maxPerOrder !== undefined ? { maxPerOrder: dto.maxPerOrder } : {}),
      },
    });
  }

  async deleteTicketType(id: string, ttId: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    const tt = ev.ticketTypes.find((t) => t.id === ttId);
    if (!tt) throw new NotFoundException('Ticket type not found.');
    if (tt.sold > 0) throw new BadRequestException('Tickets of this type have been sold, so it can’t be deleted.');
    if (ev.ticketTypes.length === 1) throw new BadRequestException('An event needs at least one ticket type.');
    if (ev.seatMap && (ev.seatMap as SeatMap).sections.some((s) => s.ticketTypeId === ttId)) throw new BadRequestException('Remove this ticket type from the seat map first.');
    await this.prisma.ticketType.delete({ where: { id: ttId } });
    return { deleted: true };
  }

  async submit(id: string, user: AuthUser) {
    const ev = await this.eventFor(id, user, EDIT);
    if (ev.status !== 'DRAFT' && ev.status !== 'REJECTED') throw new BadRequestException('Only drafts and rejected events can be submitted.');
    if (ev.startsAt <= new Date()) throw new BadRequestException('The event date is in the past.');
    return this.prisma.event.update({ where: { id }, data: { status: 'IN_REVIEW', reviewNote: null } });
  }

  async setPaused(id: string, user: AuthUser, paused: boolean) {
    await this.eventFor(id, user, EDIT);
    await this.audit.log(user.id, paused ? 'event.pause' : 'event.resume', 'Event', id);
    return this.prisma.event.update({ where: { id }, data: { salesPaused: paused } });
  }

  /* ---------- seat map ---------- */

  async saveSeatMap(id: string, user: AuthUser, input: unknown) {
    const ev = await this.eventFor(id, user, EDIT);
    const result = validateSeatMap(input, new Set(ev.ticketTypes.map((t) => t.id)));
    if (!result.ok) throw new BadRequestException({ message: 'The seat map has problems.', errors: result.errors });
    const caps = capacityByTicketType(result.map);
    for (const t of ev.ticketTypes) {
      const cap = caps.get(t.id);
      if (cap !== undefined && cap < t.sold) {
        throw new BadRequestException(`${t.name}: the seat map has ${cap} places but ${t.sold} are already sold.`);
      }
    }
    if (ev.status === 'PUBLISHED') {
      // Sold seats must still exist in the new layout.
      const sold = await this.prisma.ticket.findMany({ where: { eventId: id, section: { not: null }, status: { not: 'VOID' } }, select: { section: true }, distinct: ['section'] });
      const kept = new Set(result.map.sections.map((s) => s.id));
      const missing = sold.map((s) => s.section!).filter((s) => !kept.has(s));
      if (missing.length) throw new BadRequestException(`Sections with sold tickets can’t be removed: ${missing.join(', ')}`);
    }
    await this.prisma.$transaction([
      this.prisma.event.update({ where: { id }, data: { seatMap: result.map as unknown as Prisma.InputJsonValue } }),
      ...[...caps.entries()].map(([ttId, capacity]) => this.prisma.ticketType.update({ where: { id: ttId }, data: { capacity } })),
    ]);
    return { seatMap: result.map, capacities: Object.fromEntries(caps) };
  }

  async applyTemplate(id: string, user: AuthUser, dto: TemplateDto) {
    return this.saveSeatMap(id, user, arenaTemplate({ floor: dto.floor, lower: dto.lower, upper: dto.upper }));
  }

  /* ---------- stats & attendees ---------- */

  async stats(id: string, user: AuthUser, days = 30) {
    const ev = await this.eventFor(id, user, DOOR);
    const since = new Date(Date.now() - days * DAY);
    const orders = await this.prisma.order.findMany({
      where: { eventId: id, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since } },
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
    const sold = ev.ticketTypes.reduce((s, t) => s + t.sold, 0);
    const gross = ev.ticketTypes.reduce((s, t) => s + t.sold * t.priceCents, 0);
    return {
      sold,
      capacity: ev.ticketTypes.reduce((s, t) => s + t.capacity, 0),
      grossCents: gross,
      netCents: ev.ticketTypes.reduce((s, t) => s + t.sold * organizerNet(t.priceCents, ev.feeMode, config.organizerFeePermille), 0),
      checkedIn,
      byTicketType: ev.ticketTypes.map((t) => ({ id: t.id, name: t.name, sold: t.sold, capacity: t.capacity, priceCents: t.priceCents })),
      daily: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
    };
  }

  async attendees(id: string, user: AuthUser, q?: string, status?: string) {
    await this.eventFor(id, user, DOOR);
    const s = q?.trim();
    return this.prisma.ticket.findMany({
      where: {
        eventId: id,
        status: status === 'checked-in' ? 'CHECKED_IN' : status === 'not-checked-in' ? { in: ['ACTIVE', 'TRANSFER_PENDING', 'LISTED'] } : { not: 'VOID' },
        ...(s
          ? { OR: [{ holderName: { contains: s, mode: 'insensitive' } }, { holderEmail: { contains: s, mode: 'insensitive' } }, { id: { contains: s.toUpperCase() } }] }
          : {}),
      },
      select: { id: true, holderName: true, holderEmail: true, section: true, row: true, seat: true, status: true, checkedInAt: true, ticketType: { select: { name: true } } },
      orderBy: { id: 'asc' },
      take: 5000,
    });
  }

  async attendeesCsv(id: string, user: AuthUser) {
    const rows = await this.attendees(id, user);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Ticket', 'Name', 'Email', 'Ticket type', 'Section', 'Row', 'Seat', 'Status', 'Checked in at'];
    return [head, ...rows.map((r) => [r.id, r.holderName, r.holderEmail, r.ticketType.name, r.section, r.row, r.seat, r.status, r.checkedInAt?.toISOString()])]
      .map((r) => r.map(esc).join(','))
      .join('\r\n');
  }

  /* ---------- door check-in ---------- */

  async checkIn(id: string, user: AuthUser, code: string) {
    await this.eventFor(id, user, DOOR);
    let ticketId = code.trim().toUpperCase();
    if (code.includes('.')) {
      const v = verifyQr(config.qrSecret, code.trim());
      if (!v.ok) return { result: v.reason === 'expired' ? 'expired-code' : 'invalid', message: v.reason === 'expired' ? 'This code has expired. Ask them to reopen the ticket.' : 'Not a valid Eventro code.' };
      ticketId = v.ticketId;
    }
    const t = await this.prisma.ticket.findUnique({ where: { id: ticketId }, include: { ticketType: { select: { name: true } } } });
    if (!t) return { result: 'invalid', message: 'Ticket not found.' };
    if (t.eventId !== id) return { result: 'wrong-event', message: 'This ticket is for a different event.' };
    if (t.status === 'CHECKED_IN') return { result: 'duplicate', message: 'Already checked in.', ticket: this.doorView(t), checkedInAt: t.checkedInAt };
    if (t.status === 'VOID') return { result: 'invalid', message: 'This ticket was refunded or cancelled.' };
    if (t.status === 'TRANSFER_PENDING') return { result: 'invalid', message: 'This ticket is being transferred.' };
    // Conditional update so two scanners can't admit the same ticket twice.
    const { count } = await this.prisma.ticket.updateMany({
      where: { id: t.id, status: { in: ['ACTIVE', 'LISTED'] } },
      data: { status: 'CHECKED_IN', checkedInAt: new Date(), checkedInBy: user.id, listCents: null },
    });
    if (!count) return { result: 'duplicate', message: 'Already checked in.', ticket: this.doorView(t) };
    return { result: 'ok', message: 'Valid: let them in.', ticket: this.doorView(t) };
  }

  private doorView(t: { id: string; holderName: string; section: string | null; row: string | null; seat: number | null; ticketType: { name: string } }) {
    return { id: t.id, holderName: t.holderName, ticketType: t.ticketType.name, section: t.section, row: t.row, seat: t.seat };
  }

  async undoCheckIn(id: string, ticketId: string, user: AuthUser) {
    await this.eventFor(id, user, DOOR);
    const { count } = await this.prisma.ticket.updateMany({
      where: { id: ticketId, eventId: id, status: 'CHECKED_IN' },
      data: { status: 'ACTIVE', checkedInAt: null, checkedInBy: null },
    });
    if (!count) throw new NotFoundException('Checked-in ticket not found.');
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
    const since = new Date(Date.now() - 31 * DAY);
    const orders = await this.prisma.order.findMany({
      where: { event: { orgId }, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] }, paidAt: { gte: since } },
      select: { paidAt: true, quantity: true, unitCents: true, discountCents: true, refundedCents: true, event: { select: { feeMode: true } } },
    });
    const byDay = new Map<string, number>();
    for (const o of orders) {
      const k = dayKey(o.paidAt!);
      // Organizer share of the tickets (protection is Eventro's), after discounts and refunds.
      const net = organizerNet(o.unitCents, o.event.feeMode, config.organizerFeePermille) * o.quantity - o.discountCents - o.refundedCents;
      byDay.set(k, (byDay.get(k) ?? 0) + Math.max(0, net));
    }
    const today = dayKey(new Date());
    const history = [...byDay.entries()]
      .filter(([d]) => d < today)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, cents]) => ({ salesDate: date, amountCents: cents, status: 'PAID' as const }));
    return {
      schedule: org.payoutSchedule,
      pendingCents: byDay.get(today) ?? 0,
      nextPayoutCents: org.payoutSchedule === 'DAILY' ? (byDay.get(dayKey(new Date(Date.now() - DAY))) ?? 0) : history.slice(0, 7).reduce((s, h) => s + h.amountCents, 0),
      payoutMethod: org.stripeAccountId ? { provider: 'stripe', bankLast4: org.bankLast4, bankName: org.bankName } : null,
      history,
    };
  }

  async setPayoutSchedule(orgId: string, user: AuthUser, schedule?: 'DAILY' | 'WEEKLY') {
    await this.member(orgId, user, ADMIN_ONLY);
    return this.prisma.organization.update({ where: { id: orgId }, data: schedule ? { payoutSchedule: schedule } : {}, select: { payoutSchedule: true } });
  }

  /**
   * Bank details are collected by Stripe Connect, never by Eventro.
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
