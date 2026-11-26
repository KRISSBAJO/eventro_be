/**
 * Multiple dates (DATES: separate performances, a copy of every tier per date) and multi-day events (DAYS: ticket
 * types valid on one or more days): creating and editing dates, buying on a date, the door per date (online and
 * offline), cancelling one date, the Omoshow Guarantee per date and per day, list items, and one-date events unchanged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { doorDate, summaryTimes } from '../src/domain/event-dates';
import { planDates } from '../src/organizer/event-dates';
import { splitCents } from '../src/guarantee/guarantee';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const DAY = 86_400_000;
const HOUR = 3_600_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A JSON array (finds return a plain value: the tests assert on it straight away). */
type Jsons = any[]; // eslint-disable-line @typescript-eslint/no-explicit-any

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
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
});

/** A wall-clock time `days` from now at `hour`:00 (UTC venue, so wall clock = real time). */
const at = (days: number, hour = 20) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

let n = 0;
/** An organization with a published event made from `body` (plus a UTC venue). */
async function published(org: string, admin: string, body: Json) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Dates Org ${run} ${n}` }, org));
  const ev = await ok(
    call('POST', `/organizer/orgs/${o.id}/events`, { title: `Run ${run} ${n}`, category: 'THEATER', venue: { name: 'Date Hall', address: '1 Date St', city: 'London', country: 'GB' }, timezone: 'UTC', ...body }, org),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  return { org: o as Json, ev };
}

/** Buys `qty` of a ticket type and pays (mock provider). */
async function buy(buyer: { token: string; user: Json }, ticketTypeId: string, qty = 1, extra: Json = {}) {
  const h = await ok(call('POST', '/holds', { ticketTypeId, quantity: qty, ...extra }, buyer.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: buyer.user.email, name: buyer.user.name }, buyer.token));
  return ok(call('POST', `/orders/${o.orderId}/pay`));
}

test('domain: summary times, the door’s default date, and date checks', () => {
  const d = (id: string, s: string, status = 'ACTIVE', end: string | null = null) => ({ id, startsAt: new Date(s), doorsAt: null, endsAt: end ? new Date(end) : null, label: null, status });
  const dates = [d('a', '2026-12-12T20:00:00Z'), d('b', '2026-12-13T14:00:00Z'), d('c', '2026-12-13T20:00:00Z', 'ACTIVE', '2026-12-13T23:00:00Z'), d('x', '2026-12-20T20:00:00Z', 'CANCELLED')];
  assert.deepEqual(summaryTimes(dates), { startsAt: new Date('2026-12-12T20:00:00Z'), doorsAt: null, endsAt: new Date('2026-12-13T23:00:00Z') });
  // Today at the venue: the latest one that has started; before any has, the first of the day; between days, the next.
  assert.equal(doorDate(dates, 'UTC', new Date('2026-12-13T21:00:00Z'))?.id, 'c');
  assert.equal(doorDate(dates, 'UTC', new Date('2026-12-13T09:00:00Z'))?.id, 'b');
  assert.equal(doorDate(dates, 'UTC', new Date('2026-12-10T09:00:00Z'))?.id, 'a');
  assert.equal(doorDate(dates, 'UTC', new Date('2027-01-10T09:00:00Z'))?.id, 'c');
  // Lagos is UTC+1: 23:30Z on the 12th is already the 13th there.
  assert.equal(doorDate(dates, 'Africa/Lagos', new Date('2026-12-12T23:30:00Z'))?.id, 'b');

  // Noon, so an hour later is still the same calendar day whenever the test runs.
  const future = new Date(new Date(Date.now() + 10 * DAY).setUTCHours(12, 0, 0, 0)).toISOString();
  assert.throws(() => planDates('DAYS', [{ startsAt: future }, { startsAt: new Date(new Date(future).getTime() + HOUR).toISOString() }]), /Two days fall on/);
  assert.throws(() => planDates('DATES', [{ startsAt: new Date(Date.now() - DAY).toISOString() }]), /is in the past/);
  assert.throws(() => planDates('DATES', [{ startsAt: future, doorsAt: new Date(new Date(future).getTime() + HOUR).toISOString() }]), /doors can’t open after the start/);
  assert.throws(() => planDates('DATES', [{ startsAt: future, endsAt: new Date(new Date(future).getTime() - HOUR).toISOString() }]), /end has to be after the start/);
  assert.throws(() => planDates('DAYS', Array.from({ length: 15 }, (_, i) => ({ startsAt: new Date(Date.now() + (i + 2) * DAY).toISOString() }))), /up to 14 days/);
  assert.equal(planDates('DATES', [{ startsAt: future, label: '  Matinee ' }])[0].label, 'Matinee');
});

test('DATES: a copy of every tier per date, per-date capacity, tier edits reach every copy, dates added and removed', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dates-org1-${run}@test.local`, 'Dee Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Dates Org ${run} create` }, org.token));
  const created = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Hamlet ${run}`,
        category: 'THEATER',
        online: true,
        timezone: 'UTC',
        dateMode: 'DATES',
        startsAt: at(1), // ignored: the times come from the dates
        dates: [
          { startsAt: at(12, 20), doorsAt: at(12, 19), endsAt: at(12, 23), label: 'Opening night' },
          { startsAt: at(13, 14), label: 'Matinee' },
          { startsAt: at(13, 20) },
        ],
        ticketTypes: [
          { name: 'Stalls', basePriceCents: 3000, capacity: 100, capacityByDate: { '1': 40 } },
          { name: 'Circle', basePriceCents: 2000, capacity: 50 },
        ],
      },
      org.token,
    ),
  );
  assert.equal(created.dateMode, 'DATES');
  assert.equal(created.dates.length, 3);
  const [opening, matinee, evening] = created.dates as Json[];
  assert.equal(opening.label, 'Opening night');
  // Summary: the earliest start and doors, the latest end (or start).
  assert.equal(new Date(created.startsAt).toISOString(), at(12, 20));
  assert.equal(new Date(created.doorsAt).toISOString(), at(12, 19));
  assert.equal(new Date(created.endsAt).toISOString(), at(13, 20));
  // 2 tiers × 3 dates, copies of a tier share a tierKey; the matinee's Stalls has 40 places.
  assert.equal(created.ticketTypes.length, 6);
  const stalls = (created.ticketTypes as Jsons).filter((t) => t.name === 'Stalls');
  assert.equal(new Set(stalls.map((t) => t.tierKey)).size, 1);
  assert.deepEqual(stalls.map((t) => [t.eventDateId, t.capacity]).sort(), [[opening.id, 100], [matinee.id, 40], [evening.id, 100]].sort());

  // A tier edit (price, perks) reaches every copy; capacity can be set on one date.
  const edit = await ok(call('PATCH', `/organizer/events/${created.id}/ticket-types/${stalls[0].id}`, { basePriceCents: 3500, perks: ['Programme included'], capacityByDate: { [evening.id]: 80 } }, org.token));
  assert.equal(edit.copies.length, 3);
  const after = await ok(call('GET', `/organizer/events/${created.id}`, undefined, org.token));
  const stalls2 = (after.ticketTypes as Jsons).filter((t) => t.tierKey === stalls[0].tierKey);
  assert.equal(new Set(stalls2.map((t) => t.priceCents)).size, 1);
  assert.ok(stalls2.every((t) => t.priceCents > stalls[0].priceCents && t.perks[0] === 'Programme included'));
  assert.deepEqual(stalls2.map((t) => [t.eventDateId, t.capacity]).sort(), [[opening.id, 100], [matinee.id, 40], [evening.id, 80]].sort());

  // A new tier gets a copy on every date; reordering takes one id per tier.
  const vip = await ok(call('POST', `/organizer/events/${created.id}/ticket-types`, { name: 'Box', basePriceCents: 9000, capacity: 8 }, org.token));
  assert.equal(vip.copies.length, 3);
  const order = await ok(call('PUT', `/organizer/events/${created.id}/ticket-types/order`, { ids: [vip.tierKey, stalls[0].id, (created.ticketTypes as Jsons).find((t) => t.name === 'Circle').id] }, org.token));
  assert.deepEqual([...new Set((order as Jsons).map((t) => t.name))], ['Box', 'Stalls', 'Circle']);

  // Dates: change a label, add one (copies of every tier), remove one without sales.
  const patched = await ok(
    call(
      'PATCH',
      `/organizer/events/${created.id}`,
      {
        dates: [
          { id: opening.id, startsAt: opening.startsAt, doorsAt: opening.doorsAt, endsAt: opening.endsAt, label: 'Gala' },
          { id: matinee.id, startsAt: matinee.startsAt, label: 'Matinee' },
          { startsAt: at(14, 20), label: 'Extra show' },
        ],
      },
      org.token,
    ),
  );
  assert.deepEqual((patched.dates as Jsons).map((d) => d.label), ['Gala', 'Matinee', 'Extra show']);
  assert.equal(new Date(patched.endsAt).toISOString(), at(14, 20));
  const extra = (patched.dates as Jsons)[2];
  const copies = await prisma.ticketType.findMany({ where: { eventDateId: extra.id } });
  assert.deepEqual(copies.map((c) => c.name).sort(), ['Box', 'Circle', 'Stalls']);
  assert.equal(copies.find((c) => c.name === 'Stalls')!.priceCents, stalls2[0].priceCents);
  assert.equal(await prisma.ticketType.count({ where: { eventDateId: evening.id } }), 0);

  // A date with sales can't be removed (cancel it instead); a past date can't be added.
  await ok(call('POST', `/organizer/events/${created.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${created.id}/approve`, undefined, admin.token));
  const fan = await account(`dates-fan1-${run}@test.local`, 'Fay Fan');
  await buy(fan, copies.find((c) => c.name === 'Circle')!.id);
  const keep = (patched.dates as Jsons).slice(0, 2).map((d) => ({ id: d.id, startsAt: d.startsAt, doorsAt: d.doorsAt ?? undefined, endsAt: d.endsAt ?? undefined, label: d.label ?? undefined }));
  const refused = await call('PATCH', `/organizer/events/${created.id}`, { dates: keep }, org.token);
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /has orders, so it can’t be removed\. Cancel that date instead\./);
  const past = await call('PATCH', `/organizer/events/${created.id}`, { dates: [...keep, { startsAt: new Date(Date.now() - DAY).toISOString() }] }, org.token);
  assert.equal(past.status, 400);
  // Switching mode needs an event without orders.
  const mode = await call('PATCH', `/organizer/events/${created.id}`, { dateMode: 'SINGLE', startsAt: at(20) }, org.token);
  assert.equal(mode.status, 409);
  assert.equal(mode.body.code, 'DATE_MODE_LOCKED');
});

test('DATES: buying on a date: inventory and seats are per date; the event page shows each date', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dates-org2-${run}@test.local`, 'Dan Organizer');
  const fan = await account(`dates-fan2-${run}@test.local`, 'Femi Fan');
  const { ev } = await published(org.token, admin.token, {
    dateMode: 'DATES',
    dates: [{ startsAt: at(20) }, { startsAt: at(21) }],
    ticketTypes: [
      { name: 'Seated', basePriceCents: 2500, capacity: 10 },
      { name: 'Standing', basePriceCents: 1000, capacity: 2 },
    ],
  });
  const [d1, d2] = ev.dates as Json[];
  const copy = (name: string, d: Json) => (ev.ticketTypes as Jsons).find((t) => t.name === name && t.eventDateId === d.id);
  // One seat map for every date: sections point at the tier (any copy's id is accepted and stored as the tierKey).
  const seatMap = {
    version: 1,
    width: 600,
    height: 400,
    sections: [{ id: 'A', label: 'Block A', ticketTypeId: copy('Seated', d2).id, shape: 'rect', seating: 'reserved', rows: 2, seatsPerRow: 5, geometry: { x: 10, y: 10, w: 200, h: 100 } }],
  };
  const saved = await ok(call('PUT', `/organizer/events/${ev.id}/seat-map`, { seatMap }, org.token));
  assert.equal(saved.seatMap.sections[0].ticketTypeId, copy('Seated', d1).tierKey);

  // The same seat sells once per date.
  const a1 = await buy(fan, copy('Seated', d1).id, 1, { sectionId: 'A', seats: [{ row: 'A', seat: 1 }] });
  const a2 = await buy(fan, copy('Seated', d2).id, 1, { sectionId: 'A', seats: [{ row: 'A', seat: 1 }] });
  assert.deepEqual([a1.tickets[0].row, a1.tickets[0].seat, a2.tickets[0].row, a2.tickets[0].seat], ['A', 1, 'A', 1]);
  assert.equal(a1.date.id, d1.id);
  assert.equal(a2.date.id, d2.id);
  const again = await call('POST', '/holds', { ticketTypeId: copy('Seated', d1).id, quantity: 1, sectionId: 'A', seats: [{ row: 'A', seat: 1 }] }, fan.token);
  assert.equal(again.status, 409);
  const taken1 = await ok(call('GET', `/events/${ev.slug}/sections/A/seats?date=${d1.id}`));
  const taken2 = await ok(call('GET', `/events/${ev.slug}/sections/A/seats?date=${d2.id}`));
  assert.deepEqual([taken1.taken, taken2.taken, taken1.dateId], [['A:1'], ['A:1'], d1.id]);
  const tickets = await prisma.ticket.findMany({ where: { orderId: { in: [a1.id, a2.id] } } });
  assert.deepEqual(tickets.map((t) => t.dateKey).sort(), [d1.id, d2.id].sort());

  // Selling out one date leaves the other on sale.
  await buy(fan, copy('Standing', d1).id, 2);
  const sold = await call('POST', '/holds', { ticketTypeId: copy('Standing', d1).id, quantity: 1 }, fan.token);
  assert.equal(sold.status, 409);
  const page = await ok(call('GET', `/events/${ev.slug}?date=${d2.id}`));
  assert.equal(page.dateMode, 'DATES');
  const [p1, p2] = page.dates as Json[];
  assert.deepEqual([p1.available, p2.available], [9, 11]);
  assert.equal(p1.soldOut, false);
  assert.equal((page.ticketTypes as Jsons).find((t) => t.id === copy('Standing', d1).id).available, 0);
  assert.equal((page.ticketTypes as Jsons).find((t) => t.id === copy('Standing', d2).id).available, 2);
  assert.equal(page.seatMapDateId, d2.id);
  assert.equal(page.seatMap.sections[0].available, 9);

  // My tickets carry the date.
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t1 = (mine.tickets as Jsons).find((t) => t.id === a1.tickets[0].id);
  assert.equal(t1.date.id, d1.id);
  assert.deepEqual(t1.validDates, []);
});

