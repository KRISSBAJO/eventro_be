import { Body, Controller, Delete, Get, Header, HttpCode, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrganizerService } from './organizer.service';
import { BankAccountDto, PayoutAccounts } from './payout-accounts';
import { CheckoutModule } from '../checkout/checkout.module';
import { AdminModule } from '../admin/admin-console';
import { CurrentUser, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit } from '../common/rate-limit';
import { config } from '../config';
import {
  CancelEventDto,
  CheckInDto,
  CheckInSyncDto,
  CreateEventDto,
  CreateOrgDto,
  InviteDto,
  MemberRoleDto,
  PayoutSettingsDto,
  PromoDto,
  SeatMapDto,
  TemplateDto,
  TicketTypeInputDto,
  UpdateEventDto,
  UpdateOrgDto,
  UpdatePromoDto,
  UpdateTicketTypeDto,
  TicketOrderDto,
} from './organizer.dto';

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer')
export class OrganizerController {
  constructor(
    private readonly svc: OrganizerService,
    private readonly accounts: PayoutAccounts,
  ) {}

  /* organizations & team */
  @Post('orgs') createOrg(@CurrentUser() u: AuthUser, @Body() dto: CreateOrgDto) {
    return this.svc.createOrg(u, dto);
  }
  @Get('orgs') myOrgs(@CurrentUser() u: AuthUser) {
    return this.svc.myOrgs(u);
  }
  @Patch('orgs/:orgId') updateOrg(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateOrgDto) {
    return this.svc.updateOrg(orgId, u, dto);
  }
  @Get('orgs/:orgId/team') team(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser) {
    return this.svc.team(orgId, u);
  }
  @Post('orgs/:orgId/team') invite(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: InviteDto) {
    return this.svc.invite(orgId, u, dto);
  }
  @Patch('orgs/:orgId/team/:memberId') setRole(@Param('orgId') orgId: string, @Param('memberId') memberId: string, @CurrentUser() u: AuthUser, @Body() dto: MemberRoleDto) {
    return this.svc.setRole(orgId, memberId, u, dto.role);
  }
  @Delete('orgs/:orgId/team/:memberId') removeMember(@Param('orgId') orgId: string, @Param('memberId') memberId: string, @CurrentUser() u: AuthUser) {
    return this.svc.removeMember(orgId, memberId, u);
  }
  @Post('invites/accept') @HttpCode(200) acceptInvites(@CurrentUser() u: AuthUser) {
    return this.svc.acceptInvites(u);
  }

  /* payouts */
  @Get('orgs/:orgId/payouts') payouts(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser) {
    return this.svc.payouts(orgId, u);
  }
  @Put('orgs/:orgId/payout-settings') async payoutSettings(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: PayoutSettingsDto) {
    const r = await this.svc.setPayoutSchedule(orgId, u, dto.schedule);
    await this.accounts.syncSchedule(orgId);
    return r;
  }
  @Get('payout-countries') payoutCountries() {
    return this.accounts.countries();
  }
  @ApiQuery({ name: 'country', example: 'NG' })
  @Get('orgs/:orgId/payouts/banks') payoutBanks(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Query('country') country: string) {
    return this.accounts.banks(orgId, u, (country ?? '').toUpperCase());
  }
  @Post('orgs/:orgId/payouts/resolve') @HttpCode(200) resolveBank(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: BankAccountDto) {
    return this.accounts.resolve(orgId, u, dto);
  }
  @Put('orgs/:orgId/payouts/bank') saveBank(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: BankAccountDto) {
    return this.accounts.save(orgId, u, dto);
  }
  @Post('orgs/:orgId/payouts/onboarding') @HttpCode(200) onboarding(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser) {
    return this.svc.payoutOnboarding(orgId, u, `${config.corsOrigins[0] ?? 'http://localhost:3500'}/organizer/payouts`);
  }

