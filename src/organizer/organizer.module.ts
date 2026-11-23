import { Body, Controller, Delete, Get, Header, HttpCode, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrganizerService } from './organizer.service';
import { CheckoutModule } from '../checkout/checkout.module';
import { CurrentUser, type AuthUser } from '../common/auth';
import { config } from '../config';
import {
  CheckInDto,
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
} from './organizer.dto';

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer')
export class OrganizerController {
  constructor(private readonly svc: OrganizerService) {}

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
  @Put('orgs/:orgId/payout-settings') payoutSettings(@Param('orgId') orgId: string, @CurrentUser() u: AuthUser, @Body() dto: PayoutSettingsDto) {
    return this.svc.setPayoutSchedule(orgId, u, dto.schedule);
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
  @Patch('events/:id/ticket-types/:ttId') updateTicketType(@Param('id') id: string, @Param('ttId') ttId: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateTicketTypeDto) {
    return this.svc.updateTicketType(id, ttId, u, dto);
  }
  @Delete('events/:id/ticket-types/:ttId') deleteTicketType(@Param('id') id: string, @Param('ttId') ttId: string, @CurrentUser() u: AuthUser) {
    return this.svc.deleteTicketType(id, ttId, u);
  }
  @Post('events/:id/submit') @HttpCode(200) submit(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.submit(id, u);
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
    return this.svc.checkIn(id, u, dto.code);
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
  imports: [CheckoutModule],
  controllers: [OrganizerController],
  providers: [OrganizerService],
})
export class OrganizerModule {}
