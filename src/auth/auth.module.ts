import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, Module, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { MailService, render } from '../mail/mail.module';
import { config } from '../config';
import { CurrentUser, Public, type AuthUser, type Role } from '../common/auth';
import { RATE_RULES, RateLimit, clientIp } from '../common/rate-limit';

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

export class SignupDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiProperty({ example: 'ada@example.com' }) @Transform(lower) @IsEmail() email: string;
  @ApiProperty({ minLength: 8 }) @PasswordRules() password: string;
}

export class UpdateMeDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
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
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword: string;
  @ApiProperty({ minLength: 8 }) @PasswordRules() newPassword: string;
}

type SessionUser = { id: string; email: string; name: string; roles: string[]; passwordChangedAt?: Date | null };

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
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private async session(u: SessionUser) {
    // JWT `iat` is in whole seconds and the guard refuses tokens issued at or before the last password change,
    // so a token issued in the same second as a change is stamped one second later to stay valid.
    const now = Math.floor(Date.now() / 1000);
    const changed = u.passwordChangedAt ? Math.floor(u.passwordChangedAt.getTime() / 1000) + 1 : 0;
    return {
      token: await this.jwt.signAsync({ sub: u.id, iat: Math.max(now, changed) }),
      user: { id: u.id, email: u.email, name: u.name, roles: u.roles as Role[] },
    };
  }

  async signup(dto: SignupDto) {
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
    return this.session(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Same message and similar timing whether or not the email exists.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) throw new UnauthorizedException('Email or password is incorrect.');
    if (user.suspendedAt) throw new ForbiddenException('This account is suspended. Contact Eventro support.');
    return this.session(user);
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
      preheader: 'Choose a new password for your Eventro account. The link works for an hour.',
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${user.name.split(' ')[0] || 'there'}, someone (hopefully you) asked to reset the password for ${user.email}.`,
        'Use the button below to choose a new one. The link works once, for the next hour.',
        'If you didn’t ask for this, you can ignore this email: your password stays the same.',
      ],
      cta: { label: 'Choose a new password', url },
      footer: 'You’re getting this because a password reset was requested for your Eventro account.',
    });
    await this.mail.send('auth.password_reset', { to: user.email, subject: 'Reset your Eventro password', html, text });
  }

  /** The reset this token belongs to, if it can still be used; otherwise a 400 saying why not (`code`). */
  private async usableReset(token: string) {
    const r = await this.prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!r) throw resetRefused('RESET_INVALID');
    if (r.usedAt) throw resetRefused('RESET_USED');
    if (r.expiresAt <= new Date()) throw resetRefused('RESET_EXPIRED');
    if (r.user.suspendedAt) throw new ForbiddenException('This account is suspended. Contact Eventro support.');
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
    const user = await this.setPassword(r.userId, dto.password, 'user.password_reset', ip);
    return this.session(user);
  }

  async changePassword(me: AuthUser, dto: ChangePasswordDto, ip: string | null) {
    const u = await this.prisma.user.findUnique({ where: { id: me.id } });
    if (!u || !(await bcrypt.compare(dto.currentPassword, u.passwordHash))) throw new BadRequestException('Your current password isn’t right.');
    if (await bcrypt.compare(dto.newPassword, u.passwordHash)) throw new BadRequestException('Choose a new password that’s different from your current one.');
    const user = await this.setPassword(u.id, dto.newPassword, 'user.password_change', ip);
    return this.session(user);
  }

  /**
   * New password: unused reset links stop working, sign-ins from before now end (the guard checks
   * passwordChangedAt), the change is audited and the account holder gets an email about it.
   */
  private async setPassword(userId: string, password: string, action: string, ip: string | null) {
    const passwordHash = await hashPassword(password);
    const now = new Date();
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: now } }),
      this.prisma.passwordReset.deleteMany({ where: { userId, usedAt: null } }),
    ]);
    await this.audit.log(userId, action, 'User', userId, { ip });
    const { html, text } = render({
      preheader: 'The password for your Eventro account was just changed.',
      heading: 'Your password was changed',
      paragraphs: [
        `The password for ${user.email} was changed on ${now.toUTCString()}.`,
        'For your security, you’ve been signed out everywhere else. Sign in with the new password on your other devices.',
        'If this wasn’t you, reset your password right away and reply to this email to reach Eventro support.',
      ],
      cta: { label: 'Reset my password', url: `${config.webUrl}/forgot-password` },
      footer: 'You’re getting this because the password on your Eventro account changed.',
    });
    void this.mail.send('auth.password_changed', { to: user.email, subject: 'Your Eventro password was changed', html, text }).catch(() => undefined);
    return user;
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  @RateLimit(RATE_RULES.signup)
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit(RATE_RULES.loginPerIpEmail, RATE_RULES.loginPerIp)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
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
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.auth.changePassword(user, dto, clientIp(req));
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

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
