/**
 * "Report this event": anyone can tell Omoshow an event looks wrong (a scam, wrong details, offensive, a duplicate).
 * Reports go to the admin console; an admin dismisses each one or marks it acted on (pausing or cancelling the event
 * is done from the event itself). The organizer isn't told who reported.
 *
 *   POST /events/:slug/report                 { reason, details?, email? }  (signed in or not; a few per hour per IP)
 *   GET  /admin/event-reports?status=OPEN     reports with their event, newest first, and how many are open
 *   POST /admin/event-reports/:id/resolve     { action: 'DISMISS' | 'ACTIONED', note? }
 */
import { BadRequestException, Body, Controller, Get, Global, HttpCode, Injectable, Module, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { CurrentUser, OptionalAuth, Roles, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit, clientIp } from '../common/rate-limit';

export const REPORT_REASONS = ['SCAM', 'WRONG_INFO', 'OFFENSIVE', 'DUPLICATE', 'OTHER'] as const;
const STATUSES = ['OPEN', 'DISMISSED', 'ACTIONED'] as const;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const tidy = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value);

class ReportDto {
  @ApiProperty({ enum: REPORT_REASONS }) @IsIn(REPORT_REASONS) reason: (typeof REPORT_REASONS)[number];
  @ApiPropertyOptional({ description: 'What looks wrong (required for OTHER)' }) @IsOptional() @Transform(tidy) @IsString() @MaxLength(1000) details?: string;
  @ApiPropertyOptional({ description: 'Where Omoshow can reach you (optional; signed-in reports use the account)' }) @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254) email?: string;
}

class ResolveDto {
  @ApiProperty({ enum: ['DISMISS', 'ACTIONED'] }) @IsIn(['DISMISS', 'ACTIONED']) action: 'DISMISS' | 'ACTIONED';
  @ApiPropertyOptional() @IsOptional() @Transform(tidy) @IsString() @MaxLength(500) note?: string;
}

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async report(slug: string, dto: ReportDto, user: AuthUser | null, ip: string | null) {
    const e = await this.prisma.event.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!e || (e.status !== 'PUBLISHED' && e.status !== 'CANCELLED')) throw new NotFoundException('Event not found.');
    if (dto.reason === 'OTHER' && (dto.details ?? '').length < 10) throw new BadRequestException('Tell us what looks wrong, in a sentence or two.');
    // One open report per person and event: sending it again adds nothing.
    const same = await this.prisma.eventReport.findFirst({ where: { eventId: e.id, status: 'OPEN', ...(user ? { userId: user.id } : { userId: null, clientIp: ip ?? '' }) }, select: { id: true } });
    if (!same) {
      await this.prisma.eventReport.create({ data: { eventId: e.id, reason: dto.reason, details: dto.details ?? '', email: user?.email ?? dto.email ?? null, userId: user?.id ?? null, clientIp: ip } });
    }
    return { received: true };
  }

  async list(status = 'OPEN') {
    if (!(STATUSES as readonly string[]).includes(status)) throw new BadRequestException('Unknown status.');
    const [rows, open] = await Promise.all([
      this.prisma.eventReport.findMany({
        where: { status },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { event: { select: { id: true, slug: true, title: true, status: true, startsAt: true, salesPaused: true, org: { select: { id: true, name: true } } } } },
      }),
      this.prisma.eventReport.groupBy({ by: ['eventId'], where: { status: 'OPEN' }, _count: { _all: true } }),
    ]);
    const openFor = new Map(open.map((o) => [o.eventId, o._count._all]));
    return {
      open: open.reduce((n, o) => n + o._count._all, 0),
      reports: rows.map(({ clientIp: _ip, userId, ...r }) => ({ ...r, signedIn: !!userId, openForEvent: openFor.get(r.eventId) ?? 0 })),
    };
  }

  async resolve(id: string, admin: AuthUser, dto: ResolveDto) {
    const r = await this.prisma.eventReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Report not found.');
    if (r.status !== 'OPEN') throw new BadRequestException('This report was already handled.');
    const status = dto.action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED';
    const updated = await this.prisma.eventReport.update({ where: { id }, data: { status, note: dto.note || null, resolvedBy: admin.id, resolvedAt: new Date() } });
    await this.audit.log(admin.id, `event.report.${status.toLowerCase()}`, 'Event', r.eventId, { reportId: id, reason: r.reason, note: dto.note ?? null });
    return { id: updated.id, status: updated.status };
  }
}

@ApiTags('events')
@Controller('events')
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  @OptionalAuth()
  @Post(':slug/report')
  @HttpCode(200)
  @RateLimit(RATE_RULES.priceWatch)
  report(@Param('slug') slug: string, @Body() dto: ReportDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.reports.report(slug, dto, user, clientIp(req));
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/event-reports')
export class AdminReportController {
  constructor(private readonly reports: ReportService) {}

  @Get() list(@Query('status') status?: string) {
    return this.reports.list(status || 'OPEN');
  }
  @Post(':id/resolve') @HttpCode(200) resolve(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: ResolveDto) {
    return this.reports.resolve(id, u, dto);
  }
}

@Global()
@Module({ controllers: [ReportController, AdminReportController], providers: [ReportService], exports: [ReportService] })
export class ReportModule {}
