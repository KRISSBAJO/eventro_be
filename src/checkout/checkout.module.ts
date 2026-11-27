import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Module, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { Payments } from './payments';
import { CurrentUser, OptionalAuth, Public, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit } from '../common/rate-limit';
import { DONATION_MAX_CENTS, PWYW_CEILING_CENTS } from '../domain/pwyw';

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
  @ApiPropertyOptional({ description: 'Pay what you want: the base amount per ticket (minor units), required for those tiers; the event’s fee mode applies to it' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PWYW_CEILING_CENTS)
  amountCents?: number;
  @ApiPropertyOptional({ description: 'The event’s presale code, to buy before the public on-sale' }) @IsOptional() @IsString() @MaxLength(30) accessCode?: string;
}

/** One answer to a checkout question. */
export class AnswerDto {
  @ApiProperty() @IsString() @MaxLength(40) questionId: string;
  @ApiProperty() @IsString() @MaxLength(200) value: string;
  @ApiPropertyOptional({ description: 'For a question asked per ticket: the ticket’s number in this checkout, from 0 (a cart counts across its lines)' }) @IsOptional() @IsInt() @Min(0) @Max(119) ticket?: number;
}

export class PresaleDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(30) code: string;
}

export class CartItemDto {
  @ApiProperty() @IsString() @MaxLength(40) ticketTypeId: string;
  @ApiProperty({ minimum: 1, maximum: 20 }) @IsInt() @Min(1) @Max(20) quantity: number;
  @ApiPropertyOptional({ description: 'Pay what you want: the base amount per ticket (minor units), required for those tiers' }) @IsOptional() @IsInt() @Min(0) @Max(PWYW_CEILING_CENTS) amountCents?: number;
}

