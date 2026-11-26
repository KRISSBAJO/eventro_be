/**
 * Safeguards on events that already have fans: times that make sense, who can cancel once an event has started (and
 * what the organizer owes back when they'd been paid), a date or time change (holders told, buyers can take a refund),
 * edits to a live event's title and cover waiting for Omoshow, and cancelling one day of a multi-day event.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { holdLiveEdit, readPendingEdit } from '../src/domain/pending-edit';
import { organizerShareOf } from '../src/domain/paid-out';
import { dateChangeView } from '../src/domain/date-changes';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const DAY = 86_400_000;

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
const waitFor = async <T>(fn: () => Promise<T | null>, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
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

/** `days` from now at `hour`:00 UTC (a UTC venue, so wall clock = real time). */
const at = (days: number, hour = 20) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

let n = 0;
async function published(org: string, admin: string, body: Json) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Safe Org ${run} ${n}` }, org));
  const ev = await ok(
    call('POST', `/organizer/orgs/${o.id}/events`, { title: `Safe ${run} ${n}`, category: 'THEATER', venue: { name: 'Safe Hall', address: '1 Safe St', city: 'London', country: 'GB' }, timezone: 'UTC', ...body }, org),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  return { org: o as Json, ev };
}
async function buy(buyer: { token: string; user: Json }, ticketTypeId: string, qty = 1) {
  const h = await ok(call('POST', '/holds', { ticketTypeId, quantity: qty }, buyer.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: buyer.user.email, name: buyer.user.name }, buyer.token));
  await ok(call('POST', `/orders/${o.orderId}/pay`));
  return o.orderId as string;
}
const single = (title: string) => ({ title, startsAt: at(20), endsAt: at(20, 23), ticketTypes: [{ name: 'General', basePriceCents: 3000, capacity: 50 }] });

test('domain: pending edits, organizer share of a refund, date change view', () => {
  const live = { title: 'Old', subtitle: '', imageUrl: 'https://x/a.jpg', media: null, pendingEdit: null };
  const a = holdLiveEdit(live, { title: 'New', subtitle: '' }, 'u1', new Date('2026-12-01T00:00:00Z'));
  assert.deepEqual(a.held, ['title']);
  assert.equal(a.next?.title, 'New');
  // Setting it back to the live value stops it waiting.
  assert.equal(holdLiveEdit({ ...live, pendingEdit: a.next }, { title: 'Old' }, 'u1').next, null);
  assert.equal(readPendingEdit({ submittedAt: 'x', by: 'y' }), null);
  // $100 order, organizer net $90 on it: a full refund owes all of it; a half refund half of it.
  const o = { quantity: 1, unitCents: 10_000, discountCents: 0, totalCents: 10_000, refundedCents: 0, donationCents: 0, donationRefundedCents: 0 };
  assert.equal(organizerShareOf(o, 10_000, 9_000), 9_000);
  assert.equal(organizerShareOf(o, 5_000, 9_000), 4_500);
  // A change after the purchase shows; one before it doesn't (they bought the new time).
  const c = { id: 'c', eventId: 'e', eventDateId: null, fromStartsAt: new Date(), toStartsAt: new Date(), reason: null, refundUntil: new Date(Date.now() + DAY), createdAt: new Date() };
  const order = { kind: 'SALE', status: 'PAID', paidAt: new Date(Date.now() - DAY), createdAt: new Date(Date.now() - DAY), totalCents: 1000, refundedCents: 0 };
  assert.equal(dateChangeView([c], 'SINGLE', { eventDateId: null, validDateIds: [] }, order, { isBuyer: true, used: false })?.refundable, true);
  assert.equal(dateChangeView([c], 'SINGLE', { eventDateId: null, validDateIds: [] }, { ...order, paidAt: new Date(Date.now() + 1000) }, { isBuyer: true, used: false }), null);
  assert.equal(dateChangeView([c], 'SINGLE', { eventDateId: null, validDateIds: [] }, order, { isBuyer: false, used: false })?.refundable, false);
});

test('times: doors before the start, the end after it, and a moved start in the future', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`safe-t-${run}@test.local`, 'Tolu Organizer');
  const { ev } = await published(org.token, admin.token, single(`Times ${run}`));
  const bad = async (body: Json, msg: RegExp) => {
    const r = await call('PATCH', `/organizer/events/${ev.id}`, body, org.token);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message, msg);
  };
  await bad({ doorsAt: at(20, 21) }, /Doors can’t open after the start/);
  await bad({ endsAt: at(20, 19) }, /end has to be after the start/);
  await bad({ startsAt: at(-1) }, /start time is in the past/);
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { doorsAt: at(20, 19) }, org.token));
});

test('cancelling: organizers only before it starts; Omoshow after; refunds of orders already paid out are owed', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`safe-c-${run}@test.local`, 'Chidi Organizer');
  const fan = await account(`safe-cf-${run}@test.local`, 'Funke Fan');
  const { org: o, ev } = await published(org.token, admin.token, single(`Started ${run}`));
  const orderId = await buy(fan, ev.ticketTypes[0].id, 2);
  // It started an hour ago; the order was paid (and paid out, DAILY) three days ago.
  await prisma.event.update({ where: { id: ev.id }, data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3_600_000) } });
  await prisma.order.update({ where: { id: orderId }, data: { paidAt: new Date(Date.now() - 3 * DAY) } });
  const refused = await call('POST', `/organizer/events/${ev.id}/cancel`, { reason: 'Storm warning for the whole area', confirmTitle: ev.title }, org.token);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EVENT_STARTED');
  const done = await ok(call('POST', `/admin/events/${ev.id}/cancel`, { reason: 'Storm warning for the whole area' }, admin.token));
  assert.equal(done.refunded, 1);
  const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(after.status, 'REFUNDED');
  assert.ok(after.refundOwedCents > 0 && after.refundOwedCents < after.totalCents, 'the organizer’s share, not the fee');
  const payouts = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(payouts.refundOwedCents, after.refundOwedCents);
});

test('date change: holders hear, buyers can take a full refund until the window closes; later buyers can’t', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`safe-d-${run}@test.local`, 'Dayo Organizer');
  const fan = await account(`safe-df-${run}@test.local`, 'Dami Fan');
  const late = await account(`safe-dl-${run}@test.local`, 'Lara Late');
  const { ev } = await published(org.token, admin.token, single(`Moved ${run}`));
  const orderId = await buy(fan, ev.ticketTypes[0].id, 2);
  // A small fix (under 30 minutes) isn't a change.
  const nudge = await ok(call('PATCH', `/organizer/events/${ev.id}`, { startsAt: new Date(new Date(at(20)).getTime() + 15 * 60_000).toISOString() }, org.token));
  assert.deepEqual(nudge.dateChanges, []);
  const moved = await ok(call('PATCH', `/organizer/events/${ev.id}`, { startsAt: at(27), endsAt: at(27, 23), changeReason: 'The headliner’s flight moved' }, org.token));
  assert.equal(moved.dateChanges.length, 1);
  assert.equal(moved.dateChanges[0].reason, 'The headliner’s flight moved');
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'event.date_change', to: fan.user.email } })), 'the buyer is emailed');
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t = (mine.tickets as Json[]).find((x) => x.orderId === orderId)!;
  assert.equal(t.dateChange.refundable, true);
  assert.equal(new Date(t.dateChange.toStartsAt).toISOString(), at(27));
  assert.ok(!('email' in t.order), 'the buyer’s email stays out of the ticket');
  // Someone who buys after the change bought the new time.
  const lateOrder = await buy(late, ev.ticketTypes[0].id);
  const theirs = await ok(call('GET', '/me/tickets', undefined, late.token));
  assert.equal((theirs.tickets as Json[]).find((x) => x.orderId === lateOrder)!.dateChange, null);
  assert.equal((await call('POST', `/me/orders/${lateOrder}/date-change-refund`, undefined, late.token)).status, 400);
  // Only the buyer; then the refund, once.
  assert.equal((await call('POST', `/me/orders/${orderId}/date-change-refund`, undefined, late.token)).status, 404);
  const r = await ok(call('POST', `/me/orders/${orderId}/date-change-refund`, undefined, fan.token));
  assert.equal(r.status, 'REFUNDED');
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { tickets: true } });
  assert.equal(o.refundedCents, o.totalCents);
  assert.ok(o.tickets.every((x) => x.status === 'VOID'));
  assert.equal((await call('POST', `/me/orders/${orderId}/date-change-refund`, undefined, fan.token)).status, 400);
  // After the window, no refund.
  const other = await buy(await account(`safe-dx-${run}@test.local`, 'Xena Fan'), ev.ticketTypes[0].id);
  await prisma.order.update({ where: { id: other }, data: { paidAt: new Date(Date.now() - 2 * DAY) } });
  await prisma.dateChange.updateMany({ where: { eventId: ev.id }, data: { refundUntil: new Date(Date.now() - 1000) } });
  const xena = await account(`safe-dx-${run}@test.local`, 'Xena Fan');
  assert.equal((await call('POST', `/me/orders/${other}/date-change-refund`, undefined, xena.token)).status, 400);
});

test('live edits: title and cover wait for Omoshow; the description goes live; approve, reject, withdraw', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`safe-e-${run}@test.local`, 'Efe Organizer');
  const { ev } = await published(org.token, admin.token, single(`Approved Title ${run}`));
  const r = await ok(call('PATCH', `/organizer/events/${ev.id}`, { title: `Free Bitcoin ${run}`, description: 'Doors at seven, bring ID.' }, org.token));
  assert.deepEqual(r.heldForReview, ['title']);
  assert.equal(r.title, `Approved Title ${run}`, 'fans still see the approved title');
  assert.equal(r.description, 'Doors at seven, bring ID.');
  assert.equal(r.pendingEdit.title, `Free Bitcoin ${run}`);
  const page = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(page.title, `Approved Title ${run}`);
  assert.ok(!('pendingEdit' in page), 'the public page never shows a waiting edit');
  const queue = await ok(call('GET', '/admin/pending-edits', undefined, admin.token));
  assert.ok((queue as unknown as Json[]).some((e) => e.id === ev.id));
  await ok(call('POST', `/admin/events/${ev.id}/edit/reject`, { note: 'Misleading title' }, admin.token));
  const after = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(after.title, `Approved Title ${run}`);
  assert.equal(after.pendingEditNote, 'Misleading title');
  // A better one, approved.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { title: `Encore Night ${run}` }, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/edit/approve`, undefined, admin.token));
  assert.equal((await ok(call('GET', `/events/${ev.slug}`))).title, `Encore Night ${run}`);
  // Withdrawn before anyone looked.
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { subtitle: 'A new line' }, org.token));
  await ok(call('DELETE', `/organizer/events/${ev.id}/pending-edit`, undefined, org.token));
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).pendingEdit, null);
  assert.equal((await call('POST', `/admin/events/${ev.id}/edit/approve`, undefined, admin.token)).status, 404);
});

