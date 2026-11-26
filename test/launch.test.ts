/**
 * Launch items: password reset and change, rate limiting, and cancelling a whole event with refunds.
 * Email goes to a stand-in Resend (nothing real is sent).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

const KEY = `re_test_${'k'.repeat(20)}`;
let resend: Server;
/** every message the stand-in accepted */
const outbox: { to: string; subject: string; html: string }[] = [];

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const PASSWORD = 'test-password-123';

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
/** Background sends finish shortly after the request that started them. */
async function waitFor<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const resetToken = (html: string) => /reset-password\?token=([A-Za-z0-9_-]+)/.exec(html)?.[1];

before(async () => {
  resend = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }));
      }
      const body = JSON.parse(raw);
      const list = Array.isArray(body) ? body : [body];
      for (const m of list) outbox.push({ to: m.to[0], subject: m.subject, html: m.html });
      res.writeHead(200, { 'content-type': 'application/json' });
      const ids = list.map((_: unknown, i: number) => ({ id: `email_${outbox.length}_${i}` }));
      res.end(JSON.stringify(req.url === '/emails/batch' ? { data: ids } : ids[0]));
    });
  });
  await new Promise<void>((r) => resend.listen(0, '127.0.0.1', r));
  process.env.RESEND_API_URL = `http://127.0.0.1:${(resend.address() as AddressInfo).port}`;
  process.env.RESEND_API_KEY = KEY;
  process.env.MAIL_FROM = 'Omoshow Test <hello@test.local>';

  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
  resend?.close();
});

/* ---------- password reset ---------- */

test('forgot password: same answer either way; one-time link that resets, signs in and signs out other sessions', async () => {
  const email = `reset-${run}@test.local`;
  const old = await account(email, 'Rhoda Reset');

  // Unknown and known emails get the identical answer; only the real account gets mail.
  const unknown = await ok(call('POST', '/auth/forgot', { email: `nobody-${run}@test.local` }));
  const known = await ok(call('POST', '/auth/forgot', { email: email.toUpperCase(), next: '/events/some-show' }));
  assert.deepEqual(unknown, known);
  const m = await waitFor(() => outbox.find((x) => x.to === email && /Reset your Omoshow password/.test(x.subject)));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(outbox.filter((x) => x.to === `nobody-${run}@test.local`).length, 0);
  const token = resetToken(m.html);
  assert.ok(token && token.length >= 40, 'link carries the token');
  assert.ok(m.html.includes('next=%2Fevents%2Fsome-show'), 'and where to go afterwards');

  // Only a hash is stored.
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const rows = await prisma.passwordReset.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tokenHash, token);
  assert.ok(rows[0].expiresAt.getTime() - Date.now() > 55 * 60_000 && rows[0].expiresAt.getTime() - Date.now() <= 60 * 60_000);

  // The link checks out, then resets. Weak passwords are refused first.
  assert.equal((await ok(call('POST', '/auth/reset/check', { token }))).email, email);
  assert.equal((await call('POST', '/auth/reset', { token, password: 'short' })).status, 400);
  const before = outbox.length;
  const s = await ok(call('POST', '/auth/reset', { token, password: 'brand-new-password-1' }));
  assert.equal(s.user.email, email);
  assert.ok(s.token);

  // The new session works straight away (same second as the change); the old one is signed out.
  assert.equal((await call('GET', '/auth/me', undefined, s.token)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, old.token)).status, 401);
  // Public routes still work with the stale token (it's just ignored).
  assert.equal((await call('GET', '/events', undefined, old.token)).status, 200);

  // Old password no longer works; the new one does, and that session works too.
  assert.equal((await call('POST', '/auth/login', { email, password: PASSWORD })).status, 401);
  const again = await ok(call('POST', '/auth/login', { email, password: 'brand-new-password-1' }));
  assert.equal((await call('GET', '/auth/me', undefined, again.token)).status, 200);

  // The link works once.
  const used = await call('POST', '/auth/reset', { token, password: 'another-password-2' });
  assert.equal(used.status, 400);
  assert.equal(used.body.code, 'RESET_USED');
  assert.equal((await call('POST', '/auth/reset/check', { token })).body.code, 'RESET_USED');

  // Audit + a "password changed" notice.
  const audit = await prisma.auditLog.findFirst({ where: { entityId: user.id, action: 'user.password_reset' } });
  assert.ok(audit);
  await waitFor(() => outbox.slice(before).find((x) => x.to === email && /password was changed/.test(x.subject)));
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { email } })).passwordChangedAt);
});