test('DAYS: ticket types are valid on chosen days; a pass gets in once per day, re-entry on the next valid day', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`days-org-${run}@test.local`, 'Dayo Organizer');
  const fan = await account(`days-fan-${run}@test.local`, 'Funke Fan');
  const { ev, org: o } = await published(org.token, admin.token, {
    category: 'FESTIVALS',
    dateMode: 'DAYS',
    dates: [{ startsAt: at(30, 12), label: 'Day 1' }, { startsAt: at(31, 12), label: 'Day 2' }, { startsAt: at(32, 12), label: 'Day 3' }],
    ticketTypes: [
      { name: 'Weekend pass', basePriceCents: 9000, capacity: 50, validDates: ['0', '1', '2'] },
      { name: 'Saturday', basePriceCents: 4000, capacity: 50, validDates: ['1'] },
    ],
  });
  assert.equal(ev.ticketTypes.length, 2);
  const [day1, day2, day3] = ev.dates as Json[];
  // Every DAYS ticket type says which days it covers.
  const missing = await call('POST', `/organizer/orgs/${o.id}/events`, { title: 'No days', category: 'FESTIVALS', online: true, dateMode: 'DAYS', dates: [{ startsAt: at(30) }], ticketTypes: [{ name: 'Day', basePriceCents: 100, capacity: 5 }] }, org.token);
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /pick the days this ticket is valid on/);
  const pass = (ev.ticketTypes as Jsons).find((t) => t.name === 'Weekend pass');
  const sat = (ev.ticketTypes as Jsons).find((t) => t.name === 'Saturday');
  assert.deepEqual(pass.validDateIds, [day1.id, day2.id, day3.id]);
  assert.deepEqual(sat.validDateIds, [day2.id]);
  // Sold days can only be added to.
  const p = await buy(fan, pass.id, 1);
  const s = await buy(fan, sat.id, 1);
  assert.deepEqual(p.validDates.map((d: Json) => d.id), [day1.id, day2.id, day3.id]);
  const shrink = await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${pass.id}`, { validDates: [day1.id] }, org.token);
  assert.equal(shrink.status, 400);

  const scan = (ticketId: string, eventDateId: string) => ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ticketId, eventDateId, deviceId: 'gate-1' }, org.token));
  const passId = p.tickets[0].id;
  const satId = s.tickets[0].id;
  // Day 1: the pass is in; the Saturday ticket isn't valid.
  assert.equal((await scan(passId, day1.id)).result, 'ok');
  const wrong = await scan(satId, day1.id);
  assert.equal(wrong.result, 'wrong-date');
  assert.match(wrong.message, /^Not valid today\. Valid /);
  assert.equal(wrong.date.id, day1.id);
  // Again on day 1: already in today.
  const dup = await scan(passId, day1.id);
  assert.equal(dup.result, 'duplicate');
  assert.equal(dup.message, 'Already checked in today.');
  // Day 2: in again (re-entry on another valid day); the ticket stays CHECKED_IN from its first entry.
  assert.equal((await scan(passId, day2.id)).result, 'ok');
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: passId }, include: { checkIns: true } });
  assert.equal(t.status, 'CHECKED_IN');
  assert.deepEqual(t.checkIns.map((c) => c.eventDateId).sort(), [day1.id, day2.id].sort());
  // A used pass still shows its code (it has days left).
  await ok(call('GET', `/tickets/${passId}/qr`, undefined, fan.token));
  // Undo day 2 only.
  await ok(call('DELETE', `/organizer/events/${ev.id}/check-in/${passId}?eventDateId=${day2.id}`, undefined, org.token));
  assert.equal(await prisma.ticketCheckIn.count({ where: { ticketId: passId } }), 1);
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: passId } })).status, 'CHECKED_IN');

  // Offline: day 3 scans sync with their date; the same scan again is a replay; a wrong-day scan is refused.
  const scannedAt = new Date(Date.now() - 60_000).toISOString();
  const sync = await ok(
    call(
      'POST',
      `/organizer/events/${ev.id}/check-ins/sync`,
      { deviceId: 'offline-1', eventDateId: day3.id, scans: [{ ticketId: passId, scannedAt }, { ticketId: satId, scannedAt }, { ticketId: passId, scannedAt: new Date(Date.now() - 30_000).toISOString() }] },
      org.token,
    ),
  );
  assert.deepEqual((sync.results as Jsons).sort((a, b) => a.index - b.index).map((r) => [r.result, r.reason ?? null, r.eventDateId]), [
    ['checked_in', null, day3.id],
    ['invalid', 'wrong-date', day3.id],
    ['already', null, day3.id],
  ]);
  const resend = await ok(call('POST', `/organizer/events/${ev.id}/check-ins/sync`, { deviceId: 'offline-1', scans: [{ ticketId: passId, scannedAt, eventDateId: day3.id }] }, org.token));
  assert.equal(resend.results[0].result, 'checked_in');
  assert.equal(resend.results[0].replay, true);
  // The offline pack carries each ticket's days and entries.
  const pack = await ok(call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, org.token));
  assert.equal(pack.dateMode, 'DAYS');
  const packed = (pack.tickets as Jsons).find((x) => x.id === passId);
  assert.deepEqual(packed.validDateIds, [day1.id, day2.id, day3.id]);
  assert.deepEqual(packed.checkIns.map((c: Json) => c.eventDateId).sort(), [day1.id, day3.id].sort());

  // Stats per day: entries that day.
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual((stats.byDate as Jsons).map((d) => [d.dateId, d.sold, d.checkedIn]), [
    [day1.id, 1, 1],
    [day2.id, 2, 0],
    [day3.id, 1, 1],
  ]);
});

test('DATES at the door: only on the ticket’s own date (online and offline); the door picker shows the dates', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`door-org-${run}@test.local`, 'Dora Organizer');
  const fan = await account(`door-fan-${run}@test.local`, 'Fola Fan');
  const { ev, org: o } = await published(org.token, admin.token, { dateMode: 'DATES', dates: [{ startsAt: at(5) }, { startsAt: at(6), label: 'Late show' }], ticketTypes: [{ name: 'GA', basePriceCents: 1500, capacity: 20 }] });
  const [d1, d2] = ev.dates as Json[];
  const tt2 = (ev.ticketTypes as Jsons).find((t) => t.eventDateId === d2.id);
  const paid = await buy(fan, tt2.id, 2);
  const [x, y] = paid.tickets as Json[];
  const wrong = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: x.id, eventDateId: d1.id }, org.token));
  assert.equal(wrong.result, 'wrong-date');
  assert.match(wrong.message, /^This ticket is for .*\(Late show\)\.$/);
  assert.equal(wrong.ticket.date.id, d2.id);
  const scan = await prisma.scanAttempt.findFirst({ where: { ticketId: x.id }, orderBy: { at: 'desc' } });
  assert.equal(scan?.result, 'WRONG_DATE');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: x.id, eventDateId: d2.id }, org.token))).result, 'ok');
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: x.id, eventDateId: d2.id }, org.token))).result, 'duplicate');
  assert.equal(await prisma.ticketCheckIn.count({ where: { ticketId: x.id, eventDateId: d2.id } }), 1);
  // Offline: a scan for the other date is refused; its own date is let in.
  const sync = await ok(
    call(
      'POST',
      `/organizer/events/${ev.id}/check-ins/sync`,
      { deviceId: 'door-2', scans: [{ ticketId: y.id, scannedAt: new Date(Date.now() - 5000).toISOString(), eventDateId: d1.id }, { ticketId: y.id, scannedAt: new Date(Date.now() - 4000).toISOString(), eventDateId: d2.id }] },
      org.token,
    ),
  );
  assert.deepEqual((sync.results as Jsons).map((r) => [r.result, r.reason ?? null]), [['invalid', 'wrong-date'], ['checked_in', null]]);
  // The door picker: dates with entries, and the default date.
  const door = await ok(call('GET', `/organizer/orgs/${o.id}/door-events`, undefined, org.token));
  const row = (door as Jsons).find((e) => e.id === ev.id);
  assert.equal(row.dateMode, 'DATES');
  assert.equal(row.currentDateId, d1.id);
  assert.deepEqual(row.dates.map((d: Json) => d.checkedIn), [0, 2]);
  // Attendees for one date.
  const list = await ok(call('GET', `/organizer/events/${ev.id}/attendees?date=${d2.id}`, undefined, org.token));
  assert.equal(list.length, 2);
  assert.deepEqual(await ok(call('GET', `/organizer/events/${ev.id}/attendees?date=${d1.id}`, undefined, org.token)), []);
});

test('cancel one date: only its orders are refunded, the summary moves on, and the last date cancels the event', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cancel-org-${run}@test.local`, 'Cal Organizer');
  const fan = await account(`cancel-fan-${run}@test.local`, 'Cass Fan');
  const { ev } = await published(org.token, admin.token, {
    dateMode: 'DATES',
    dates: [{ startsAt: at(8) }, { startsAt: at(9) }, { startsAt: at(10) }],
    ticketTypes: [{ name: 'GA', basePriceCents: 2000, capacity: 20 }],
    donationsEnabled: true,
    donationCause: 'Theatre Fund',
  });
  const [d1, d2, d3] = ev.dates as Json[];
  const copy = (d: Json) => (ev.ticketTypes as Jsons).find((t) => t.eventDateId === d.id).id;
  const h1 = await ok(call('POST', '/holds', { ticketTypeId: copy(d1), quantity: 2 }, fan.token));
  const o1 = await ok(call('POST', '/orders', { holdId: h1.id, email: fan.user.email, name: fan.user.name, donationCents: 500 }, fan.token));
  const p1 = await ok(call('POST', `/orders/${o1.orderId}/pay`));
  const p2 = await buy(fan, copy(d2), 1);
  // Make date 1's copy the cheapest, to see it drop out of the from-price once the date is cancelled.
  await prisma.ticketType.update({ where: { id: copy(d1) }, data: { priceCents: 100 } });
  const noReason = await call('POST', `/organizer/events/${ev.id}/dates/${d1.id}/cancel`, {}, org.token);
  assert.equal(noReason.status, 400);

  const preview = await ok(call('GET', `/organizer/events/${ev.id}/dates/${d1.id}/cancel-preview`, undefined, org.token));
  assert.deepEqual([preview.paidOrders, preview.tickets, preview.cancelsEvent], [1, 2, false]);
  const r = await ok(call('POST', `/organizer/events/${ev.id}/dates/${d1.id}/cancel`, { reason: 'The lead actor is unwell tonight.' }, org.token));
  assert.equal(r.refunded, 1);
  assert.equal(r.ticketsVoided, 2);
  assert.equal(r.eventCancelled, false);
  // Refunded in full, donation included; the other date's order is untouched.
  const o1After = await prisma.order.findUniqueOrThrow({ where: { id: p1.id } });
  assert.equal(o1After.status, 'REFUNDED');
  assert.equal(o1After.refundedCents, o1After.totalCents);
  assert.equal(o1After.donationRefundedCents, 500);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: p2.id } })).status, 'PAID');
  assert.equal(await prisma.ticket.count({ where: { eventDateId: d1.id, status: { not: 'VOID' } } }), 0);
  // The date is cancelled, stops selling, and the event's summary starts at the next date.
  const page = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(page.dates[0].status, 'CANCELLED');
  assert.equal(page.dates[0].available, 0);
  assert.equal(new Date(page.startsAt).toISOString(), new Date(d2.startsAt).toISOString());
  const held = await call('POST', '/holds', { ticketTypeId: copy(d1), quantity: 1 }, fan.token);
  assert.equal(held.status, 400);
  assert.match(held.body.message, /This date was cancelled/);
  const audit = await prisma.auditLog.findFirst({ where: { entity: 'Event', entityId: ev.id, action: 'event.date_cancel' } });
  assert.ok(audit);
  // Calling again only retries (nothing to do).
  // A retry needs no reason: the preview shows the stored one, and the retry keeps it.
  const after1 = await ok(call('GET', `/organizer/events/${ev.id}/dates/${d1.id}/cancel-preview`, undefined, org.token));
  assert.equal(after1.cancelReason, 'The lead actor is unwell tonight.');
  assert.equal(after1.date.status, 'CANCELLED');
  const again = await ok(call('POST', `/organizer/events/${ev.id}/dates/${d1.id}/cancel`, {}, org.token));
  assert.deepEqual([again.alreadyCancelled, again.refunded], [true, 0]);

  // The fan still sees the voided tickets, marked with the cancelled date and its reason.
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const gone = (mine.tickets as Jsons).filter((t) => t.date?.id === d1.id);
  assert.equal(gone.length, 2);
  assert.ok(gone.every((t) => t.status === 'VOID' && t.date.status === 'CANCELLED' && t.date.cancelReason === 'The lead actor is unwell tonight.'));
  // Display sums leave the cancelled date's copies out: from-price (event page, list, venue page) and capacity.
  assert.notEqual(page.fromCents, 100);
  const listed = await ok(call('GET', `/events?q=${encodeURIComponent(ev.title)}`));
  assert.notEqual(listed.items[0].fromCents, 100);
  const venue = await prisma.venue.findUniqueOrThrow({ where: { id: ev.venueId } });
  const vpage = await ok(call('GET', `/venues/${venue.slug}`));
  const vev = (vpage.events as Jsons).find((x) => x.slug === ev.slug);
  assert.notEqual(vev.fromCents, 100);
  assert.equal(vev.dateCount, 2);
  const adminList = await ok(call('GET', `/admin/events?q=${encodeURIComponent(ev.title)}`, undefined, admin.token));
  assert.equal(adminList.items[0].capacity, 40);
  assert.equal(adminList.items[0].dates.length, 3);
  const orgEvents = await ok(call('GET', `/organizer/orgs/${ev.orgId}/events`, undefined, org.token));
  assert.equal(orgEvents[0].capacity, 40);

  await ok(call('POST', `/admin/events/${ev.id}/dates/${d3.id}/cancel`, { reason: 'The theatre is closed for repairs.' }, admin.token));
  // The last active date: the whole event is cancelled (and its orders refunded).
  const last = await ok(call('POST', `/organizer/events/${ev.id}/dates/${d2.id}/cancel`, { reason: 'The run has been called off.' }, org.token));
  assert.equal(last.eventCancelled, true);
  const e = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(e.status, 'CANCELLED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: p2.id } })).status, 'REFUNDED');
});

