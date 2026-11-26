/**
 * A small in-memory, sliding-window rate limiter for abuse-prone routes (sign-in, password resets, checkout,
 * sign-ups). Put `@RateLimit(...)` on a route with one or more rules; a request is refused with 429 and a
 * Retry-After header when any rule is over its limit, and then counts against none of them.
 *
 * Limits are read from the environment on every request (so they can be tuned without code changes, and tests
 * can tighten one on the fly). Counts live in this process only: they reset on restart and aren't shared
 * between instances, which is fine for one API process. Keys use the client IP as Express sees it (`trust proxy`
 * is set in main.ts) and, for rules `by: 'ip+email'`, the email in the request body.
 */
import { applyDecorators, CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

export type RateRule = {
  /** Bucket name; routes sharing a bucket share counts. */
  bucket: string;
  /** Environment variable holding the limit (a whole number of requests per window). */
  env: string;
  /** Used when the environment variable is missing or not a number. */
  limit: number;
  windowMs: number;
  by: 'ip' | 'ip+email';
};

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The limits Omoshow uses. Each one's environment variable overrides the default. */
export const RATE_RULES = {
  loginPerIpEmail: { bucket: 'login:ip+email', env: 'RATE_LOGIN_PER_IP_EMAIL', limit: 10, windowMs: 15 * MIN, by: 'ip+email' },
  loginPerIp: { bucket: 'login:ip', env: 'RATE_LOGIN_PER_IP', limit: 30, windowMs: 15 * MIN, by: 'ip' },
  /** account sign-ups, newsletter sign-ups and price alerts: one limit (each its own bucket), per hour */
  signup: { bucket: 'signup:ip', env: 'SIGNUPS_PER_IP_PER_HOUR', limit: 20, windowMs: HOUR, by: 'ip' },
  newsletter: { bucket: 'newsletter:ip', env: 'SIGNUPS_PER_IP_PER_HOUR', limit: 20, windowMs: HOUR, by: 'ip' },
  priceWatch: { bucket: 'price-watch:ip', env: 'SIGNUPS_PER_IP_PER_HOUR', limit: 20, windowMs: HOUR, by: 'ip' },
  /** cookie consent records from the website (one per choice; many visitors can share an IP) */
  consent: { bucket: 'consent:ip', env: 'RATE_CONSENT_PER_IP', limit: 60, windowMs: HOUR, by: 'ip' },
  forgotPassword: { bucket: 'forgot:ip', env: 'RATE_FORGOT_PER_IP', limit: 5, windowMs: HOUR, by: 'ip' },
  /** "Can't find my order?" (each request may email someone) */
  findOrders: { bucket: 'find-orders:ip', env: 'RATE_FIND_ORDERS_PER_IP', limit: 5, windowMs: HOUR, by: 'ip' },
  /** resetting (and checking a reset link) and changing a password */
  password: { bucket: 'password:ip', env: 'RATE_PASSWORD_PER_IP', limit: 10, windowMs: HOUR, by: 'ip' },
  /** holds and orders, including resale orders */
  checkout: { bucket: 'checkout:ip', env: 'RATE_CHECKOUT_PER_IP', limit: 30, windowMs: 10 * MIN, by: 'ip' },
  resaleHold: { bucket: 'resale-hold:ip', env: 'RATE_RESALE_HOLD_PER_IP', limit: 20, windowMs: 10 * MIN, by: 'ip' },
  /** mobile app: refreshing an access token and signing a device out (many phones can share a carrier IP) */
  refresh: { bucket: 'refresh:ip', env: 'RATE_REFRESH_PER_IP', limit: 120, windowMs: 15 * MIN, by: 'ip' },
  /** door scanners downloading an event's offline ticket pack (it holds every ticket's QR seed) */
  doorPack: { bucket: 'door-pack:ip', env: 'RATE_DOOR_PACK_PER_IP', limit: 30, windowMs: 10 * MIN, by: 'ip' },
} satisfies Record<string, RateRule>;

const limitOf = (r: RateRule) => {
  const raw = process.env[r.env];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : r.limit;
};

/** Sliding-window counters: every hit's time, per key, for as long as the window lasts. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private calls = 0;

  /**
   * Checks every rule for these keys. If all have room, records one hit on each and returns null; otherwise
   * records nothing and returns how many milliseconds until the tightest rule has room again.
   */
  take(checks: { key: string; limit: number; windowMs: number }[], now = Date.now()): number | null {
    if (++this.calls % 500 === 0) this.sweep(now);
    let wait = 0;
    for (const c of checks) {
      const list = this.live(c.key, c.windowMs, now);
      if (list.length >= c.limit) {
        // The oldest hit that must expire before one more request fits.
        const oldest = list[list.length - c.limit] ?? now;
        wait = Math.max(wait, oldest + c.windowMs - now, 1000);
      }
    }
    if (wait) return wait;
    for (const c of checks) this.live(c.key, c.windowMs, now).push(now);
    return null;
  }

  /** Forgets every count (tests). */
  reset() {
    this.hits.clear();
  }

  private live(key: string, windowMs: number, now: number) {
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    const from = now - windowMs;
    let drop = 0;
    while (drop < list.length && list[drop] <= from) drop++;
    if (drop) list.splice(0, drop);
    return list;
  }

  /** Drops keys with no recent hits so memory stays small. The longest window is an hour. */
  private sweep(now: number) {
    for (const [k, list] of this.hits) if (!list.length || list[list.length - 1] <= now - 2 * HOUR) this.hits.delete(k);
  }
}

/** The process-wide limiter behind @RateLimit. */
export const rateLimiter = new RateLimiter();

/** The client's address as Express reports it (honours `trust proxy`), without the IPv4-mapped prefix. */
export const clientIp = (req: Request) => (req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');

const RULES = 'eventro:rate-rules';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const rules = this.reflector.get<RateRule[]>(RULES, ctx.getHandler()) ?? [];
    if (!rules.length) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = clientIp(req);
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : '';
    const checks = rules.map((r) => ({
      key: `${r.bucket}|${ip}${r.by === 'ip+email' ? `|${email}` : ''}`,
      limit: limitOf(r),
      windowMs: r.windowMs,
    }));
    const wait = rateLimiter.take(checks);
    if (wait === null) return true;
    const seconds = Math.ceil(wait / 1000);
    const minutes = Math.ceil(seconds / 60);
    ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(seconds));
    throw new HttpException(
      { statusCode: 429, error: 'Too Many Requests', message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryAfterSeconds: seconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Limits this route by the given rules (see RATE_RULES). */
export const RateLimit = (...rules: RateRule[]) => applyDecorators(SetMetadata(RULES, rules), UseGuards(RateLimitGuard));
