import { CURRENCY_CODES } from '../domain/currency';
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
  ValidateNested,
} from 'class-validator';
import { Category } from '@prisma/client';

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
  @ApiProperty({ description: 'Organizer price in cents (0 = free). The fan price is calculated from the fee mode.' })
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
}

export class CreateEventDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiProperty({ enum: Object.values(Category) }) @IsIn(Object.values(Category)) category: Category;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) imageUrl?: string;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() doorsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ example: 'Africa/Lagos' }) @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() online?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) streamUrl?: string;
  @ApiPropertyOptional({ description: 'An existing venue' }) @IsOptional() @IsString() venueId?: string;
  @ApiPropertyOptional({ type: VenueInputDto, description: 'Or a new venue' }) @IsOptional() @ValidateNested() @Type(() => VenueInputDto) venue?: VenueInputDto;
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
}

export class UpdateEventDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) subtitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: true }) imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() doorsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endsAt?: string;
  @ApiPropertyOptional({ enum: ['PUBLIC', 'UNLISTED'] }) @IsOptional() @IsIn(['PUBLIC', 'UNLISTED']) visibility?: 'PUBLIC' | 'UNLISTED';
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