test('reset links: expired and made-up ones are refused; a new one replaces the old; 3 emails an hour per account', async () => {
  const email = `reset2-${run}@test.local`;
  await account(email, 'Remi Reset');
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  assert.equal((await call('POST', '/auth/reset', { token: 'x'.repeat(43), password: 'whatever-password' })).body.code, 'RESET_INVALID');

  await ok(call('POST', '/auth/forgot', { email }));
  const first = resetToken((await waitFor(() => outbox.find((x) => x.to === email))).html)!;
  await prisma.passwordReset.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call('POST', '/auth/reset', { token: first, password: 'whatever-password' });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.code, 'RESET_EXPIRED');

  // Two more requests: both sent (3 this hour), then a fourth is quietly not sent, with the same answer.
  await ok(call('POST', '/auth/forgot', { email }));
  await ok(call('POST', '/auth/forgot', { email }));
  await waitFor(() => (outbox.filter((x) => x.to === email).length >= 3 ? true : undefined));
  const fourth = await ok(call('POST', '/auth/forgot', { email }));
  assert.match(fourth.message, /If an account uses that email/);
  await new Promise((r) => setTimeout(r, 300));
  const mails = outbox.filter((x) => x.to === email);
  assert.equal(mails.length, 3);
  assert.equal(await prisma.passwordReset.count({ where: { userId: user.id } }), 3);

  // Using the newest link removes the other unused ones.
  const newest = resetToken(mails[2].html)!;
  await ok(call('POST', '/auth/reset', { token: newest, password: 'fresh-password-99' }));
  const second = resetToken(mails[1].html)!;
  assert.equal((await call('POST', '/auth/reset', { token: second, password: 'fresh-password-98' })).body.code, 'RESET_INVALID');
  assert.equal(await prisma.passwordReset.count({ where: { userId: user.id, usedAt: null } }), 0);

  // Suspended accounts get no link.
  const susp = `reset3-${run}@test.local`;
  await account(susp, 'Sam Suspended');
  await prisma.user.update({ where: { email: susp }, data: { suspendedAt: new Date() } });
  await ok(call('POST', '/auth/forgot', { email: susp }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outbox.filter((x) => x.to === susp).length, 0);
});

test('signed-in password change: needs the current password, keeps this session, ends the others', async () => {
  const email = `change-${run}@test.local`;
  const a = await account(email, 'Chi Change');
  const other = (await ok(call('POST', '/auth/login', { email, password: PASSWORD }))) as { token: string };

  assert.equal((await call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'changed-password-1' })).status, 401);
  assert.equal((await call('POST', '/auth/password', { currentPassword: 'wrong-password', newPassword: 'changed-password-1' }, a.token)).status, 400);
  assert.equal((await call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'short' }, a.token)).status, 400);
  assert.equal((await call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD }, a.token)).status, 400);

  const s = await ok(call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'changed-password-1' }, a.token));
  assert.equal((await call('GET', '/auth/me', undefined, s.token)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, a.token)).status, 401);
  assert.equal((await call('GET', '/auth/me', undefined, other.token)).status, 401);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'user.password_change', entityId: a.user.id } }));
  await waitFor(() => outbox.find((x) => x.to === email && /password was changed/.test(x.subject)));
});

/* ---------- rate limiting ---------- */

test('rate limiter: sliding window, all rules or none, and how long to wait', async () => {
  const { RateLimiter } = await import('../src/common/rate-limit');
  const l = new RateLimiter();
  const rule = (key: string, limit: number) => ({ key, limit, windowMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(l.take([rule('a', 2)], t0), null);
  assert.equal(l.take([rule('a', 2)], t0 + 10_000), null);
  assert.equal(l.take([rule('a', 2)], t0 + 20_000), 40_000, 'full: wait for the first hit to age out');
  // A refused request counts against no rule.
  assert.equal(l.take([rule('b', 5), rule('a', 2)], t0 + 20_000), 40_000);
  assert.equal(l.take([rule('b', 1)], t0 + 20_000), null, '"b" still has room');
  // Sliding: once the first hit is a minute old there is room for one more.
  assert.equal(l.take([rule('a', 2)], t0 + 60_001), null);
  assert.ok(l.take([rule('a', 2)], t0 + 60_002)! > 0);
});

test('429 with Retry-After when a limit is reached (forgot password and sign-in)', async () => {
  const { rateLimiter } = await import('../src/common/rate-limit');
  const saved = { forgot: process.env.RATE_FORGOT_PER_IP, login: process.env.RATE_LOGIN_PER_IP_EMAIL };
  try {
    rateLimiter.reset();
    process.env.RATE_FORGOT_PER_IP = '2';
    await ok(call('POST', '/auth/forgot', { email: `rl-${run}@test.local` }));
    await ok(call('POST', '/auth/forgot', { email: `rl2-${run}@test.local` }));
    const limited = await call('POST', '/auth/forgot', { email: `rl3-${run}@test.local` });
    assert.equal(limited.status, 429);
    assert.match(limited.body.message, /^Too many attempts\. Try again in 60 minutes\.$/);
    assert.equal(limited.headers.get('retry-after'), '3600');

    // Sign-in: per IP + email, so another email from the same place still gets through.
    process.env.RATE_LOGIN_PER_IP_EMAIL = '3';
    const email = `rl-login-${run}@test.local`;
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/auth/login', { email, password: 'wrong-password' })).status, 401);
    const blocked = await call('POST', '/auth/login', { email, password: 'wrong-password' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 800);
    assert.match(blocked.body.message, /Try again in 15 minutes/);
    assert.equal((await call('POST', '/auth/login', { email: `rl-other-${run}@test.local`, password: 'wrong-password' })).status, 401);
  } finally {
    process.env.RATE_FORGOT_PER_IP = saved.forgot;
    process.env.RATE_LOGIN_PER_IP_EMAIL = saved.login;
    rateLimiter.reset();
  }
});

/* ---------- cancelling an event ---------- */

/** A published event in Austin with one $50 (all-in) ticket type. */
async function publishedEvent(orgToken: string, adminToken: string, name: string) {
  const o = await ok(call('POST', '/organizer/orgs', { name: `${name} ${run}` }, orgToken));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `${name} Night ${run}`,
        category: 'COMEDY',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Cap City Room', address: '1 Congress Ave', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
        ticketTypes: [{ name: 'General', basePriceCents: 4830, capacity: 100 }],
      },
      orgToken,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, orgToken));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, adminToken));
  return { org: o, ev, tt: ev.ticketTypes[0] as Json };
}

