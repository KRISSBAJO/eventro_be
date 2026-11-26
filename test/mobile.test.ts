/**
 * The mobile app's API: long-lived device sign-ins (refresh tokens), push notifications (against a stand-in Expo
 * push service; nothing real is sent), offline QR seeds, door packs and offline check-in sync.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

const EXPO_KEY = `expo_test_${'k'.repeat(20)}`;
let expo: Server;
/** every push the stand-in accepted or refused */
const pushes: { to: string; title: string; body: string; data: Json }[] = [];
const receiptToken = new Map<string, string>();
let badAuth = 0;

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const PASSWORD = 'test-password-123';
const PHONE = { name: 'Test Phone', platform: 'ios' };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed as Json, headers: res.headers };
}
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const account = async (email: string, name: string) => {
  const s = await call('POST', '/auth/signup', { email, name, password: PASSWORD });
  if (s.status < 300) return s.body as { token: string; user: Json };
  return (await ok(call('POST', '/auth/login', { email, password: PASSWORD }))) as { token: string; user: Json };
};
/** A device sign-in (creates the account first if needed). */
const phone = async (email: string, name: string, device: Json = PHONE) => {
  await account(email, name);
  return (await ok(call('POST', '/auth/login', { email, password: PASSWORD, device }))) as Json;
};
/** Background sends finish shortly after the request that started them. */
async function waitFor<T>(fn: () => T | undefined | null | Promise<T | undefined | null>, ms = 4000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) as { sub: string; iat: number; exp: number; sid?: string };
const expoToken = (label: string) => `ExponentPushToken[${label}${run}abcdef]`;
const pushesTo = (token: string) => pushes.filter((p) => p.to === token);
/** The documented offline algorithm, written out independently of src/domain/qr.ts. */
const codeFromSeed = (seedB64: string, ticketId: string, window: number) =>
  `${ticketId}.${window}.${createHmac('sha256', Buffer.from(seedB64, 'base64url')).update(`${ticketId}.${window}`).digest('base64url').slice(0, 22)}`;
const windowNow = () => Math.floor(Date.now() / 15_000);

