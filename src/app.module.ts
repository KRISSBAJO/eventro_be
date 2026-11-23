import { Controller, Get, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { config } from './config';
import { PrismaService } from './prisma.service';
import { AuthGuard, Public } from './common/auth';
import { AuditService } from './common/audit.service';
import { InventoryService } from './common/inventory.service';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { CheckoutModule } from './checkout/checkout.module';
import { TicketsModule } from './tickets/tickets.module';
import { OrganizerModule } from './organizer/organizer.module';
import { AdminModule } from './admin/admin.module';

@ApiTags('health')
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, payments: config.stripeSecretKey ? 'stripe' : 'mock' };
  }
}

@Global()
@Module({
  providers: [PrismaService, AuditService, InventoryService],
  exports: [PrismaService, AuditService, InventoryService],
})
class CoreModule {}

@Module({
  imports: [
    CoreModule,
    JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: '7d' } }),
    AuthModule,
    EventsModule,
    CheckoutModule,
    TicketsModule,
    OrganizerModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