async function buy(ticketTypeId: string, quantity: number, email: string, name: string, token?: string) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity }, token));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email, name }, token));
  return ok(call('POST', `/orders/${order.orderId}/pay`));
}

test('organizer cancels an event: everything refunded once, tickets void, buyers emailed, failures kept visible', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cx-org-${run}@test.local`, 'Cora Organizer');
  const manager = await account(`cx-mgr-${run}@test.local`, 'Max Manager');
  const fan = await account(`cx-fan-${run}@test.local`, 'Fiona Fan');
  const { org: o, ev, tt } = await publishedEvent(org.token, admin.token, 'Called Off');
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `cx-mgr-${run}@test.local`, role: 'MANAGER' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, manager.token));

  // Three paid orders (one partly refunded already), one resale purchase, an open hold and a pending order.
  const a = await buy(tt.id, 2, `cx-fan-${run}@test.local`, 'Fiona Fan', fan.token);
  const b = await buy(tt.id, 1, `cx-b-${run}@example.com`, 'Bo Buyer');
  const c = await buy(tt.id, 1, `cx-c-${run}@example.com`, 'Cy Buyer');
  await ok(call('POST', `/admin/orders/${c.id}/refund`, { amountCents: 1000, reason: 'Goodwill' }, admin.token));
  // Fiona lists one of her two tickets; Rae buys it.
  const listed = await ok(call('POST', `/tickets/${a.tickets[1].id}/listing`, { priceCents: 5000 }, fan.token));
  const rhold = await ok(call('POST', `/resale/${listed.listingId}/hold`));
  const ro = await ok(call('POST', `/resale/${listed.listingId}/orders`, { holdKey: rhold.holdKey, email: `cx-rae-${run}@example.com`, name: 'Rae Resale' }));
  await ok(call('POST', `/orders/${ro.orderId}/pay`));
  // and lists the other one, which nobody has bought yet
  const open = await ok(call('POST', `/tickets/${a.tickets[0].id}/listing`, { priceCents: 5200 }, fan.token));
  const openHold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }));
  const pendingHold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }));
  const pending = await ok(call('POST', '/orders', { holdId: pendingHold.id, email: `cx-late-${run}@example.com`, name: 'Lee Late' }));

  // Preview: 4 refundable orders.
  const preview = await ok(call('GET', `/organizer/events/${ev.id}/cancel-preview`, undefined, org.token));
  assert.equal(preview.paidOrders, 4);
  const owed = [a, b, c].reduce((s, x) => s + x.totalCents, 0) - 1000 + ro.totalCents;
  assert.deepEqual(preview.refundCents, [{ currency: 'USD', cents: owed }]);

  // Managers can't cancel; the title must match; the reason needs 10+ characters.
  const reason = 'The venue flooded and can’t reopen in time.';
  assert.equal((await call('POST', `/organizer/events/${ev.id}/cancel`, { reason, confirmTitle: ev.title }, manager.token)).status, 403);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/cancel`, { reason, confirmTitle: 'Wrong title' }, org.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/cancel`, { reason: 'Too short', confirmTitle: ev.title }, org.token)).status, 400);

  // One refund fails at the payment provider.
  const { Payments } = await import('../src/checkout/payments');
  const payments = app.get(Payments);
  const realByName = payments.byName.bind(payments);
  const badRef = (await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).paymentRef;
  payments.byName = (name: string) => {
    const p = realByName(name);
    return { name: p.name, createPayment: p.createPayment.bind(p), refund: async (ref: string, cents: number) => (ref === badRef ? Promise.reject(new Error('Card network unavailable')) : p.refund(ref, cents)) };
  };
  const sentBefore = outbox.length;
  let summary: Json;
  try {
    summary = await ok(call('POST', `/organizer/events/${ev.id}/cancel`, { reason, confirmTitle: `  ${ev.title} ` }, org.token));
  } finally {
    payments.byName = realByName;
  }
  assert.equal(summary.status, 'CANCELLED');
  assert.equal(summary.alreadyCancelled, false);
  assert.equal(summary.refunded, 3);
  assert.deepEqual(summary.failed, [{ orderId: b.id, message: 'Card network unavailable' }]);
  assert.deepEqual(summary.totalRefundedCents, { USD: owed - b.totalCents });
  assert.equal(summary.listingsCancelled, 1);
  assert.ok(summary.holdsReleased >= 2);

  const evNow = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(evNow.status, 'CANCELLED');
  assert.equal(evNow.cancelReason, reason);
  assert.ok(evNow.cancelledAt && evNow.salesPaused);
  const orders = await prisma.order.findMany({ where: { eventId: ev.id }, orderBy: { createdAt: 'asc' } });
  const byId = new Map(orders.map((x) => [x.id, x]));
  assert.equal(byId.get(a.id)!.status, 'REFUNDED');
  assert.equal(byId.get(c.id)!.status, 'REFUNDED');
  assert.equal(byId.get(c.id)!.refundedCents, c.totalCents);
  assert.equal(byId.get(ro.orderId)!.status, 'REFUNDED');
  assert.equal(byId.get(b.id)!.status, 'PAID', 'failed refund stays PAID for an admin to see');
  assert.equal(await prisma.ticket.count({ where: { eventId: ev.id, status: { not: 'VOID' } } }), 0);
  assert.equal((await prisma.resaleListing.findUniqueOrThrow({ where: { id: open.listingId } })).status, 'CANCELLED');
  assert.equal((await prisma.resaleListing.findUniqueOrThrow({ where: { id: listed.listingId } })).payoutStatus, 'HELD', 'resale payout held like an admin refund');
  assert.equal((await prisma.hold.findUniqueOrThrow({ where: { id: openHold.id } })).status, 'RELEASED');
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: ev.id, action: 'event.cancel' } });
  assert.deepEqual((audit.data as Json).failed, [{ orderId: b.id, message: 'Card network unavailable' }]);

  // One email per order: refunded ones say how much; the failed one that the refund is coming.
  const mails = await waitFor(() => {
    const m = outbox.slice(sentBefore).filter((x) => /^Cancelled:/.test(x.subject));
    return m.length >= 4 ? m : undefined;
  });
  assert.equal(mails.length, 4);
  const fionas = mails.filter((x) => x.to === `cx-fan-${run}@test.local`);
  assert.equal(fionas.length, 1);
  assert.match(fionas[0].html, /\$\d/);
  assert.ok(fionas[0].html.includes('5–10 business days') && fionas[0].html.includes('The venue flooded'));
  assert.match(mails.find((x) => x.to === `cx-b-${run}@example.com`)!.html, /being processed/);

  // Selling is over: no holds, and a payment that finishes now is refunded rather than ticketed.
  assert.equal((await call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 })).status, 400);
  const late = await call('POST', `/orders/${pending.orderId}/pay`);
  assert.equal(late.status, 409);
  assert.match(late.body.message, /cancelled/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: pending.orderId } })).status, 'CANCELLED');

  // Public page: still there, flagged cancelled, nothing on sale; not in search.
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(pub.status, 'CANCELLED');
  assert.equal(pub.cancelReason, reason);
  assert.ok(pub.ticketTypes.every((t: Json) => t.available === 0));
  assert.equal((await ok(call('GET', `/events?q=${encodeURIComponent(ev.title)}`))).total, 0);

  // My tickets shows the cancelled, refunded ticket.
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t = mine.tickets.find((x: Json) => x.id === a.tickets[0].id);
  assert.equal(t.status, 'VOID');
  assert.equal(t.event.status, 'CANCELLED');
  assert.equal(t.order.status, 'REFUNDED');

  // Again (by an Omoshow admin): only the failed refund is retried; nothing is refunded twice.
  const retry = await ok(call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'Retrying the failed refund' }, admin.token));
  assert.equal(retry.alreadyCancelled, true);
  assert.equal(retry.refunded, 1);
  assert.deepEqual(retry.failed, []);
  assert.deepEqual(retry.totalRefundedCents, { USD: b.totalCents });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status, 'REFUNDED');
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).cancelReason, reason, 'the first reason stays');
  const third = await ok(call('POST', `/organizer/events/${ev.id}/cancel`, { reason, confirmTitle: ev.title }, org.token));
  assert.equal(third.refunded, 0);
  assert.deepEqual(third.totalRefundedCents, {});
  const refundedTotal = (await prisma.order.findMany({ where: { eventId: ev.id } })).reduce((s, x) => s + x.refundedCents, 0);
  assert.equal(refundedTotal, [a, b, c].reduce((s, x) => s + x.totalCents, 0) + ro.totalCents);
});

test('admin cancel: needs ADMIN and a reason; drafts with no sales cancel cleanly', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cx2-org-${run}@test.local`, 'Dora Organizer');
  const { ev } = await publishedEvent(org.token, admin.token, 'Quiet One');
  assert.equal((await call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'Organizer asked us to' }, org.token)).status, 403);
  assert.equal((await call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'short' }, admin.token)).status, 400);
  const p = await ok(call('GET', `/admin/events/${ev.id}/cancel-preview`, undefined, admin.token));
  assert.equal(p.paidOrders, 0);
  const s = await ok(call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'Organizer asked us to cancel it' }, admin.token));
  assert.equal(s.refunded, 0);
  const list = await ok(call('GET', `/admin/events?q=${encodeURIComponent(ev.title)}`, undefined, admin.token));
  assert.equal(list.items[0].status, 'CANCELLED');
  assert.equal(list.items[0].cancelReason, 'Organizer asked us to cancel it');
  // Organizers can't resume sales on it.
  assert.equal((await call('POST', `/organizer/events/${ev.id}/resume`, undefined, org.token)).status, 400);
});

