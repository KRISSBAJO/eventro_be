import { CURRENCY_CODES } from '../domain/currency';
import { TIER_STYLE_INPUTS } from '../domain/tier-look';
import { DONATION_MAX_CENTS, MAX_DONATION_SUGGESTIONS, MAX_QUICK_PICKS, PWYW_CEILING_CENTS } from '../domain/pwyw';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Category, type ScheduleKind } from '@prisma/client';
import { DATE_MODES, MAX_DATES, MAX_DAYS, type DateMode } from '../domain/event-dates';
import { MAX_ITEMS, MAX_PEOPLE, MAX_PLACES, SCHEDULE_KINDS } from '../domain/schedule';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class CreateOrgDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() supportEmail?: string;
}

export class UpdateOrgDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) website?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() supportEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) about?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Square logo (an uploaded photo link); null removes it' }) @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }) @MaxLength(1000) logoUrl?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Wide banner for the organizer page; null removes it' }) @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https', 'http'] }) @MaxLength(1000) coverUrl?: string | null;
}

export class InviteDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty({ enum: ['ADMIN', 'MANAGER', 'DOOR'] }) @IsIn(['ADMIN', 'MANAGER', 'DOOR']) role: 'ADMIN' | 'MANAGER' | 'DOOR';
}

export class MemberRoleDto {
  @ApiProperty({ enum: ['ADMIN', 'MANAGER', 'DOOR'] }) @IsIn(['ADMIN', 'MANAGER', 'DOOR']) role: 'ADMIN' | 'MANAGER' | 'DOOR';
}

export class VenueInputDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(200) address: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) city: string;
  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2, e.g. NG' }) @IsOptional() @IsString() @Matches(/^[A-Za-z]{2}$/) country?: string;
  @ApiPropertyOptional({ description: 'State, province or region' }) @IsOptional() @IsString() @MaxLength(80) region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
}