before(async () => {
  expo = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${EXPO_KEY}`) {
        badAuth++;
        res.writeHead(401);
        return res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'bad access token' }] }));
      }
      const body = JSON.parse(raw);
      if (req.url === '/send') {
        const data = (body as Json[]).map((m) => {
          pushes.push({ to: m.to, title: m.title, body: m.body, data: m.data });
          if (String(m.to).includes('Gone')) return { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } };
          const id = `rcpt-${pushes.length}`;
          receiptToken.set(id, m.to);
          return { status: 'ok', id };
        });
        return res.end(JSON.stringify({ data }));
      }
      if (req.url === '/getReceipts') {
        const data: Json = {};
        for (const id of body.ids as string[]) {
          const to = receiptToken.get(id) ?? '';
          data[id] = to.includes('Later') ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' };
        }
        return res.end(JSON.stringify({ data }));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'no' }] }));
    });
  });
  await new Promise<void>((r) => expo.listen(0, '127.0.0.1', r));
  process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;
  process.env.EXPO_ACCESS_TOKEN = EXPO_KEY;

  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
  expo?.close();
});

/** A published event in Austin with one $50 (all-in) ticket type, 30 days out. */
async function publishedEvent(orgToken: string, adminToken: string, name: string, extra: Json = {}) {
  const o = await ok(call('POST', '/organizer/orgs', { name: `${name} ${run}` }, orgToken));
  const startsAt = new Date(Date.now() + 30 * 86_400_000);
  startsAt.setUTCHours(20, 0, 0, 0);
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `${name} Night ${run}`,
        category: 'COMEDY',
        startsAt: startsAt.toISOString(),
        venue: { name: 'Cap City Room', address: '1 Congress Ave', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
        ticketTypes: [{ name: 'General', basePriceCents: 4830, capacity: 100 }],
        ...extra,
      },
      orgToken,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, orgToken));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, adminToken));
  return { org: o, ev, tt: ev.ticketTypes[0] as Json };
}

async function buy(ticketTypeId: string, quantity: number, email: string, name: string, token?: string, gift?: Json) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity }, token));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email, name, ...(gift ? { gift } : {}) }, token));
  return ok(call('POST', `/orders/${order.orderId}/pay`));
}

/* ---------- QR seeds (unit) ---------- */

test('qr seeds: a code made from the seed matches the server; a new version refuses old codes', async () => {
  const { qrSeed, qrToken, qrTokenFromSeed, verifyQr, QR_WINDOW_MS } = await import('../src/domain/qr');
  const secret = 's'.repeat(40);
  const id = 'EVT-AAAA-BBBB-01';
  const t0 = 1_700_000_000_000;
  const seed = qrSeed(secret, id, 0);
  assert.equal(seed.length, 32);
  const server = qrToken(secret, id, t0);
  assert.equal(qrTokenFromSeed(seed, id, t0).token, server.token);
  // The README's spec, implemented separately, gives the same code.
  assert.equal(codeFromSeed(seed.toString('base64url'), id, Math.floor(t0 / QR_WINDOW_MS)), server.token);
  assert.equal(verifyQr(secret, server.token, t0 + QR_WINDOW_MS).ok, true);
  // After a change of hands (version 1) the old code fails and the new seed's code works.
  assert.deepEqual(verifyQr(secret, server.token, t0, 1), { ok: false, reason: 'bad-signature' });
  const v1 = qrToken(secret, id, t0, 1).token;
  assert.notEqual(v1, server.token);
  assert.deepEqual(verifyQr(secret, v1, t0, 1), { ok: true, ticketId: id });
  assert.deepEqual(verifyQr(secret, v1, t0, 0), { ok: false, reason: 'bad-signature' });
});

test('wall-clock event times convert to the real moment in the venue zone', async () => {
  const { wallClockToInstant } = await import('../src/domain/wallclock');
  // 20:00 in Chicago in January is 02:00Z the next day (UTC−6); in July 01:00Z (UTC−5).
  assert.equal(wallClockToInstant(new Date('2027-01-15T20:00:00Z'), 'America/Chicago').toISOString(), '2027-01-16T02:00:00.000Z');
  assert.equal(wallClockToInstant(new Date('2027-07-15T20:00:00Z'), 'America/Chicago').toISOString(), '2027-07-16T01:00:00.000Z');
  assert.equal(wallClockToInstant(new Date('2027-07-15T20:00:00Z'), 'Africa/Lagos').toISOString(), '2027-07-15T19:00:00.000Z');
  assert.equal(wallClockToInstant(new Date('2027-07-15T20:00:00Z'), 'UTC').toISOString(), '2027-07-15T20:00:00.000Z');
});

/* ---------- sessions ---------- */

test('device sign-in: refresh tokens rotate, a reused token ends the session, website sign-in is unchanged', async () => {
  const email = `sess-${run}@test.local`;
  await account(email, 'Sade Session');

  // Website: no device, no refresh token, 7-day token without a session.
  const web = await ok(call('POST', '/auth/login', { email, password: PASSWORD }));
  assert.equal(web.refreshToken, undefined);
  const wp = jwtPayload(web.token);
  assert.equal(wp.sid, undefined);
  assert.equal(wp.exp - wp.iat, 7 * 86_400);

  // Phone: refresh token `<sessionId>.<43 chars>`, 1-hour access token bound to the session.
  const a = await ok(call('POST', '/auth/login', { email, password: PASSWORD, device: PHONE }));
  assert.ok(a.token && a.user.email === email);
  assert.match(a.refreshToken, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(a.refreshToken.split('.')[0], a.sessionId);
  const ap = jwtPayload(a.token);
  assert.equal(ap.sid, a.sessionId);
  assert.equal(ap.exp - ap.iat, 3600);
  assert.ok(new Date(a.refreshTokenExpiresAt).getTime() > Date.now() + 59 * 86_400_000);
  assert.equal((await ok(call('GET', '/auth/me', undefined, a.token))).email, email);
  // Only a hash is stored.
  const row = await prisma.session.findUniqueOrThrow({ where: { id: a.sessionId } });
  assert.equal(row.tokenHash, createHash('sha256').update(a.refreshToken).digest('hex'));
  assert.equal(row.deviceName, 'Test Phone');
  assert.equal(row.platform, 'ios');

  const list = await ok(call('GET', '/me/sessions', undefined, a.token));
  const mine = list.sessions.find((s: Json) => s.id === a.sessionId);
  assert.equal(mine.current, true);
  assert.equal(mine.deviceName, 'Test Phone');

  // Rotate: a new refresh token, same session, the new access token works.
  const r1 = await ok(call('POST', '/auth/refresh', { refreshToken: a.refreshToken }));
  assert.notEqual(r1.refreshToken, a.refreshToken);
  assert.equal(r1.sessionId, a.sessionId);
  assert.equal((await ok(call('GET', '/auth/me', undefined, r1.token))).email, email);
  assert.ok((await prisma.session.findUniqueOrThrow({ where: { id: a.sessionId } })).lastUsedAt >= row.lastUsedAt);

  // The old token again: someone copied it. The session ends for everyone.
  const reuse = await call('POST', '/auth/refresh', { refreshToken: a.refreshToken });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.code, 'REFRESH_REUSED');
  const after = await call('POST', '/auth/refresh', { refreshToken: r1.refreshToken });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'REFRESH_REVOKED');
  assert.equal((await call('GET', '/auth/me', undefined, r1.token)).status, 401, 'its access token stops working too');
  // The website sign-in is untouched.
  assert.equal((await call('GET', '/auth/me', undefined, web.token)).status, 200);

  // Made-up and expired tokens.
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: 'x'.repeat(60) })).body.code, 'REFRESH_INVALID');
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: `${a.sessionId}.${'y'.repeat(43)}` })).status, 401);
  const b = await phone(email, 'Sade Session');
  await prisma.session.update({ where: { id: b.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call('POST', '/auth/refresh', { refreshToken: b.refreshToken });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, 'REFRESH_EXPIRED');

  // Sign-up from the phone works the same way.
  const fresh = await ok(call('POST', '/auth/signup', { email: `sess-new-${run}@test.local`, name: 'New Phone', password: PASSWORD, device: { platform: 'android' } }));
  assert.ok(fresh.refreshToken && fresh.sessionId);
  // A bad device field is refused like any other bad input.
  assert.equal((await call('POST', '/auth/login', { email, password: PASSWORD, device: { name: 'x', imei: '1' } })).status, 400);
});

test('signed-in devices: sign one out, logout stops its pushes, password changes and suspension end sessions', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const email = `dev-${run}@test.local`;
  const p1 = await phone(email, 'Dee Devices', { name: 'Phone A', platform: 'ios' });
  const p2 = await phone(email, 'Dee Devices', { name: 'Phone B', platform: 'android' });
  const web = await account(email, 'Dee Devices');

  const fromA = await ok(call('GET', '/me/sessions', undefined, p1.token));
  assert.deepEqual(fromA.sessions.filter((s: Json) => [p1.sessionId, p2.sessionId].includes(s.id)).map((s: Json) => [s.deviceName, s.current]).sort(), [
    ['Phone A', true],
    ['Phone B', false],
  ]);
  assert.ok((await ok(call('GET', '/me/sessions', undefined, web.token))).sessions.every((s: Json) => !s.current), 'website tokens are no device');

  // Phone A signs out Phone B.
  assert.equal((await ok(call('DELETE', `/me/sessions/${p2.sessionId}`, undefined, p1.token))).revoked, true);
  assert.equal((await call('GET', '/auth/me', undefined, p2.token)).status, 401);
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: p2.refreshToken })).body.code, 'REFRESH_REVOKED');
  assert.equal((await call('DELETE', `/me/sessions/${p2.sessionId}`, undefined, p1.token)).status, 404);
  const other = await phone(`dev-other-${run}@test.local`, 'Otto Other');
  assert.equal((await call('DELETE', `/me/sessions/${other.sessionId}`, undefined, p1.token)).status, 404, 'not someone else’s');

  // Logout on Phone A, with its push token: no more sign-in, no more notifications there.
  const token = expoToken('Logout');
  await ok(call('POST', '/me/push-devices', { token, platform: 'ios' }, p1.token));
  assert.equal((await ok(call('POST', '/auth/logout', { refreshToken: p1.refreshToken, pushToken: token }))).ok, true);
  assert.ok((await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).disabledAt);
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: p1.refreshToken })).status, 401);
  assert.equal((await ok(call('POST', '/auth/logout', { refreshToken: p1.refreshToken }))).ok, true, 'logging out twice is fine');

  // Changing the password on a phone keeps that phone signed in and ends every other sign-in.
  const c1 = await phone(email, 'Dee Devices', { name: 'Phone C' });
  const c2 = await phone(email, 'Dee Devices', { name: 'Phone D' });
  const changed = await ok(call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'another-password-456' }, c1.token));
  assert.equal(changed.sessionId, c1.sessionId);
  assert.equal(jwtPayload(changed.token).sid, c1.sessionId);
  assert.equal((await call('GET', '/auth/me', undefined, changed.token)).status, 200);
  const c1r = await ok(call('POST', '/auth/refresh', { refreshToken: c1.refreshToken }));
  assert.equal((await call('GET', '/auth/me', undefined, c1r.token)).status, 200);
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: c2.refreshToken })).body.code, 'REFRESH_REVOKED');
  assert.equal((await call('GET', '/auth/me', undefined, web.token)).status, 401, 'the website sign-in ended (as before)');

  // A password reset ends every session, and can start one for the phone.
  const resetToken = `reset-${run}-${'r'.repeat(30)}`;
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.passwordReset.create({ data: { userId: u.id, tokenHash: createHash('sha256').update(resetToken).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  const reset = await ok(call('POST', '/auth/reset', { token: resetToken, password: PASSWORD, device: { name: 'Phone E' } }));
  assert.ok(reset.refreshToken);
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: c1r.refreshToken })).body.code, 'REFRESH_REVOKED');
  const e1 = await ok(call('POST', '/auth/refresh', { refreshToken: reset.refreshToken }));

  // Suspension ends the phone's sign-in too.
  await ok(call('PATCH', `/admin/users/${u.id}`, { suspended: true, reason: 'Testing device sign-out' }, admin.token));
  assert.equal((await call('POST', '/auth/refresh', { refreshToken: e1.refreshToken })).status, 401);
  await ok(call('PATCH', `/admin/users/${u.id}`, { suspended: false }, admin.token));
});

test('refresh is rate limited per IP', async () => {
  const { rateLimiter } = await import('../src/common/rate-limit');
  const saved = process.env.RATE_REFRESH_PER_IP;
  try {
    rateLimiter.reset();
    process.env.RATE_REFRESH_PER_IP = '2';
    const bad = { refreshToken: 'z'.repeat(60) };
    assert.equal((await call('POST', '/auth/refresh', bad)).status, 401);
    assert.equal((await call('POST', '/auth/refresh', bad)).status, 401);
    const limited = await call('POST', '/auth/refresh', bad);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    process.env.RATE_REFRESH_PER_IP = saved;
    rateLimiter.reset();
  }
});

/* ---------- push ---------- */

test('push devices and notification choices', async () => {
  const a = await phone(`pd-a-${run}@test.local`, 'Ada Push');
  const b = await phone(`pd-b-${run}@test.local`, 'Ben Push');
  assert.equal((await call('POST', '/me/push-devices', { token: 'not-a-token' }, a.token)).status, 400);
  assert.equal((await call('POST', '/me/push-devices', { token: expoToken('A') })).status, 401);
  const token = expoToken('Shared');
  const d = await ok(call('POST', '/me/push-devices', { token, platform: 'iOS', deviceName: 'Ada’s phone' }, a.token));
  assert.equal(d.token, token);
  assert.equal(d.platform, 'ios');
  await ok(call('POST', '/me/push-devices', { token: `ExpoPushToken[${run}zzzzzzzz]` }, a.token)); // the newer prefix works too
  // The same phone signed in as someone else moves to them.
  await ok(call('POST', '/me/push-devices', { token }, b.token));
  assert.equal((await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).userId, b.user.id);
  assert.equal((await ok(call('DELETE', `/me/push-devices/${encodeURIComponent(token)}`, undefined, a.token))).removed, false, 'not Ada’s any more');
  assert.equal((await ok(call('DELETE', `/me/push-devices/${encodeURIComponent(token)}`, undefined, b.token))).removed, true);
  assert.ok((await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).disabledAt);
  // Registering again turns it back on.
  await ok(call('POST', '/me/push-devices', { token }, b.token));
  assert.equal((await prisma.pushDevice.findUniqueOrThrow({ where: { token } })).disabledAt, null);

  assert.deepEqual(await ok(call('GET', '/me/notify-prefs', undefined, a.token)), { orders: true, tickets: true, priceDrops: true, reminders: true, marketing: false, sales: true, following: true });
  assert.deepEqual(await ok(call('PATCH', '/me/notify-prefs', { marketing: true, priceDrops: false }, a.token)), { orders: true, tickets: true, priceDrops: false, reminders: true, marketing: true, sales: true, following: true });
  assert.deepEqual(await ok(call('PATCH', '/me/notify-prefs', { marketing: false }, a.token)), { orders: true, tickets: true, priceDrops: false, reminders: true, marketing: false, sales: true, following: true });
  assert.equal((await call('PATCH', '/me/notify-prefs', { orders: 'yes' }, a.token)).status, 400);
  assert.equal((await call('PATCH', '/me/notify-prefs', { sms: true }, a.token)).status, 400);
});

test('push: order paid, transfer sent and accepted, with deep links; switched-off kinds skipped; dead phones disabled', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pu-org-${run}@test.local`, 'Paula Organizer');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Push Party');
  const buyerEmail = `pu-buyer-${run}@test.local`;
  const friendEmail = `pu-friend-${run}@test.local`;
  const buyer = await phone(buyerEmail, 'Bisi Buyer');
  const friend = await phone(friendEmail, 'Femi Friend');
  const tb = expoToken('Buyer');
  const gone = expoToken('BuyerGone');
  const tf = expoToken('Friend');
  await ok(call('POST', '/me/push-devices', { token: tb }, buyer.token));
  await ok(call('POST', '/me/push-devices', { token: gone }, buyer.token));
  await ok(call('POST', '/me/push-devices', { token: tf }, friend.token));

  const paid = await buy(tt.id, 2, buyerEmail, 'Bisi Buyer', buyer.token);
  const first = paid.tickets[0].id as string;
  const p = await waitFor(() => pushesTo(tb).find((x) => x.title === `You’re going to ${ev.title}`));
  assert.equal(p.data.url, `eventro://tickets/${first}`);
  assert.equal(p.data.path, `/tickets/${first}`);
  assert.match(p.body, /2 × General/);
  const log = await waitFor(() => prisma.notificationLog.findFirst({ where: { dedupeKey: `order.paid:${paid.id}`, status: { not: 'PENDING' } } }));
  assert.equal(log.status, 'SENT');
  assert.equal(log.userId, buyer.user.id);
  assert.equal(log.kind, 'order.paid');
  // The uninstalled phone got DeviceNotRegistered and is switched off; the access token went to Expo.
  await waitFor(async () => (await prisma.pushDevice.findUniqueOrThrow({ where: { token: gone } })).disabledAt);
  assert.equal(badAuth, 0);

  // Transfer: the recipient hears, then the sender hears it was accepted.
  await ok(call('POST', `/tickets/${first}/transfer`, { email: friendEmail }, buyer.token));
  const tp = await waitFor(() => pushesTo(tf).find((x) => x.data?.type === 'ticket.transfer' && x.data.ticketId === first));
  assert.equal(tp.title, 'Bisi sent you a ticket');
  assert.equal(tp.data.url, 'eventro://tickets');
  await ok(call('POST', `/tickets/${first}/accept`, undefined, friend.token));
  const ap = await waitFor(() => pushesTo(tb).find((x) => x.data?.type === 'ticket.accepted'));
  assert.equal(ap.title, 'Femi accepted your ticket');

  // Orders switched off: logged as SKIPPED, nothing sent.
  await ok(call('PATCH', '/me/notify-prefs', { orders: false }, buyer.token));
  const before = pushesTo(tb).length;
  const second = await buy(tt.id, 1, buyerEmail, 'Bisi Buyer', buyer.token);
  const skipped = await waitFor(() => prisma.notificationLog.findFirst({ where: { dedupeKey: `order.paid:${second.id}`, status: { not: 'PENDING' } } }));
  assert.equal(skipped.status, 'SKIPPED');
  assert.match(skipped.error ?? '', /orders/);
  assert.equal(pushesTo(tb).length, before);
  // No phones: SKIPPED too. Guests (no account) get nothing and nothing is logged.
  const quiet = await account(`pu-quiet-${run}@test.local`, 'Quinn Quiet');
  const third = await buy(tt.id, 1, `pu-quiet-${run}@test.local`, 'Quinn Quiet', quiet.token);
  assert.equal((await waitFor(() => prisma.notificationLog.findFirst({ where: { dedupeKey: `order.paid:${third.id}`, status: { not: 'PENDING' } } }))).error, 'No push devices');
  const guest = await buy(tt.id, 1, `pu-guest-${run}@example.com`, 'Gil Guest');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await prisma.notificationLog.count({ where: { dedupeKey: `order.paid:${guest.id}` } }), 0);

  // Expo receipts can report a dead phone later.
  const later = expoToken('FriendLater');
  await ok(call('POST', '/me/push-devices', { token: later }, friend.token));
  await ok(call('POST', `/tickets/${paid.tickets[1].id}/transfer`, { email: friendEmail }, buyer.token));
  await waitFor(() => pushesTo(later).length);
  const { PushService } = await import('../src/push/push.service');
  const push = app.get(PushService);
  const r = await push.checkReceipts();
  assert.ok(r.disabled >= 1);
  assert.ok((await prisma.pushDevice.findUniqueOrThrow({ where: { token: later } })).disabledAt);
  assert.equal((await prisma.pushDevice.findUniqueOrThrow({ where: { token: tf } })).disabledAt, null);

  // The same dedupe key never sends twice.
  const msg = { userId: friend.user.id, title: 'Hello', body: 'Once', dedupeKey: `test.once:${run}` };
  assert.equal((await push.send('test.once', 'tickets', [msg])).sent, 1);
  assert.deepEqual(await push.send('test.once', 'tickets', [msg, msg]), { sent: 0, failed: 0, skipped: 0, duplicate: 2 });
  assert.equal(pushesTo(tf).filter((x) => x.body === 'Once').length, 1);

  // Admins see the log next to emails.
  const adminLog = await ok(call('GET', `/admin/notifications?kind=order.paid&q=${encodeURIComponent(ev.title)}`, undefined, admin.token));
  assert.ok(adminLog.items.some((x: Json) => x.dedupeKey === `order.paid:${paid.id}`));
  assert.ok(adminLog.activeDevices >= 1);
  assert.equal((await call('GET', '/admin/notifications', undefined, buyer.token)).status, 403);
});

