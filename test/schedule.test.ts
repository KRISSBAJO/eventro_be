/**
 * Event schedule (agenda) and bookable sessions: creating and replacing a schedule and its checks, the public view
 * with places left, booking with a ticket (date, day, tier and tier-key eligibility, FULL, CLASH, CLOSED, one per
 * ticket, cancelling), places released when a ticket is resold, refunded, voided or its date cancelled (and kept on
 * transfer), holders told when a booked session is removed or moved, session check-in and undo, stats, the admin
 * view, and an event without a schedule unchanged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { overlaps, itemWindow } from '../src/domain/schedule';
import { planSchedule } from '../src/schedule/plan';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const DAY = 86_400_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Jsons = any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
type Account = { token: string; user: Json };

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
const account = async (email: string, name: string): Promise<Account> => {
  const s = await call('POST', '/auth/signup', { email, name, password: 'test-password-123' });
  if (s.status < 300) return s.body as Account;
  return (await ok(call('POST', '/auth/login', { email, password: 'test-password-123' }))) as Account;
};
async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
});

/** A wall-clock time `days` from now at hour:minute (UTC venue, so wall clock = real time). */
const at = (days: number, hour = 20, minute = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

let n = 0;
let admin: Account;
/** An organization (with a door staff member) and a published event made from `body`. */
async function published(org: Account, body: Json, door?: Account) {
  n++;
  admin ??= await account('admin@test.local', 'Admin');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Schedule Org ${run} ${n}` }, org.token));
  if (door) {
    await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
    await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  }
  const ev = await ok(call('POST', `/organizer/orgs/${o.id}/events`, { title: `Fest ${run} ${n}`, category: 'CONCERTS', venue: { name: 'Sched Hall', address: '1 Agenda St', city: 'London', country: 'GB' }, timezone: 'UTC', ...body }, org.token));
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));
  return { org: o as Json, ev };
}

/** Buys `qty` of a ticket type and pays (mock provider); returns the paid order. */
async function buy(buyer: Account, ticketTypeId: string, qty = 1) {
  const h = await ok(call('POST', '/holds', { ticketTypeId, quantity: qty }, buyer.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: buyer.user.email, name: buyer.user.name }, buyer.token));
  return ok(call('POST', `/orders/${o.orderId}/pay`));
}

const tier = (ev: Json, name: string, dateId?: string) => (ev.ticketTypes as Jsons).find((t) => t.name === name && (!dateId || t.eventDateId === dateId));
const item = (list: Jsons, title: string) => list.find((i) => i.title === title);

/** A one-date event (doors 18:00, 20:00–23:30, 10 days out) with General and VIP, and a schedule with three bookable items. */
const SINGLE = () => ({
  startsAt: at(10, 20),
  doorsAt: at(10, 18),
  endsAt: at(10, 23, 30),
  ticketTypes: [
    { name: 'General', basePriceCents: 2000, capacity: 50 },
    { name: 'VIP', basePriceCents: 6000, capacity: 10 },
  ],
  schedule: [
    { startsAt: at(10, 18, 30), endsAt: at(10, 19, 30), title: 'Opening set', stage: 'Main', people: ['DJ Ada', ' dj ada ', 'MC Bo'], kind: 'PERFORMANCE' },
    { startsAt: at(10, 21), endsAt: at(10, 22), title: 'Masterclass', stage: 'Studio', kind: 'WORKSHOP', bookable: true, capacity: 2, eligibleTiers: ['1'], note: 'Bring headphones' },
    { startsAt: at(10, 21, 30), endsAt: at(10, 22), title: 'Meet and greet', stage: 'Lounge', bookable: true, capacity: 5 },
    { startsAt: at(10, 20), title: 'Headliner', stage: 'Main', kind: 'PERFORMANCE' },
    { startsAt: at(10, 22, 30), endsAt: at(10, 23), title: 'Tasting', stage: 'Lounge', bookable: true, capacity: 3 },
  ],
});

/** The items of a schedule as PUT takes them back (what GET returns, minus the read-only fields). */
const asInput = (items: Jsons) =>
  items.map((i) => ({ id: i.id, eventDateId: i.eventDateId ?? undefined, startsAt: i.startsAt, endsAt: i.endsAt, title: i.title, note: i.note, stage: i.stage, people: i.people, kind: i.kind, bookable: i.bookable, capacity: i.capacity, eligibleTiers: i.eligibleTiers }));

test('domain: item windows, clashes and the plan checks', () => {
  const w = itemWindow({ startsAt: new Date('2026-12-12T20:00:00Z'), doorsAt: null, endsAt: null });
  assert.equal(w.from.toISOString(), '2026-12-12T08:00:00.000Z');
  assert.equal(w.to.toISOString(), '2026-12-13T20:00:00.000Z');
  const s = (a: string, b: string | null = null) => ({ startsAt: new Date(a), endsAt: b ? new Date(b) : null });
  assert.equal(overlaps(s('2026-12-12T20:00:00Z', '2026-12-12T21:00:00Z'), s('2026-12-12T21:00:00Z', '2026-12-12T22:00:00Z')), false, 'end to start is fine');
  assert.equal(overlaps(s('2026-12-12T20:00:00Z', '2026-12-12T21:00:00Z'), s('2026-12-12T20:30:00Z')), true);
  assert.equal(overlaps(s('2026-12-12T20:00:00Z'), s('2026-12-12T20:29:00Z')), true, 'no end: 30 minutes');
  assert.equal(overlaps(s('2026-12-12T20:00:00Z'), s('2026-12-12T20:30:00Z')), false);
  const ctx = { mode: 'SINGLE' as const, event: { startsAt: new Date('2026-12-12T20:00:00Z'), doorsAt: null, endsAt: null }, dates: [], tier: () => null, tierInfo: () => ({ name: '', validDateIds: [] }) };
  const p = planSchedule([{ startsAt: '2026-12-12T21:00:00Z', title: '  Set  one ', people: ['A', 'a', ' B '], stage: '  ' }], ctx);
  assert.deepEqual([p[0].title, p[0].people, p[0].stage, p[0].kind, p[0].bookable, p[0].capacity], ['Set one', ['A', 'B'], null, 'OTHER', false, null]);
  assert.throws(() => planSchedule([{ startsAt: '2026-12-14T21:00:00Z', title: 'Late' }], ctx), /has to be between/);
});

test('schedule: created with the event, checked on create and replace, public view with places left and stages', async () => {
  const org = await account(`sc-org1-${run}@test.local`, 'Sam Organizer');
  const { org: o, ev } = await published(org, SINGLE());
  assert.equal(ev.schedule.length, 5);
  const created = ev.schedule as Jsons;
  // Ordered by time; tier refs on create are indexes into ticketTypes.
  assert.deepEqual(created.map((i) => i.title), ['Opening set', 'Headliner', 'Masterclass', 'Meet and greet', 'Tasting']);
  assert.deepEqual(item(created, 'Masterclass').eligibleTiers, [tier(ev, 'VIP').id]);
  assert.deepEqual(item(created, 'Opening set').people, ['DJ Ada', 'MC Bo']);
  assert.equal(item(created, 'Opening set').capacity, null);

  // A bad schedule on create: 400 and no event.
  const before = (await ok(call('GET', `/organizer/orgs/${o.id}/events`, undefined, org.token))).length;
  const bad = await call('POST', `/organizer/orgs/${o.id}/events`, { ...SINGLE(), title: 'Bad schedule', category: 'CONCERTS', online: true, schedule: [{ startsAt: at(10, 17), title: 'Too early' }] }, org.token);
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Item 1 \(Too early\) has to be between/);
  assert.equal((await ok(call('GET', `/organizer/orgs/${o.id}/events`, undefined, org.token))).length, before);

  // Public view.
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual(pub.stages, ['Main', 'Studio', 'Lounge']);
  const mc = item(pub.schedule, 'Masterclass');
  assert.deepEqual([mc.bookable, mc.capacity, mc.placesLeft, mc.eligibleTierNames, mc.note, mc.kind], [true, 2, 2, ['VIP'], 'Bring headphones', 'WORKSHOP']);
  assert.equal(mc.reserved, undefined, 'organizer fields stay private');
  assert.deepEqual([item(pub.schedule, 'Headliner').placesLeft, item(pub.schedule, 'Meet and greet').eligibleTierNames], [null, []]);

  // Replace: checks.
  const cur = (await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items as Jsons;
  assert.equal(cur.length, 5);
  assert.deepEqual([item(cur, 'Masterclass').reserved, item(cur, 'Masterclass').checkedIn], [0, 0]);
  const put = (items: Jsons) => call('PUT', `/organizer/events/${ev.id}/schedule`, { items }, org.token);
  const base0 = asInput(cur);
  const expect400 = async (items: Jsons, re: RegExp) => {
    const r = await put(items);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const m = r.body.message;
    assert.match(typeof m === 'string' ? m : JSON.stringify(m), re);
  };
  await expect400([...base0, { startsAt: at(10, 21), endsAt: at(10, 20), title: 'Backwards' }], /Item 6: the end has to be after the start/);
  await expect400([...base0, { startsAt: at(11, 3), title: 'After hours' }], /Item 6 \(After hours\) has to be between/);
  await expect400([...base0, { startsAt: at(10, 21), title: 'No places', bookable: true }], /set the number of places/);
  await expect400([...base0, { startsAt: at(10, 21), title: 'Odd tier', bookable: true, capacity: 3, eligibleTiers: ['nope'] }], /eligibleTiers names a ticket type that isn’t part of this event \("nope"\)/);
  await expect400([...base0, { startsAt: at(10, 21), title: 'Dated', eventDateId: 'x' }], /this event has one date/);
  await expect400([{ ...base0[0], id: 'not-an-item' }], /that item isn’t part of this schedule/);
  await expect400([base0[0], base0[0]], /Item 2 is listed twice/);
  await expect400(Array.from({ length: 61 }, (_, i) => ({ startsAt: at(10, 19, i % 60), title: `Slot ${i}`, bookable: true, capacity: 1 })), /Up to 60 items can be bookable/);
  await expect400(Array.from({ length: 201 }, (_, i) => ({ startsAt: at(10, 19), title: `Item ${i}` })), /A schedule can have up to 200 items/);
  // Door staff can't edit.
  const door = await account(`sc-door1-${run}@test.local`, 'Dora Door');
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/schedule`, { items: base0 }, door.token)).status, 403);
  assert.equal((await call('GET', `/organizer/events/${ev.id}/schedule`, undefined, door.token)).status, 200);

  // A valid replace: one kept and renamed, one added, the rest (no bookings) removed for good.
  const out = await ok(put([{ ...base0[0], title: 'Opening set (extended)', endsAt: at(10, 19, 45) }, { startsAt: at(10, 23), title: 'Encore', stage: 'Main' }]));
  assert.equal(out.notified, 0);
  assert.deepEqual((out.items as Jsons).map((i) => i.title), ['Opening set (extended)', 'Encore']);
  assert.equal((out.items as Jsons)[0].id, base0[0].id);
  assert.equal(await prisma.scheduleItem.count({ where: { eventId: ev.id } }), 2);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'schedule.update', entityId: ev.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([(audit!.data as Json).added, (audit!.data as Json).removed], [1, 4]);

  // Admins see it read-only.
  const adm = await ok(call('GET', `/admin/events/${ev.id}/schedule`, undefined, admin.token));
  assert.equal(adm.items.length, 2);
  assert.equal((await call('GET', `/admin/events/${ev.id}/schedule`, undefined, org.token)).status, 403);

  // Switching to multiple dates (no orders yet) puts each item on the date that holds it; back to one date clears it.
  const toDates = await ok(call('PATCH', `/organizer/events/${ev.id}`, { dateMode: 'DATES', dates: [{ startsAt: at(9, 20) }, { startsAt: at(10, 20), doorsAt: at(10, 18), endsAt: at(10, 23, 30) }] }, org.token));
  const second = (toDates.dates as Jsons).find((d) => d.startsAt === at(10, 20)).id;
  assert.deepEqual(((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items as Jsons).map((i) => i.eventDateId), [second, second]);
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { dateMode: 'SINGLE', startsAt: at(10, 20), doorsAt: at(10, 18), endsAt: at(10, 23, 30) }, org.token));
  assert.deepEqual(((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items as Jsons).map((i) => i.eventDateId), [null, null]);
});

