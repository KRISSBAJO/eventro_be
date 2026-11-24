/**
 * The admin console beyond moderation queues: platform overview, people, organizers, events, orders,
 * newsletter subscribers and broadcasts, price drops and the email log. Every change is written to the audit log.
 * All routes need the ADMIN role.
 */
import { previewToken } from '../events/preview';
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, Roles, type AuthUser, type Role } from '../common/auth';
import { config } from '../config';
import { FxService } from '../fx/fx.module';
import { MailService, render, type Mail } from '../mail/mail.module';
import { CATEGORIES } from '../newsletter/newsletter.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { AdminController, AdminService } from './admin.module';
import { EventCancellation } from './cancel-event';

const PAGE = 25;
const DAY = 86400_000;
const ROLES: Role[] = ['FAN', 'ORGANIZER', 'ADMIN'];
const EVENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED', 'CANCELLED'] as const;
const ORDER_STATUSES = ['PENDING', 'PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

const pageOf = (raw?: string) => Math.max(1, Math.min(10_000, Number(raw) || 1));
const like = (q?: string) => (q ?? '').trim().slice(0, 100);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/* ---------- DTOs ---------- */

export class AdminCancelEventDto {
  @ApiProperty({ minLength: 10, description: 'Shown to buyers in the cancellation email and kept in the audit log' }) @IsString() @MinLength(10) @MaxLength(500) reason: string;
}

const REASON_DOC = { description: 'Why. Required (5+ characters) when suspending; shown on the account and kept in the audit log.' };
const NOTE_DOC = { description: 'Internal note for the audit log (never shown to the account holder), e.g. why a suspension was lifted.' };
/** A reason is required to suspend; when given at any other time it must still say something. */
const needsReason = (o: { suspended?: boolean; reason?: string }) => o.suspended === true || o.reason !== undefined;

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: ROLES, isArray: true }) @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(ROLES, { each: true }) roles?: Role[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() suspended?: boolean;
  @ApiPropertyOptional(REASON_DOC) @ValidateIf(needsReason) @IsString() @MinLength(5) @MaxLength(300) reason?: string;
  @ApiPropertyOptional(NOTE_DOC) @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class UpdateOrgDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() verified?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() suspended?: boolean;
  @ApiPropertyOptional(REASON_DOC) @ValidateIf(needsReason) @IsString() @MinLength(5) @MaxLength(300) reason?: string;
  @ApiPropertyOptional(NOTE_DOC) @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Trimmed text, or null when blank. */
const clean = (s?: string) => s?.trim() || null;
/** Suspending needs a reason that says something once trimmed. */
function reasonFor(dto: { suspended?: boolean; reason?: string }) {
  const reason = clean(dto.reason);
  if (dto.suspended && (!reason || reason.length < 5)) throw new BadRequestException('Give a reason (at least 5 characters) to suspend.');
  return reason;
}
const PAID_STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as ('PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED')[];

export class NoteDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(500) note: string;
}

export class SalesDto {
  @ApiProperty() @IsBoolean() paused: boolean;
}

export class AdminRefundDto {
  @ApiPropertyOptional({ description: 'Minor units; leave out for a full refund of what is left' }) @IsOptional() @IsInt() @Min(1) amountCents?: number;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason: string;
}

export class BroadcastDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(150) subject: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(150) heading: string;
  @ApiProperty({ description: 'Plain text; blank lines start new paragraphs' }) @IsString() @MinLength(10) @MaxLength(5000) body: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) ctaLabel?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }) ctaUrl?: string;
  @ApiPropertyOptional({ enum: CATEGORIES }) @IsOptional() @IsIn(CATEGORIES) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[a-z0-9-]{1,60}$/) city?: string;
  @ApiPropertyOptional({ description: 'Inbox preview line; defaults to the start of the first paragraph' }) @IsOptional() @IsString() @MaxLength(150) preheader?: string;
  @ApiPropertyOptional({ description: 'Send only to yourself' }) @IsOptional() @IsBoolean() test?: boolean;
}

/* ---------- service ---------- */

