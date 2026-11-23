import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { Payments } from './payments';
import { CurrentUser, OptionalAuth, Public, type AuthUser } from '../common/auth';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateHoldDto {
  @ApiProperty() @IsString() @MaxLength(40) ticketTypeId: string;
  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) quantity: number;
  @ApiPropertyOptional({ description: 'Seat map section id, to sit in a specific section' }) @IsOptional() @IsString() @MaxLength(24) sectionId?: string;
}

export class CreateOrderDto {
  @ApiProperty() @IsString() @MaxLength(40) holdId: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() protection?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{3,15}$/) promoCode?: string;
}

export class QuoteDto {
  @ApiProperty() @IsString() @MaxLength(40) holdId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() protection?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{3,15}$/) promoCode?: string;
}

export class RefundRequestDto {
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(1000) reason: string;
}

@ApiTags('checkout')
@Controller()
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly payments: Payments,
  ) {}

  @OptionalAuth()
  @Post('holds')
  hold(@Body() dto: CreateHoldDto, @CurrentUser() user: AuthUser | null) {
    return this.checkout.createHold(dto, user);
  }

  @Public()
  @Get('holds/:id')
  getHold(@Param('id') id: string) {
    return this.checkout.getHold(id);
  }

  @Public()
  @Post('quote')
  @HttpCode(200)
  quote(@Body() dto: QuoteDto) {
    return this.checkout.quoteHold(dto);
  }

  @Public()
  @Delete('holds/:id')
  release(@Param('id') id: string) {
    return this.checkout.releaseHold(id);
  }

  @OptionalAuth()
  @Post('orders')
  order(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.checkout.createOrder(dto, user, req.ip ?? null);
  }

  @ApiQuery({ name: 'email', required: false, description: 'Guest lookup: the email used at checkout' })
  @OptionalAuth()
  @Get('orders/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser | null, @Query('email') email?: string) {
    return this.checkout.getOrder(id, user, email);
  }

  /** Completes a payment with the mock provider (only when Stripe isn't configured). */
  @Public()
  @Post('orders/:id/pay')
  @HttpCode(200)
  pay(@Param('id') id: string) {
    return this.checkout.payMock(id);
  }

  @ApiBearerAuth()
  @Post('orders/:id/refund-requests')
  refund(@Param('id') id: string, @Body() dto: RefundRequestDto, @CurrentUser() user: AuthUser) {
    return this.checkout.requestRefund(id, user, dto.reason);
  }

  /** After paying on Paystack's page, the website asks us to confirm the payment. */
  @Public()
  @Post('orders/:id/verify')
  @HttpCode(200)
  verify(@Param('id') id: string) {
    return this.checkout.verifyPaystack(id);
  }

  @Public()
  @Post('webhooks/paystack')
  @HttpCode(200)
  async paystack(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-paystack-signature') sig: string) {
    if (!this.payments.paystack || !req.rawBody || !sig || !this.payments.paystack.signatureOk(req.rawBody, sig)) throw new BadRequestException('Invalid signature');
    const body = req.body as { event?: string; data?: { reference?: string } };
    await this.checkout.handlePaystackEvent(body.event ?? '', body.data ?? {});
    return { received: true };
  }

  @Public()
  @Post('webhooks/stripe')
  @HttpCode(200)
  async stripe(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') sig: string) {
    if (!req.rawBody || !sig) throw new BadRequestException('Missing signature');
    let event;
    try {
      event = this.payments.parseWebhook(req.rawBody, sig);
    } catch {
      throw new BadRequestException('Invalid signature');
    }
    await this.checkout.handleStripeEvent(event.type, event.data.object as { id?: string; metadata?: Record<string, string> });
    return { received: true };
  }
}

@Module({
  controllers: [CheckoutController],
  providers: [CheckoutService, Payments],
  exports: [CheckoutService, Payments],
})
export class CheckoutModule {}
