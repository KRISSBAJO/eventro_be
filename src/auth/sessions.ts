/**
 * Long-lived sign-ins for the mobile app.
 *
 * `POST /auth/login` (or signup, or a password reset) with `device: { name?, platform? }` starts a Session: the
 * answer carries a short-lived access token (1 hour, bound to the session with a `sid` claim) and a refresh token.
 * The refresh token is `<sessionId>.<32 random bytes, base64url>`; only its SHA-256 hash is stored. It lasts 60
 * days from its last use.
 *
 * `POST /auth/refresh` swaps a refresh token for a new access token and a new refresh token (rotation). The old
 * refresh token stops working at once. Presenting an already-rotated token again means it was copied: the whole
 * session is revoked (theft detection), so both the thief and the phone have to sign in again.
 *
 * Signing out (`POST /auth/logout`, `DELETE /me/sessions/:id`), a password reset or change and an admin
 * suspension revoke sessions; the guard refuses access tokens of revoked sessions immediately.
 *
 * Website sign-ins don't send `device` and are unchanged: a 7-day access token and no session row.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import type { Role } from '../common/auth';

export const REFRESH_TTL_MS = 60 * 86_400_000;
/** Access tokens for device sessions; the website's stay at the default 7 days. */
export const DEVICE_ACCESS_TTL_S = 3600;

export type SessionUser = { id: string; email: string; name: string; roles: string[]; passwordChangedAt?: Date | null; suspendedAt?: Date | null };
export type DeviceInfo = { name?: string; platform?: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const refused = (code: 'REFRESH_INVALID' | 'REFRESH_EXPIRED' | 'REFRESH_REVOKED' | 'REFRESH_REUSED' | 'ACCOUNT_SUSPENDED') =>
  new UnauthorizedException({
    statusCode: 401,
    code,
    message: {
      REFRESH_INVALID: 'Your session has expired. Please sign in again.',
      REFRESH_EXPIRED: 'Your session has expired. Please sign in again.',
      REFRESH_REVOKED: 'You were signed out on this device. Please sign in again.',
      REFRESH_REUSED: 'For your security, this device was signed out. Please sign in again.',
      ACCOUNT_SUSPENDED: 'This account is suspended. Contact Omoshow support.',
    }[code],
  });

/** `<sessionId>.<secret>` → the session id, or null when it isn't shaped like one of ours. */
function sessionIdOf(token: string) {
  const i = token.indexOf('.');
  if (i < 1 || i > 64 || token.length > 200) return null;
  return token.slice(0, i);
}

@Injectable()
export class SessionService {
  private readonly log = new Logger('Sessions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /**
   * An access token. JWT `iat` is in whole seconds and the guard refuses tokens issued at or before the last
   * password change, so a token issued in the same second as a change is stamped one second later to stay valid.
   * With a session id it's a 1-hour device token; without, the website's 7-day token.
   */
  async accessToken(u: SessionUser, sid?: string) {
    const now = Math.floor(Date.now() / 1000);
    const changed = u.passwordChangedAt ? Math.floor(u.passwordChangedAt.getTime() / 1000) + 1 : 0;
    const iat = Math.max(now, changed);
    if (!sid) return { token: await this.jwt.signAsync({ sub: u.id, iat }), expiresAt: null };
    const token = await this.jwt.signAsync({ sub: u.id, iat, sid }, { expiresIn: DEVICE_ACCESS_TTL_S });
    return { token, expiresAt: new Date((iat + DEVICE_ACCESS_TTL_S) * 1000) };
  }

  static userView(u: SessionUser) {
    return { id: u.id, email: u.email, name: u.name, roles: u.roles as Role[] };
  }

  /** Starts a device session and answers like /auth/login, plus the refresh token. */
  async start(u: SessionUser, device: DeviceInfo, ip: string | null) {
    const id = randomUUID();
    const refreshToken = `${id}.${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await this.prisma.session.create({
      data: { id, userId: u.id, tokenHash: sha256(refreshToken), deviceName: device.name?.trim() || null, platform: device.platform?.trim().toLowerCase() || null, ip, expiresAt },
    });
    const access = await this.accessToken(u, id);
    return { token: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken, refreshTokenExpiresAt: expiresAt, sessionId: id, user: SessionService.userView(u) };
  }

  /** Rotates a refresh token. See the file comment for reuse detection. */
  async refresh(refreshToken: string, ip: string | null) {
    const id = sessionIdOf(refreshToken);
    const s = id ? await this.prisma.session.findUnique({ where: { id }, include: { user: true } }) : null;
    if (!s) throw refused('REFRESH_INVALID');
    if (s.revokedAt) throw refused('REFRESH_REVOKED');
    const hash = sha256(refreshToken);
    if (hash !== s.tokenHash) {
      // An older token from this session: someone else has a copy. End the session for everyone.
      await this.prisma.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(s.userId, 'session.reuse_detected', 'Session', s.id, { ip });
      this.log.warn(`Refresh token reuse on session ${s.id}: session revoked`);
      throw refused('REFRESH_REUSED');
    }
    if (s.expiresAt <= new Date()) throw refused('REFRESH_EXPIRED');
    if (s.user.suspendedAt) {
      await this.prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
      throw refused('ACCOUNT_SUSPENDED');
    }
    const next = `${s.id}.${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
    // Conditional on the old hash, so two refreshes racing with the same token can't both succeed.
    const { count } = await this.prisma.session.updateMany({
      where: { id: s.id, tokenHash: hash, revokedAt: null },
      data: { tokenHash: sha256(next), lastUsedAt: now, expiresAt, ...(ip ? { ip } : {}) },
    });
    if (!count) throw refused('REFRESH_INVALID');
    const access = await this.accessToken(s.user, s.id);
    return { token: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: next, refreshTokenExpiresAt: expiresAt, sessionId: s.id, user: SessionService.userView(s.user) };
  }

  /** Signs this device out. Always answers ok (the token may already be gone); returns the user id when it was ours. */
  async logout(refreshToken: string) {
    const id = sessionIdOf(refreshToken);
    const s = id ? await this.prisma.session.findUnique({ where: { id }, select: { id: true, userId: true, tokenHash: true, revokedAt: true } }) : null;
    if (!s || s.tokenHash !== sha256(refreshToken)) return null;
    if (!s.revokedAt) await this.prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    return s.userId;
  }

  /** The account's signed-in devices (not revoked, not expired), most recently used first. */
  async list(userId: string, currentId: string | null) {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, deviceName: true, platform: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
    return { sessions: rows.map((r) => ({ ...r, current: r.id === currentId })) };
  }

  async revokeOne(userId: string, id: string) {
    const { count } = await this.prisma.session.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw new NotFoundException('Signed-in device not found.');
    await this.audit.log(userId, 'session.revoke', 'Session', id);
    return { revoked: true };
  }

  /** Every device session of this account ends, except `exceptId` (the one making a password change). */
  revokeAll(userId: string, exceptId?: string | null) {
    return this.prisma.session.updateMany({ where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { revokedAt: new Date() } });
  }
}