@Injectable()
export class AdminConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fx: FxService,
    private readonly mail: MailService,
    private readonly admin: AdminService,
  ) {}

  private usd = (cents: number, currency: string) => this.fx.convert(cents, currency, 'USD');

  async overview() {
    const since = new Date(Date.now() - 29 * DAY);
    since.setUTCHours(0, 0, 0, 0);
    const paidStatuses = { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as ('PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED')[] };
    const [users, suspendedUsers, organizers, orgs, verifiedOrgs, suspendedOrgs, byStatus, upcoming, subscribers, watchers, openRefunds, openFraud, byCurrency, recent, recentOrders, emailStats, ticketsSold] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.user.count({ where: { suspendedAt: { not: null } } }),
        this.prisma.user.count({ where: { roles: { has: 'ORGANIZER' } } }),
        this.prisma.organization.count(),
        this.prisma.organization.count({ where: { verifiedAt: { not: null } } }),
        this.prisma.organization.count({ where: { suspendedAt: { not: null } } }),
        this.prisma.event.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.event.count({ where: { status: 'PUBLISHED', startsAt: { gte: new Date() } } }),
        this.prisma.subscriber.count({ where: { unsubscribedAt: null } }),
        this.prisma.priceWatch.count({ where: { stoppedAt: null } }),
        this.prisma.refundRequest.count({ where: { status: 'OPEN' } }),
        this.prisma.fraudFlag.count({ where: { status: 'OPEN' } }),
        this.prisma.order.groupBy({ by: ['currency'], where: { status: paidStatuses }, _sum: { totalCents: true, refundedCents: true, quantity: true }, _count: { _all: true } }),
        this.prisma.order.findMany({ where: { status: paidStatuses, paidAt: { gte: since } }, select: { paidAt: true, quantity: true, totalCents: true, refundedCents: true, currency: true } }),
        this.prisma.order.findMany({
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, email: true, buyerName: true, totalCents: true, currency: true, status: true, createdAt: true, quantity: true, event: { select: { title: true, slug: true } } },
        }),
        this.prisma.emailLog.groupBy({ by: ['status'], where: { createdAt: { gte: new Date(Date.now() - 7 * DAY) } }, _count: { _all: true } }),
        this.prisma.ticket.count({ where: { status: { not: 'VOID' } } }),
      ]);
    const [venues, openVenueClaims] = await Promise.all([this.prisma.venue.count({ where: { hiddenAt: null } }), this.prisma.venueClaim.count({ where: { status: 'PENDING' } })]);

    const currencies = byCurrency.map((c) => ({ currency: c.currency, orders: c._count._all, grossCents: c._sum.totalCents ?? 0, refundedCents: c._sum.refundedCents ?? 0 }));
    const grossUsd = currencies.reduce((s, c) => s + this.usd(c.grossCents, c.currency), 0);
    const refundedUsd = currencies.reduce((s, c) => s + this.usd(c.refundedCents, c.currency), 0);

    const keys = Array.from({ length: 30 }, (_, i) => dayKey(new Date(since.getTime() + i * DAY)));
    const daily = new Map(keys.map((k) => [k, { day: k, orders: 0, tickets: 0, grossUsdCents: 0 }]));
    for (const o of recent) {
      const d = daily.get(dayKey(o.paidAt!));
      if (!d) continue;
      d.orders += 1;
      d.tickets += o.quantity;
      d.grossUsdCents += this.usd(o.totalCents - o.refundedCents, o.currency);
    }

    const top = await this.prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true, slug: true, title: true, currency: true, ticketTypes: { select: { sold: true, capacity: true, priceCents: true } } },
    });
    const topEvents = top
      .map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        sold: e.ticketTypes.reduce((s, t) => s + t.sold, 0),
        capacity: e.ticketTypes.reduce((s, t) => s + t.capacity, 0),
        grossUsdCents: this.usd(e.ticketTypes.reduce((s, t) => s + t.sold * t.priceCents, 0), e.currency),
      }))
      .sort((a, b) => b.grossUsdCents - a.grossUsdCents)
      .slice(0, 5);

    const events = Object.fromEntries(EVENT_STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0]));
    const mailCounts = Object.fromEntries(['SENT', 'FAILED', 'SKIPPED'].map((s) => [s, emailStats.find((e) => e.status === s)?._count._all ?? 0]));
    return {
      counts: { users, suspendedUsers, organizers, orgs, verifiedOrgs, suspendedOrgs, events, upcomingPublished: upcoming, ordersPaid: currencies.reduce((s, c) => s + c.orders, 0), ticketsSold, subscribers, priceWatchers: watchers, openRefunds, openFraud, venues, openVenueClaims },
      money: {
        currencies,
        usd: { grossCents: grossUsd, refundedCents: refundedUsd, netCents: grossUsd - refundedUsd, estFeeCents: Math.round(((grossUsd - refundedUsd) * config.organizerFeePermille) / 1000) },
      },
      daily: [...daily.values()],
      recentOrders,
      topEvents,
      email: { enabled: this.mail.enabled, from: config.mailFrom, last7d: mailCounts },
    };
  }

  /* ----- people ----- */

  async users(q?: string, role?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = like(q);
    const where: Prisma.UserWhereInput = {
      ...(s ? { OR: [{ email: { contains: s, mode: 'insensitive' } }, { name: { contains: s, mode: 'insensitive' } }, { id: s }] } : {}),
      ...(role && ROLES.includes(role as Role) ? { roles: { has: role as Role } } : {}),
      ...(status === 'suspended' ? { suspendedAt: { not: null } } : status === 'active' ? { suspendedAt: null } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: { id: true, email: true, name: true, roles: true, createdAt: true, suspendedAt: true, suspendReason: true, _count: { select: { orders: true, memberships: true, tickets: true } } },
      }),
    ]);
    return { total, page, pageSize: PAGE, items: rows.map(({ _count, ...u }) => ({ ...u, orders: _count.orders, orgs: _count.memberships, tickets: _count.tickets })) };
  }

  async updateUser(id: string, me: AuthUser, dto: UpdateUserDto) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw new NotFoundException('User not found.');
    if (id === me.id && (dto.suspended || (dto.roles && !dto.roles.includes('ADMIN')))) {
      throw new ForbiddenException('You can’t suspend yourself or remove your own admin role.');
    }
    if (dto.roles && u.roles.includes('ADMIN') && !dto.roles.includes('ADMIN')) {
      const admins = await this.prisma.user.count({ where: { roles: { has: 'ADMIN' }, suspendedAt: null } });
      if (admins <= 1) throw new BadRequestException('Eventro needs at least one admin.');
    }
    const reason = reasonFor(dto);
    const note = clean(dto.note);
    const data: Prisma.UserUpdateInput = {};
    if (dto.roles) data.roles = { set: [...new Set<Role>(['FAN', ...dto.roles])] };
    if (dto.suspended !== undefined) {
      data.suspendedAt = dto.suspended ? new Date() : null;
      data.suspendReason = dto.suspended ? reason : null;
    }
    const out = await this.prisma.user.update({ where: { id }, data, select: { id: true, email: true, name: true, roles: true, createdAt: true, suspendedAt: true, suspendReason: true } });
    if (dto.roles) await this.audit.log(me.id, 'user.roles', 'User', id, { from: u.roles, to: out.roles, note });
    if (dto.suspended !== undefined) {
      await this.audit.log(me.id, dto.suspended ? 'user.suspend' : 'user.unsuspend', 'User', id, dto.suspended ? { reason, note } : { note, reason, previousReason: u.suspendReason });
    }
    return out;
  }

  /** Audit entries about these records, newest first, with who made them. */
  private async history(where: Prisma.AuditLogWhereInput, take = 100) {
    const rows = await this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, include: { actor: { select: { id: true, name: true, email: true } } } });
    return rows.map(({ actorId: _a, ...r }) => r);
  }

  /** One account for its admin page: activity, team memberships and the history of admin changes to it. */
  async user(id: string) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, roles: true, createdAt: true, suspendedAt: true, suspendReason: true, _count: { select: { orders: true, tickets: true, memberships: true } } },
    });
    if (!u) throw new NotFoundException('User not found.');
    const [orders, tickets, memberships, spend, history, activeAdmins] = await Promise.all([
      this.prisma.order.findMany({
        where: { buyerId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, quantity: true, totalCents: true, refundedCents: true, currency: true, status: true, createdAt: true, event: { select: { title: true, slug: true } } },
      }),
      this.prisma.ticket.groupBy({ by: ['status'], where: { ownerId: id }, _count: { _all: true } }),
      this.prisma.organizationMember.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, status: true, createdAt: true, org: { select: { id: true, name: true, verifiedAt: true, suspendedAt: true } } },
      }),
      this.prisma.order.groupBy({ by: ['currency'], where: { buyerId: id, status: { in: PAID_STATUSES } }, _sum: { totalCents: true, refundedCents: true }, _count: { _all: true } }),
      this.history({ entity: 'User', entityId: id }),
      this.prisma.user.count({ where: { roles: { has: 'ADMIN' }, suspendedAt: null } }),
    ]);
    const { _count, ...rest } = u;
    const spent = spend.map((s) => ({ currency: s.currency, orders: s._count._all, netCents: (s._sum.totalCents ?? 0) - (s._sum.refundedCents ?? 0) }));
    return {
      ...rest,
      counts: { orders: _count.orders, tickets: _count.tickets, orgs: _count.memberships },
      tickets: Object.fromEntries(tickets.map((t) => [t.status, t._count._all])),
      spent,
      spentUsdCents: spent.reduce((s, c) => s + this.usd(c.netCents, c.currency), 0),
      orders,
      memberships: memberships.map((m) => ({ role: m.role, status: m.status, since: m.createdAt, org: { id: m.org.id, name: m.org.name, verified: !!m.org.verifiedAt, suspended: !!m.org.suspendedAt } })),
      activeAdmins,
      history,
    };
  }

  /* ----- organizers ----- */

  async orgs(q?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = like(q);
    const where: Prisma.OrganizationWhereInput = {
      ...(s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { supportEmail: { contains: s, mode: 'insensitive' } }, { id: s }] } : {}),
      ...(status === 'suspended' ? { suspendedAt: { not: null } } : {}),
      ...(status === 'verified' ? { verifiedAt: { not: null } } : {}),
      ...(status === 'unverified' ? { verifiedAt: null } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          _count: { select: { members: true } },
          events: { select: { status: true, currency: true, ticketTypes: { select: { sold: true, priceCents: true } } } },
        },
      }),
    ]);
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map((o) => ({
        id: o.id,
        name: o.name,
        supportEmail: o.supportEmail,
        website: o.website,
        createdAt: o.createdAt,
        verifiedAt: o.verifiedAt,
        suspendedAt: o.suspendedAt,
        suspendReason: o.suspendReason,
        payoutsReady: !!o.stripeAccountId || !!o.bankLast4,
        members: o._count.members,
        events: { total: o.events.length, published: o.events.filter((e) => e.status === 'PUBLISHED').length },
        ticketsSold: o.events.reduce((s, e) => s + e.ticketTypes.reduce((a, t) => a + t.sold, 0), 0),
        grossUsdCents: o.events.reduce((s, e) => s + this.usd(e.ticketTypes.reduce((a, t) => a + t.sold * t.priceCents, 0), e.currency), 0),
      })),
    };
  }

  async updateOrg(id: string, me: AuthUser, dto: UpdateOrgDto) {
    const o = await this.prisma.organization.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Organizer not found.');
    const reason = reasonFor(dto);
    const note = clean(dto.note);
    const data: Prisma.OrganizationUpdateInput = {};
    if (dto.verified !== undefined) data.verifiedAt = dto.verified ? (o.verifiedAt ?? new Date()) : null;
    if (dto.suspended !== undefined) {
      data.suspendedAt = dto.suspended ? new Date() : null;
      data.suspendReason = dto.suspended ? reason : null;
    }
    const out = await this.prisma.organization.update({ where: { id }, data });
    // Suspending stops sales at once; lifting it leaves resuming to the organizer, event by event.
    let paused = 0;
    if (dto.suspended) paused = (await this.prisma.event.updateMany({ where: { orgId: id, salesPaused: false }, data: { salesPaused: true } })).count;
    if (dto.verified !== undefined) await this.audit.log(me.id, dto.verified ? 'org.verify' : 'org.unverify', 'Organization', id, { note });
    if (dto.suspended !== undefined) {
      await this.audit.log(
        me.id,
        dto.suspended ? 'org.suspend' : 'org.unsuspend',
        'Organization',
        id,
        dto.suspended ? { reason, note, pausedEvents: paused } : { note, reason, previousReason: o.suspendReason },
      );
    }
    return { ...out, pausedEvents: paused };
  }

  /** One organizer for its admin page: team, events (with preview links), sales and payouts, and its history. */
  async org(id: string) {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        members: { orderBy: { createdAt: 'asc' }, select: { id: true, email: true, role: true, status: true, createdAt: true, user: { select: { id: true, name: true, email: true, suspendedAt: true } } } },
        events: {
          orderBy: { startsAt: 'desc' },
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            startsAt: true,
            currency: true,
            salesPaused: true,
            online: true,
            venue: { select: { name: true, city: true } },
            ticketTypes: { select: { sold: true, capacity: true, priceCents: true } },
          },
        },
      },
    });
    if (!o) throw new NotFoundException('Organizer not found.');
    const eventIds = o.events.map((e) => e.id);
    const [sales, history] = await Promise.all([
      this.prisma.order.groupBy({ by: ['currency'], where: { event: { orgId: id }, status: { in: PAID_STATUSES } }, _sum: { totalCents: true, refundedCents: true, quantity: true }, _count: { _all: true } }),
      this.history({ OR: [{ entity: 'Organization', entityId: id }, ...(eventIds.length ? [{ entity: 'Event', entityId: { in: eventIds } }] : [])] }),
    ]);
    const events = o.events.map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      status: e.status,
      previewToken: previewToken(e.slug, e.status),
      startsAt: e.startsAt,
      currency: e.currency,
      salesPaused: e.salesPaused,
      online: e.online,
      venue: e.venue,
      sold: e.ticketTypes.reduce((s, t) => s + t.sold, 0),
      capacity: e.ticketTypes.reduce((s, t) => s + t.capacity, 0),
      grossCents: e.ticketTypes.reduce((s, t) => s + t.sold * t.priceCents, 0),
    }));
    const byCurrency = sales.map((s) => ({
      currency: s.currency,
      orders: s._count._all,
      tickets: s._sum.quantity ?? 0,
      grossCents: s._sum.totalCents ?? 0,
      refundedCents: s._sum.refundedCents ?? 0,
    }));
    const grossUsd = byCurrency.reduce((s, c) => s + this.usd(c.grossCents, c.currency), 0);
    const refundedUsd = byCurrency.reduce((s, c) => s + this.usd(c.refundedCents, c.currency), 0);
    return {
      id: o.id,
      name: o.name,
      supportEmail: o.supportEmail,
      website: o.website,
      about: o.about,
      createdAt: o.createdAt,
      verifiedAt: o.verifiedAt,
      suspendedAt: o.suspendedAt,
      suspendReason: o.suspendReason,
      members: o.members,
      events,
      counts: {
        events: events.length,
        published: events.filter((e) => e.status === 'PUBLISHED').length,
        paused: events.filter((e) => e.salesPaused).length,
        ticketsSold: events.reduce((s, e) => s + e.sold, 0),
      },
      payouts: {
        ready: !!o.stripeAccountId || !!o.bankLast4,
        schedule: o.payoutSchedule,
        provider: o.stripeAccountId ? 'stripe' : o.bankLast4 ? 'bank' : null,
        bankName: o.bankName,
        bankLast4: o.bankLast4,
        bankCountry: o.bankCountry,
        byCurrency,
        usd: { grossCents: grossUsd, refundedCents: refundedUsd, netCents: grossUsd - refundedUsd, estFeeCents: Math.round(((grossUsd - refundedUsd) * config.organizerFeePermille) / 1000) },
      },
      history,
    };
  }

  /* ----- events ----- */

  async events(q?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = like(q);
    const where: Prisma.EventWhereInput = {
      ...(s ? { OR: [{ title: { contains: s, mode: 'insensitive' } }, { slug: { contains: s, mode: 'insensitive' } }, { org: { name: { contains: s, mode: 'insensitive' } } }] } : {}),
      ...(status && (EVENT_STATUSES as readonly string[]).includes(status) ? { status: status as (typeof EVENT_STATUSES)[number] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        orderBy: { startsAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: {
          org: { select: { id: true, name: true, verifiedAt: true, suspendedAt: true } },
          venue: { select: { name: true, city: true } },
          ticketTypes: { select: { sold: true, capacity: true, priceCents: true } },
          _count: { select: { priceWatches: true, priceDrops: true } },
        },
      }),
    ]);
    return {
      total,
      page,
      pageSize: PAGE,
      items: rows.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        status: e.status,
        previewToken: previewToken(e.slug, e.status),
        category: e.category,
        startsAt: e.startsAt,
        currency: e.currency,
        salesPaused: e.salesPaused,
        reviewNote: e.reviewNote,
        cancelledAt: e.cancelledAt,
        cancelReason: e.cancelReason,
        online: e.online,
        org: { id: e.org.id, name: e.org.name, verified: !!e.org.verifiedAt, suspended: !!e.org.suspendedAt },
        venue: e.venue,
        sold: e.ticketTypes.reduce((s, t) => s + t.sold, 0),
        capacity: e.ticketTypes.reduce((s, t) => s + t.capacity, 0),
        grossCents: e.ticketTypes.reduce((s, t) => s + t.sold * t.priceCents, 0),
        priceWatchers: e._count.priceWatches,
        priceDrops: e._count.priceDrops,
        createdAt: e.createdAt,
      })),
    };
  }

  async takedown(id: string, me: AuthUser, note: string) {
    const { count } = await this.prisma.event.updateMany({ where: { id, status: 'PUBLISHED' }, data: { status: 'REJECTED', reviewNote: `Taken down by Eventro: ${note}`, salesPaused: true } });
    if (!count) throw new NotFoundException('No published event with that id.');
    await this.audit.log(me.id, 'event.takedown', 'Event', id, { note });
    return { status: 'REJECTED' };
  }

  async publish(id: string, me: AuthUser) {
    const e = await this.prisma.event.findUnique({ where: { id }, include: { org: { select: { suspendedAt: true } } } });
    if (!e || !['REJECTED', 'IN_REVIEW'].includes(e.status)) throw new NotFoundException('Only events in review or taken down can be published.');
    if (e.org.suspendedAt) throw new BadRequestException('The organizer is suspended. Lift the suspension first.');
    await this.prisma.event.update({ where: { id }, data: { status: 'PUBLISHED', reviewNote: null, salesPaused: false } });
    await this.audit.log(me.id, 'event.publish', 'Event', id);
    return { status: 'PUBLISHED' };
  }

  async setSales(id: string, me: AuthUser, paused: boolean) {
    const e = await this.prisma.event.findUnique({ where: { id }, select: { id: true } });
    if (!e) throw new NotFoundException('Event not found.');
    await this.prisma.event.update({ where: { id }, data: { salesPaused: paused } });
    await this.audit.log(me.id, paused ? 'event.admin_pause' : 'event.admin_resume', 'Event', id);
    return { salesPaused: paused };
  }

  /* ----- orders ----- */

  async orders(q?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = like(q);
    const where: Prisma.OrderWhereInput = {
      ...(s ? { OR: [{ id: { contains: s.toUpperCase() } }, { email: { contains: s, mode: 'insensitive' } }, { buyerName: { contains: s, mode: 'insensitive' } }, { event: { title: { contains: s, mode: 'insensitive' } } }] } : {}),
      ...(status && (ORDER_STATUSES as readonly string[]).includes(status) ? { status: status as (typeof ORDER_STATUSES)[number] } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: {
          id: true,
          email: true,
          buyerName: true,
          quantity: true,
          totalCents: true,
          refundedCents: true,
          currency: true,
          status: true,
          provider: true,
          promoCode: true,
          createdAt: true,
          paidAt: true,
          event: { select: { title: true, slug: true } },
          ticketType: { select: { name: true } },
          fraudFlag: { select: { score: true, status: true } },
          _count: { select: { refunds: true } },
        },
      }),
    ]);
    return { total, page, pageSize: PAGE, items: items.map(({ fraudFlag, _count, ...o }) => ({ ...o, fraud: fraudFlag, refundRequests: _count.refunds })) };
  }

  async refund(id: string, me: AuthUser, dto: AdminRefundDto) {
    const o = await this.prisma.order.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Order not found.');
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.status)) throw new BadRequestException('Only paid orders can be refunded.');
    const left = o.totalCents - o.refundedCents;
    await this.admin.refundOrder(id, dto.amountCents ?? left, me, dto.reason);
    return this.prisma.order.findUnique({ where: { id }, select: { id: true, status: true, refundedCents: true, totalCents: true, currency: true } });
  }

  /* ----- subscribers & broadcasts ----- */

  private subscriberWhere(q?: string, status?: string): Prisma.SubscriberWhereInput {
    const s = like(q);
    return {
      ...(s ? { email: { contains: s, mode: 'insensitive' } } : {}),
      ...(status === 'unsubscribed' ? { unsubscribedAt: { not: null } } : status === 'active' ? { unsubscribedAt: null } : {}),
    };
  }

  async subscribers(q?: string, status?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const where = this.subscriberWhere(q, status);
    const d30 = new Date(Date.now() - 30 * DAY);
    const d60 = new Date(Date.now() - 60 * DAY);
    const [total, active, unsubscribed, joined30d, joinedPrev30d, left30d, items] = await Promise.all([
      this.prisma.subscriber.count({ where }),
      this.prisma.subscriber.count({ where: { unsubscribedAt: null } }),
      this.prisma.subscriber.count({ where: { unsubscribedAt: { not: null } } }),
      this.prisma.subscriber.count({ where: { createdAt: { gte: d30 } } }),
      this.prisma.subscriber.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
      this.prisma.subscriber.count({ where: { unsubscribedAt: { gte: d30 } } }),
      this.prisma.subscriber.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE,
        take: PAGE,
        select: { id: true, email: true, source: true, interests: true, city: true, createdAt: true, unsubscribedAt: true },
      }),
    ]);
    return { total, page, pageSize: PAGE, counts: { active, unsubscribed, joined30d, joinedPrev30d, left30d }, items };
  }

  async subscribersCsv(status?: string) {
    const rows = await this.prisma.subscriber.findMany({ where: this.subscriberWhere(undefined, status), orderBy: { createdAt: 'asc' } });
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return ['email,status,source,interests,city,signed_up,unsubscribed_at']
      .concat(rows.map((r) => [r.email, r.unsubscribedAt ? 'unsubscribed' : 'active', r.source, r.interests.join(' '), r.city ?? '', r.createdAt.toISOString(), r.unsubscribedAt?.toISOString() ?? ''].map(cell).join(',')))
      .join('\n');
  }

  private audienceWhere(category?: string, city?: string): Prisma.SubscriberWhereInput {
    return {
      unsubscribedAt: null,
      ...(category ? { OR: [{ interests: { isEmpty: true } }, { interests: { has: category } }] } : {}),
      ...(city ? { AND: [{ OR: [{ city: null }, { city }] }] } : {}),
    };
  }

  async broadcastAudience(category?: string, city?: string) {
    return { count: await this.prisma.subscriber.count({ where: this.audienceWhere(category, city) }) };
  }

  async broadcast(me: AuthUser, dto: BroadcastDto) {
    const recipients = dto.test
      ? [{ email: me.email, token: '' }]
      : await this.prisma.subscriber.findMany({ where: this.audienceWhere(dto.category, dto.city), select: { email: true, token: true } });
    if (!recipients.length) throw new BadRequestException('No subscribers match that audience.');
    const paragraphs = dto.body.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    const mails: Mail[] = recipients.map((r) => {
      const manage = r.token ? `${config.webUrl}/newsletter/manage?t=${r.token}` : `${config.webUrl}/newsletter`;
      const { html, text } = render({
        preheader: clean(dto.preheader) ?? paragraphs[0]?.slice(0, 120) ?? dto.subject,
        heading: dto.heading,
        paragraphs,
        cta: dto.ctaLabel && dto.ctaUrl ? { label: dto.ctaLabel, url: dto.ctaUrl } : undefined,
        footer: dto.test ? 'Test send: only you got this.' : 'You get drops and presales from Eventro.',
        footerLink: { label: 'Change preferences or unsubscribe', url: manage },
      });
      return { to: r.email, subject: dto.test ? `[Test] ${dto.subject}` : dto.subject, html, text, unsubscribeUrl: manage };
    });
    if (!dto.test) await this.audit.log(me.id, 'newsletter.broadcast', 'Subscriber', 'broadcast', { subject: dto.subject, category: dto.category ?? null, city: dto.city ?? null, recipients: mails.length });
    // Big lists go out in the background; the admin sees progress in the email log.
    const sending = this.mail.sendMany(dto.test ? 'broadcast.test' : 'broadcast', mails);
    if (dto.test) {
      const [ok] = await sending;
      return { test: true, recipients: 1, sent: ok, emailEnabled: this.mail.enabled };
    }
    void sending;
    return { test: false, recipients: mails.length, queued: true, emailEnabled: this.mail.enabled };
  }

  /** The last broadcasts (from the audit log), with how their emails went (from the email log). */
  async broadcasts(limitRaw?: string) {
    const take = Math.max(1, Math.min(50, Number(limitRaw) || 10));
    const rows = await this.history({ action: 'newsletter.broadcast' }, take);
    return Promise.all(
      rows.map(async (r, i) => {
        const d = (r.data ?? {}) as { subject?: string; category?: string | null; city?: string | null; recipients?: number };
        // This broadcast's emails: same subject, logged after it started and before the next (newer) one.
        const until = rows[i - 1]?.createdAt;
        const stats = d.subject
          ? await this.prisma.emailLog.groupBy({
              by: ['status'],
              where: { kind: 'broadcast', subject: d.subject.slice(0, 300), createdAt: { gte: new Date(r.createdAt.getTime() - 5000), ...(until ? { lt: until } : {}) } },
              _count: { _all: true },
            })
          : [];
        const count = (s: string) => stats.find((x) => x.status === s)?._count._all ?? 0;
        return {
          id: r.id,
          createdAt: r.createdAt,
          actor: r.actor,
          subject: d.subject ?? '',
          category: d.category ?? null,
          city: d.city ?? null,
          recipients: d.recipients ?? 0,
          delivery: { sent: count('SENT'), failed: count('FAILED'), skipped: count('SKIPPED') },
        };
      }),
    );
  }

  /* ----- price drops & email log ----- */

  async priceDrops(pageRaw?: string) {
    const page = pageOf(pageRaw);
    const [total, items] = await Promise.all([
      this.prisma.priceDrop.count(),
      this.prisma.priceDrop.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE, include: { event: { select: { title: true, slug: true } } } }),
    ]);
    return { total, page, pageSize: PAGE, items };
  }

  async emails(kind?: string, status?: string, q?: string, pageRaw?: string) {
    const page = pageOf(pageRaw);
    const s = like(q);
    const where: Prisma.EmailLogWhereInput = {
      ...(kind ? { kind: { startsWith: kind } } : {}),
      ...(status && ['SENT', 'FAILED', 'SKIPPED'].includes(status) ? { status } : {}),
      ...(s ? { OR: [{ to: { contains: s, mode: 'insensitive' } }, { subject: { contains: s, mode: 'insensitive' } }] } : {}),
    };
    const [total, items, kinds] = await Promise.all([
      this.prisma.emailLog.count({ where }),
      this.prisma.emailLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
      this.prisma.emailLog.groupBy({ by: ['kind'], _count: { _all: true } }),
    ]);
    return { total, page, pageSize: PAGE, enabled: this.mail.enabled, from: config.mailFrom, kinds: kinds.map((k) => ({ kind: k.kind, count: k._count._all })), items };
  }
}

