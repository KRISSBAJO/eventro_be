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
import { AdminModule } from './admin/admin-console';
import { MediaModule } from './media/media.module';
import { GeoModule } from './geo/geo.module';
import { FxModule } from './fx/fx.module';
import { NewsletterModule } from './newsletter/newsletter.module';
import { MailModule } from './mail/mail.module';
import { PriceDropModule } from './price-drops/price-drops.module';
import { GiftModule } from './gifts/gifts.module';
import { VenuesModule } from './venues/venues.module';
import { ResaleModule } from './resale/resale.module';
import { PushModule } from './push/push.module';
import { SavedModule } from './saved/saved.module';
import { Payments } from './checkout/payments';

@ApiTags('health')
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    // `payments` is "mock" when neither provider has keys (test mode everywhere).
    return { ok: true, payments: config.stripeSecretKey || config.paystackSecretKey ? 'live' : 'mock', stripe: !!config.stripeSecretKey, paystack: !!config.paystackSecretKey };
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
    MediaModule,
    GeoModule,
    FxModule,
    NewsletterModule,
    MailModule,
    PushModule,
    PriceDropModule,
    GiftModule,
    VenuesModule,
    ResaleModule,
    SavedModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