/* ---------- can't find my order ---------- */

test('can’t find my order: same answer either way; the list goes only to an email with orders, at most 3 an hour, 5 asks per IP', async () => {
  const { rateLimiter } = await import('../src/common/rate-limit');
  const saved = process.env.RATE_FIND_ORDERS_PER_IP;
  rateLimiter.reset();
  process.env.RATE_FIND_ORDERS_PER_IP = '50';
  try {
    const admin = await account('admin@test.local', 'Admin');
    const org = await account(`fo-org-${run}@test.local`, 'Finn Organizer');
    const { ev, tt } = await publishedEvent(org.token, admin.token, 'Lost Order');
    const guest = `fo-guest-${run}@example.com`;
    await buy(tt.id, 2, guest, 'Gail Guest');

    // Unknown and known emails get the identical answer; only the one with orders gets mail.
    const none = await ok(call('POST', '/orders/find', { email: `fo-nobody-${run}@example.com` }));
    const some = await ok(call('POST', '/orders/find', { email: guest.toUpperCase() }));
    assert.deepEqual(none, some);
    const m = await waitFor(() => outbox.find((x) => x.to === guest && x.subject === 'Your Omoshow orders'));
    assert.ok(m.html.includes(ev.title as string), 'lists the event');
    assert.match(m.html, /2 × General/);
    assert.ok(m.html.includes('/signin?next=%2Ftickets'), 'links to sign in');
    assert.match(m.html, /Sign up with this same email/, 'a guest is told to sign up with the same email');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(outbox.filter((x) => x.to === `fo-nobody-${run}@example.com`).length, 0);

    // With an account on that email, the email says to sign in.
    const fan = `fo-fan-${run}@test.local`;
    const f = await account(fan, 'Fola Fan');
    await buy(tt.id, 1, fan, 'Fola Fan', f.token);
    await ok(call('POST', '/orders/find', { email: fan }));
    assert.match((await waitFor(() => outbox.find((x) => x.to === fan && x.subject === 'Your Omoshow orders'))).html, /Sign in with this email/);

    // Two more for the guest: both sent (3 this hour), then a fourth is quietly not sent, with the same answer.
    await ok(call('POST', '/orders/find', { email: guest }));
    await ok(call('POST', '/orders/find', { email: guest }));
    await waitFor(() => (outbox.filter((x) => x.to === guest && x.subject === 'Your Omoshow orders').length >= 3 ? true : undefined));
    assert.deepEqual(await ok(call('POST', '/orders/find', { email: guest })), some);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(outbox.filter((x) => x.to === guest && x.subject === 'Your Omoshow orders').length, 3);

    assert.equal((await call('POST', '/orders/find', { email: 'not-an-email' })).status, 400);

    // The per-IP limit.
    rateLimiter.reset();
    process.env.RATE_FIND_ORDERS_PER_IP = '2';
    await ok(call('POST', '/orders/find', { email: `fo-x-${run}@example.com` }));
    await ok(call('POST', '/orders/find', { email: `fo-y-${run}@example.com` }));
    assert.equal((await call('POST', '/orders/find', { email: `fo-z-${run}@example.com` })).status, 429);
  } finally {
    process.env.RATE_FIND_ORDERS_PER_IP = saved;
    rateLimiter.reset();
  }
});