test('push: a new sale reaches the organization’s admins and managers (not door staff), unless they switch sales off', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const owner = await phone(`ns-owner-${run}@test.local`, 'Nora Owner');
  const manager = await phone(`ns-mgr-${run}@test.local`, 'Mo Manager');
  const door = await phone(`ns-door-${run}@test.local`, 'Dee Door');
  const { org: o, ev, tt } = await publishedEvent(owner.token, admin.token, 'Sale Push');
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `ns-mgr-${run}@test.local`, role: 'MANAGER' }, owner.token));
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `ns-door-${run}@test.local`, role: 'DOOR' }, owner.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, manager.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  const to = expoToken('SaleOwner');
  const tm = expoToken('SaleMgr');
  const td = expoToken('SaleDoor');
  await ok(call('POST', '/me/push-devices', { token: to }, owner.token));
  await ok(call('POST', '/me/push-devices', { token: tm }, manager.token));
  await ok(call('POST', '/me/push-devices', { token: td }, door.token));
  // Saved choices from before "sales" existed: the missing key counts as on.
  await prisma.user.update({ where: { id: owner.user.id }, data: { notifyPrefs: { orders: true, tickets: true, priceDrops: true, reminders: true, marketing: false } } });
  assert.equal((await ok(call('GET', '/me/notify-prefs', undefined, owner.token))).sales, true);

  const paid = await buy(tt.id, 2, `ns-fan-${run}@example.com`, 'Fola Fan');
  const p = await waitFor(() => pushesTo(to).find((x) => x.data?.type === 'order.sale' && x.data.orderId === paid.id));
  assert.equal(p.title, `New sale: ${ev.title}`);
  assert.equal(p.body, `2 × General · ${(await import('../src/mail/mail.module')).formatMoney(paid.totalCents, 'USD')}`);
  assert.equal(p.data.path, `/organizer/events/${ev.id}`);
  assert.equal(p.data.url, `eventro://organizer/events/${ev.id}`);
  await waitFor(() => pushesTo(tm).find((x) => x.data?.type === 'order.sale' && x.data.orderId === paid.id));
  const logs = await waitFor(async () => {
    const rows = await prisma.notificationLog.findMany({ where: { kind: 'order.sale', dedupeKey: { startsWith: `order.sale:${paid.id}:` }, status: { not: 'PENDING' } } });
    return rows.length === 2 ? rows : null;
  });
  assert.deepEqual(logs.map((l) => l.userId).sort(), [owner.user.id, manager.user.id].sort());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pushesTo(td).length, 0, 'door staff get no sales');

  // The manager switches sales off: logged as SKIPPED; the owner still hears.
  assert.equal((await ok(call('PATCH', '/me/notify-prefs', { sales: false }, manager.token))).sales, false);
  const second = await buy(tt.id, 1, `ns-fan-${run}@example.com`, 'Fola Fan');
  await waitFor(() => pushesTo(to).find((x) => x.data?.orderId === second.id));
  const skipped = await waitFor(() => prisma.notificationLog.findFirst({ where: { dedupeKey: `order.sale:${second.id}:${manager.user.id}`, status: { not: 'PENDING' } } }));
  assert.equal(skipped.status, 'SKIPPED');
  assert.match(skipped.error ?? '', /sales/);
  assert.equal(pushesTo(tm).filter((x) => x.data?.orderId === second.id).length, 0);
});

