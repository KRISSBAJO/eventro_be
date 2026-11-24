import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { Payments } from './payments';
import { CurrentUser, OptionalAuth, Public, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit } from '../common/rate-limit';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class SeatChoiceDto {
  @ApiProperty({ example: 'A' }) @IsString() @Matches(/^[A-Z]{1,3}$/) row: string;
  @ApiProperty({ example: 7 }) @IsInt() @Min(1) @Max(500) seat: number;
}

export class CreateHoldDto {
  @ApiProperty() @IsString() @MaxLength(40) ticketTypeId: string;
  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) quantity: number;
  @ApiPropertyOptional({ description: 'Seat map section id, to sit in a specific section' }) @IsOptional() @IsString() @MaxLength(24) sectionId?: string;
  @ApiPropertyOptional({ type: [SeatChoiceDto], description: 'Exact seats in a reserved section (needs sectionId; one per ticket). Left out: the best seats side by side.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SeatChoiceDto)
  seats?: SeatChoiceDto[];
}

export class GiftDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) message?: string;
  @ApiPropertyOptional({ description: 'When to deliver (ISO time); now if left out' }) @IsOptional() @IsDateString() sendAt?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() hidePrice?: boolean;
}

export class CreateOrderDto {
  @ApiProperty() @IsString() @MaxLength(40) holdId: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() protection?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{3,15}$/) promoCode?: string;
  @ApiPropertyOptional({ type: GiftDto, description: 'Buy for someone else' }) @IsOptional() @ValidateNested() @Type(() => GiftDto) gift?: GiftDto;
  @ApiPropertyOptional({ enum: ['app'], description: 'Paying from the mobile app: Paystack sends the fan back to /checkout/return?order=…&app=1, which opens the app' })
  @IsOptional()
  @IsIn(['app'])
  returnTo?: 'app';
}

export class ResaleOrderDto {
  @ApiProperty({ description: 'From POST /resale/:id/hold' }) @IsString() @MaxLength(64) holdKey: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional({ enum: ['app'], description: 'Paying from the mobile app: Paystack sends the fan back to /checkout/return?order=…&app=1, which opens the app' })
  @IsOptional()
  @IsIn(['app'])
  returnTo?: 'app';
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
  @RateLimit(RATE_RULES.checkout)
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
  @Post('resale/:id/orders')
  @RateLimit(RATE_RULES.checkout)
  resaleOrder(@Param('id') id: string, @Body() dto: ResaleOrderDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.checkout.createResaleOrder(id, dto, user, req.ip ?? null);
  }

  @OptionalAuth()
  @Post('orders')
  @RateLimit(RATE_RULES.checkout)
  order(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.checkout.createOrder(dto, user, req.ip ?? null);
  }

  @ApiQuery({ name: 'email', required: false, description: 'Guest lookup: the email used at checkout' })
  @OptionalAuth()
  @Get('orders/:id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser | null, @Query('email') email?: string) {
    return this.checkout.getOrder(id, user, email);
  }

  /** Order history: the signed-in fan's paid, refunded and cancelled-after-payment orders, newest first. */
  @ApiBearerAuth()
  @Get('me/orders')
  mine(@CurrentUser() user: AuthUser) {
    return this.checkout.myOrders(user);
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