test('booking: tier eligibility, one per ticket, FULL, CLASH, CLOSED, capacity below booked, cancel frees the place', async () => {
  const org = await account(`sc-org2-${run}@test.local`, 'Sam Organizer');
  const fan = await account(`sc-fan2-${run}@test.local`, 'Fay Fan');
  const other = await account(`sc-other2-${run}@test.local`, 'Oli Other');
  const { ev } = await published(org, SINGLE());
  const sched = ev.schedule as Jsons;
  const mc = item(sched, 'Masterclass');
  const meet = item(sched, 'Meet and greet');
  const tasting = item(sched, 'Tasting');
  const general = (await buy(fan, tier(ev, 'General').id)).tickets[0].id as string;
  const [vip1, vip2, vip3] = ((await buy(fan, tier(ev, 'VIP').id, 3)).tickets as Jsons).map((t) => t.id as string);

  // The ticket's view: only VIP can book the masterclass; plain items aren't listed.
  const g = await ok(call('GET', `/tickets/${general}/sessions`, undefined, fan.token));
  assert.deepEqual((g.items as Jsons).map((i) => i.title), ['Masterclass', 'Meet and greet', 'Tasting']);
  assert.deepEqual([item(g.items, 'Masterclass').status, item(g.items, 'Masterclass').reason], ['NOT_ELIGIBLE', 'Only for VIP tickets.']);
  assert.equal(item(g.items, 'Meet and greet').status, 'OPEN');
  const denied = await call('POST', `/tickets/${general}/sessions/${mc.id}`, undefined, fan.token);
  assert.deepEqual([denied.status, denied.body.code], [403, 'NOT_ELIGIBLE']);
  // Not your ticket, or not an item of this event.
  assert.equal((await call('POST', `/tickets/${vip1}/sessions/${mc.id}`, undefined, other.token)).status, 404);
  assert.equal((await call('POST', `/tickets/${vip1}/sessions/${item(sched, 'Headliner').id}`, undefined, fan.token)).status, 404);

  // Book; booking the same item again returns the same booking.
  const r1 = await call('POST', `/tickets/${vip1}/sessions/${mc.id}`, undefined, fan.token);
  assert.equal(r1.status, 201);
  assert.equal(r1.body.item.placesLeft, 1);
  const again = await ok(call('POST', `/tickets/${vip1}/sessions/${mc.id}`, undefined, fan.token));
  assert.equal(again.id, r1.body.id);
  assert.equal((await prisma.scheduleItem.findUniqueOrThrow({ where: { id: mc.id } })).reserved, 1);

  // A clash with the booked masterclass (21:00–22:00 vs 21:30).
  const clash = await call('POST', `/tickets/${vip1}/sessions/${meet.id}`, undefined, fan.token);
  assert.deepEqual([clash.status, clash.body.code, clash.body.message], [409, 'CLASH', 'You’ve booked Masterclass at that time.']);
  const v1 = await ok(call('GET', `/tickets/${vip1}/sessions`, undefined, fan.token));
  assert.deepEqual(['Masterclass', 'Meet and greet', 'Tasting'].map((t) => item(v1.items, t).status), ['BOOKED', 'CLASH', 'OPEN']);
  assert.equal(item(v1.items, 'Masterclass').reservationId, r1.body.id);

  // Full.
  await ok(call('POST', `/tickets/${vip2}/sessions/${mc.id}`, undefined, fan.token));
  const full = await call('POST', `/tickets/${vip3}/sessions/${mc.id}`, undefined, fan.token);
  assert.deepEqual([full.status, full.body.code], [409, 'FULL']);
  assert.equal(item((await ok(call('GET', `/tickets/${vip3}/sessions`, undefined, fan.token))).items, 'Masterclass').status, 'FULL');
  assert.equal(item((await ok(call('GET', `/events/${ev.slug}`))).schedule, 'Masterclass').placesLeft, 0);

  // Capacity can't go below what's booked.
  const cur = asInput((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items);
  const low = await call('PUT', `/organizer/events/${ev.id}/schedule`, { items: cur.map((i) => (i.id === mc.id ? { ...i, capacity: 1 } : i)) }, org.token);
  assert.deepEqual([low.status, low.body.code, low.body.message], [409, 'CAPACITY_BELOW_RESERVED', 'Masterclass has 2 places booked, so it needs at least 2.']);

  // Cancelling frees the place for someone else.
  assert.equal((await call('DELETE', `/tickets/${vip2}/sessions/${mc.id}`, undefined, fan.token)).status, 204);
  assert.equal((await call('DELETE', `/tickets/${vip2}/sessions/${mc.id}`, undefined, fan.token)).status, 404, 'once');
  await ok(call('POST', `/tickets/${vip3}/sessions/${mc.id}`, undefined, fan.token));
  // Booking again after cancelling reuses the booking row.
  await ok(call('DELETE', `/tickets/${vip3}/sessions/${mc.id}`, undefined, fan.token));
  await ok(call('POST', `/tickets/${vip2}/sessions/${mc.id}`, undefined, fan.token));
  assert.equal((await prisma.scheduleItem.findUniqueOrThrow({ where: { id: mc.id } })).reserved, 2);
  assert.equal(await prisma.sessionReservation.count({ where: { scheduleItemId: mc.id, cancelledAt: null } }), 2);

  // A ticket listed for resale can't book.
  await ok(call('POST', `/tickets/${general}/listing`, { priceCents: tier(ev, 'General').priceCents }, fan.token));
  const listed = await call('POST', `/tickets/${general}/sessions/${tasting.id}`, undefined, fan.token);
  assert.deepEqual([listed.status, listed.body.code], [403, 'NOT_ELIGIBLE']);
  await ok(call('DELETE', `/tickets/${general}/listing`, undefined, fan.token));
  await ok(call('POST', `/tickets/${general}/sessions/${tasting.id}`, undefined, fan.token));

  // Closed once it starts: no booking, no cancelling.
  await prisma.scheduleItem.update({ where: { id: tasting.id }, data: { startsAt: new Date(Date.now() - 60_000), endsAt: null } });
  const closed = await call('POST', `/tickets/${vip1}/sessions/${tasting.id}`, undefined, fan.token);
  assert.deepEqual([closed.status, closed.body.code], [409, 'CLOSED']);
  const noCancel = await call('DELETE', `/tickets/${general}/sessions/${tasting.id}`, undefined, fan.token);
  assert.deepEqual([noCancel.status, noCancel.body.code], [409, 'CLOSED']);
  assert.equal(item((await ok(call('GET', `/tickets/${vip1}/sessions`, undefined, fan.token))).items, 'Tasting').status, 'CLOSED');

  // My tickets list each ticket's sessions; stats count them.
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t1 = (mine.tickets as Jsons).find((t) => t.id === vip1);
  assert.deepEqual(t1.sessions.map((s: Json) => [s.title, s.stage, s.checkedIn, s.reservationId]), [['Masterclass', 'Studio', false, r1.body.id]]);
  assert.deepEqual((mine.tickets as Jsons).find((t) => t.id === vip3).sessions, []);
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(
    (stats.sessions as Jsons).map((s) => [s.title, s.capacity, s.reserved, s.checkedIn]),
    // by time (Tasting has started)
    [
      ['Tasting', 3, 1, 0],
      ['Masterclass', 2, 2, 0],
      ['Meet and greet', 5, 0, 0],
    ],
  );
});

test('multiple dates and days: eligibility by date, by day and by tier key; dates on create by index', async () => {
  const org = await account(`sc-org3-${run}@test.local`, 'Sam Organizer');
  const fan = await account(`sc-fan3-${run}@test.local`, 'Fay Fan');
  // DATES: two performances; the workshop on each is for Box holders (a tier key, so every copy).
  const dates = [
    { startsAt: at(12, 19), endsAt: at(12, 22) },
    { startsAt: at(13, 19), endsAt: at(13, 22) },
  ];
  const tiers = [
    { name: 'Stalls', basePriceCents: 3000, capacity: 20 },
    { name: 'Box', basePriceCents: 9000, capacity: 4 },
  ];
  const o = await ok(call('POST', '/organizer/orgs', { name: `Schedule Org ${run} dates` }, org.token));
  const noDate = await call('POST', `/organizer/orgs/${o.id}/events`, { title: 'Bad', category: 'THEATER', online: true, timezone: 'UTC', dateMode: 'DATES', dates, ticketTypes: tiers, schedule: [{ startsAt: at(12, 18), title: 'Talk' }] }, org.token);
  assert.deepEqual([noDate.status, noDate.body.message], [400, 'Item 1: pick the date it’s on (eventDateId).']);
  const wrongDay = await call('POST', `/organizer/orgs/${o.id}/events`, { title: 'Bad', category: 'THEATER', online: true, timezone: 'UTC', dateMode: 'DATES', dates, ticketTypes: tiers, schedule: [{ dateRef: 0, startsAt: at(13, 20), title: 'Talk' }] }, org.token);
  assert.equal(wrongDay.status, 400);
  const { ev } = await published(org, {
    dateMode: 'DATES',
    dates,
    ticketTypes: tiers,
    schedule: [
      { dateRef: 0, startsAt: at(12, 18), endsAt: at(12, 18, 45), title: 'Backstage tour', bookable: true, capacity: 5, eligibleTiers: ['1'] },
      { dateRef: 1, startsAt: at(13, 18), endsAt: at(13, 18, 45), title: 'Backstage tour', bookable: true, capacity: 5, eligibleTiers: ['1'] },
    ],
  });
  const [d0, d1] = (ev.dates as Jsons).map((d) => d.id as string);
  const [tour0, tour1] = [...(ev.schedule as Jsons)].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  assert.deepEqual([tour0.eventDateId, tour1.eventDateId], [d0, d1]);
  const boxKey = tier(ev, 'Box', d0).tierKey;
  assert.deepEqual(tour0.eligibleTiers, [boxKey], 'stored as the tier key');
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual(item(pub.schedule, 'Backstage tour').eligibleTierNames, ['Box']);

  const box1 = (await buy(fan, tier(ev, 'Box', d1).id)).tickets[0].id as string;
  const stalls0 = (await buy(fan, tier(ev, 'Stalls', d0).id)).tickets[0].id as string;
  // A ticket only lists its own date's sessions; another date's is refused with the ticket's date.
  assert.deepEqual(((await ok(call('GET', `/tickets/${box1}/sessions`, undefined, fan.token))).items as Jsons).map((i) => i.id), [tour1.id]);
  const other = await call('POST', `/tickets/${box1}/sessions/${tour0.id}`, undefined, fan.token);
  assert.equal(other.status, 403);
  assert.match(other.body.message, /^This ticket is for /);
  assert.equal((await call('POST', `/tickets/${stalls0}/sessions/${tour0.id}`, undefined, fan.token)).status, 403, 'Stalls is not Box');
  await ok(call('POST', `/tickets/${box1}/sessions/${tour1.id}`, undefined, fan.token));

  // PUT: a copy id works as the tier; a booked item can't move to the other date.
  const cur = asInput((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items);
  const viaCopy = await ok(call('PUT', `/organizer/events/${ev.id}/schedule`, { items: cur.map((i) => (i.id === tour0.id ? { ...i, eligibleTiers: [tier(ev, 'Box', d1).id] } : i)) }, org.token));
  assert.deepEqual(item(viaCopy.items, 'Backstage tour').eligibleTiers, [boxKey]);
  const move = await call('PUT', `/organizer/events/${ev.id}/schedule`, { items: cur.map((i) => (i.id === tour1.id ? { ...i, eventDateId: d0, startsAt: at(12, 18, 50), endsAt: at(12, 19, 30) } : i)) }, org.token);
  assert.deepEqual([move.status, move.body.code], [409, 'ITEM_HAS_BOOKINGS']);

  // DAYS: a weekend pass and a Saturday-only pass; Sunday's session is for weekend passes.
  const days = [
    { startsAt: at(20, 12), endsAt: at(20, 23) },
    { startsAt: at(21, 12), endsAt: at(21, 23) },
  ];
  const dayTiers = [
    { name: 'Weekend', basePriceCents: 8000, capacity: 20, validDates: ['0', '1'] },
    { name: 'Saturday', basePriceCents: 5000, capacity: 20, validDates: ['0'] },
  ];
  const o2 = await ok(call('POST', '/organizer/orgs', { name: `Schedule Org ${run} days` }, org.token));
  const badTier = await call('POST', `/organizer/orgs/${o2.id}/events`, { title: 'Bad', category: 'FESTIVALS', online: true, timezone: 'UTC', dateMode: 'DAYS', dates: days, ticketTypes: dayTiers, schedule: [{ dateRef: 1, startsAt: at(21, 14), title: 'Yoga', bookable: true, capacity: 5, eligibleTiers: ['1'] }] }, org.token);
  assert.equal(badTier.status, 400);
  assert.match(badTier.body.message, /Item 1: Saturday isn’t valid on /);
  const fest = (await published(org, { category: 'FESTIVALS', dateMode: 'DAYS', dates: days, ticketTypes: dayTiers, schedule: [{ dateRef: 1, startsAt: at(21, 14), endsAt: at(21, 15), title: 'Yoga', bookable: true, capacity: 5 }] })).ev;
  const yoga = fest.schedule[0];
  const sat = (await buy(fan, tier(fest, 'Saturday').id)).tickets[0].id as string;
  const weekend = (await buy(fan, tier(fest, 'Weekend').id)).tickets[0].id as string;
  const satNo = await call('POST', `/tickets/${sat}/sessions/${yoga.id}`, undefined, fan.token);
  assert.equal(satNo.status, 403);
  assert.match(satNo.body.message, /^Your pass isn’t valid on /);
  assert.deepEqual((await ok(call('GET', `/tickets/${sat}/sessions`, undefined, fan.token))).items, []);
  await ok(call('POST', `/tickets/${weekend}/sessions/${yoga.id}`, undefined, fan.token));
  // Checked in on Saturday, the weekend pass can still book Sunday's session (it's still upcoming).
  await prisma.ticket.update({ where: { id: weekend }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
  await ok(call('DELETE', `/tickets/${weekend}/sessions/${yoga.id}`, undefined, fan.token));
  await ok(call('POST', `/tickets/${weekend}/sessions/${yoga.id}`, undefined, fan.token));
});

test('ticket lifecycle: a transfer keeps the booking; resale, refund, void and a cancelled date release it', async () => {
  const org = await account(`sc-org4-${run}@test.local`, 'Sam Organizer');
  const ana = await account(`sc-ana4-${run}@test.local`, 'Ana Fan');
  const ben = await account(`sc-ben4-${run}@test.local`, 'Ben Fan');
  const cal = await account(`sc-cal4-${run}@test.local`, 'Cal Fan');
  const guest = await account(`sc-guest4-${run}@test.local`, 'Gia Guest');
  const { ev } = await published(org, { ...SINGLE(), schedule: [{ startsAt: at(10, 21), endsAt: at(10, 22), title: 'Workshop', bookable: true, capacity: 10 }] });
  const ws = ev.schedule[0];
  const reserved = async () => (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: ws.id } })).reserved;
  const general = tier(ev, 'General');

  // Transfer: same ticket, so the booking goes with it.
  const t1 = (await buy(ana, general.id)).tickets[0].id as string;
  await ok(call('POST', `/tickets/${t1}/sessions/${ws.id}`, undefined, ana.token));
  await ok(call('POST', `/tickets/${t1}/transfer`, { email: ben.user.email }, ana.token));
  await ok(call('POST', `/tickets/${t1}/accept`, undefined, ben.token));
  assert.equal(((await ok(call('GET', '/me/tickets', undefined, ben.token))).tickets as Jsons).find((t) => t.id === t1).sessions.length, 1);
  assert.equal(await reserved(), 1);
  // The new holder can cancel it; the old one can't see the ticket any more.
  assert.equal((await call('DELETE', `/tickets/${t1}/sessions/${ws.id}`, undefined, ana.token)).status, 404);

  // Resale: the buyer gets a new ticket, the seller's booking is released.
  const t2 = (await buy(cal, general.id)).tickets[0].id as string;
  await ok(call('POST', `/tickets/${t2}/sessions/${ws.id}`, undefined, cal.token));
  assert.equal(await reserved(), 2);
  const listed = await ok(call('POST', `/tickets/${t2}/listing`, { priceCents: general.priceCents }, cal.token));
  const hold = await ok(call('POST', `/resale/${listed.listingId}/hold`, undefined, ana.token));
  const ro = await ok(call('POST', `/resale/${listed.listingId}/orders`, { holdKey: hold.holdKey, email: ana.user.email, name: ana.user.name }, ana.token));
  const bought = await ok(call('POST', `/orders/${ro.orderId}/pay`));
  assert.equal(await reserved(), 1);
  assert.ok((await prisma.sessionReservation.findFirstOrThrow({ where: { ticketId: t2 } })).cancelledAt);
  assert.equal(await prisma.sessionReservation.count({ where: { ticketId: bought.tickets[0].id } }), 0);

  // Refund (Omoshow admin refunds the order): released.
  const paid = await buy(cal, general.id);
  const t3 = paid.tickets[0].id as string;
  await ok(call('POST', `/tickets/${t3}/sessions/${ws.id}`, undefined, cal.token));
  assert.equal(await reserved(), 2);
  await ok(call('POST', `/admin/orders/${paid.id ?? paid.orderId}/refund`, { reason: 'Changed plans' }, admin.token));
  assert.equal(await reserved(), 1);

  // Void (the organizer cancels a comp): released.
  const issued = await ok(call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'Gia Guest', email: guest.user.email }] }, org.token));
  const c = issued.items[0];
  const gift = await prisma.gift.findUniqueOrThrow({ where: { orderId: c.orderId } });
  await waitFor(() => prisma.gift.findFirst({ where: { id: gift.id, sentAt: { not: null } } }));
  await ok(call('POST', `/gifts/${gift.token}/claim`, undefined, guest.token));
  await ok(call('POST', `/tickets/${c.ticketId}/sessions/${ws.id}`, undefined, guest.token));
  assert.equal(await reserved(), 2);
  await ok(call('POST', `/organizer/events/${ev.id}/comps/${c.orderId}/revoke`, { reason: 'Wrong person' }, org.token));
  assert.equal(await reserved(), 1);
  assert.equal(await prisma.sessionReservation.count({ where: { scheduleItemId: ws.id, cancelledAt: null } }), 1, 'only the transferred one is left');

  // A cancelled date (multiple dates): its tickets' bookings go.
  const two = await published(org, {
    dateMode: 'DATES',
    dates: [{ startsAt: at(15, 19) }, { startsAt: at(16, 19) }],
    ticketTypes: [{ name: 'Seat', basePriceCents: 2500, capacity: 10 }],
    schedule: [
      { dateRef: 0, startsAt: at(15, 18), title: 'Talk', bookable: true, capacity: 5 },
      { dateRef: 1, startsAt: at(16, 18), title: 'Talk', bookable: true, capacity: 5 },
    ],
  });
  const [e0, e1] = (two.ev.dates as Jsons).map((d) => d.id as string);
  const talk0 = (two.ev.schedule as Jsons).find((i) => i.eventDateId === e0);
  const talk1 = (two.ev.schedule as Jsons).find((i) => i.eventDateId === e1);
  const s0 = (await buy(ana, tier(two.ev, 'Seat', e0).id)).tickets[0].id as string;
  const s1 = (await buy(ana, tier(two.ev, 'Seat', e1).id)).tickets[0].id as string;
  await ok(call('POST', `/tickets/${s0}/sessions/${talk0.id}`, undefined, ana.token));
  await ok(call('POST', `/tickets/${s1}/sessions/${talk1.id}`, undefined, ana.token));
  await ok(call('POST', `/organizer/events/${two.ev.id}/dates/${e0}/cancel`, { reason: 'The lead actor is ill, sorry' }, org.token));
  assert.equal((await prisma.scheduleItem.findUniqueOrThrow({ where: { id: talk0.id } })).reserved, 0);
  assert.equal((await prisma.scheduleItem.findUniqueOrThrow({ where: { id: talk1.id } })).reserved, 1, 'the other date keeps its bookings');
  // The cancelled date's items leave the public schedule.
  assert.deepEqual(((await ok(call('GET', `/events/${two.ev.slug}`))).schedule as Jsons).map((i) => i.id), [talk1.id]);
});