test('gifts: the recipient gets a push with the gift link; claiming changes the QR seed', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gp-org-${run}@test.local`, 'Gina Organizer');
  const { tt } = await publishedEvent(org.token, admin.token, 'Gift Push');
  const buyerEmail = `gp-buyer-${run}@test.local`;
  const friendEmail = `gp-friend-${run}@test.local`;
  const buyer = await phone(buyerEmail, 'Bayo Buyer');
  const friend = await phone(friendEmail, 'Funke Friend');
  const tf = expoToken('GiftFriend');
  await ok(call('POST', '/me/push-devices', { token: tf }, friend.token));

  const paid = await buy(tt.id, 1, buyerEmail, 'Bayo Buyer', buyer.token, { name: 'Funke', email: friendEmail });
  const gift = await prisma.gift.findUniqueOrThrow({ where: { orderId: paid.id } });
  const p = await waitFor(() => pushesTo(tf).find((x) => x.data?.type === 'gift.delivered'));
  assert.equal(p.data.url, `eventro://gift/${gift.token}`);
  assert.equal(p.title, '🎁 Bayo sent you tickets');
  // Held gift tickets have no seed for the buyer.
  assert.equal((await call('GET', `/tickets/${paid.tickets[0].id}/qr-seed`, undefined, buyer.token)).status, 400);

  await ok(call('POST', `/gifts/${gift.token}/claim`, undefined, friend.token));
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: paid.tickets[0].id } });
  assert.equal(t.qrVersion, 1);
  const seed = await ok(call('GET', `/tickets/${t.id}/qr-seed`, undefined, friend.token));
  assert.equal(seed.version, 1);
});