/* ---------- just announced ---------- */

test('just announced: approval stamps publishedAt once; sort=new lists the newest first', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`ja-org-${run}@test.local`, 'Jade Organizer');
  const older = await publishedEvent(org.token, admin.token, 'Announced First');
  const before = await prisma.event.findUniqueOrThrow({ where: { id: older.ev.id as string } });
  assert.ok(before.publishedAt, 'approval sets publishedAt');
  await new Promise((r) => setTimeout(r, 20));
  const newer = await publishedEvent(org.token, admin.token, 'Announced Second');

  const page = await ok(call('GET', '/events?sort=new&pageSize=100'));
  const slugs = (page.items as Json[]).map((e) => e.slug as string);
  assert.ok(slugs.indexOf(newer.ev.slug as string) < slugs.indexOf(older.ev.slug as string), 'newest first');
  const card = (page.items as Json[]).find((e) => e.slug === newer.ev.slug)!;
  assert.ok(card.publishedAt, 'cards carry publishedAt');

  // Organizers and admins see it too.
  const mine = (await ok(call('GET', `/organizer/orgs/${older.org.id}/events`, undefined, org.token))) as unknown as Json[];
  assert.ok(mine.find((e) => e.id === older.ev.id)?.publishedAt, 'organizer list has publishedAt');
  const adminList = await ok(call('GET', `/admin/events?q=${encodeURIComponent(older.ev.title as string)}`, undefined, admin.token));
  assert.ok((adminList.items as Json[])[0].publishedAt, 'admin list has publishedAt');

  // Taken down and published again from the admin console: the first date stays.
  await ok(call('POST', `/admin/events/${older.ev.id}/takedown`, { note: 'Checking the listing details' }, admin.token));
  await ok(call('POST', `/admin/events/${older.ev.id}/publish`, undefined, admin.token));
  const after = await prisma.event.findUniqueOrThrow({ where: { id: older.ev.id as string } });
  assert.equal(after.publishedAt?.getTime(), before.publishedAt!.getTime());
});

