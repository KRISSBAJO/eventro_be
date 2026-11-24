/**
 * Preview links for events that aren't published yet (draft, in review, rejected). Organizers and admins get a
 * signed token with the event; `GET /events/:slug?preview=<token>` then returns the event as fans will see it.
 * The token is tied to the slug and expires after a week, so a leaked link stops working on its own.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

const WEEK = 7 * 24 * 60 * 60 * 1000;

const sign = (slug: string, exp: number) => createHmac('sha256', config.jwtSecret).update(`event-preview:${slug}:${exp}`).digest('base64url');

/** A preview token for this slug, or undefined for published events (their public page works already). */
export function previewToken(slug: string, status: string): string | undefined {
  if (status === 'PUBLISHED') return undefined;
  // Rounded to the hour so the token stays the same across a page's refreshes.
  const exp = Math.ceil((Date.now() + WEEK) / 3_600_000) * 3_600_000;
  return `${exp.toString(36)}.${sign(slug, exp)}`;
}

export function previewOk(slug: string, token: string | undefined): boolean {
  if (!token || token.length > 120) return false;
  const [expRaw, mac] = token.split('.');
  const exp = parseInt(expRaw ?? '', 36);
  if (!mac || !Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(sign(slug, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}