/* ---------- offline tickets ---------- */

test('offline QR: the seed reproduces the server code; a transfer changes it and old codes are refused', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`oq-org-${run}@test.local`, 'Ola Organizer');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Offline QR');
  const buyerEmail = `oq-buyer-${run}@test.local`;
  const friendEmail = `oq-friend-${run}@test.local`;
  const buyer = await phone(buyerEmail, 'Obi Buyer');
  const friend = await phone(friendEmail, 'Fola Friend');
  const paid = await buy(tt.id, 2, buyerEmail, 'Obi Buyer', buyer.token);
  const [a, b] = paid.tickets.map((t: Json) => t.id as string);

  // In the ticket list (ACTIVE tickets) and on its own route.
  const mine = await ok(call('GET', '/me/tickets', undefined, buyer.token));
  const listed = mine.tickets.find((t: Json) => t.id === a);
  assert.equal(listed.qrVersion, 0);
  const r = await call('GET', `/tickets/${a}/qr-seed`, undefined, buyer.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const s = r.body;
  assert.equal(listed.qrSeed, s.seed);
  assert.deepEqual([s.ticketId, s.version, s.windowMs, s.algorithm], [a, 0, 15000, 'HMAC-SHA256']);
  assert.match(s.format, /first 22 chars/);
  assert.equal(Buffer.from(s.seed, 'base64url').length, 32);
  // The phone's code equals the server's for the same window.
  const server = (await ok(call('GET', `/tickets/${a}/qr`, undefined, buyer.token))).token as string;
  const w = Number(server.split('.')[1]);
  assert.equal(codeFromSeed(s.seed, a, w), server);
  // Someone else's ticket: not found.
  assert.equal((await call('GET', `/tickets/${a}/qr-seed`, undefined, friend.token)).status, 404);

  // While a transfer is pending: no seed, not in the list either.
  const oldCode = codeFromSeed(s.seed, a, windowNow());
  await ok(call('POST', `/tickets/${a}/transfer`, { email: friendEmail }, buyer.token));
  assert.equal((await call('GET', `/tickets/${a}/qr-seed`, undefined, buyer.token)).status, 400);
  assert.equal((await ok(call('GET', '/me/tickets', undefined, buyer.token))).tickets.find((t: Json) => t.id === a).qrSeed, undefined);
  await ok(call('POST', `/tickets/${a}/accept`, undefined, friend.token));

  // New holder, new seed (version 1); the code the sender's phone makes from its saved seed is refused at the door.
  const s2 = await ok(call('GET', `/tickets/${a}/qr-seed`, undefined, friend.token));
  assert.equal(s2.version, 1);
  assert.notEqual(s2.seed, s.seed);
  const stale = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: codeFromSeed(s.seed, a, windowNow()) }, org.token));
  assert.equal(stale.result, 'invalid');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: oldCode }, org.token))).result, 'invalid');
  const good = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: codeFromSeed(s2.seed, a, windowNow()), deviceId: 'gate-1' }, org.token));
  assert.equal(good.result, 'ok');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: a } })).checkedInDevice, 'gate-1');
  // Used tickets have no seed.
  assert.equal((await call('GET', `/tickets/${a}/qr-seed`, undefined, friend.token)).status, 400);

  // Listed tickets have no seed.
  await ok(call('POST', `/tickets/${b}/listing`, { priceCents: 4000 }, buyer.token));
  assert.equal((await call('GET', `/tickets/${b}/qr-seed`, undefined, buyer.token)).status, 400);
  assert.equal((await ok(call('GET', '/me/tickets', undefined, buyer.token))).tickets.find((t: Json) => t.id === b).qrSeed, undefined);
});