test('guarantee: DATES uses the ticket’s own date; DAYS refunds the day’s share and declines a day with a check-in', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gd-org-${run}@test.local`, 'Gus Organizer');
  const fan = await account(`gd-fan-${run}@test.local`, 'Gina Fan');

  // DATES: date 1 is under way, date 2 is next week.
  const a = await published(org.token, admin.token, { dateMode: 'DATES', dates: [{ startsAt: at(3) }, { startsAt: at(7) }], ticketTypes: [{ name: 'GA', basePriceCents: 3000, capacity: 20 }] });
  const [a1, a2] = a.ev.dates as Json[];
  const ttA = (d: Json) => (a.ev.ticketTypes as Jsons).find((t) => t.eventDateId === d.id).id;
  const t1 = (await buy(fan, ttA(a1))).tickets[0].id;
  const t2 = (await buy(fan, ttA(a2))).tickets[0].id;
  await prisma.eventDate.update({ where: { id: a1.id }, data: { startsAt: new Date(Date.now() - HOUR) } });
  const early = await call('POST', `/tickets/${t2}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token);
  assert.equal(early.status, 400);
  assert.match(early.body.message, /Claims open 3 hours before your date starts/);
  const c1 = await ok(call('POST', `/tickets/${t1}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token));
  assert.equal(c1.status, 'PENDING');

  // DAYS: a 3-day pass; day 1 under way, day 2 tomorrow.
  const b = await published(org.token, admin.token, {
    category: 'FESTIVALS',
    dateMode: 'DAYS',
    dates: [{ startsAt: at(3, 12) }, { startsAt: at(4, 12) }, { startsAt: at(5, 12) }],
    ticketTypes: [{ name: '3-day pass', basePriceCents: 10000, capacity: 20, validDates: ['0', '1', '2'] }],
  });
  const [b1, b2, b3] = b.ev.dates as Json[];
  const order = await buy(fan, (b.ev.ticketTypes as Jsons)[0].id, 2);
  const [pa, pb] = (order.tickets as Jsons).map((t) => t.id as string);
  await prisma.eventDate.update({ where: { id: b1.id }, data: { startsAt: new Date(Date.now() - HOUR) } });
  await prisma.eventDate.update({ where: { id: b2.id }, data: { startsAt: new Date(Date.now() - 30 * 60_000) } });
  const status = await ok(call('GET', `/tickets/${pa}/guarantee-claims`, undefined, fan.token));
  assert.equal(status.days.length, 3);
  // The pass's share split evenly over its 3 days.
  const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const share = splitCents(o.totalCents - o.donationCents, 2, 0);
  assert.equal(status.days[0].refundCents, splitCents(share, 3, 0));
  const needDay = await call('POST', `/tickets/${pa}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token);
  assert.equal(needDay.status, 400);
  const notYet = await call('POST', `/tickets/${pa}/guarantee-claims`, { reason: 'DID_NOT_SCAN', eventDateId: b3.id }, fan.token);
  assert.equal(notYet.status, 400);

  // Ticket B was let in on day 2: a claim about day 2 is declined; ticket A (in on day 2 too) claims day 1.
  await ok(call('POST', `/organizer/events/${b.ev.id}/check-in`, { code: pb, eventDateId: b2.id }, org.token));
  await ok(call('POST', `/organizer/events/${b.ev.id}/check-in`, { code: pa, eventDateId: b2.id }, org.token));
  const declined = await ok(call('POST', `/tickets/${pb}/guarantee-claims`, { reason: 'TURNED_AWAY', eventDateId: b2.id }, fan.token));
  assert.equal(declined.status, 'DECLINED');
  assert.equal(declined.auto, true);
  const claim = await ok(call('POST', `/tickets/${pa}/guarantee-claims`, { reason: 'DID_NOT_SCAN', eventDateId: b1.id }, fan.token));
  assert.equal(claim.status, 'PENDING');
  assert.equal(claim.eventDateId, b1.id);
  assert.equal(claim.amountCents, splitCents(share, 3, 0));
  // Approved: that day's share goes back, and the pass still works on its other days.
  const decided = await ok(call('POST', `/admin/guarantee-claims/${claim.id}/decide`, { decision: 'APPROVE' }, admin.token));
  assert.equal(decided.refundStatus, 'REFUNDED');
  assert.equal(decided.date.id, b1.id);
  const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(after.refundedCents, claim.amountCents);
  assert.equal(after.status, 'PARTIALLY_REFUNDED');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: pa } })).status, 'CHECKED_IN');
  assert.equal((await ok(call('POST', `/organizer/events/${b.ev.id}/check-in`, { code: pa, eventDateId: b3.id }, org.token))).result, 'ok');
});