/* ---------- routes ---------- */

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminConsoleController {
  constructor(
    private readonly svc: AdminConsoleService,
    private readonly cancellation: EventCancellation,
  ) {}

  @Get('overview') overview() {
    return this.svc.overview();
  }

  @Get('users') users(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.svc.users(q, role, status, page);
  }
  @Get('users/:id') user(@Param('id') id: string) {
    return this.svc.user(id);
  }
  @Patch('users/:id') updateUser(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateUserDto) {
    return this.svc.updateUser(id, u, dto);
  }

  @Get('orgs') orgs(@Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.svc.orgs(q, status, page);
  }
  @Get('orgs/:id') org(@Param('id') id: string) {
    return this.svc.org(id);
  }
  @Patch('orgs/:id') updateOrg(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateOrgDto) {
    return this.svc.updateOrg(id, u, dto);
  }

  @Get('events') events(@Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.svc.events(q, status, page);
  }
  @Post('events/:id/takedown') @HttpCode(200) takedown(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: NoteDto) {
    return this.svc.takedown(id, u, dto.note);
  }
  @Post('events/:id/publish') @HttpCode(200) publish(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.publish(id, u);
  }
  /** What cancelling would refund (paid orders and totals per currency). */
  @Get('events/:id/cancel-preview') cancelPreview(@Param('id') id: string) {
    return this.cancellation.preview(id);
  }
  /** Cancels the event and refunds every paid order. Safe to call again: it only retries refunds that failed. */
  @Post('events/:id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: AdminCancelEventDto) {
    return this.cancellation.cancel(id, u, dto.reason, 'admin');
  }
  @Post('events/:id/sales') @HttpCode(200) sales(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: SalesDto) {
    return this.svc.setSales(id, u, dto.paused);
  }

  @Get('orders') orders(@Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.svc.orders(q, status, page);
  }
  @Post('orders/:id/refund') @HttpCode(200) refund(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: AdminRefundDto) {
    return this.svc.refund(id, u, dto);
  }

  @Get('subscribers') subscribers(@Query('q') q?: string, @Query('status') status?: string, @Query('page') page?: string) {
    return this.svc.subscribers(q, status, page);
  }
  @Get('subscribers.csv') async subscribersCsv(@Res() res: Response, @Query('status') status?: string) {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="eventro-subscribers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.svc.subscribersCsv(status));
  }
  @Get('broadcast/audience') audience(@Query('category') category?: string, @Query('city') city?: string) {
    return this.svc.broadcastAudience(category, city);
  }
  @Get('broadcasts') broadcasts(@Query('limit') limit?: string) {
    return this.svc.broadcasts(limit);
  }
  @Post('broadcast') @HttpCode(200) broadcast(@CurrentUser() u: AuthUser, @Body() dto: BroadcastDto) {
    return this.svc.broadcast(u, dto);
  }

  @Get('price-drops') priceDrops(@Query('page') page?: string) {
    return this.svc.priceDrops(page);
  }
  @Get('emails') emails(@Query('kind') kind?: string, @Query('status') status?: string, @Query('q') q?: string, @Query('page') page?: string) {
    return this.svc.emails(kind, status, q, page);
  }
}

@Module({
  imports: [CheckoutModule],
  controllers: [AdminController, AdminConsoleController],
  providers: [AdminService, AdminConsoleService, EventCancellation],
  // The organizer module cancels events through the same service.
  exports: [EventCancellation],
})
export class AdminModule {}