test('watching: price alerts in one list, with today’s price and whether it dropped since; stop from the list', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`wa-org-${run}@test.local`, 'Wura Organizer');
  const fanEmail = `wa-fan-${run}@test.local`;
  const fan = await account(fanEmail, 'Femi Watcher');
  const other = await account(`wa-other-${run}@test.local`, 'Ola Other');
  const a = await publishedEvent(org.token, admin.token, 'Watched One');
  const b = await publishedEvent(org.token, admin.token, 'Watched Two');

  assert.equal((await call('GET', '/me/watching')).status, 401, 'signed in only');
  const empty = await ok(call('GET', '/me/watching', undefined, fan.token));
  assert.deepEqual(empty.items, []);

  // Watched signed in, and (another event) as a guest with the same email: both are the fan's.
  await ok(call('POST', `/events/${a.ev.slug}/price-watch`, {}, fan.token));
  await new Promise((r) => setTimeout(r, 20));
  await ok(call('POST', `/events/${b.ev.slug}/price-watch`, { email: fanEmail.toUpperCase() }));
  let list = await ok(call('GET', '/me/watching', undefined, fan.token));
  assert.deepEqual(list.slugs, [b.ev.slug, a.ev.slug], 'newest watch first');
  const first = (list.items as Json[]).find((e) => e.slug === a.ev.slug)!;
  assert.ok((first.fromCents as number) > 0);
  assert.equal(first.startedFromCents, first.fromCents, 'starts at today’s price');
  assert.equal(first.dropped, false);
  assert.ok(first.watchingSince && first.title && first.currency, 'an event card plus when watching started');
  assert.deepEqual((await ok(call('GET', '/me/watching', undefined, other.token))).items, [], 'nobody else sees it');

  // The organizer cuts the price: the list says so.
  await ok(call('PATCH', `/organizer/events/${a.ev.id}/ticket-types/${a.tt.id}`, { basePriceCents: 3864 }, org.token));
  list = await ok(call('GET', '/me/watching', undefined, fan.token));
  const cut = (list.items as Json[]).find((e) => e.slug === a.ev.slug)!;
  assert.equal(cut.dropped, true);
  assert.ok((cut.fromCents as number) < (cut.startedFromCents as number));
  // Watching again while already watching keeps the starting price.
  await ok(call('POST', `/events/${a.ev.slug}/price-watch`, {}, fan.token));
  assert.equal(((await ok(call('GET', '/me/watching', undefined, fan.token))).items as Json[]).find((e) => e.slug === a.ev.slug)!.dropped, true);

  // Stop from the list (by slug or id; twice is fine): no more alerts for it, and the alert link agrees.
  assert.equal((await ok(call('DELETE', `/me/watching/${a.ev.slug}`, undefined, fan.token))).watching, false);
  await ok(call('DELETE', `/me/watching/${a.ev.id}`, undefined, fan.token));
  assert.deepEqual((await ok(call('GET', '/me/watching', undefined, fan.token))).slugs, [b.ev.slug]);
  const stopped = await prisma.priceWatch.findMany({ where: { eventId: a.ev.id as string } });
  assert.ok(stopped.length && stopped.every((w) => w.stoppedAt), 'every watch on it stopped');
  // Another fan can't stop someone else's watch.
  await ok(call('DELETE', `/me/watching/${b.ev.slug}`, undefined, other.token));
  assert.deepEqual((await ok(call('GET', '/me/watching', undefined, fan.token))).slugs, [b.ev.slug]);

  // Watching again later starts from the price then.
  await ok(call('POST', `/events/${a.ev.slug}/price-watch`, {}, fan.token));
  const again = ((await ok(call('GET', '/me/watching', undefined, fan.token))).items as Json[]).find((e) => e.slug === a.ev.slug)!;
  assert.equal(again.dropped, false);
  assert.equal(again.startedFromCents, again.fromCents);

  // Events that are no longer on sale drop off the list.
  await ok(call('POST', `/admin/events/${b.ev.id}/takedown`, { note: 'Checking the listing details' }, admin.token));
  assert.deepEqual((await ok(call('GET', '/me/watching', undefined, fan.token))).slugs, [a.ev.slug]);
});