test('list items: nextDate and dateCount; a run whose first show has passed still lists by its next date', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`list-org-${run}@test.local`, 'Lee Organizer');
  const title = `Listed Run ${run}`;
  // In review, the admin card gets the dates like every other event payload.
  const o = await ok(call('POST', '/organizer/orgs', { name: `Review Org ${run}` }, org.token));
  const draft = await ok(call('POST', `/organizer/orgs/${o.id}/events`, { title: `In Review ${run}`, category: 'THEATER', online: true, dateMode: 'DATES', dates: [{ startsAt: at(40) }, { startsAt: at(41) }], ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 5 }] }, org.token));
  await ok(call('POST', `/organizer/events/${draft.id}/submit`, undefined, org.token));
  const reviews = await ok(call('GET', '/admin/reviews', undefined, admin.token));
  assert.equal((reviews as Jsons).find((r) => r.id === draft.id).dates.length, 2);

  const { ev } = await published(org.token, admin.token, { title, dateMode: 'DATES', dates: [{ startsAt: at(40) }, { startsAt: at(41) }, { startsAt: at(42) }], ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 5 }] });
  const [d1, d2] = ev.dates as Json[];
  let list = await ok(call('GET', `/events?q=${encodeURIComponent(title)}`));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].dateMode, 'DATES');
  assert.equal(list.items[0].nextDate.id, d1.id);
  assert.equal(list.items[0].dateCount, 3);
  // The first show is over (the stored summary still says it): the event lists by its next date.
  await prisma.eventDate.update({ where: { id: d1.id }, data: { startsAt: new Date(Date.now() - DAY) } });
  await prisma.event.update({ where: { id: ev.id }, data: { startsAt: new Date(Date.now() - DAY) } });
  list = await ok(call('GET', `/events?q=${encodeURIComponent(title)}`));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].nextDate.id, d2.id);
  assert.equal(list.items[0].dateCount, 2);
  const orgList = await ok(call('GET', `/organizer/orgs/${ev.orgId}/events`, undefined, org.token));
  assert.equal(orgList[0].nextDate.id, d2.id);
  // Venue bookings on Omoshow are for one-date events (v1).
  const booking = await call('PUT', `/organizer/events/${ev.id}/venue-booking`, { bookingId: 'nope' }, org.token);
  assert.equal(booking.status, 400);
  assert.match(booking.body.message, /single-date events/);
});