export class TicketTypeInputDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(60) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiProperty({ description: 'Organizer price in cents (0 = free). The fan price is calculated from the fee mode. Optional (ignored) with pay what you want.' })
  @ValidateIf((o: { pricing?: string; basePriceCents?: unknown }) => o.pricing !== 'PWYW' || o.basePriceCents !== undefined)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  basePriceCents: number;
  @ApiProperty() @IsInt() @Min(1) @Max(200_000) capacity: number;
  @ApiPropertyOptional({ default: 8 }) @IsOptional() @IsInt() @Min(1) @Max(20) maxPerOrder?: number;
  @ApiPropertyOptional({ type: [String], description: 'Up to 8 inclusions, e.g. "Priority entry"' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(60, { each: true })
  perks?: string[];
  @ApiPropertyOptional({ description: 'Short label, e.g. "Best view" (empty string clears it)' }) @IsOptional() @IsString() @MaxLength(24) badge?: string;
  @ApiPropertyOptional({ enum: TIER_STYLE_INPUTS, nullable: true, description: 'The ticket’s look; "auto" or null follows the name' })
  @IsOptional()
  @IsIn(TIER_STYLE_INPUTS)
  style?: string | null;
  @ApiPropertyOptional({ enum: ['FIXED', 'PWYW'], description: 'Fixed price, or pay what you want (the fan picks an amount within the limits below)' })
  @IsOptional()
  @IsIn(['FIXED', 'PWYW'])
  pricing?: 'FIXED' | 'PWYW';
  @ApiPropertyOptional({ description: 'Pay what you want: the minimum base amount (minor units, 0 or more); required with PWYW' })
  @ValidateIf((o: { pricing?: string; pwywMinCents?: unknown }) => o.pricing === 'PWYW' || o.pwywMinCents !== undefined)
  @IsInt()
  @Min(0)
  @Max(PWYW_CEILING_CENTS)
  pwywMinCents?: number;
  @ApiPropertyOptional({ nullable: true, description: 'Pay what you want: the suggested amount, shown as the default' }) @IsOptional() @IsInt() @Min(0) @Max(PWYW_CEILING_CENTS) pwywSuggestedCents?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Pay what you want: the most a fan can pay (null = no maximum; capped at 10,000,000)' }) @IsOptional() @IsInt() @Min(1) @Max(PWYW_CEILING_CENTS) pwywMaxCents?: number | null;
  @ApiPropertyOptional({ type: [Number], description: `Pay what you want: up to ${MAX_QUICK_PICKS} quick-pick amounts` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_PICKS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(PWYW_CEILING_CENTS, { each: true })
  pwywQuickPicks?: number[];
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { '0': 200, '1': 150 },
    description: 'Multiple dates (DATES): capacity on particular dates, keyed by date ref (the date’s id, or its index in `dates`); other dates get `capacity`',
  })
  @IsOptional()
  @IsObject()
  capacityByDate?: Record<string, number>;
  @ApiPropertyOptional({ type: [String], description: 'Multi-day event (DAYS, required there): the days this ticket admits on, as date refs (the date’s id, or its index in `dates`)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  validDates?: string[];
}

/** One date of a DATES or DAYS event, on create and edit. */
export class EventDateInputDto {
  @ApiPropertyOptional({ description: 'Edit only: an existing date (leave out to add a new one)' }) @IsOptional() @IsString() @MaxLength(40) id?: string;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() doorsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ description: 'e.g. "Matinee" or "Day 1: Afrobeats" (empty clears it)' }) @IsOptional() @IsString() @MaxLength(60) label?: string;
}

/** Charity donations at checkout and the comp limit, on create and edit. */
export class EventExtrasDto {
  @ApiPropertyOptional({ description: "Accept donations at checkout. Omoshow collects donations on the organizer's behalf; the organizer is responsible for passing them to the cause." })
  @IsOptional()
  @IsBoolean()
  donationsEnabled?: boolean;
  @ApiPropertyOptional({ nullable: true, description: "The cause donations go to (required when donations are on), e.g. \"Lagos Children's Fund\"" }) @IsOptional() @IsString() @MaxLength(80) donationCause?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(280) donationDescription?: string | null;
  @ApiPropertyOptional({ type: [Number], description: `Up to ${MAX_DONATION_SUGGESTIONS} suggested amounts (minor units)` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DONATION_SUGGESTIONS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(DONATION_MAX_CENTS, { each: true })
  donationSuggestedCents?: number[];
  @ApiPropertyOptional({ nullable: true, description: 'Smallest donation (minor units)' }) @IsOptional() @IsInt() @Min(1) @Max(DONATION_MAX_CENTS) donationMinCents?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Most live complimentary tickets on this event (null = no limit)' }) @IsOptional() @IsInt() @Min(0) @Max(200_000) compLimit?: number | null;
}

const toIntOrSelf = ({ value }: { value: unknown }) => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value);

/** One schedule item (create, or PUT /organizer/events/:id/schedule). See src/schedule. */
export class ScheduleItemInputDto {
  @ApiPropertyOptional({ description: 'PUT: an item to keep (and change). Without: a new item' }) @IsOptional() @IsString() @MaxLength(40) id?: string;
  @ApiPropertyOptional({ nullable: true, description: 'DATES/DAYS: the date or day it is on (required there; leave out for one-date events)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  eventDateId?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Create only: the date as an index into `dates` as sent (instead of eventDateId)' })
  @IsOptional()
  @Transform(toIntOrSelf)
  @IsInt()
  @Min(0)
  @Max(MAX_DATES - 1)
  dateRef?: number | null;
  @ApiProperty({ description: 'Wall-clock time, like event times' }) @IsDateString() startsAt: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsDateString() endsAt?: string | null;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(600) note?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Stage or room' }) @IsOptional() @IsString() @MaxLength(60) stage?: string | null;
  @ApiPropertyOptional({ type: [String], description: `Artists, speakers, hosts (up to ${MAX_PEOPLE})` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PEOPLE)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  people?: string[] | null;
  @ApiPropertyOptional({ enum: SCHEDULE_KINDS, default: 'OTHER' }) @IsOptional() @IsIn(SCHEDULE_KINDS) kind?: ScheduleKind;
  @ApiPropertyOptional({ description: 'Ticket holders can book a place' }) @IsOptional() @IsBoolean() bookable?: boolean;
  @ApiPropertyOptional({ nullable: true, description: `Places (required when bookable), 1–${MAX_PLACES}` }) @IsOptional() @IsInt() @Min(1) @Max(MAX_PLACES) capacity?: number | null;
  @ApiPropertyOptional({
    type: [String],
    description: 'Bookable items: only these ticket types can book (TicketType ids; DATES: tier keys or any copy id; create: indexes into `ticketTypes`). Empty = any ticket for that date',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  eligibleTiers?: string[] | null;
}

export class ScheduleDto {
  @ApiProperty({ type: [ScheduleItemInputDto], description: 'The full schedule: items left out are removed (bookings on them are cancelled and holders told)' })
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS, { message: `A schedule can have up to ${MAX_ITEMS} items.` })
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemInputDto)
  items: ScheduleItemInputDto[];
}

export class SessionCheckInDto {
  @ApiProperty({ description: 'The ticket QR payload or the ticket number' }) @IsString() @MinLength(3) @MaxLength(200) code: string;
}

export class CreateEventDto extends EventExtrasDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiProperty({ enum: Object.values(Category) }) @IsIn(Object.values(Category)) category: Category;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) imageUrl?: string;
  @ApiProperty({ description: 'One date (SINGLE). Multiple dates and multi-day events send `dates` instead (the event times are worked out from them)' })
  @ValidateIf((o: { dateMode?: string }) => !o.dateMode || o.dateMode === 'SINGLE')
  @IsDateString()
  startsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() doorsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ enum: DATE_MODES, default: 'SINGLE', description: 'One date, multiple dates (separate performances) or a multi-day event (festival, conference)' })
  @IsOptional()
  @IsIn(DATE_MODES)
  dateMode?: DateMode;
  @ApiPropertyOptional({ type: [EventDateInputDto], description: `DATES (1–${MAX_DATES}) and DAYS (1–${MAX_DAYS}, distinct calendar days): the dates` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DATES)
  @ValidateNested({ each: true })
  @Type(() => EventDateInputDto)
  dates?: EventDateInputDto[];
  @ApiPropertyOptional({ example: 'Africa/Lagos' }) @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() online?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) streamUrl?: string;
  @ApiPropertyOptional({ description: 'An existing venue' }) @IsOptional() @IsString() venueId?: string;
  @ApiPropertyOptional({ type: VenueInputDto, description: 'Or a new venue' }) @IsOptional() @ValidateNested() @Type(() => VenueInputDto) venue?: VenueInputDto;
  @ApiPropertyOptional({ description: 'Or a venue booked on Omoshow: the event is held there, and waits for the venue to confirm before it can be submitted' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  venueBookingId?: string;
  @ApiPropertyOptional({ enum: ['BUYER', 'ORGANIZER'] }) @IsOptional() @IsIn(['BUYER', 'ORGANIZER']) feeMode?: 'BUYER' | 'ORGANIZER';
  @ApiPropertyOptional({ enum: CURRENCY_CODES, default: 'USD', description: 'Prices and payments for this event are in this currency' })
  @IsOptional()
  @IsIn(CURRENCY_CODES)
  currency?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED']) visibility?: 'PUBLIC' | 'UNLISTED';
  @ApiProperty({ type: [TicketTypeInputDto] })
  @ValidateNested({ each: true })
  @Type(() => TicketTypeInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  ticketTypes: TicketTypeInputDto[];
  @ApiPropertyOptional({ type: [ScheduleItemInputDto], description: 'Optional schedule (agenda); DATES/DAYS items name their date with `dateRef` (index into `dates`)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ITEMS, { message: `A schedule can have up to ${MAX_ITEMS} items.` })
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemInputDto)
  schedule?: ScheduleItemInputDto[];
}

export class UpdateEventDto extends EventExtrasDto {
  @ApiPropertyOptional({ description: 'Why the time or date moved (live events with tickets out): sent to ticket holders', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  changeReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() doorsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ enum: DATE_MODES, description: 'Can change only while the event has no orders' }) @IsOptional() @IsIn(DATE_MODES) dateMode?: DateMode;
  @ApiPropertyOptional({
    type: [EventDateInputDto],
    description: 'DATES/DAYS: the full list of dates. With `id`: keep (and change times or label); without: add (DATES: copies of every tier are made). An active date left out is removed, if it has no sales (cancel it instead). Cancelled dates can be left out.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DATES)
  @ValidateNested({ each: true })
  @Type(() => EventDateInputDto)
  dates?: EventDateInputDto[];
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED']) visibility?: 'PUBLIC' | 'UNLISTED';
  /** Fan resale and transfer rules */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() resaleEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Most a ticket may be resold for, % of face value (100–1000); null = no cap', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(1000)
  resaleCapPercent?: number | null;
  @ApiPropertyOptional({ description: 'Organizer share of each resale, per mille (0–200 = 0–20%)' }) @IsOptional() @IsInt() @Min(0) @Max(200) resaleRoyaltyPermille?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() transfersEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Resale and transfers stop this many minutes before the start (0–10080)' }) @IsOptional() @IsInt() @Min(0) @Max(10_080) transferCutoffMinutes?: number;
}

/** PUT /organizer/events/:id/venue: an existing venue, or a new one (same shape and reuse rules as creating an event). */
export class ChangeVenueDto {
  @ApiPropertyOptional({ description: 'An existing venue' }) @IsOptional() @IsString() @MaxLength(40) venueId?: string;
  @ApiPropertyOptional({ type: VenueInputDto, description: 'Or a new venue' }) @IsOptional() @ValidateNested() @Type(() => VenueInputDto) venue?: VenueInputDto;
  @ApiPropertyOptional({
    example: 'America/Chicago',
    description: 'Only when the organizer picked the zone themselves; otherwise the new venue’s zone is used (map position, else its state, else its country)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}

/** PUT /organizer/events/:id/venue-booking */
export class AttachBookingDto {
  @ApiProperty({ description: 'A pending or confirmed venue booking of the same organization' }) @IsString() @MaxLength(40) bookingId: string;
}

export class UpdateTicketTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10_000_000) basePriceCents?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(200_000) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) maxPerOrder?: number;
  @ApiPropertyOptional({ type: [String], description: 'Up to 8 inclusions, e.g. "Priority entry"' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(60, { each: true })
  perks?: string[];
  @ApiPropertyOptional({ description: 'Short label, e.g. "Best view" (empty string clears it)' }) @IsOptional() @IsString() @MaxLength(24) badge?: string;
  @ApiPropertyOptional({ enum: TIER_STYLE_INPUTS, nullable: true, description: 'The ticket’s look; "auto" or null follows the name' })
  @IsOptional()
  @IsIn(TIER_STYLE_INPUTS)
  style?: string | null;
  @ApiPropertyOptional({ enum: ['FIXED', 'PWYW'], description: 'Fixed price, or pay what you want (the fan picks an amount within the limits below)' })
  @IsOptional()
  @IsIn(['FIXED', 'PWYW'])
  pricing?: 'FIXED' | 'PWYW';
  @ApiPropertyOptional({ description: 'Pay what you want: the minimum base amount (minor units, 0 or more); required with PWYW' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PWYW_CEILING_CENTS)
  pwywMinCents?: number;
  @ApiPropertyOptional({ nullable: true, description: 'Pay what you want: the suggested amount, shown as the default' }) @IsOptional() @IsInt() @Min(0) @Max(PWYW_CEILING_CENTS) pwywSuggestedCents?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Pay what you want: the most a fan can pay (null = no maximum; capped at 10,000,000)' }) @IsOptional() @IsInt() @Min(1) @Max(PWYW_CEILING_CENTS) pwywMaxCents?: number | null;
  @ApiPropertyOptional({ type: [Number], description: `Pay what you want: up to ${MAX_QUICK_PICKS} quick-pick amounts` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_PICKS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(PWYW_CEILING_CENTS, { each: true })
  pwywQuickPicks?: number[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'integer' }, description: 'Multiple dates (DATES): capacity on particular dates, keyed by date id (or index in the event’s `dates`). `capacity` sets every date.' })
  @IsOptional()
  @IsObject()
  capacityByDate?: Record<string, number>;
  @ApiPropertyOptional({ type: [String], description: 'Multi-day event (DAYS): the days this ticket admits on (date ids, or indexes in the event’s `dates`). Once sold, days can only be added.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  validDates?: string[];
}

export class TicketOrderDto {
  @ApiProperty({ type: [String], description: 'Every ticket type id of the event, top tier first' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids: string[];
}

export class SeatMapDto {
  @ApiProperty({ description: 'Seat map layout (see README: version, width, height, stage, sections)' })
  @IsObject()
  seatMap: Record<string, unknown>;
}

export class TemplateDto {
  @ApiProperty({ enum: ['arena'] }) @IsIn(['arena']) template: 'arena';
  @ApiProperty({ description: 'Ticket type for the standing floor' }) @IsString() floor: string;
  @ApiProperty({ description: 'Ticket type for the lower bowl' }) @IsString() lower: string;
  @ApiProperty({ description: 'Ticket type for the upper bowl' }) @IsString() upper: string;
}

export class CheckInDto {
  @ApiProperty({ description: 'Scanned QR token, or a ticket ID typed in' }) @IsString() @MinLength(4) @MaxLength(200) code: string;
  @ApiPropertyOptional({ description: 'Which scanner (stored on the ticket as checkedInDevice)' }) @IsOptional() @IsString() @MaxLength(80) deviceId?: string;
  @ApiPropertyOptional({ description: 'DATES/DAYS: the date the door is working on (default: the date running today at the venue, else the next one)' }) @IsOptional() @IsString() @MaxLength(40) eventDateId?: string;
}

export class OfflineScanDto {
  @ApiProperty({ example: 'EVT-AB12-CD34-01' }) @IsString() @MinLength(4) @MaxLength(64) ticketId: string;
  @ApiProperty({ description: 'When the scanner admitted it (ISO 8601, the scanner’s clock)' }) @IsDateString() scannedAt: string;
  @ApiPropertyOptional({ description: 'The QR code that was scanned; checked against the ticket’s seed when sent' }) @IsOptional() @IsString() @MaxLength(200) code?: string;
  @ApiPropertyOptional({ description: 'DATES/DAYS: the date the scanner was working on (default: the batch’s eventDateId, else the date of scannedAt at the venue)' }) @IsOptional() @IsString() @MaxLength(40) eventDateId?: string;
}

export class CheckInSyncDto {
  @ApiProperty({ description: 'A stable id for this scanner' }) @IsString() @MinLength(1) @MaxLength(80) deviceId: string;
  @ApiPropertyOptional({ description: 'DATES/DAYS: the date the scanner was working on, for scans that don’t say' }) @IsOptional() @IsString() @MaxLength(40) eventDateId?: string;
  @ApiProperty({ type: [OfflineScanDto], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OfflineScanDto)
  scans: OfflineScanDto[];
}

export class PromoDto {
  @ApiProperty() @Transform(upper) @Matches(/^[A-Z0-9]{3,15}$/) code: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100) percent: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
}

export class UpdatePromoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
}

export class PayoutSettingsDto {
  @ApiPropertyOptional({ enum: ['DAILY', 'WEEKLY'] }) @IsOptional() @IsIn(['DAILY', 'WEEKLY']) schedule?: 'DAILY' | 'WEEKLY';
}

/** POST /organizer/events/:id/dates/:dateId/cancel and the admin one */
export class CancelDateDto {
  @ApiPropertyOptional({ minLength: 10, description: 'Shown to buyers in the cancellation email and kept in the audit log. Required to cancel; leave it out to retry the refunds of a date already cancelled (its stored reason is kept).' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason?: string;
}

export class PostponeDto {
  @ApiProperty({ minLength: 10, description: 'Why it’s postponed: sent to ticket holders' }) @IsString() @MinLength(10) @MaxLength(500) reason: string;
}

export class CancelEventDto {
  @ApiProperty({ minLength: 10, description: 'Shown to buyers in the cancellation email and kept in the audit log' }) @IsString() @MinLength(10) @MaxLength(500) reason: string;
  @ApiProperty({ description: 'The event title, typed again to confirm' }) @IsString() @MaxLength(200) confirmTitle: string;
}

/* ---------- comps and the guest list ---------- */

export class CompRecipientDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) name: string;
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
}

export class IssueCompsDto {
  @ApiProperty() @IsString() @MaxLength(40) ticketTypeId: string;
  @ApiPropertyOptional({ type: [CompRecipientDto], description: 'One comp each (1-200)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CompRecipientDto)
  recipients?: CompRecipientDto[];
  @ApiPropertyOptional({ description: 'Or pasted lines: "Name, email", "Name <email>" or "Name<TAB>email" (up to 200)' }) @IsOptional() @IsString() @MaxLength(40_000) text?: string;
  @ApiPropertyOptional({ description: 'Group label, e.g. Press, Artist, Sponsor' }) @IsOptional() @IsString() @MaxLength(40) group?: string;
  @ApiPropertyOptional({ description: 'Private note for the team' }) @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class RevokeCompDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class GuestEntryDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @Transform(lower) @IsEmail() email?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 10 }) @IsOptional() @IsInt() @Min(0) @Max(10) plusOnes?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) group?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class AddGuestsDto {
  @ApiPropertyOptional({ type: [GuestEntryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GuestEntryDto)
  entries?: GuestEntryDto[];
  @ApiPropertyOptional({ description: 'Or pasted lines: name[, email][, +N][, group] (up to 500)' }) @IsOptional() @IsString() @MaxLength(60_000) text?: string;
  @ApiPropertyOptional({ description: 'Group for pasted lines that have none' }) @IsOptional() @IsString() @MaxLength(40) group?: string;
}

export class UpdateGuestDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(lower) @IsEmail() email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10) plusOnes?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(40) group?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}

export class GuestCheckInDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 11, default: 1, description: 'How many of the party just arrived' }) @IsOptional() @IsInt() @Min(1) @Max(11) guests?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceId?: string;
}

export class GuestOfflineDto {
  @ApiProperty() @IsString() @MaxLength(40) entryId: string;
  @ApiProperty({ minimum: 1, maximum: 11 }) @IsInt() @Min(1) @Max(11) guests: number;
  @ApiProperty({ description: "When the scanner checked them in (ISO 8601, the scanner's clock)" }) @IsDateString() at: string;
  @ApiProperty({ description: 'Unique per check-in (e.g. a UUID): the same one sent again is applied once' }) @IsString() @MinLength(1) @MaxLength(64) opId: string;
}

export class GuestSyncDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) deviceId: string;
  @ApiProperty({ type: [GuestOfflineDto], maxItems: 500 })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GuestOfflineDto)
  checkIns: GuestOfflineDto[];
}