/** Several ticket types of one event, held together (all or nothing). */
export class CartHoldsDto {
  @ApiProperty({ type: [CartItemDto], description: '1 to 6 ticket types of one event, each once' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
  @ApiPropertyOptional({ description: 'The event’s presale code, to buy before the public on-sale' }) @IsOptional() @IsString() @MaxLength(30) accessCode?: string;
}

class CartPriceDto {
  @ApiProperty({ type: [String], description: 'The holds from POST /holds/cart, in order (the first carries the donation)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  holdIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() protection?: boolean;
  @ApiPropertyOptional({ description: 'Applies to the fixed-price lines' }) @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{3,15}$/) promoCode?: string;
  @ApiPropertyOptional({ description: 'One donation for the whole cart (minor units; 0 = none)' }) @IsOptional() @IsInt() @Min(0) @Max(DONATION_MAX_CENTS) donationCents?: number;
}

export class CartQuoteDto extends CartPriceDto {}

export class CartOrderDto extends CartPriceDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional({ type: () => GiftDto, description: 'Buy the whole cart for someone else (one gift email, one claim)' }) @IsOptional() @ValidateNested() @Type(() => GiftDto) gift?: { name: string; email: string; message?: string; sendAt?: string; hidePrice?: boolean };
  @ApiPropertyOptional({ enum: ['app'] }) @IsOptional() @IsIn(['app']) returnTo?: 'app';
  @ApiPropertyOptional({ type: [AnswerDto], description: 'Answers to the event’s checkout questions (GET /holds/:id `questions`)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers?: AnswerDto[];
}

/** Pay what you want and donations, on the quote and the order. */
class PriceExtrasDto {
  @ApiPropertyOptional({ description: 'Pay what you want: change the base amount per ticket chosen at the hold' }) @IsOptional() @IsInt() @Min(0) @Max(PWYW_CEILING_CENTS) amountCents?: number;
  @ApiPropertyOptional({ description: 'A donation to the event’s cause (minor units; 0 = none). No fee is taken on it.' }) @IsOptional() @IsInt() @Min(0) @Max(DONATION_MAX_CENTS) donationCents?: number;
}

export class GiftDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) message?: string;
  @ApiPropertyOptional({ description: 'When to deliver (ISO time); now if left out' }) @IsOptional() @IsDateString() sendAt?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() hidePrice?: boolean;
}

export class CreateOrderDto extends PriceExtrasDto {
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
  @ApiPropertyOptional({ type: [AnswerDto], description: 'Answers to the event’s checkout questions (GET /holds/:id `questions`)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers?: AnswerDto[];
}

/** What the fan chose before checkout moves elsewhere (the app hands card payments to the website). */
export class UpdateHoldDto {
  @ApiPropertyOptional({ description: 'A donation to the event’s cause (minor units; 0 = none), used by the quote and the order when they send none' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DONATION_MAX_CENTS)
  donationCents?: number;
  @ApiPropertyOptional({ description: 'Pay what you want: the base amount per ticket' }) @IsOptional() @IsInt() @Min(0) @Max(PWYW_CEILING_CENTS) amountCents?: number;
}

export class ResaleOrderDto {
  @ApiPropertyOptional({ description: 'A donation to the event’s cause (minor units; 0 = none), for the organizer, not the seller. No fee is taken on it.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DONATION_MAX_CENTS)
  donationCents?: number;
  @ApiProperty({ description: 'From POST /resale/:id/hold' }) @IsString() @MaxLength(64) holdKey: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional({ enum: ['app'], description: 'Paying from the mobile app: Paystack sends the fan back to /checkout/return?order=…&app=1, which opens the app' })
  @IsOptional()
  @IsIn(['app'])
  returnTo?: 'app';
}

export class QuoteDto extends PriceExtrasDto {
  @ApiProperty() @IsString() @MaxLength(40) holdId: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() protection?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{3,15}$/) promoCode?: string;
}

export class FindOrdersDto {
  @ApiProperty({ description: 'The email used at checkout' }) @Transform(lower) @IsEmail() @MaxLength(254) email: string;
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

  /** Checks a presale code: which ticket types it opens right now. The code itself never comes back. */
  @Public()
  @Post('events/:slug/presale')
  @HttpCode(200)
  @RateLimit(RATE_RULES.checkout)
  presale(@Param('slug') slug: string, @Body() dto: PresaleDto) {
    return this.checkout.checkPresale(slug, dto.code);
  }

  /** A cart: several ticket types of one event held together. */
  @OptionalAuth()
  @Post('holds/cart')
  @RateLimit(RATE_RULES.checkout)
  cartHolds(@Body() dto: CartHoldsDto, @CurrentUser() user: AuthUser | null) {
    return this.checkout.createCartHolds(dto.items, user, dto.accessCode);
  }

  @Public()
  @Get('holds/:id')
  getHold(@Param('id') id: string) {
    return this.checkout.getHold(id);
  }

  @Public()
  @Patch('holds/:id')
  @RateLimit(RATE_RULES.checkout)
  updateHold(@Param('id') id: string, @Body() dto: UpdateHoldDto) {
    return this.checkout.updateHold(id, dto);
  }

  @Public()
  @Post('quote')
  @HttpCode(200)
  quote(@Body() dto: QuoteDto) {
    return this.checkout.quoteHold(dto);
  }

  @Public()
  @Post('quote/cart')
  @HttpCode(200)
  quoteCart(@Body() dto: CartQuoteDto) {
    return this.checkout.quoteCart(dto);
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

  /** Checks out a cart: one order per ticket type, one payment. The answer's `orderId` is the cart's id (CRT-…). */
  @OptionalAuth()
  @Post('orders/cart')
  @RateLimit(RATE_RULES.checkout)
  cartOrder(@Body() dto: CartOrderDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.checkout.createCartOrder(dto, user, req.ip ?? null);
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

  /**
   * "Can't find my order?": emails the orders bought with this address and a link to sign in, or to sign up with the
   * same email (which brings guest tickets into the new account). Always answers the same way and does the work after
   * replying, so neither the answer nor its timing tells whether that email has bought anything.
   */
  @Public()
  @Post('orders/find')
  @HttpCode(200)
  @RateLimit(RATE_RULES.findOrders)
  find(@Body() dto: FindOrdersDto) {
    return this.checkout.findOrders(dto.email);
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