test('SINGLE events are unchanged: no dates, no date fields on tickets, check-in as before', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`single-org-${run}@test.local`, 'Sol Organizer');
  const fan = await account(`single-fan-${run}@test.local`, 'Sade Fan');
  const { ev, org: o } = await published(org.token, admin.token, { startsAt: at(15), ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 10 }] });
  assert.equal(ev.dateMode, 'SINGLE');
  assert.deepEqual(ev.dates, []);
  const bad = await call('POST', `/organizer/orgs/${o.id}/events`, { title: 'Single', category: 'COMEDY', online: true, startsAt: at(15), ticketTypes: [{ name: 'GA', basePriceCents: 0, capacity: 5, validDates: ['0'] }] }, org.token);
  assert.equal(bad.status, 400);
  const paid = await buy(fan, ev.ticketTypes[0].id);
  assert.equal(paid.date, null);
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: paid.tickets[0].id } });
  assert.deepEqual([t.eventDateId, t.dateKey], [null, '']);
  const first = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: t.id }, org.token));
  assert.deepEqual([first.result, 'date' in first], ['ok', false]);
  assert.equal((await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: t.id }, org.token))).result, 'duplicate');
  assert.equal(await prisma.ticketCheckIn.count({ where: { ticketId: t.id } }), 1);
  const page = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual([page.dateMode, page.dates, page.nextDate, page.seatMapDateId], ['SINGLE', [], null, null]);
  const door = await ok(call('GET', `/organizer/orgs/${o.id}/door-events`, undefined, org.token));
  assert.equal('dates' in (door as Jsons).find((e) => e.id === ev.id), false);
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.byDate, []);
  await ok(call('DELETE', `/organizer/events/${ev.id}/check-in/${t.id}`, undefined, org.token));
  assert.equal(await prisma.ticketCheckIn.count({ where: { ticketId: t.id } }), 0);
});