test('door pack and offline check-in sync', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dp-org-${run}@test.local`, 'Dami Organizer');
  const door = await account(`dp-door-${run}@test.local`, 'Dayo Door');
  const fan = await phone(`dp-fan-${run}@test.local`, 'Fiyin Fan');
  const { org: o, ev, tt } = await publishedEvent(org.token, admin.token, 'Door Pack');
  const other = await publishedEvent(org.token, admin.token, 'Other Door');
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `dp-door-${run}@test.local`, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));

  const paid = await buy(tt.id, 5, `dp-fan-${run}@test.local`, 'Fiyin Fan', fan.token);
  const [t1, t2, t3, t4, t5] = paid.tickets.map((t: Json) => t.id as string);
  const x = (await buy(other.tt.id, 1, `dp-fan-${run}@test.local`, 'Fiyin Fan', fan.token)).tickets[0].id as string;
  await prisma.ticket.update({ where: { id: t5 }, data: { status: 'VOID' } });

  // Only the organization's members get the pack.
  assert.equal((await call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, fan.token)).status, 404);
  const r = await call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, door.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const pack = r.body;
  assert.equal(pack.eventId, ev.id);
  assert.equal(pack.windowMs, 15000);
  assert.ok(pack.generatedAt);
  assert.deepEqual(pack.tickets.map((t: Json) => t.id).sort(), [t1, t2, t3, t4].sort(), 'every ticket but the void one');
  const p1 = pack.tickets.find((t: Json) => t.id === t1);
  assert.equal(p1.seed, (await ok(call('GET', `/tickets/${t1}/qr-seed`, undefined, fan.token))).seed);
  assert.deepEqual([p1.version, p1.status, p1.holderName, p1.ticketType], [0, 'ACTIVE', 'Fiyin Fan', 'General']);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'door_pack.download', entityId: ev.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit?.actorId, door.user.id);
  assert.equal((audit?.data as Json).tickets, 4);

  // t3 was let in online at another gate first.
  await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: t3, deviceId: 'gate-online' }, org.token));

  const t0 = Date.now() - 10 * 60_000;
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const scans = [
    { ticketId: t1, scannedAt: at(30) }, // the same ticket again, later (sent first)
    { ticketId: t1, scannedAt: at(10) },
    { ticketId: t2.toLowerCase(), scannedAt: at(20), code: codeFromSeed(pack.tickets.find((t: Json) => t.id === t2).seed, t2, Math.floor((t0 + 20_000) / 15_000)) },
    { ticketId: t3, scannedAt: at(40) },
    { ticketId: 'EVT-NOPE-NOPE-99', scannedAt: at(50) },
    { ticketId: x, scannedAt: at(60) },
    { ticketId: t5, scannedAt: at(70) },
    // a code made from a wrong seed: refused, and the ticket stays usable
    { ticketId: t4, scannedAt: at(80), code: codeFromSeed(Buffer.alloc(32, 7).toString('base64url'), t4, Math.floor((t0 + 80_000) / 15_000)) },
  ];
  const res = await ok(call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-2', scans }, door.token));
  const by = (i: number) => res.results.find((x: Json) => x.index === i);
  assert.deepEqual(res.results.map((x: Json) => x.index), [1, 2, 0, 3, 4, 5, 6, 7], 'applied oldest first');
  assert.equal(by(1).result, 'checked_in');
  assert.equal(by(0).result, 'already');
  assert.equal(by(0).checkedInDevice, 'gate-2');
  assert.equal(new Date(by(0).checkedInAt).toISOString(), at(10));
  assert.equal(by(2).result, 'checked_in');
  assert.equal(by(3).result, 'already');
  assert.equal(by(3).checkedInDevice, 'gate-online');
  assert.equal(by(3).checkedInBy.name, 'Dami Organizer');
  assert.deepEqual([by(4).result, by(4).reason], ['invalid', 'unknown']);
  assert.deepEqual([by(5).result, by(5).reason], ['invalid', 'wrong-event']);
  assert.deepEqual([by(6).result, by(6).reason], ['invalid', 'void']);
  assert.deepEqual([by(7).result, by(7).reason], ['invalid', 'bad-code']);
  assert.deepEqual(res.summary, { checked_in: 2, already: 2, invalid: 4 });
  const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t1 } });
  assert.deepEqual([row.status, row.checkedInDevice, row.checkedInBy, row.checkedInAt?.toISOString()], ['CHECKED_IN', 'gate-2', door.user.id, at(10)]);
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: t4 } })).status, 'ACTIVE');

  // Sending the same batch again gives the same answers and changes nothing.
  const again = await ok(call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-2', scans }, door.token));
  assert.deepEqual(
    again.results.map((x: Json) => [x.index, x.result]),
    res.results.map((x: Json) => [x.index, x.result]),
  );
  assert.equal(again.results.find((x: Json) => x.index === 1).replay, true);
  // Another scanner uploading the same ticket later hears who let it in.
  const late = await ok(call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-3', scans: [{ ticketId: t1, scannedAt: at(5) }] }, door.token));
  assert.equal(late.results[0].result, 'already');
  assert.equal(late.results[0].checkedInDevice, 'gate-2');
  assert.equal(late.results[0].checkedInBy.name, 'Dayo Door');

  // Online check-in still works next to it, and the pack shows the new state.
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: t1 }, door.token))).result, 'duplicate');
  const pack2 = await ok(call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, door.token));
  assert.equal(pack2.tickets.find((t: Json) => t.id === t1).status, 'CHECKED_IN');

  // Limits and validation.
  const tooMany = Array.from({ length: 501 }, () => ({ ticketId: t4, scannedAt: at(1) }));
  assert.equal((await call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-2', scans: tooMany }, door.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-2', scans: [{ ticketId: t4, scannedAt: 'yesterday' }] }, door.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'gate-2', scans: [] }, fan.token)).status, 404);
});

test('reminders: the day before and when doors open, once each, to holders of active tickets', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rm-org-${run}@test.local`, 'Remi Organizer');
  const doorsWall = new Date(Date.now() + 30 * 86_400_000);
  doorsWall.setUTCHours(19, 0, 0, 0);
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Remind Me', { doorsAt: doorsWall.toISOString() });
  const holder = await phone(`rm-holder-${run}@test.local`, 'Hana Holder');
  const used = await phone(`rm-used-${run}@test.local`, 'Uche Used');
  const off = await phone(`rm-off-${run}@test.local`, 'Ofe Off');
  const [th, tu, to] = [expoToken('RemHolder'), expoToken('RemUsed'), expoToken('RemOff')];
  await ok(call('POST', '/me/push-devices', { token: th }, holder.token));
  await ok(call('POST', '/me/push-devices', { token: tu }, used.token));
  await ok(call('POST', '/me/push-devices', { token: to }, off.token));
  await ok(call('PATCH', '/me/notify-prefs', { reminders: false }, off.token));
  const ht = (await buy(tt.id, 2, `rm-holder-${run}@test.local`, 'Hana Holder', holder.token)).tickets[0].id as string;
  const ut = (await buy(tt.id, 1, `rm-used-${run}@test.local`, 'Uche Used', used.token)).tickets[0].id as string;
  await buy(tt.id, 1, `rm-off-${run}@test.local`, 'Ofe Off', off.token);
  await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ut }, org.token));

  const { NoticeService } = await import('../src/push/notices');
  const { wallClockToInstant } = await import('../src/domain/wallclock');
  const notices = app.get(NoticeService);
  const e = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(e.timezone, 'America/Chicago');
  const start = wallClockToInstant(e.startsAt, e.timezone).getTime();
  const doors = wallClockToInstant(e.doorsAt!, e.timezone).getTime();

  // Two days out: nothing yet.
  const reminders = (token: string) => pushesTo(token).filter((p) => String(p.data?.type).startsWith('reminder.') && p.data.eventId === ev.id);
  await notices.sendReminders(new Date(start - 48 * 3600_000));
  assert.equal(reminders(th).length, 0);

  // 22 hours before the real start (the stored time is Austin wall-clock).
  await notices.sendReminders(new Date(start - 22 * 3600_000));
  const day = await waitFor(() => pushesTo(th).find((p) => p.data?.type === 'reminder.day' && p.data.eventId === ev.id));
  assert.equal(day.title, `Tomorrow: ${ev.title}`);
  assert.equal(day.data.url, `eventro://tickets/${ht}`);
  assert.match(day.body, /8:00 PM · Cap City Room/);
  assert.equal(reminders(tu).length, 0, 'checked-in tickets get no reminder');
  assert.equal(reminders(to).length, 0);
  assert.equal((await prisma.notificationLog.findUniqueOrThrow({ where: { dedupeKey: `reminder.day:${ev.id}:${off.user.id}` } })).status, 'SKIPPED');
  // Running again (the timer runs every few minutes) sends nothing new.
  await notices.sendReminders(new Date(start - 21 * 3600_000));
  assert.equal(pushesTo(th).filter((p) => p.data?.type === 'reminder.day' && p.data.eventId === ev.id).length, 1);

  // Half an hour before doors.
  await notices.sendReminders(new Date(doors - 30 * 60_000));
  const soon = await waitFor(() => pushesTo(th).find((p) => p.data?.type === 'reminder.doors' && p.data.eventId === ev.id));
  assert.equal(soon.title, `Doors open soon: ${ev.title}`);
  assert.match(soon.body, /Doors at 7:00 PM/);
  await notices.sendReminders(new Date(doors - 10 * 60_000));
  assert.equal(pushesTo(th).filter((p) => p.data?.type === 'reminder.doors' && p.data.eventId === ev.id).length, 1);
});

