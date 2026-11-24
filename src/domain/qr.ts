import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rotating ticket codes. The QR shown in the app encodes `ticketId.window.signature`,
 * where `window` changes every 15 seconds. Screenshots stop scanning after ~30 seconds.
 *
 * Each ticket has its own seed, derived from the server secret and the ticket's `qrVersion`:
 *
 *   seed      = HMAC-SHA256(key = TICKET_QR_SECRET, message = "seed.<ticketId>.<qrVersion>")   (32 bytes)
 *   window    = floor(unixTimeMs / 15000)
 *   signature = first 22 characters of base64url(HMAC-SHA256(key = seed, message = "<ticketId>.<window>"))
 *   code      = "<ticketId>.<window>.<signature>"
 *
 * The server's `GET /tickets/:id/qr` and the phone's offline generator (which only knows the seed, never the
 * secret) produce the same code. When a ticket changes hands its `qrVersion` goes up, so its seed changes and
 * codes made from the old seed are refused.
 */

export const QR_WINDOW_MS = 15_000;
export const QR_SIG_LENGTH = 22;

/** The per-ticket seed (32 raw bytes). Send it to the holder's phone as base64url. */
export const qrSeed = (secret: string, ticketId: string, version = 0) => createHmac('sha256', secret).update(`seed.${ticketId}.${version}`).digest();

/** The signature for one window, from a ticket's seed. */
export const qrSignature = (seed: Buffer, ticketId: string, window: number) =>
  createHmac('sha256', seed).update(`${ticketId}.${window}`).digest('base64url').slice(0, QR_SIG_LENGTH);

/** The code for a ticket at `now`, made from its seed (what the phone does offline). */
export function qrTokenFromSeed(seed: Buffer, ticketId: string, now = Date.now()) {
  const window = Math.floor(now / QR_WINDOW_MS);
  return {
    token: `${ticketId}.${window}.${qrSignature(seed, ticketId, window)}`,
    expiresInMs: QR_WINDOW_MS - (now % QR_WINDOW_MS),
  };
}

export function qrToken(secret: string, ticketId: string, now = Date.now(), version = 0) {
  return qrTokenFromSeed(qrSeed(secret, ticketId, version), ticketId, now);
}

export type QrParse = { ok: true; ticketId: string; window: number; sig: string } | { ok: false; reason: 'malformed' };

/** Splits a scanned code without checking it, so the ticket (and its qrVersion) can be looked up first. */
export function parseQr(token: string): QrParse {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [ticketId, w, sig] = parts;
  const window = Number(w);
  if (!ticketId || !w || !Number.isInteger(window) || !sig) return { ok: false, reason: 'malformed' };
  return { ok: true, ticketId, window, sig };
}

export type QrCheck = { ok: true; ticketId: string } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

/**
 * Accepts the current window and one either side (clock skew, slow scanners). `version` is the ticket's
 * qrVersion: a code made from an older seed fails as a bad signature.
 */
export function verifyQr(secret: string, token: string, now = Date.now(), version = 0): QrCheck {
  const p = parseQr(token);
  if (!p.ok) return p;
  const expected = Buffer.from(qrSignature(qrSeed(secret, p.ticketId, version), p.ticketId, p.window));
  const given = Buffer.from(p.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad-signature' };
  const current = Math.floor(now / QR_WINDOW_MS);
  if (Math.abs(current - p.window) > 1) return { ok: false, reason: 'expired' };
  return { ok: true, ticketId: p.ticketId };
}
