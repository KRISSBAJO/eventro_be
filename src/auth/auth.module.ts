import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Logger, Module, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { MailService, render } from '../mail/mail.module';
import { config } from '../config';
import { CurrentSession, CurrentUser, Public, type AuthUser, type Role } from '../common/auth';
import { RATE_RULES, RateLimit, clientIp } from '../common/rate-limit';
import { SessionService, type SessionUser } from './sessions';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** The password rules, shared by sign-up, reset and change. */
const PasswordRules = (): PropertyDecorator => (target, key) => {
  IsString()(target, key as string);
  MinLength(8, { message: 'Use at least 8 characters for your password.' })(target, key as string);
  MaxLength(200)(target, key as string);
};
const hashPassword = (password: string) => bcrypt.hash(password, 11);

const RESET_TTL_MS = 60 * 60_000;
/** Reset emails one account can get per hour, however many times someone asks. */
const RESETS_PER_ACCOUNT_PER_HOUR = 3;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** A path on the website to go to after resetting (never another site). */
const SAFE_NEXT = /^\/(?![/\\])\S{0,300}$/;

/** Sent by the mobile app only: asks for a long-lived device sign-in (a refresh token). */
export class DeviceDto {
  @ApiPropertyOptional({ example: 'Ada’s iPhone' }) @IsOptional() @IsString() @MaxLength(80) name?: string;
  @ApiPropertyOptional({ example: 'ios', description: 'ios, android, …' }) @IsOptional() @IsString() @MaxLength(20) platform?: string;
}
const DEVICE_DOC = { type: DeviceDto, description: 'Mobile app only. When present the answer also has refreshToken (see POST /auth/refresh) and a 1-hour access token.' };

export class SignupDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiProperty({ example: 'ada@example.com' }) @Transform(lower) @IsEmail() email: string;
  @ApiProperty({ minLength: 8 }) @PasswordRules() password: string;
  @ApiPropertyOptional(DEVICE_DOC) @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

export class RefreshDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) refreshToken: string;
}

export class LogoutDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) refreshToken: string;
  @ApiPropertyOptional({ description: 'This phone’s Expo push token: it stops getting notifications.' }) @IsOptional() @IsString() @MaxLength(250) pushToken?: string;
}

export class UpdateMeDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
  @ApiPropertyOptional(DEVICE_DOC) @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

export class ForgotDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiPropertyOptional({ description: 'Website path to return to after resetting, e.g. /events/some-show' })
  @IsOptional()
  @IsString()
  @Matches(SAFE_NEXT)
  next?: string;
}

export class ResetTokenDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) token: string;
}

export class ResetDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) token: string;
  @ApiProperty({ minLength: 8 }) @PasswordRules() password: string;
  @ApiPropertyOptional(DEVICE_DOC) @IsOptional() @ValidateNested() @Type(() => DeviceDto) device?: DeviceDto;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword: string;
  @ApiProperty({ minLength: 8 }) @PasswordRules() newPassword: string;
}

