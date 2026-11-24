/**
 * Fan parity: saved events (hearts kept on the server, merged from a signed-out device, nothing hidden leaking) and
 * order history (GET /me/orders, refund requests on the order).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';

let app: INestApplication;
let base = '';
const run = Date.now().toString(36);
const CITY = `Savedon ${run}`;

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
  return { status: res.status, body: parsed as Json };
}
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const account = async (email: string, name: string) => {
  const s = await call('POST', '/auth/signup', { email, name, password: 'test-password-123' });
  if (s.status < 300) return s.body as { token: string; user: Json };
  return (await ok(call('POST', '/auth/login', { email, password: 'test-password-123' }))) as { token: string; user: Json };
};

before(async () => {
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
});

let shared: { admin: { token: string; user: Json }; org: { token: string; user: Json }; orgId: string } | null = null;
async function setup() {
  if (shared) return shared;
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`saved-org-${run}@test.local`, 'Sam Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Saved Promotions ${run}` }, org.token));
  shared = { admin, org, orgId: o.id };
  return shared;
}

let n = 0;
/** A published event in CITY, `days` from now. */
async function publishedEvent(title: string, days: number, basePriceCents = 2500) {
  const { admin, org, orgId } = await setup();
  n += 1;
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${orgId}/events`,
      {
        title: `${title} ${run}`,
        category: 'COMEDY',
        startsAt: new Date(Date.now() + days * 86_400_000).toISOString(),
        venue: { name: `Savehall${run}`, address: '9 Quiet Lane', city: CITY, country: 'US', region: 'Oregon', lat: 44.0521, lng: -123.0868 },
        ticketTypes: [{ name: 'General', basePriceCents, capacity: 500 }],
      },
      org.token,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));
  return ev as Json;
}

test('saved events: put by id or slug, idempotent, newest first, same card shape as GET /events', async () => {
  const fan = await account(`saved-fan1-${run}@test.local`, 'Hana Heart');
  const other = await account(`saved-fan2-${run}@test.local`, 'Otto Other');
  const a = await publishedEvent('Heart One', 10);
  const b = await publishedEvent('Heart Two', 11);

  assert.equal((await call('GET', '/me/saved')).status, 401, 'needs a sign-in');
  assert.equal((await call('PUT', `/me/saved/${a.slug}`)).status, 401);

  const empty = await ok(call('GET', '/me/saved', undefined, fan.token));
  assert.deepEqual(empty, { ids: [], slugs: [], items: [] });

  const first = await ok(call('PUT', `/me/saved/${a.slug}`, undefined, fan.token));
  assert.deepEqual(first, { saved: true, eventId: a.id, slug: a.slug });
  await ok(call('PUT', `/me/saved/${a.slug}`, undefined, fan.token));
  await ok(call('PUT', `/me/saved/${a.id}`, undefined, fan.token)); // by id: still one save
  await new Promise((r) => setTimeout(r, 5));
  await ok(call('PUT', `/me/saved/${b.id}`, undefined, fan.token));

  const list = await ok(call('GET', '/me/saved', undefined, fan.token));
  assert.deepEqual(list.slugs, [b.slug, a.slug], 'newest saved first');
  assert.deepEqual(list.ids, [b.id, a.id]);
  const prisma = app.get(PrismaService);
  assert.equal(await prisma.savedEvent.count({ where: { userId: fan.user.id } }), 2);

  // Cards look exactly like GET /events items.
  const page = await ok(call('GET', `/events?city=${encodeURIComponent(CITY)}&pageSize=100`));
  const card = (page.items as Json[]).find((c) => c.slug === a.slug)!;
  assert.deepEqual(list.items[1], card);

  // Someone else's list is their own.
  assert.deepEqual((await ok(call('GET', '/me/saved', undefined, other.token))).slugs, []);

  // Delete is idempotent, works by id or slug, and for unknown events too.
  assert.deepEqual(await ok(call('DELETE', `/me/saved/${a.id}`, undefined, fan.token)), { saved: false, eventId: a.id, slug: a.slug });
  await ok(call('DELETE', `/me/saved/${a.slug}`, undefined, fan.token));
  await ok(call('DELETE', `/me/saved/no-such-event-${run}`, undefined, fan.token));
  assert.deepEqual((await ok(call('GET', '/me/saved', undefined, fan.token))).slugs, [b.slug]);
  assert.equal((await call('PUT', `/me/saved/no-such-event-${run}`, undefined, fan.token)).status, 404);
});

test('saved events: hidden, unpublished, cancelled and past events never come back', async () => {
  const { org, orgId } = await setup();
  const fan = await account(`saved-fan3-${run}@test.local`, 'Pia Private');
  const prisma = app.get(PrismaService);
  const keep = await publishedEvent('Stays Up', 12);
  const unlisted = await publishedEvent('Goes Unlisted', 13);
  const takenDown = await publishedEvent('Taken Down', 14);
  const cancelled = await publishedEvent('Called Off', 15);
  const past = await publishedEvent('Long Gone', 16);
  for (const e of [keep, unlisted, takenDown, cancelled, past]) await ok(call('PUT', `/me/saved/${e.slug}`, undefined, fan.token));
  assert.equal((await ok(call('GET', '/me/saved', undefined, fan.token))).slugs.length, 5);

  await prisma.event.update({ where: { id: unlisted.id }, data: { visibility: 'UNLISTED' } });
  await prisma.event.update({ where: { id: takenDown.id }, data: { status: 'REJECTED' } });
  await prisma.event.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Test' } });
  await prisma.event.update({ where: { id: past.id }, data: { startsAt: new Date(Date.now() - 86_400_000) } });

  const list = await ok(call('GET', '/me/saved', undefined, fan.token));
  assert.deepEqual(list.slugs, [keep.slug]);
  assert.deepEqual(list.ids, [keep.id]);
  assert.equal(list.items.length, 1);

  // A draft (never published) can't be saved, by id or slug, and neither can the hidden ones.
  const draft = await ok(
    call('POST', `/organizer/orgs/${orgId}/events`, { title: `Draft ${run}`, category: 'COMEDY', startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), online: true, ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 10 }] }, org.token),
  );
  for (const key of [draft.id, draft.slug, unlisted.slug, takenDown.id, cancelled.slug]) {
    const r = await call('PUT', `/me/saved/${key}`, undefined, fan.token);
    assert.equal(r.status, 404, `${key} must not be savable`);
    assert.equal(r.body.message, 'Event not found.', 'the same answer as an unknown event');
  }
  // Taking a heart back always works, even for an event that's no longer shown.
  await ok(call('DELETE', `/me/saved/${takenDown.slug}`, undefined, fan.token));
  assert.equal(await prisma.savedEvent.count({ where: { userId: fan.user.id, eventId: takenDown.id } }), 0);

  // Published again: the old save shows again.
  await prisma.event.update({ where: { id: unlisted.id }, data: { visibility: 'PUBLIC' } });
  assert.deepEqual(new Set((await ok(call('GET', '/me/saved', undefined, fan.token))).slugs), new Set([keep.slug, unlisted.slug]));
});

test('saved events: sync merges a signed-out device’s hearts, skips unknown and hidden, max 200', async () => {
  const fan = await account(`saved-fan4-${run}@test.local`, 'Sid Sync');
  const prisma = app.get(PrismaService);
  const already = await publishedEvent('Already Saved', 17);
  const x = await publishedEvent('Device X', 18);
  const y = await publishedEvent('Device Y', 19);
  const hidden = await publishedEvent('Device Hidden', 20);
  await prisma.event.update({ where: { id: hidden.id }, data: { status: 'REJECTED' } });
  await ok(call('PUT', `/me/saved/${already.slug}`, undefined, fan.token));

  assert.equal((await call('POST', '/me/saved/sync', { eventIds: [x.slug] })).status, 401);
  assert.equal((await call('POST', '/me/saved/sync', { eventIds: 'nope' }, fan.token)).status, 400);
  assert.equal((await call('POST', '/me/saved/sync', {}, fan.token)).status, 400);
  assert.equal((await call('POST', '/me/saved/sync', { eventIds: [42] }, fan.token)).status, 400);
  assert.equal((await call('POST', '/me/saved/sync', { eventIds: Array.from({ length: 201 }, (_, i) => `e${i}`) }, fan.token)).status, 400);

  // Slugs and ids mixed, a duplicate, the one already saved, an unknown and a hidden one.
  const merged = await ok(call('POST', '/me/saved/sync', { eventIds: [x.slug, y.id, x.id, already.slug, `ghost-${run}`, hidden.slug] }, fan.token));
  assert.deepEqual(new Set(merged.slugs), new Set([already.slug, x.slug, y.slug]));
  assert.equal(merged.items.length, 3);
  assert.equal(merged.slugs[0], y.slug, 'the device’s last heart is the newest');
  assert.equal(await prisma.savedEvent.count({ where: { userId: fan.user.id } }), 3, 'no duplicates, nothing hidden');

  // Running it again changes nothing; an empty list is fine.
  const again = await ok(call('POST', '/me/saved/sync', { eventIds: [x.slug, y.slug] }, fan.token));
  assert.deepEqual(again, merged);
  assert.deepEqual(await ok(call('POST', '/me/saved/sync', { eventIds: [] }, fan.token)), merged);
});

test('order history: GET /me/orders lists paid orders newest first; refund requests show on the order', async () => {
  const fan = await account(`saved-buyer-${run}@test.local`, 'Bo Buyer');
  const stranger = await account(`saved-stranger-${run}@test.local`, 'Stan Stranger');
  const { admin } = await setup();
  const ev = await publishedEvent('Order Show', 21, 3000);
  const tt = ev.ticketTypes[0].id as string;

  const buy = async (qty: number) => {
    const hold = await ok(call('POST', '/holds', { ticketTypeId: tt, quantity: qty }, fan.token));
    const o = await ok(call('POST', '/orders', { holdId: hold.id, email: fan.user.email, name: fan.user.name }, fan.token));
    return ok(call('POST', `/orders/${o.orderId}/pay`));
  };
  const first = await buy(1);
  const second = await buy(2);
  // An abandoned checkout doesn't show.
  const h = await ok(call('POST', '/holds', { ticketTypeId: tt, quantity: 1 }, fan.token));
  const abandoned = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name }, fan.token));

  assert.equal((await call('GET', '/me/orders')).status, 401);
  const mine = (await ok(call('GET', '/me/orders', undefined, fan.token))).orders as Json[];
  assert.deepEqual(mine.map((o) => o.id), [second.id, first.id]);
  assert.ok(!mine.some((o) => o.id === abandoned.orderId));
  const row = mine[0];
  assert.equal(row.status, 'PAID');
  assert.equal(row.quantity, 2);
  assert.equal(row.currency, 'USD');
  assert.equal(row.totalCents, second.totalCents);
  assert.equal(row.event.slug, ev.slug);
  assert.equal(row.ticketType.name, 'General');
  assert.equal(row.refundRequest, null);
  assert.equal(row.paymentRef, undefined);
  assert.equal(row.clientIp, undefined);
  assert.deepEqual((await ok(call('GET', '/me/orders', undefined, stranger.token))).orders, []);

  // Refund request: 10 to 1000 characters, one open at a time, only on paid orders, only the buyer's.
  assert.equal((await call('POST', `/orders/${second.id}/refund-requests`, { reason: 'too short' }, fan.token)).status, 400);
  assert.equal((await call('POST', `/orders/${second.id}/refund-requests`, { reason: 'x'.repeat(1001) }, fan.token)).status, 400);
  assert.equal((await call('POST', `/orders/${second.id}/refund-requests`, { reason: 'I can no longer make it that night.' }, stranger.token)).status, 404);
  await ok(call('POST', `/orders/${second.id}/refund-requests`, { reason: 'I can no longer make it that night.' }, fan.token));
  assert.equal((await call('POST', `/orders/${second.id}/refund-requests`, { reason: 'Asking a second time, please.' }, fan.token)).status, 409);

  const detail = await ok(call('GET', `/orders/${second.id}`, undefined, fan.token));
  assert.equal(detail.refundRequests.length, 1);
  assert.equal(detail.refundRequests[0].status, 'OPEN');
  assert.equal(detail.refundRequests[0].reason, 'I can no longer make it that night.');
  const listed = ((await ok(call('GET', '/me/orders', undefined, fan.token))).orders as Json[]).find((o) => o.id === second.id)!;
  assert.equal(listed.refundRequest.status, 'OPEN');

  // Approved: the order is refunded and the request says so.
  const open = ((await ok(call('GET', '/admin/refunds', undefined, admin.token))) as Json[]).find((r) => r.orderId === second.id)!;
  await ok(call('POST', `/admin/refunds/${open.id}/decide`, { decision: 'APPROVE' }, admin.token));
  const after = ((await ok(call('GET', '/me/orders', undefined, fan.token))).orders as Json[]).find((o) => o.id === second.id)!;
  assert.equal(after.status, 'REFUNDED');
  assert.equal(after.refundRequest.status, 'APPROVED');
  assert.equal(after.refundedCents, second.totalCents);
  assert.equal((await ok(call('GET', `/orders/${second.id}`, undefined, fan.token))).refundRequests[0].status, 'APPROVED');
});

test('exact seats: a hold can take the seats the fan picked in a reserved section, and they stay theirs', async () => {
  const { org } = await setup();
  const fan = await account(`saved-seats-${run}@test.local`, 'Cy Seats');
  const rival = await account(`saved-rival-${run}@test.local`, 'Ray Rival');
  const ev = await publishedEvent('Seat Picker', 22);
  const tt = ev.ticketTypes[0].id as string;
  // Seat maps can only change before review, so this one is set up on a fresh draft.
  const { orgId, admin } = await setup();
  const draft = await ok(
    call(
      'POST',
      `/organizer/orgs/${orgId}/events`,
      {
        title: `Arena Pick ${run}`,
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + 23 * 86_400_000).toISOString(),
        venue: { name: `Savehall${run}`, address: '9 Quiet Lane', city: CITY, country: 'US', region: 'Oregon', lat: 44.0521, lng: -123.0868 },
        ticketTypes: [{ name: 'Seats', basePriceCents: 4000, capacity: 5000 }],
      },
      org.token,
    ),
  );
  const ttA = draft.ticketTypes[0].id as string;
  await ok(call('POST', `/organizer/events/${draft.id}/seat-map/template`, { template: 'arena', floor: ttA, lower: ttA, upper: ttA }, org.token));
  await ok(call('POST', `/organizer/events/${draft.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${draft.id}/approve`, undefined, admin.token));
  const detail = await ok(call('GET', `/events/${draft.slug}`));
  const reserved = (detail.seatMap.sections as Json[]).find((s) => s.seating === 'reserved')!;
  const standing = (detail.seatMap.sections as Json[]).find((s) => s.seating === 'ga');

  const hold = (body: Json, token = fan.token) => call('POST', '/holds', { ticketTypeId: ttA, ...body }, token);
  // Not on a seat map, or without a section: refused.
  assert.equal((await call('POST', '/holds', { ticketTypeId: tt, quantity: 1, seats: [{ row: 'A', seat: 1 }] }, fan.token)).status, 400);
  assert.equal((await hold({ quantity: 1, seats: [{ row: 'A', seat: 1 }] })).status, 400);
  if (standing) assert.equal((await hold({ quantity: 1, sectionId: standing.id, seats: [{ row: 'A', seat: 1 }] })).status, 400);
  assert.equal((await hold({ quantity: 2, sectionId: reserved.id, seats: [{ row: 'A', seat: 1 }] })).status, 400, 'one seat per ticket');
  assert.equal((await hold({ quantity: 2, sectionId: reserved.id, seats: [{ row: 'A', seat: 1 }, { row: 'A', seat: 1 }] })).status, 400, 'no repeats');
  assert.equal((await hold({ quantity: 1, sectionId: reserved.id, seats: [{ row: 'A', seat: (reserved.seatsPerRow as number) + 1 }] })).status, 400, 'past the end of the row');
  assert.equal((await hold({ quantity: 1, sectionId: reserved.id, seats: [{ row: 'ZZ', seat: 1 }] })).status, 400, 'no such row');
  assert.equal((await hold({ quantity: 1, sectionId: reserved.id, seats: [{ row: 'a', seat: 1 }] })).status, 400, 'row labels are capitals');

  // Two seats apart in row B: exactly those are held.
  const picked = [{ row: 'B', seat: 3 }, { row: 'B', seat: 6 }];
  const h = await ok(hold({ quantity: 2, sectionId: reserved.id, seats: picked }));
  assert.deepEqual(h.seats, picked.map((p) => ({ section: reserved.id, ...p })));
  const seatsNow = await ok(call('GET', `/events/${draft.slug}/sections/${reserved.id}/seats`));
  assert.ok(seatsNow.taken.includes('B:3') && seatsNow.taken.includes('B:6'));

  // Someone else can't take one of them while it's held.
  const clash = await hold({ quantity: 1, sectionId: reserved.id, seats: [{ row: 'B', seat: 6 }] }, rival.token);
  assert.equal(clash.status, 409);
  assert.match(clash.body.message, /B6 was just taken/);

  // Paid: the tickets are for those seats.
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name }, fan.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  assert.deepEqual((paid.tickets as Json[]).map((t) => `${t.row}${t.seat}`).sort(), ['B3', 'B6']);
  // Best available (no seats sent) still works and never hands out a picked seat.
  const auto = await ok(hold({ quantity: 2, sectionId: reserved.id }, rival.token));
  assert.ok(!(auto.seats as Json[]).some((s) => s.row === 'B' && (s.seat === 3 || s.seat === 6)));
});