test('multi-day: cancelling one day refunds day-only tickets in full and a pass that day’s share; the pass keeps working', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`safe-m-${run}@test.local`, 'Mo Organizer');
  const passFan = await account(`safe-mp-${run}@test.local`, 'Pat Pass');
  const dayFan = await account(`safe-md-${run}@test.local`, 'Dee Day');
  const { ev } = await published(org.token, admin.token, {
    title: `Fest ${run}`,
    dateMode: 'DAYS',
    dates: [{ startsAt: at(30, 14) }, { startsAt: at(31, 14) }, { startsAt: at(32, 14) }],
    ticketTypes: [
      { name: 'Weekend pass', basePriceCents: 9000, capacity: 50, validDates: ['0', '1', '2'] },
      { name: 'Saturday', basePriceCents: 4000, capacity: 50, validDates: ['1'] },
    ],
  });
  const full = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org.token));
  const pass = (full.ticketTypes as Json[]).find((t) => t.name === 'Weekend pass')!;
  const sat = (full.ticketTypes as Json[]).find((t) => t.name === 'Saturday')!;
  const day2 = (full.dates as Json[])[1];
  const passOrder = await buy(passFan, pass.id);
  const dayOrder = await buy(dayFan, sat.id);
  const preview = await ok(call('GET', `/organizer/events/${ev.id}/dates/${day2.id}/cancel-preview`, undefined, org.token));
  assert.equal(preview.partial, 1);
  const res = await ok(call('POST', `/organizer/events/${ev.id}/dates/${day2.id}/cancel`, { reason: 'The main stage failed inspection' }, org.token));
  assert.equal(res.refunded, 2);
  const p = await prisma.order.findUniqueOrThrow({ where: { id: passOrder }, include: { tickets: true } });
  const d = await prisma.order.findUniqueOrThrow({ where: { id: dayOrder }, include: { tickets: true } });
  assert.equal(d.status, 'REFUNDED');
  assert.ok(d.tickets.every((t) => t.status === 'VOID'));
  assert.equal(p.status, 'PARTIALLY_REFUNDED');
  assert.ok(Math.abs(p.refundedCents - Math.round(p.totalCents / 3)) <= 1, `a third back: ${p.refundedCents} of ${p.totalCents}`);
  assert.ok(p.tickets.every((t) => t.status === 'ACTIVE'), 'the pass still works');
  // A retry refunds nobody twice.
  await ok(call('POST', `/organizer/events/${ev.id}/dates/${day2.id}/cancel`, {}, org.token));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: passOrder } })).refundedCents, p.refundedCents);
  // Saturday-only tickets can't be bought now, and nobody checks in for that day.
  const hold = await call('POST', '/holds', { ticketTypeId: sat.id, quantity: 1 }, dayFan.token);
  assert.equal(hold.status, 400);
  const door = await call('POST', `/organizer/events/${ev.id}/check-in`, { code: p.tickets[0].id, eventDateId: day2.id }, org.token);
  assert.equal(door.status, 400);
});