test('switching a draft between one date, multiple dates and a multi-day event (no orders yet)', async () => {
  const org = await account(`switch-org-${run}@test.local`, 'Sam Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Switch Org ${run}` }, org.token));
  const ev = await ok(
    call('POST', `/organizer/orgs/${o.id}/events`, { title: `Switch ${run}`, category: 'CONCERTS', online: true, timezone: 'UTC', startsAt: at(50), ticketTypes: [{ name: 'Seated', basePriceCents: 1000, capacity: 6 }] }, org.token),
  );
  const seated = ev.ticketTypes[0];
  const seatMap = { version: 1, width: 600, height: 400, sections: [{ id: 'S', label: 'Stalls', ticketTypeId: seated.id, shape: 'rect', seating: 'reserved', rows: 2, seatsPerRow: 3, geometry: { x: 10, y: 10, w: 200, h: 100 } }] };
  await ok(call('PUT', `/organizer/events/${ev.id}/seat-map`, { seatMap }, org.token));

  // One date → multiple dates: today's ticket type becomes the first date's copy; the seat map points at the tier.
  const dates = await ok(call('PATCH', `/organizer/events/${ev.id}`, { dateMode: 'DATES', dates: [{ startsAt: at(50) }, { startsAt: at(51) }] }, org.token));
  assert.equal(dates.dateMode, 'DATES');
  let full = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org.token));
  assert.equal(full.ticketTypes.length, 2);
  assert.ok(full.ticketTypes.some((t: Json) => t.id === seated.id && t.eventDateId === full.dates[0].id));
  assert.equal(full.seatMap.sections[0].ticketTypeId, full.ticketTypes[0].tierKey);
  assert.deepEqual(full.ticketTypes.map((t: Json) => t.capacity), [6, 6]);

  // → multi-day: one ticket type again, valid on every day.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { dateMode: 'DAYS', dates: [{ startsAt: at(52) }, { startsAt: at(53) }] }, org.token));
  full = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org.token));
  assert.equal(full.ticketTypes.length, 1);
  assert.deepEqual(full.ticketTypes[0].validDateIds, full.dates.map((d: Json) => d.id));
  assert.equal(full.seatMap.sections[0].ticketTypeId, seated.id);

  // → one date again.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { dateMode: 'SINGLE', startsAt: at(55) }, org.token));
  full = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org.token));
  assert.deepEqual([full.dateMode, full.dates, full.ticketTypes[0].validDateIds, new Date(full.startsAt).toISOString()], ['SINGLE', [], [], at(55)]);
});