test('following: organizer pages, follow organizers and venues, their new events in one list and a push when one goes on sale', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`fo-org-${run}@test.local`, 'Funmi Organizer');
  const fan = await account(`fo-fan-${run}@test.local`, 'Fola Follower');
  const other = await account(`fo-other-${run}@test.local`, 'Ola Other');
  const a = await publishedEvent(org.token, admin.token, 'Followed');
  const page = await ok(call('GET', `/events/${a.ev.slug}`));
  const orgSlug = page.organizer.slug as string;
  const venueSlug = page.venue.slug as string;
  assert.ok(orgSlug && page.organizer.name === a.org.name, 'event pages link to the organizer');

  // The organizer's public page.
  const op = await ok(call('GET', `/organizers/${orgSlug}`));
  assert.equal(op.name, a.org.name);
  assert.equal(op.followers, 0);
  assert.deepEqual((op.events as Json[]).map((e) => e.slug), [a.ev.slug]);
  // An organizer with nothing on sale yet has no page.
  const fresh = await ok(call('POST', '/organizer/orgs', { name: `Quiet Org ${run}` }, org.token));
  assert.ok(fresh.slug);
  assert.equal((await call('GET', `/organizers/${fresh.slug}`)).status, 404);
  assert.equal((await call('PUT', `/me/following/organizers/${fresh.slug}`, undefined, fan.token)).status, 404);

  assert.equal((await call('GET', '/me/following')).status, 401, 'signed in only');
  assert.equal((await call('PUT', `/me/following/organizers/${orgSlug}`)).status, 401);
  assert.equal((await call('PUT', `/me/following/people/${orgSlug}`, undefined, fan.token)).status, 404);
  const none = await ok(call('GET', '/me/following', undefined, fan.token));
  assert.deepEqual([none.organizers, none.venues, none.events], [[], [], []]);

  // Follow the organizer (twice is fine) and the venue.
  assert.equal((await ok(call('PUT', `/me/following/organizers/${orgSlug}`, undefined, fan.token))).followers, 1);
  assert.equal((await ok(call('PUT', `/me/following/organizers/${orgSlug}`, undefined, fan.token))).followers, 1);
  assert.equal((await ok(call('GET', `/organizers/${orgSlug}`))).followers, 1);
  await ok(call('PUT', `/me/following/venues/${venueSlug}`, undefined, fan.token));
  assert.ok(((await ok(call('GET', `/venues/${venueSlug}`))).followers as number) >= 1, 'venue pages count followers');

  let f = await ok(call('GET', '/me/following', undefined, fan.token));
  assert.deepEqual((f.organizers as Json[]).map((o) => [o.slug, o.upcoming]), [[orgSlug, 1]]);
  assert.deepEqual((f.venues as Json[]).map((v) => v.slug), [venueSlug]);
  const mine = (f.events as Json[]).find((e) => e.slug === a.ev.slug)!;
  assert.deepEqual(mine.via, { kind: 'organizer', slug: orgSlug, name: a.org.name }, 'the organizer wins over the venue');
  assert.ok(mine.title && mine.fromCents, 'an event card');
  assert.deepEqual((await ok(call('GET', '/me/following', undefined, other.token))).organizers, [], 'nobody else sees it');

  // The organizer puts a new event on sale: followers get a push (once), others don't.
  const ev2 = await ok(
    call('POST', `/organizer/orgs/${a.org.id}/events`, {
      title: `Followed Encore ${run}`,
      category: 'COMEDY',
      startsAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
      venue: { name: `Encore Hall ${run}`, address: '9 Test Street', city: 'Austin', country: 'US', region: 'Texas' },
      ticketTypes: [{ name: 'General', basePriceCents: 2500, capacity: 50 }],
    }, org.token),
  );
  await ok(call('POST', `/organizer/events/${ev2.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev2.id}/approve`, undefined, admin.token));
  const key = `follow.new_event:${ev2.id}:${fan.user.id}`;
  let log = null;
  for (let i = 0; i < 80 && !log; i++) {
    log = await prisma.notificationLog.findFirst({ where: { dedupeKey: key, status: { not: 'PENDING' } } });
    if (!log) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(log, 'followers hear about it');
  assert.equal(log!.title, `New from ${a.org.name}`);
  assert.equal(log!.kind, 'follow.new_event');
  assert.equal(await prisma.notificationLog.count({ where: { dedupeKey: `follow.new_event:${ev2.id}:${other.user.id}` } }), 0);
  f = await ok(call('GET', '/me/following', undefined, fan.token));
  assert.equal((f.organizers as Json[])[0].upcoming, 2);
  assert.ok((f.events as Json[]).some((e) => e.slug === ev2.slug));

  // Unfollow the organizer: its event at the followed venue stays, now because of the venue; the other one goes.
  assert.equal((await ok(call('DELETE', `/me/following/organizers/${orgSlug}`, undefined, fan.token))).following, false);
  await ok(call('DELETE', `/me/following/organizers/${orgSlug}`, undefined, fan.token));
  await ok(call('DELETE', `/me/following/organizers/no-such-${run}`, undefined, fan.token));
  f = await ok(call('GET', '/me/following', undefined, fan.token));
  assert.deepEqual(f.organizers, []);
  assert.equal((f.events as Json[]).find((e) => e.slug === a.ev.slug)?.via.kind, 'venue');
  assert.ok(!(f.events as Json[]).some((e) => e.slug === ev2.slug));
  await ok(call('DELETE', `/me/following/venues/${venueSlug}`, undefined, fan.token));
  assert.deepEqual((await ok(call('GET', '/me/following', undefined, fan.token))).venues, []);
});