const resetRefused = (code: 'RESET_INVALID' | 'RESET_USED' | 'RESET_EXPIRED') =>
  new BadRequestException({
    statusCode: 400,
    code,
    message: {
      RESET_INVALID: 'This reset link isn’t valid. Ask for a new one.',
      RESET_USED: 'This reset link has already been used. Ask for a new one if you need to.',
      RESET_EXPIRED: 'This reset link has expired. Ask for a new one.',
    }[code],
  });

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly sessions: SessionService,
  ) {}

  /** The website's answer ({ token, user }); with `device`, a mobile session with a refresh token as well. */
  private async session(u: SessionUser, device?: DeviceDto, ip: string | null = null) {
    if (device) return this.sessions.start(u, device, ip);
    return { token: (await this.sessions.accessToken(u)).token, user: SessionService.userView(u) };
  }

  async signup(dto: SignupDto, ip: string | null = null) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('An account with this email already exists. Sign in instead.');
    const roles: Role[] = ['FAN'];
    if (config.adminEmail && dto.email === config.adminEmail) roles.push('ADMIN');
    const user = await this.prisma.user.create({
      data: { email: dto.email, name: dto.name.trim(), passwordHash: await hashPassword(dto.password), roles },
    });
    // Tickets bought with this email before the account existed now belong to it.
    await this.prisma.ticket.updateMany({ where: { holderEmail: dto.email, ownerId: null }, data: { ownerId: user.id } });
    await this.prisma.order.updateMany({ where: { email: dto.email, buyerId: null }, data: { buyerId: user.id } });
    return this.session(user, dto.device, ip);
  }

  async login(dto: LoginDto, ip: string | null = null) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Same message and similar timing whether or not the email exists.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) throw new UnauthorizedException('Email or password is incorrect.');
    if (user.suspendedAt) throw new ForbiddenException('This account is suspended. Contact Omoshow support.');
    return this.session(user, dto.device, ip);
  }

  async rename(id: string, name: string) {
    const u = await this.prisma.user.update({ where: { id }, data: { name } });
    return { id: u.id, email: u.email, name: u.name, roles: u.roles };
  }

  /* ---------- forgotten and changed passwords ---------- */

  static readonly FORGOT_REPLY = { ok: true, message: 'If an account uses that email, we’ve sent it a link to reset the password. The link works for an hour.' };

  /**
   * Always answers the same way, and does the work after replying, so neither the answer nor its timing tells
   * whether an account exists. Links go only to accounts that aren't suspended, at most 3 an hour per account.
   */
  forgot(dto: ForgotDto, ip: string | null) {
    void this.sendReset(dto.email, dto.next, ip).catch((e) => this.log.warn(`Reset email: ${(e as Error).message}`));
    return AuthService.FORGOT_REPLY;
  }

  private async sendReset(email: string, next: string | undefined, ip: string | null) {
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, suspendedAt: true } });
    if (!user || user.suspendedAt) return;
    const recent = await this.prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
    if (recent >= RESETS_PER_ACCOUNT_PER_HOUR) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS), ip } });
    const url = `${config.webUrl}/reset-password?token=${encodeURIComponent(token)}${next && SAFE_NEXT.test(next) ? `&next=${encodeURIComponent(next)}` : ''}`;
    const { html, text } = render({
      preheader: 'Choose a new password for your Omoshow account. The link works for an hour.',
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${user.name.split(' ')[0] || 'there'}, someone (hopefully you) asked to reset the password for ${user.email}.`,
        'Use the button below to choose a new one. The link works once, for the next hour.',
        'If you didn’t ask for this, you can ignore this email: your password stays the same.',
      ],
      cta: { label: 'Choose a new password', url },
      footer: 'You’re getting this because a password reset was requested for your Omoshow account.',
    });
    await this.mail.send('auth.password_reset', { to: user.email, subject: 'Reset your Omoshow password', html, text });
  }

  /** The reset this token belongs to, if it can still be used; otherwise a 400 saying why not (`code`). */
  private async usableReset(token: string) {
    const r = await this.prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!r) throw resetRefused('RESET_INVALID');
    if (r.usedAt) throw resetRefused('RESET_USED');
    if (r.expiresAt <= new Date()) throw resetRefused('RESET_EXPIRED');
    if (r.user.suspendedAt) throw new ForbiddenException('This account is suspended. Contact Omoshow support.');
    return r;
  }

  /** Lets the website show the form (or the "expired" state) before the fan types a password. */
  async checkReset(token: string) {
    const r = await this.usableReset(token);
    return { valid: true, email: r.user.email, expiresAt: r.expiresAt };
  }

  async reset(dto: ResetDto, ip: string | null) {
    const r = await this.usableReset(dto.token);
    // Claim the link first so two submits can't both use it.
    const { count } = await this.prisma.passwordReset.updateMany({ where: { id: r.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!count) throw resetRefused('RESET_USED');
    const user = await this.setPassword(r.userId, dto.password, 'user.password_reset', ip, null);
    return this.session(user, dto.device, ip);
  }

  /**
   * From the mobile app (a device session), that device stays signed in: its refresh token keeps working and the
   * answer is a new access token for it. Every other sign-in ends.
   */
  async changePassword(me: AuthUser, dto: ChangePasswordDto, ip: string | null, sessionId: string | null = null) {
    const u = await this.prisma.user.findUnique({ where: { id: me.id } });
    if (!u || !(await bcrypt.compare(dto.currentPassword, u.passwordHash))) throw new BadRequestException('Your current password isn’t right.');
    if (await bcrypt.compare(dto.newPassword, u.passwordHash)) throw new BadRequestException('Choose a new password that’s different from your current one.');
    const user = await this.setPassword(u.id, dto.newPassword, 'user.password_change', ip, sessionId);
    if (sessionId) {
      const access = await this.sessions.accessToken(user, sessionId);
      return { token: access.token, accessTokenExpiresAt: access.expiresAt, sessionId, user: SessionService.userView(user) };
    }
    return this.session(user);
  }

  /**
   * New password: unused reset links stop working, sign-ins from before now end (the guard checks
   * passwordChangedAt), the change is audited and the account holder gets an email about it.
   */
  private async setPassword(userId: string, password: string, action: string, ip: string | null, keepSessionId: string | null) {
    const passwordHash = await hashPassword(password);
    const now = new Date();
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: now } }),
      this.prisma.passwordReset.deleteMany({ where: { userId, usedAt: null } }),
      // Mobile sign-ins end too (refresh tokens stop working), except the device making the change.
      this.prisma.session.updateMany({ where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) }, data: { revokedAt: now } }),
    ]);
    await this.audit.log(userId, action, 'User', userId, { ip });
    const { html, text } = render({
      preheader: 'The password for your Omoshow account was just changed.',
      heading: 'Your password was changed',
      paragraphs: [
        `The password for ${user.email} was changed on ${now.toUTCString()}.`,
        'For your security, you’ve been signed out everywhere else. Sign in with the new password on your other devices.',
        'If this wasn’t you, reset your password right away and reply to this email to reach Omoshow support.',
      ],
      cta: { label: 'Reset my password', url: `${config.webUrl}/forgot-password` },
      footer: 'You’re getting this because the password on your Omoshow account changed.',
    });
    void this.mail.send('auth.password_changed', { to: user.email, subject: 'Your Omoshow password was changed', html, text }).catch(() => undefined);
    return user;
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('signup')
  @RateLimit(RATE_RULES.signup)
  signup(@Body() dto: SignupDto, @Req() req: Request) {
    return this.auth.signup(dto, clientIp(req));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit(RATE_RULES.loginPerIpEmail, RATE_RULES.loginPerIp)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, clientIp(req));
  }

  /**
   * Mobile app: swaps a refresh token for a new access token and a new refresh token (the old one stops working).
   * 401 with `code` REFRESH_INVALID, REFRESH_EXPIRED, REFRESH_REVOKED, REFRESH_REUSED (an old token came back:
   * the session is ended) or ACCOUNT_SUSPENDED. Send one refresh at a time per device.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @RateLimit(RATE_RULES.refresh)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.sessions.refresh(dto.refreshToken, clientIp(req));
  }

  /** Mobile app: signs this device out (its refresh token stops working) and, with `pushToken`, stops its notifications. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  @RateLimit(RATE_RULES.refresh)
  async logout(@Body() dto: LogoutDto) {
    const userId = await this.sessions.logout(dto.refreshToken);
    if (userId && dto.pushToken) await this.prisma.pushDevice.updateMany({ where: { token: dto.pushToken, userId, disabledAt: null }, data: { disabledAt: new Date() } });
    return { ok: true };
  }

  /** Emails a reset link if the account exists. The answer is the same either way. */
  @Public()
  @Post('forgot')
  @HttpCode(200)
  @RateLimit(RATE_RULES.forgotPassword)
  forgot(@Body() dto: ForgotDto, @Req() req: Request) {
    return this.auth.forgot(dto, clientIp(req));
  }

  /** Whether a reset link can still be used, and for which email. 400 with `code` RESET_INVALID, RESET_USED or RESET_EXPIRED if not. */
  @Public()
  @Post('reset/check')
  @HttpCode(200)
  @RateLimit(RATE_RULES.password)
  checkReset(@Body() dto: ResetTokenDto) {
    return this.auth.checkReset(dto.token);
  }

  /** Sets a new password from a reset link and signs in (same answer as /auth/login). */
  @Public()
  @Post('reset')
  @HttpCode(200)
  @RateLimit(RATE_RULES.password)
  reset(@Body() dto: ResetDto, @Req() req: Request) {
    return this.auth.reset(dto, clientIp(req));
  }

  /** Changes the signed-in account's password. Other sign-ins end; the answer is a fresh session for this one. */
  @ApiBearerAuth()
  @Post('password')
  @HttpCode(200)
  @RateLimit(RATE_RULES.password)
  changePassword(@CurrentUser() user: AuthUser, @CurrentSession() sid: string | null, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.auth.changePassword(user, dto, clientIp(req), sid);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** Change the name shown on tickets bought from now on. */
  @ApiBearerAuth()
  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.auth.rename(user.id, dto.name.trim());
  }
}

/** The account's mobile sign-ins. */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('me/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionService) {}

  /** Signed-in devices; `current` marks the one making this request (mobile access tokens only). */
  @Get()
  list(@CurrentUser() user: AuthUser, @CurrentSession() sid: string | null) {
    return this.sessions.list(user.id, sid);
  }

  /** Signs that device out: its refresh token and access token stop working at once. */
  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sessions.revokeOne(user.id, id);
  }
}

@Module({
  controllers: [AuthController, SessionsController],
  providers: [AuthService, SessionService],
})
export class AuthModule {}
