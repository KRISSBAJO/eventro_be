/**
 * Drops & presales by email (the sign-up box in the site footer and the /newsletter page).
 *
 *   POST   /newsletter          { email, source?, interests?, city? }  sign up (or sign up again)
 *   GET    /newsletter/:token   one subscriber's preferences (the token is the secret in their link)
 *   PATCH  /newsletter/:token   { interests?, city? }                 change what they hear about
 *   DELETE /newsletter/:token   unsubscribe
 *
 * Signing up never reveals whether an address was already on the list to someone else: the preferences token
 * is only handed back when this request created (or re-opened) the subscription.
 */
import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { Public } from '../common/auth';
import { config } from '../config';
import { MailService, render } from '../mail/mail.module';

export const CATEGORIES = ['Concerts', 'Sports', 'Comedy', 'Theater', 'Festivals', 'Family', 'Faith'] as const;
const SOURCES = ['footer', 'newsletter', 'event', 'checkout'] as const;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

class PreferencesDto {
  @ApiPropertyOptional({ enum: CATEGORIES, isArray: true, description: 'Empty means every category.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CATEGORIES.length)
  @IsIn(CATEGORIES, { each: true })
  interests?: string[];

  @ApiPropertyOptional({ example: 'lagos', description: 'City slug for local drops; empty string clears it.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9-]*$/)
  city?: string;
}

class SubscribeDto extends PreferencesDto {
  @ApiProperty({ example: 'ada@example.com' }) @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiPropertyOptional({ enum: SOURCES }) @IsOptional() @IsIn(SOURCES) source?: string;
}

/** "a•••@example.com": enough to recognise your own address on the preferences page. */
const mask = (email: string) => {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.min(6, Math.max(2, user.length - 1)))}@${domain}`;
};

const newToken = () => randomBytes(24).toString('base64url');


@Injectable()
export class NewsletterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** The welcome email, with the private link to change preferences or leave. */
  private welcome(email: string, token: string) {
    const manage = `${config.webUrl}/newsletter/manage?t=${token}`;
    const { html, text } = render({
      preheader: 'Presale codes, new shows near you and price drops, before everyone else.',
      heading: 'You’re on the list',
      paragraphs: [
        'From now on you’ll hear about presale codes, new shows in your city and price drops before they go public.',
        'One email a week at most. Pick the kinds of events you care about and we’ll skip the rest.',
      ],
      cta: { label: 'Choose what you hear about', url: manage },
      footer: 'You signed up for drops and presales on Eventro.',
      footerLink: { label: 'Unsubscribe', url: manage },
    });
    void this.mail.send('newsletter.welcome', { to: email, subject: 'You’re on the Eventro list', html, text, unsubscribeUrl: manage });
  }

  async subscribe(dto: SubscribeDto, clientIp: string | null) {
    if (clientIp) {
      const recent = await this.prisma.subscriber.count({ where: { clientIp, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
      if (recent >= config.signupsPerIpPerHour) throw new HttpException('Too many sign-ups from this connection. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const prefs = { interests: dto.interests ?? [], city: dto.city || null };
    const existing = await this.prisma.subscriber.findUnique({ where: { email: dto.email } });

    if (existing && !existing.unsubscribedAt) return { subscribed: true, already: true };

    if (existing) {
      // Coming back after unsubscribing: reopen with a fresh link (the old one stops working).
      const s = await this.prisma.subscriber.update({
        where: { id: existing.id },
        data: { ...prefs, token: newToken(), unsubscribedAt: null, source: dto.source ?? 'footer' },
      });
      this.welcome(s.email, s.token);
      return { subscribed: true, already: false, token: s.token };
    }
    const s = await this.prisma.subscriber.create({
      data: { email: dto.email, token: newToken(), source: dto.source ?? 'footer', clientIp, ...prefs },
    });
    this.welcome(s.email, s.token);
    return { subscribed: true, already: false, token: s.token };
  }

  private async byToken(token: string) {
    const s = token.length <= 64 ? await this.prisma.subscriber.findUnique({ where: { token } }) : null;
    if (!s) throw new NotFoundException('That link has expired or was never valid.');
    return s;
  }

  private view(s: { email: string; interests: string[]; city: string | null; unsubscribedAt: Date | null; createdAt: Date }) {
    return { email: mask(s.email), interests: s.interests, city: s.city, subscribed: !s.unsubscribedAt, since: s.createdAt };
  }

  async get(token: string) {
    return this.view(await this.byToken(token));
  }

  async update(token: string, dto: PreferencesDto) {
    const s = await this.byToken(token);
    const data: { interests?: string[]; city?: string | null; unsubscribedAt?: null } = {};
    if (dto.interests) data.interests = [...new Set(dto.interests)];
    if (dto.city !== undefined) data.city = dto.city || null;
    // Saving preferences from the link counts as wanting the emails again.
    if (s.unsubscribedAt) data.unsubscribedAt = null;
    return this.view(await this.prisma.subscriber.update({ where: { id: s.id }, data }));
  }

  async unsubscribe(token: string) {
    const s = await this.byToken(token);
    const done = s.unsubscribedAt ? s : await this.prisma.subscriber.update({ where: { id: s.id }, data: { unsubscribedAt: new Date() } });
    return this.view(done);
  }
}

@ApiTags('newsletter')
@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly newsletter: NewsletterService) {}

  @Public()
  @Post()
  @HttpCode(200)
  subscribe(@Body() dto: SubscribeDto, @Req() req: Request) {
    return this.newsletter.subscribe(dto, req.ip ?? null);
  }

  @Public()
  @Get(':token')
  get(@Param('token') token: string) {
    return this.newsletter.get(token);
  }

  @Public()
  @Patch(':token')
  update(@Param('token') token: string, @Body() dto: PreferencesDto) {
    return this.newsletter.update(token, dto);
  }

  @Public()
  @Delete(':token')
  unsubscribe(@Param('token') token: string) {
    return this.newsletter.unsubscribe(token);
  }
}

@Module({ controllers: [NewsletterController], providers: [NewsletterService] })
export class NewsletterModule {}