test('organizer changes: moving or removing a booked session tells its holders; turning booking off releases places', async () => {
  const org = await account(`sc-org5-${run}@test.local`, 'Sam Organizer');
  const ana = await account(`sc-ana5-${run}@test.local`, 'Ana Fan');
  const ben = await account(`sc-ben5-${run}@test.local`, 'Ben Fan');
  const { ev } = await published(org, SINGLE());
  const sched = ev.schedule as Jsons;
  const meet = item(sched, 'Meet and greet');
  const tasting = item(sched, 'Tasting');
  const a = ((await buy(ana, tier(ev, 'General').id, 2)).tickets as Jsons).map((t) => t.id as string);
  const b = (await buy(ben, tier(ev, 'General').id)).tickets[0].id as string;
  for (const t of a) await ok(call('POST', `/tickets/${t}/sessions/${meet.id}`, undefined, ana.token));
  await ok(call('POST', `/tickets/${b}/sessions/${meet.id}`, undefined, ben.token));
  await ok(call('POST', `/tickets/${b}/sessions/${tasting.id}`, undefined, ben.token));
  const get = async () => asInput((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items);
  const put = (items: Jsons) => ok(call('PUT', `/organizer/events/${ev.id}/schedule`, { items }, org.token));

  // A new time: both holders hear once each (Ana booked with two tickets), bookings stay.
  const moved = await put((await get()).map((i) => (i.id === meet.id ? { ...i, startsAt: at(10, 22, 15), endsAt: at(10, 22, 30) } : i)));
  assert.equal(moved.notified, 2);
  assert.equal(item(moved.items, 'Meet and greet').reserved, 3);
  const movedMail = await waitFor(async () => {
    const rows = await prisma.emailLog.findMany({ where: { kind: 'session.moved', to: { in: [ana.user.email, ben.user.email] } } });
    return rows.length === 2 ? rows : null;
  });
  assert.ok(movedMail.every((m) => m.subject === 'Session moved: Meet and greet'));
  const pushes = await waitFor(async () => {
    const rows = await prisma.notificationLog.findMany({ where: { kind: 'session.moved', userId: { in: [ana.user.id, ben.user.id] } } });
    return rows.length === 2 ? rows : null;
  });
  assert.ok(pushes.every((p) => p.title === 'Session moved: Meet and greet'));
  // Saving the same list again tells nobody.
  assert.equal((await put(await get())).notified, 0);

  // Booking turned off on Tasting: its place is released and Ben is told it's cancelled.
  const off = await put((await get()).map((i) => (i.id === tasting.id ? { ...i, bookable: false, capacity: null } : i)));
  assert.equal(off.notified, 1);
  assert.equal(await prisma.sessionReservation.count({ where: { scheduleItemId: tasting.id, cancelledAt: null } }), 0);
  assert.deepEqual([item(off.items, 'Tasting').bookable, item(off.items, 'Tasting').reserved], [false, 0]);

  // Removed with bookings: kept as cancelled (out of every view), bookings released, holders told.
  const removed = await put((await get()).filter((i) => i.id !== meet.id));
  assert.equal(removed.notified, 2);
  const row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: meet.id } });
  assert.ok(row.cancelledAt);
  assert.equal(row.reserved, 0);
  assert.equal(await prisma.sessionReservation.count({ where: { scheduleItemId: meet.id, cancelledAt: null } }), 0);
  await waitFor(async () => ((await prisma.emailLog.count({ where: { kind: 'session.cancelled', subject: 'Session cancelled: Meet and greet', to: { in: [ana.user.email, ben.user.email] } } })) === 2 ? true : null));
  assert.equal(item((await ok(call('GET', `/events/${ev.slug}`))).schedule, 'Meet and greet'), undefined);
  assert.deepEqual(((await ok(call('GET', '/me/tickets', undefined, ben.token))).tickets as Jsons).find((t) => t.id === b).sessions, []);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'schedule.update', entityId: ev.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([(audit!.data as Json).cancelledSessions, (audit!.data as Json).notified], [[meet.id], 2]);
});