  /* events */
  @Post('orgs/:orgId/events') createEvent(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: CreateEventDto) {
    return this.svc.createEvent(orgId, u, dto);
  }
  @Get('orgs/:orgId/orders/recent') recentOrders(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser) {
    return this.svc.recentOrders(orgId, u);
  }
  @Get('orgs/:orgId/events') listEvents(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser) {
    return this.svc.listEvents(orgId, u);
  }
  @Get('events/:id') getEvent(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.getEvent(id, u);
  }
  @Patch('events/:id') updateEvent(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateEventDto) {
    return this.svc.updateEvent(id, u, dto);
  }
  @Post('events/:id/ticket-types') addTicketType(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: TicketTypeInputDto) {
    return this.svc.addTicketType(id, u, dto);
  }
  /** New order for the event's ticket types, top tier first. */
  @Put('events/:id/ticket-types/order') orderTicketTypes(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: TicketOrderDto) {
    return this.svc.orderTicketTypes(id, u, dto.ids);
  }
  @Patch('events/:id/ticket-types/:ttId') updateTicketType(@Param('id') id: string, @Param('ttId') ttId: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateTicketTypeDto) {
    return this.svc.updateTicketType(id, ttId, u, dto);
  }
  @Delete('events/:id/ticket-types/:ttId') deleteTicketType(@Param('id') id: string, @Param('ttId') ttId: string, @CurrentUser() u: AuthUser) {
    return this.svc.deleteTicketType(id, ttId, u);
  }
  @Post('events/:id/submit') @HttpCode(200) submit(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.submit(id, u);
  }
  /** What cancelling would refund: paid orders and totals per currency. */
  @Get('events/:id/cancel-preview') cancelPreview(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.cancelPreview(id, u);
  }
  /** Org admins: cancel the event and refund every paid order. Safe to call again (only failed refunds are retried). */
  @Post('events/:id/cancel') @HttpCode(200) cancel(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: CancelEventDto) {
    return this.svc.cancelEvent(id, u, dto.reason, dto.confirmTitle);
  }
  @Post('events/:id/pause') @HttpCode(200) pause(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.setPaused(id, u, true);
  }
  @Post('events/:id/resume') @HttpCode(200) resume(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.setPaused(id, u, false);
  }

  /* seat map */
  @Put('events/:id/seat-map') saveSeatMap(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: SeatMapDto) {
    return this.svc.saveSeatMap(id, u, dto.seatMap);
  }
  @Post('events/:id/seat-map/template') @HttpCode(200) template(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: TemplateDto) {
    return this.svc.applyTemplate(id, u, dto);
  }

  /* stats, attendees, check-in */
  @ApiQuery({ name: 'days', required: false })
  /** Who a price drop would reach (watchers + matching subscribers) and the event's recent drops. */
  @Get('events/:id/price-drops') priceDrops(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.priceDropAudience(id, u);
  }
  @Get('events/:id/stats') stats(@Param('id') id: string, @CurrentUser() u: AuthUser, @Query('days') days?: string) {
    const n = Math.min(365, Math.max(1, Number(days) || 30));
    return this.svc.stats(id, u, n);
  }
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['checked-in', 'not-checked-in'] })
  @Get('events/:id/attendees') attendees(@Param('id') id: string, @CurrentUser() u: AuthUser, @Query('q') q?: string, @Query('status') status?: string) {
    return this.svc.attendees(id, u, q, status);
  }
  @Get('events/:id/attendees.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="attendees.csv"')
  attendeesCsv(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.attendeesCsv(id, u);
  }
  @Post('events/:id/check-in') @HttpCode(200) checkIn(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: CheckInDto) {
    return this.svc.checkIn(id, u, dto.code, dto.deviceId);
  }
  /**
   * Offline door scanning: every non-void ticket with its QR seed, so a scanner can check codes without a
   * connection. Holds secrets: rate-limited, audited, never cached. Same access as check-in (DOOR and up).
   */
  @Get('events/:id/door-pack')
  @Header('Cache-Control', 'no-store')
  @RateLimit(RATE_RULES.doorPack)
  doorPack(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.doorPack(id, u);
  }
  /** Uploads scans made offline (up to 500 per call); safe to send again. */
  @Post('events/:id/check-ins/sync') @HttpCode(200) syncCheckIns(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: CheckInSyncDto) {
    return this.svc.syncCheckIns(id, u, dto.deviceId, dto.scans);
  }
  @Delete('events/:id/check-in/:ticketId') undo(@Param('id') id: string, @Param('ticketId') ticketId: string, @CurrentUser() u: AuthUser) {
    return this.svc.undoCheckIn(id, ticketId, u);
  }

  /* promos */
  @Get('events/:id/promos') promos(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.promos(id, u);
  }
  @Post('events/:id/promos') createPromo(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: PromoDto) {
    return this.svc.createPromo(id, u, dto);
  }
  @Patch('events/:id/promos/:code') updatePromo(@Param('id') id: string, @Param('code') code: string, @CurrentUser() u: AuthUser, @Body() dto: UpdatePromoDto) {
    return this.svc.updatePromo(id, code, u, dto);
  }
  @Delete('events/:id/promos/:code') deletePromo(@Param('id') id: string, @Param('code') code: string, @CurrentUser() u: AuthUser) {
    return this.svc.deletePromo(id, code, u);
  }
}

@Module({
  imports: [CheckoutModule, AdminModule],
  controllers: [OrganizerController],
  providers: [OrganizerService, PayoutAccounts],
})
export class OrganizerModule {}
