import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rotating ticket codes. The QR shown in the app encodes `ticketId.window.signature`,
 * where `window` changes every 15 seconds. Screenshots stop scanning after ~30 seconds.
 */

export const QR_WINDOW_MS = 15_000;

const sign = (secret: string, ticketId: string, window: number) =>
  createHmac('sha256', secret).update(`${ticketId}.${window}`).digest('base64url').slice(0, 22);

export function qrToken(secret: string, ticketId: string, now = Date.now()) {
  const window = Math.floor(now / QR_WINDOW_MS);
  return {
    token: `${ticketId}.${window}.${sign(secret, ticketId, window)}`,
    expiresInMs: QR_WINDOW_MS - (now % QR_WINDOW_MS),
  };
}

export type QrCheck = { ok: true; ticketId: string } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

/** Accepts the current window and one either side (clock skew, slow scanners). */
export function verifyQr(secret: string, token: string, now = Date.now()): QrCheck {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [ticketId, w, sig] = parts;
  const window = Number(w);
  if (!ticketId || !Number.isInteger(window)) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(secret, ticketId, window));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad-signature' };
  const current = Math.floor(now / QR_WINDOW_MS);
  if (Math.abs(current - window) > 1) return { ok: false, reason: 'expired' };
  return { ok: true, ticketId };
}