test('session check-in: ADMIT, ALREADY_IN, NOT_BOOKED, WRONG_DATE, INVALID; tap to check in, undo, CSV', async () => {
  const org = await account(`sc-org6-${run}@test.local`, 'Sam Organizer');
  const door = await account(`sc-door6-${run}@test.local`, 'Dora Door');
  const fan = await account(`sc-fan6-${run}@test.local`, 'Fay Fan');
  const { ev } = await published(
    org,
    {
      dateMode: 'DATES',
      dates: [{ startsAt: at(8, 19) }, { startsAt: at(9, 19) }],
      ticketTypes: [{ name: 'Seat', basePriceCents: 2500, capacity: 10 }],
      schedule: [{ dateRef: 0, startsAt: at(8, 18), title: 'Pre-show talk', bookable: true, capacity: 5 }],
    },
    door,
  );
  const [d0, d1] = (ev.dates as Jsons).map((x) => x.id as string);
  const talk = ev.schedule[0];
  const [booked, unbooked] = ((await buy(fan, tier(ev, 'Seat', d0).id, 2)).tickets as Jsons).map((t) => t.id as string);
  const otherDate = (await buy(fan, tier(ev, 'Seat', d1).id)).tickets[0].id as string;
  const r = await ok(call('POST', `/tickets/${booked}/sessions/${talk.id}`, undefined, fan.token));
  const scan = (code: string, token = door.token) => call('POST', `/organizer/events/${ev.id}/schedule/${talk.id}/check-in`, { code }, token);

  const qr = await ok(call('GET', `/tickets/${booked}/qr`, undefined, fan.token));
  const admit = (await scan(qr.token)).body;
  assert.deepEqual([admit.result, admit.ticket.id, admit.reservation.id], ['ADMIT', booked, r.id]);
  assert.ok(admit.reservation.checkedInAt);
  const again = (await scan(booked.toLowerCase())).body;
  assert.equal(again.result, 'ALREADY_IN');
  assert.match(again.message, /^Already checked in to this session at /);
  assert.equal((await scan(unbooked)).body.result, 'NOT_BOOKED');
  const wrong = (await scan(otherDate)).body;
  assert.equal(wrong.result, 'WRONG_DATE');
  assert.match(wrong.message, /^This ticket is for /);
  assert.equal((await scan('NOPE-1234')).body.result, 'INVALID');
  assert.equal((await scan(`${booked}.123.notasignaturexxxxxxxxx`)).body.result, 'INVALID');
  assert.equal((await scan(booked, fan.token)).status, 404, 'not a member');

  // The bookings list, with the check-in; undo and tap.
  const list = await ok(call('GET', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations`, undefined, door.token));
  assert.deepEqual([list.item.reserved, list.item.checkedIn, list.items.length], [1, 1, 1]);
  assert.deepEqual([list.items[0].ticketId, list.items[0].holderName, list.items[0].holderEmail, list.items[0].ticketType], [booked, 'Fay Fan', fan.user.email, 'Seat']);
  assert.ok(list.items[0].checkedInAt);
  const undone = await ok(call('DELETE', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations/${r.id}/check-in`, undefined, door.token));
  assert.equal(undone.reservation.checkedInAt, null);
  assert.equal((await call('DELETE', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations/${r.id}/check-in`, undefined, door.token)).status, 400);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'session.check_in_undo', entityId: r.id } }));
  const tap = await ok(call('POST', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations/${r.id}/check-in`, undefined, door.token));
  assert.equal(tap.result, 'ADMIT');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations/${r.id}/check-in`, undefined, door.token))).result, 'ALREADY_IN');
  // Session check-in is apart from the door: the ticket isn't checked in to the event.
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: booked } })).status, 'ACTIVE');
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  assert.equal((mine.tickets as Jsons).find((t) => t.id === booked).sessions[0].checkedIn, true);

  const csv = await call('GET', `/organizer/events/${ev.id}/schedule/${talk.id}/reservations?format=csv`, undefined, door.token);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  const lines = String(csv.body.text).split('\r\n');
  assert.equal(lines[0], '"Name","Email","Ticket","Ticket type","Booked at","Checked in at"');
  assert.ok(lines[1].startsWith(`"Fay Fan","${fan.user.email}","${booked}","Seat"`));
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, door.token));
  assert.deepEqual([stats.sessions[0].reserved, stats.sessions[0].checkedIn], [1, 1]);
});

test('an event without a schedule works as before', async () => {
  const org = await account(`sc-org7-${run}@test.local`, 'Sam Organizer');
  const fan = await account(`sc-fan7-${run}@test.local`, 'Fay Fan');
  const { ev } = await published(org, { startsAt: at(10, 20), ticketTypes: [{ name: 'General', basePriceCents: 2000, capacity: 50 }] });
  assert.equal('schedule' in ev, false, 'create answers as before');
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual([pub.schedule, pub.stages], [[], []]);
  const t = (await buy(fan, ev.ticketTypes[0].id)).tickets[0].id as string;
  assert.deepEqual((await ok(call('GET', `/tickets/${t}/sessions`, undefined, fan.token))).items, []);
  assert.deepEqual(((await ok(call('GET', '/me/tickets', undefined, fan.token))).tickets as Jsons).find((x) => x.id === t).sessions, []);
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.sessions, []);
  assert.deepEqual((await ok(call('GET', `/organizer/events/${ev.id}/schedule`, undefined, org.token))).items, []);
  // A refund with nothing booked is unchanged.
  const paid = await buy(fan, ev.ticketTypes[0].id);
  await ok(call('POST', `/admin/orders/${paid.id ?? paid.orderId}/refund`, { reason: 'Changed plans' }, admin.token));
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: paid.tickets[0].id } })).status, 'VOID');
});
