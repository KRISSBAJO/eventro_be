/**
 * End-to-end: real HTTP against a real (test) database.
 * Run with `npm test` (uses the eventro_test database; see scripts/test.mjs).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, body: parsed };
}

const ok = async (p: Promise<{ status: number; body: Json }>, expect = [200, 201]) => {
  const r = await p;
  assert.ok(expect.includes(r.status), `expected ${expect.join('/')} got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

const signup = async (email: string, name: string) => (await ok(call('POST', '/auth/signup', { email, name, password: 'test-password-123' }))).token as string;

before(async () => {
  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
  // Clean slate.
  const tables = ['AuditLog', 'FraudFlag', 'RefundRequest', 'Ticket', 'Order', 'Hold', 'Promo', 'TicketType', 'Event', 'Venue', 'OrganizationMember', 'Organization', 'User'];
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
});

after(async () => {
  await app?.close();
});

test('organizer → seat map → review → purchase → seats → QR check-in → transfer → refund', async () => {
  const admin = await signup('admin@test.local', 'Admin');
  const org = await signup('org@test.local', 'Olu Organizer');
  const fan = await signup('fan@test.local', 'Fola Fan');
  const fan2 = await signup('friend@test.local', 'Femi Friend');

  // Organizer sets up an org and an event with three ticket types.
  const o = await ok(call('POST', '/organizer/orgs', { name: 'Lagos Live' }, org));
  const startsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: 'Arena Night',
        category: 'CONCERTS',
        startsAt,
        venue: { name: 'Test Arena', address: '1 Test Rd', city: 'Lagos' },
        ticketTypes: [
          { name: 'Floor', basePriceCents: 10000, capacity: 100 },
          { name: 'Lower', basePriceCents: 8000, capacity: 100 },
          { name: 'Upper', basePriceCents: 5000, capacity: 100 },
        ],
      },
      org,
    ),
  );
  const [floor, lower, upper] = ev.ticketTypes.sort((a: Json, b: Json) => a.sortOrder - b.sortOrder);
  assert.equal(lower.priceCents, 8280); // $80 + 3.5% fee, all-in

  // Bad seat map is rejected with reasons; the arena template is accepted and sets capacities.
  const bad = await call('PUT', `/organizer/events/${ev.id}/seat-map`, { seatMap: { version: 1, width: 50, height: 600, sections: [] } }, org);
  assert.equal(bad.status, 400);
  const tpl = await ok(call('POST', `/organizer/events/${ev.id}/seat-map/template`, { template: 'arena', floor: floor.id, lower: lower.id, upper: upper.id }, org));
  assert.equal(tpl.capacities[lower.id], 1440);

  // Not on sale before review.
  assert.equal((await call('POST', '/holds', { ticketTypeId: lower.id, quantity: 2 }, fan)).status, 400);
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  assert.equal((await call('GET', '/admin/reviews', undefined, org)).status, 403); // not an admin
  const queue = await ok(call('GET', '/admin/reviews', undefined, admin));
  assert.equal(queue.length, 1);
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));

  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(pub.seatMap.sections.find((s: Json) => s.id === '104').available, 240);

  // Promo + purchase in section 104.
  await ok(call('POST', `/organizer/events/${ev.id}/promos`, { code: 'test20', percent: 20 }, org));
  const hold = await ok(call('POST', '/holds', { ticketTypeId: lower.id, quantity: 2, sectionId: '104' }, fan));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: 'fan@test.local', name: 'Fola Fan', promoCode: 'TEST20', protection: true }, fan));
  assert.equal(order.subtotalCents, 16560);
  assert.equal(order.discountCents, 3312);
  assert.equal(order.totalCents, 16560 - 3312 + 1159);
  assert.equal(order.provider, 'mock');
  const paid = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.equal(paid.status, 'PAID');
  assert.deepEqual(paid.tickets.map((t: Json) => `${t.section}-${t.row}${t.seat}`), ['104-A1', '104-A2']);

  // Paying twice doesn't issue twice.
  const again = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.equal(again.tickets.length, 2);

  // Next group sits beside them.
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: lower.id, quantity: 2, sectionId: '104' }, fan2));
  const o2 = await ok(call('POST', '/orders', { holdId: h2.id, email: 'friend@test.local', name: 'Femi Friend' }, fan2));
  const p2 = await ok(call('POST', `/orders/${o2.orderId}/pay`));
  assert.deepEqual(p2.tickets.map((t: Json) => `${t.row}${t.seat}`), ['A3', 'A4']);

  // Rotating QR -> door check-in.
  const ticketId = paid.tickets[0].id;
  const qr = await ok(call('GET', `/tickets/${ticketId}/qr`, undefined, fan));
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: qr.token }, org))).result, 'ok');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: qr.token }, org))).result, 'duplicate');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: 'EVT-NOPE-NOPE-01' }, org))).result, 'invalid');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: qr.token.slice(0, -2) + 'xx' }, org))).result, 'invalid');

  // Transfer the second ticket to a friend.
  const second = paid.tickets[1].id;
  await ok(call('POST', `/tickets/${second}/transfer`, { email: 'friend@test.local' }, fan));
  const inbox = await ok(call('GET', '/me/tickets', undefined, fan2));
  assert.equal(inbox.incomingTransfers.length, 1);
  await ok(call('POST', `/tickets/${second}/accept`, undefined, fan2));
  const friendTickets = await ok(call('GET', '/me/tickets', undefined, fan2));
  assert.ok(friendTickets.tickets.some((t: Json) => t.id === second));

  // Resale cap.
  const mine = await ok(call('GET', '/me/tickets', undefined, fan2));
  const t3 = mine.tickets.find((t: Json) => t.status === 'ACTIVE' && t.id !== second);
  assert.equal((await call('POST', `/tickets/${t3.id}/listing`, { priceCents: 9_999_999 }, fan2)).status, 400);
  const listed = await ok(call('POST', `/tickets/${t3.id}/listing`, { priceCents: 9000 }, fan2));
  assert.equal(listed.payoutCents, 8550);

  // Refund request -> admin approves -> tickets void and seats return to sale.
  await ok(call('POST', `/orders/${o2.orderId}/refund-requests`, { reason: 'Seats were not as described on the map' }, fan2));
  const refunds = await ok(call('GET', '/admin/refunds', undefined, admin));
  await ok(call('POST', `/admin/refunds/${refunds[0].id}/decide`, { decision: 'APPROVE' }, admin));
  const refunded = await ok(call('GET', `/orders/${o2.orderId}`, undefined, fan2));
  assert.equal(refunded.status, 'REFUNDED');
  assert.ok(refunded.tickets.every((t: Json) => t.status === 'VOID'));
  const after = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(after.ticketTypes.find((t: Json) => t.id === lower.id).available, 1440 - 2);

  // Organizer stats and audit trail.
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats?days=7`, undefined, org));
  assert.equal(stats.sold, 2);
  assert.equal(stats.checkedIn, 1);
  const audit = await ok(call('GET', '/admin/audit', undefined, admin));
  assert.ok(audit.some((a: Json) => a.action === 'event.approve'));
  assert.ok(audit.some((a: Json) => a.action === 'order.refund'));
});

test('no overselling under concurrent holds', async () => {
  const admin = (await ok(call('POST', '/auth/login', { email: 'admin@test.local', password: 'test-password-123' }))).token;
  const org = (await ok(call('POST', '/auth/login', { email: 'org@test.local', password: 'test-password-123' }))).token;
  const orgs = await ok(call('GET', '/organizer/orgs', undefined, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${orgs[0].org.id}/events`,
      { title: 'Tiny Room', category: 'COMEDY', startsAt: new Date(Date.now() + 86_400_000 * 3).toISOString(), venue: { name: 'Tiny', address: '2 Test Rd', city: 'Lagos' }, ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 5 }] },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));

  const attempts = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/holds', { ticketTypeId: ev.ticketTypes[0].id, quantity: 1 })));
  const won = attempts.filter((a) => a.status === 201).length;
  assert.equal(won, 5);
  assert.ok(attempts.filter((a) => a.status === 409).every((a) => /Sold out|left/.test(a.body.message)));

  // Paused sales block new holds.
  await ok(call('POST', `/organizer/events/${ev.id}/pause`, undefined, org));
  assert.equal((await call('POST', '/holds', { ticketTypeId: ev.ticketTypes[0].id, quantity: 1 })).status, 409);
});

test('holds reserve exact seats: preview, hold, quote and section seats agree', async () => {
  const fan = (await ok(call('POST', '/auth/login', { email: 'fan@test.local', password: 'test-password-123' }))).token;
  const list = await ok(call('GET', '/events?q=Arena'));
  const slug = list.items[0].slug as string;
  const ev = await ok(call('GET', `/events/${slug}`));
  const lower = ev.ticketTypes.find((t: Json) => t.name === 'Lower');

  // The preview for 2 people in section 105 is exactly what a hold gets.
  const avail = await ok(call('GET', `/events/${slug}/availability?qty=2`));
  const s105 = avail.sections.find((s: Json) => s.id === '105');
  assert.equal(s105.fits, true);
  const h1 = await ok(call('POST', '/holds', { ticketTypeId: lower.id, quantity: 2, sectionId: '105' }, fan));
  assert.deepEqual(h1.seats.map((x: Json) => `${x.row}${x.seat}`), s105.seats.map((n: number) => `${s105.row}${n}`));

  // Held seats are taken for everyone else: the next group sits beside them, not on top of them.
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: lower.id, quantity: 2, sectionId: '105' }));
  const taken = new Set(h1.seats.map((x: Json) => `${x.row}:${x.seat}`));
  assert.ok(h2.seats.every((x: Json) => !taken.has(`${x.row}:${x.seat}`)));
  const seats = await ok(call('GET', `/events/${slug}/sections/105/seats`));
  for (const x of [...h1.seats, ...h2.seats]) assert.ok(seats.taken.includes(`${x.row}:${x.seat}`));

  // Checkout reads the hold back and prices it with a promo before any order exists.
  const view = await ok(call('GET', `/holds/${h1.id}`));
  assert.equal(view.status, 'ACTIVE');
  assert.equal(view.section.id, '105');
  assert.equal(view.event.slug, slug);
  const q = await ok(call('POST', '/quote', { holdId: h1.id, promoCode: 'TEST20' }));
  assert.equal(q.promo.percent, 20);
  assert.equal(q.discountCents, Math.round(lower.priceCents * 2 * 0.2));
  assert.equal((await call('POST', '/quote', { holdId: h1.id, promoCode: 'NOPE99' })).status, 400);

  // Paying issues tickets for the held seats, not a fresh pick.
  const order = await ok(call('POST', '/orders', { holdId: h1.id, email: 'fan@test.local', name: 'Fola Fan' }, fan));
  const paid = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.deepEqual(paid.tickets.map((t: Json) => `${t.row}${t.seat}`), h1.seats.map((x: Json) => `${x.row}${x.seat}`));
  const mine = await ok(call('GET', '/me/tickets', undefined, fan));
  assert.ok(mine.tickets.some((t: Json) => t.sectionName === 'Section 105'));
});
