/**
 * Proof of cookie consent for the website.
 *
 *   POST /consent          { consentId, policyVersion, analytics, marketing, gpc?, method }  record a choice
 *   GET  /admin/consents   ?consentId= | ?userId=                                            a visitor's history (ADMIN)
 *
 * Every choice appends a row, so a visitor's history (accept, later withdraw…) stays provable. The consent ID is the
 * random UUID in the visitor's `eventro_consent` cookie; signed-in visitors also get their account attached. No IP
 * address is stored (the rate limit counts by IP in memory only). Public writes aren't audited.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Module, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { CurrentUser, OptionalAuth, Roles, type AuthUser } from '../common/auth';
import { RATE_RULES, RateLimit } from '../common/rate-limit';

export const CONSENT_METHODS = ['banner', 'settings', 'gpc'] as const;

export class RecordConsentDto {
  @ApiProperty({ format: 'uuid', description: 'The random ID kept in the visitor’s consent cookie' }) @IsUUID() consentId: string;
  @ApiProperty({ example: '2026-11-25', description: 'The cookie policy version the visitor saw' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) policyVersion: string;
  @ApiProperty() @IsBoolean() analytics: boolean;
  @ApiProperty({ description: 'Always stored as false when `gpc` is true' }) @IsBoolean() marketing: boolean;
  @ApiPropertyOptional({ description: 'The browser sent Global Privacy Control' }) @IsOptional() @IsBoolean() gpc?: boolean;
  @ApiProperty({ enum: CONSENT_METHODS }) @IsIn(CONSENT_METHODS) method: (typeof CONSENT_METHODS)[number];
}

const SELECT = { id: true, consentId: true, policyVersion: true, analytics: true, marketing: true, gpc: true, method: true, userId: true, userAgent: true, createdAt: true } as const;

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async record(dto: RecordConsentDto, user: AuthUser | null, userAgent: string | undefined) {
    const gpc = dto.gpc === true;
    await this.prisma.consentRecord.create({
      data: {
        consentId: dto.consentId.toLowerCase(),
        policyVersion: dto.policyVersion,
        analytics: dto.analytics,
        // Global Privacy Control is an opt-out of selling/sharing: marketing can't be on with it.
        marketing: dto.marketing && !gpc,
        gpc,
        method: dto.method,
        userId: user?.id ?? null,
        userAgent: userAgent ? userAgent.slice(0, 200) : null,
      },
    });
    return { ok: true as const };
  }

  /** One visitor's (or account's) choices, newest first. */
  async history(consentId?: string, userId?: string) {
    const id = (consentId ?? '').trim().toLowerCase();
    const uid = (userId ?? '').trim();
    if (!id && !uid) throw new BadRequestException('Give a consentId or a userId.');
    if (id.length > 64 || uid.length > 64) throw new BadRequestException('That ID is too long.');
    const items = await this.prisma.consentRecord.findMany({
      where: { ...(id ? { consentId: id } : {}), ...(uid ? { userId: uid } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: SELECT,
    });
    return { items };
  }
}

@ApiTags('consent')
@Controller('consent')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @OptionalAuth()
  @Post()
  @HttpCode(200)
  @RateLimit(RATE_RULES.consent)
  record(@Body() dto: RecordConsentDto, @CurrentUser() user: AuthUser | null, @Req() req: Request) {
    return this.consent.record(dto, user, req.headers['user-agent']);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/consents')
export class AdminConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get()
  history(@Query('consentId') consentId?: string, @Query('userId') userId?: string) {
    return this.consent.history(consentId, userId);
  }
}

@Module({ controllers: [ConsentController, AdminConsentController], providers: [ConsentService] })
export class ConsentModule {}