test('spotlight: Omoshow picks one event for the home page; otherwise the top seller with a photo; never a hidden one', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`sp-org-${run}@test.local`, 'Sola Spotlight');
  const fan = await account(`sp-fan-${run}@test.local`, 'Femi Fan');
  const a = await publishedEvent(org.token, admin.token, 'Spotlight One');
  const b = await publishedEvent(org.token, admin.token, 'Spotlight Two');
  for (const e of [a, b]) await prisma.event.update({ where: { id: e.ev.id as string }, data: { imageUrl: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=900' } });

  // Without a pick it's still something on sale (or nothing at all), never a pick.
  const auto = (await ok(call('GET', '/events/spotlight'))).spotlight;
  if (auto) assert.equal(auto.picked, false);

  assert.equal((await call('POST', `/admin/events/${a.ev.id}/spotlight`, { on: true }, fan.token)).status, 403, 'staff only');
  await ok(call('POST', `/admin/events/${a.ev.id}/spotlight`, { on: true }, admin.token));
  let s = (await ok(call('GET', '/events/spotlight'))).spotlight;
  assert.equal(s.slug, a.ev.slug);
  assert.equal(s.picked, true);
  assert.ok(s.title && s.fromCents && s.timezone && s.imageUrl, 'an event card with its zone and photo');
  assert.ok(Array.isArray(s.lineup) && typeof s.lineupMore === 'number');
  assert.equal((await ok(call('GET', '/admin/events?q=Spotlight One', undefined, admin.token))).items.find((e: Json) => e.id === a.ev.id).spotlight, true);

  // One at a time: picking another replaces it.
  await ok(call('POST', `/admin/events/${b.ev.id}/spotlight`, { on: true }, admin.token));
  assert.equal((await ok(call('GET', '/events/spotlight'))).spotlight.slug, b.ev.slug);
  assert.equal((await prisma.event.findUnique({ where: { id: a.ev.id as string } }))!.spotlightAt, null);

  // Paused or taken down, the pick isn't shown; and only live, public events with a photo can be picked.
  await ok(call('POST', `/admin/events/${b.ev.id}/sales`, { paused: true }, admin.token));
  assert.notEqual((await ok(call('GET', '/events/spotlight'))).spotlight?.slug, b.ev.slug);
  await ok(call('POST', `/admin/events/${b.ev.id}/sales`, { paused: false }, admin.token));
  assert.equal((await ok(call('GET', '/events/spotlight'))).spotlight.slug, b.ev.slug);
  await ok(call('POST', `/admin/events/${b.ev.id}/takedown`, { note: 'Checking the listing details' }, admin.token));
  assert.notEqual((await ok(call('GET', '/events/spotlight'))).spotlight?.slug, b.ev.slug);
  assert.equal((await call('POST', `/admin/events/${b.ev.id}/spotlight`, { on: true }, admin.token)).status, 400);
  await prisma.event.update({ where: { id: a.ev.id as string }, data: { imageUrl: null } });
  assert.equal((await call('POST', `/admin/events/${a.ev.id}/spotlight`, { on: true }, admin.token)).status, 400, 'needs a photo');

  // Taken out: back to the automatic choice.
  await ok(call('POST', `/admin/events/${b.ev.id}/spotlight`, { on: false }, admin.token));
  assert.equal((await prisma.event.count({ where: { spotlightAt: { not: null } } })), 0);
  const after = (await ok(call('GET', '/events/spotlight'))).spotlight;
  if (after) assert.equal(after.picked, false);
});