test('price drop, resale sale and cancellation pushes', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pc-org-${run}@test.local`, 'Pemi Organizer');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Many Pushes');
  const watcher = await phone(`pc-watch-${run}@test.local`, 'Wale Watcher');
  const seller = await phone(`pc-seller-${run}@test.local`, 'Sola Seller');
  const buyer = await phone(`pc-buyer-${run}@test.local`, 'Bimpe Buyer');
  const [tw, ts, tb] = [expoToken('PcWatch'), expoToken('PcSeller'), expoToken('PcBuyer')];
  await ok(call('POST', '/me/push-devices', { token: tw }, watcher.token));
  await ok(call('POST', '/me/push-devices', { token: ts }, seller.token));
  await ok(call('POST', '/me/push-devices', { token: tb }, buyer.token));

  // Price drop to a signed-in watcher.
  await ok(call('POST', `/events/${ev.slug}/price-watch`, {}, watcher.token));
  await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${tt.id}`, { basePriceCents: 3864 }, org.token));
  const drop = await waitFor(() => pushesTo(tw).find((p) => p.data?.type === 'price_drop'));
  assert.equal(drop.title, `Price drop: ${ev.title}`);
  assert.equal(drop.data.url, `eventro://events/${ev.slug}`);
  assert.match(drop.body, /General is now \$\d+.*% off/);

  // Resale: the seller hears when it sells; the buyer gets "You're going".
  const sold = await buy(tt.id, 1, `pc-seller-${run}@test.local`, 'Sola Seller', seller.token);
  const listed = await ok(call('POST', `/tickets/${sold.tickets[0].id}/listing`, { priceCents: 4000 }, seller.token));
  const hold = await ok(call('POST', `/resale/${listed.listingId}/hold`, undefined, buyer.token));
  const ro = await ok(call('POST', `/resale/${listed.listingId}/orders`, { holdKey: hold.holdKey, email: `pc-buyer-${run}@test.local`, name: 'Bimpe Buyer' }, buyer.token));
  const done = await ok(call('POST', `/orders/${ro.orderId}/pay`));
  const sale = await waitFor(() => pushesTo(ts).find((p) => p.data?.type === 'resale.sold'));
  assert.equal(sale.title, 'Your ticket sold');
  assert.match(sale.body, /sold for \$40/);
  const going = await waitFor(() => pushesTo(tb).find((p) => p.data?.type === 'order.paid'));
  assert.equal(going.data.ticketId, done.tickets[0].id);

  // Cancelled: every holder with an account, once (a retry doesn't repeat it).
  await ok(call('POST', `/organizer/events/${ev.id}/cancel`, { reason: 'The venue flooded, sorry everyone.', confirmTitle: ev.title }, org.token));
  const cx = await waitFor(() => pushesTo(tb).find((p) => p.data?.type === 'event.cancelled'));
  assert.equal(cx.title, `Cancelled: ${ev.title}`);
  assert.equal(pushesTo(ts).filter((p) => p.data?.type === 'event.cancelled').length, 0, 'the seller no longer holds a ticket');
  assert.equal((await call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'Retrying the refunds for this one.' }, admin.token)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pushesTo(tb).filter((p) => p.data?.type === 'event.cancelled').length, 1);
});
