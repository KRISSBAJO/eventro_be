/**
 * The waitlist ("tell me when tickets come back") and messages from the organizer to ticket holders.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { WaitlistService } from '../src/waitlist/waitlist.module';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
let waitlist: WaitlistService;
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
const waitFor = async <T>(fn: () => Promise<T | null | false | undefined>, tries = 80) => {
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
  const { WaitlistService: Svc } = await import('../src/waitlist/waitlist.module');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
  waitlist = app.get(Svc);
});

after(async () => {
  await app?.close();
});

let n = 0;
/** A published event with General ($30, plenty) and a small VIP tier (2 places). */
async function show(org: string, admin: string, publish = true) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Wait Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Wait Show ${run} ${n}`,
        category: 'CONCERTS',
        venue: { name: 'Wait Hall', address: '1 Wait St', city: 'London', country: 'GB' },
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 20 * DAY).toISOString(),
        ticketTypes: [
          { name: 'General', basePriceCents: 3000, capacity: 50 },
          { name: 'VIP', basePriceCents: 9000, capacity: 2 },
        ],
      },
      org,
    ),
  );
  if (publish) {
    await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
    await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  }
  const tier = (name: string) => (ev.ticketTypes as Json[]).find((t) => t.name === name)!;
  return { org: o as Json, ev, general: tier('General'), vip: tier('VIP') };
}

async function buy(fan: { token: string; user: Json }, ticketTypeId: string, quantity: number) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity }, fan.token));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: fan.user.email, name: fan.user.name }, fan.token));
  const paid = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.equal(paid.status, 'PAID');
  return paid;
}

test('waitlist: join a sold-out ticket type, hear when a refund frees it, once', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`wl-o1-${run}@test.local`, 'Wanda Organizer');
  const buyer = await account(`wl-b1-${run}@test.local`, 'Bea Buyer');
  const fan = await account(`wl-f1-${run}@test.local`, 'Fred Fan');
  const other = await account(`wl-x1-${run}@test.local`, 'Xena Other');
  const { ev, vip, general } = await show(org.token, admin.token);
  const guest = `wl-guest-${run}@test.local`;

  // On sale: nothing to wait for.
  assert.equal((await call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id }, fan.token)).status, 400);
  const order = await buy(buyer, vip.id, 2);
  // VIP is sold out; General isn't, so "any ticket" doesn't apply.
  assert.equal((await call('POST', `/events/${ev.slug}/waitlist`, {}, fan.token)).status, 400);
  assert.equal((await call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: general.id }, fan.token)).status, 400);
  assert.equal((await call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: 'nope' }, fan.token)).status, 400);
  assert.equal((await call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id })).status, 400, 'a guest needs an email');

  const joined = await ok(call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id }, fan.token));
  assert.deepEqual([joined.waiting, joined.email, joined.ticketTypeId], [true, fan.user.email, vip.id]);
  await ok(call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id }, fan.token)); // again: still one entry
  await ok(call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id, email: guest.toUpperCase() }));
  await ok(call('POST', `/events/${ev.slug}/waitlist`, { ticketTypeId: vip.id }, other.token));
  assert.equal(await prisma.waitlistEntry.count({ where: { eventId: ev.id } }), 3);
  assert.deepEqual((await ok(call('GET', `/events/${ev.slug}/waitlist`, undefined, fan.token))).ticketTypeIds, [vip.id]);
  assert.deepEqual((await ok(call('GET', `/events/${ev.slug}/waitlist`))).ticketTypeIds, []);

  // Leaving: signed in, or by the link in the email.
  assert.deepEqual((await ok(call('DELETE', `/events/${ev.slug}/waitlist?ticketTypeId=${vip.id}`, undefined, other.token))).ticketTypeIds, []);
  const seen = await ok(call('GET', `/organizer/events/${ev.id}/waitlist`, undefined, org.token));
  assert.deepEqual([seen.waiting, seen.byType.length, seen.byType[0].name, seen.byType[0].waiting, seen.told], [2, 1, 'VIP', 2, 0]);
  assert.equal((await call('GET', `/organizer/events/${ev.id}/waitlist`, undefined, fan.token)).status, 404);

  // Still sold out: nobody is told.
  assert.equal(await waitlist.sweep(), 0);
  await ok(call('POST', `/admin/orders/${order.id}/refund`, { reason: 'Buyer can no longer come' }, admin.token));
  assert.equal(await waitlist.release(ev.id), 2);
  const mails = await prisma.emailLog.findMany({ where: { kind: 'waitlist', to: { in: [fan.user.email, guest] } } });
  assert.equal(mails.length, 2);
  assert.ok(mails[0].subject.startsWith('Tickets are back'));
  assert.equal(await prisma.emailLog.count({ where: { kind: 'waitlist', to: other.user.email } }), 0, 'someone who left isn’t told');
  // Told once: the next sweep has nobody left, and the fan is no longer waiting.
  assert.equal(await waitlist.release(ev.id), 0);
  assert.deepEqual((await ok(call('GET', `/events/${ev.slug}/waitlist`, undefined, fan.token))).ticketTypeIds, []);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/waitlist`, undefined, org.token))).told, 2);

  // The stop link works and is safe to open twice.
  const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { eventId: ev.id, email: guest } });
  assert.equal((await ok(call('DELETE', `/waitlist/${entry.token}`))).stopped, true);
  assert.equal((await ok(call('DELETE', `/waitlist/${entry.token}`))).event.slug, ev.slug);
  assert.equal((await call('DELETE', '/waitlist/not-a-token')).status, 404);
});

test('waitlist: the longest wait hears first, and "any ticket" needs the whole event sold out', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`wl-o2-${run}@test.local`, 'Wes Organizer');
  const buyer = await account(`wl-b2-${run}@test.local`, 'Bo Buyer');
  const fan = await account(`wl-f2-${run}@test.local`, 'Fern Fan');
  const { ev, vip, general } = await show(org.token, admin.token);
  await buy(buyer, vip.id, 2);
  // Twelve people waiting for VIP, a minute apart.
  const t0 = Date.now() - 3_600_000;
  await prisma.waitlistEntry.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({ eventId: ev.id, ticketTypeId: vip.id, email: `wl-q${i}-${run}@test.local`, token: `tok-${run}-${i}`, createdAt: new Date(t0 + i * 60_000) })),
  });
  // One more VIP place: ten hear now (the ten who waited longest), two keep waiting.
  await prisma.ticketType.update({ where: { id: vip.id }, data: { capacity: 3 } });
  assert.equal(await waitlist.release(ev.id), 10);
  const left = await prisma.waitlistEntry.findMany({ where: { eventId: ev.id, notifiedAt: null }, orderBy: { createdAt: 'asc' }, select: { email: true } });
  assert.deepEqual(left.map((l) => l.email), [`wl-q10-${run}@test.local`, `wl-q11-${run}@test.local`]);
  // Still available on the next sweep: the rest hear.
  assert.equal(await waitlist.sweep(), 2);

  // Sell everything: now "any ticket" can be joined, and hears when anything is back.
  await prisma.ticketType.update({ where: { id: vip.id }, data: { capacity: 2 } });
  await prisma.ticketType.update({ where: { id: general.id }, data: { capacity: 0 } });
  const any = await ok(call('POST', `/events/${ev.slug}/waitlist`, {}, fan.token));
  assert.equal(any.ticketTypeId, '');
  assert.deepEqual((await ok(call('GET', `/events/${ev.slug}/waitlist`, undefined, fan.token))).ticketTypeIds, ['']);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/waitlist`, undefined, org.token))).anyTicket, 1);
  assert.equal(await waitlist.release(ev.id), 0);
  await prisma.ticketType.update({ where: { id: general.id }, data: { capacity: 5 } });
  assert.equal(await waitlist.release(ev.id), 1);
  const mail = await prisma.emailLog.findFirstOrThrow({ where: { kind: 'waitlist', to: fan.user.email } });
  assert.ok(mail.subject.includes(ev.title));
  // Joining again after being told puts them back in line.
  await prisma.ticketType.update({ where: { id: general.id }, data: { capacity: 0 } });
  await ok(call('POST', `/events/${ev.slug}/waitlist`, {}, fan.token));
  const again = await prisma.waitlistEntry.findFirstOrThrow({ where: { eventId: ev.id, email: fan.user.email } });
  assert.equal(again.notifiedAt, null);
  // Paused sales: nobody is told.
  await prisma.ticketType.update({ where: { id: general.id }, data: { capacity: 5 } });
  await prisma.event.update({ where: { id: ev.id }, data: { salesPaused: true } });
  assert.equal(await waitlist.release(ev.id), 0);
});

test('organizer messages: to ticket holders by email, on their tickets, with limits and a stop link', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`msg-o1-${run}@test.local`, 'Mona Organizer');
  const stranger = await account(`msg-x1-${run}@test.local`, 'Sly Stranger');
  const a = await account(`msg-a1-${run}@test.local`, 'Ada Holder');
  const b = await account(`msg-b1-${run}@test.local`, 'Ben Holder');
  const { ev, vip, general } = await show(org.token, admin.token);
  const draft = await show(org.token, admin.token, false);

  // Nobody holds tickets yet; a draft can't message; only the event's team can.
  const blank = { subject: 'Doors now open at 7 PM', body: 'Doors open an hour later than planned, at 7 PM.\n\nBring a photo ID that matches your ticket.' };
  assert.equal((await call('POST', `/organizer/events/${ev.id}/messages`, blank, org.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${draft.ev.id}/messages`, blank, org.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/messages`, blank, stranger.token)).status, 404);
  assert.equal((await call('GET', `/organizer/events/${ev.id}/messages`, undefined, stranger.token)).status, 404);

  await buy(a, general.id, 2);
  await buy(b, vip.id, 1);
  const before = await ok(call('GET', `/organizer/events/${ev.id}/messages`, undefined, org.token));
  assert.deepEqual([before.audience.people, before.audience.tickets, before.limits.leftToday, before.canSend, before.messages.length], [2, 3, 3, true, 0]);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/messages?ticketTypeIds=${vip.id}`, undefined, org.token))).audience.people, 1);
  assert.equal((await call('GET', `/organizer/events/${ev.id}/messages?ticketTypeIds=nope`, undefined, org.token)).status, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/messages`, { subject: 'Hi', body: 'short' }, org.token)).status, 400);

  // To everyone: one email per holder, and it shows on their tickets.
  const sent = await ok(call('POST', `/organizer/events/${ev.id}/messages`, blank, org.token));
  assert.deepEqual([sent.recipients, sent.leftToday], [2, 2]);
  const row = await waitFor(async () => {
    const m = await prisma.eventMessage.findUnique({ where: { id: sent.id } });
    return m?.deliveredAt ? m : null;
  });
  assert.ok(row, 'delivered');
  assert.equal(await prisma.emailLog.count({ where: { kind: 'event_message', to: { in: [a.user.email, b.user.email] } } }), 2);
  const mineA = await ok(call('GET', '/me/tickets', undefined, a.token));
  assert.equal(mineA.tickets.length, 2);
  assert.deepEqual(mineA.tickets[0].updates.map((u: Json) => u.subject), ['Doors now open at 7 PM']);
  assert.ok(mineA.tickets[0].updates[0].body.includes('photo ID'));

  // To VIP only: Ben gets it, Ada doesn't.
  const vipOnly = await ok(call('POST', `/organizer/events/${ev.id}/messages`, { subject: 'VIP lounge opens at 6', body: 'Your VIP ticket gets you into the lounge from 6 PM.', ticketTypeIds: [vip.id] }, org.token));
  assert.equal(vipOnly.recipients, 1);
  await waitFor(async () => (await prisma.eventMessage.findUnique({ where: { id: vipOnly.id } }))?.deliveredAt);
  assert.equal(await prisma.emailLog.count({ where: { kind: 'event_message', to: a.user.email } }), 1);
  assert.equal(await prisma.emailLog.count({ where: { kind: 'event_message', to: b.user.email } }), 2);
  const mineB = await ok(call('GET', '/me/tickets', undefined, b.token));
  assert.deepEqual(mineB.tickets[0].updates.map((u: Json) => u.subject), ['VIP lounge opens at 6', 'Doors now open at 7 PM']);
  assert.equal((await ok(call('GET', '/me/tickets', undefined, a.token))).tickets[0].updates.length, 1);

  // Ada stops messages about this event: the next one skips her.
  const { stopToken } = await import('../src/organizer/messages');
  assert.equal((await call('DELETE', `/event-messages/stop/${mineA.tickets[0].id}.aaaaaaaaaaaaaaaaaaaaaa`)).status, 404);
  const stopped = await ok(call('DELETE', `/event-messages/stop/${stopToken(mineA.tickets[0].id)}`));
  assert.deepEqual([stopped.stopped, stopped.event.slug], [true, ev.slug]);
  const third = await ok(call('POST', `/organizer/events/${ev.id}/messages`, { subject: 'Parking is on Mill Lane', body: 'The car park behind the hall is closed. Use Mill Lane instead.' }, org.token));
  assert.deepEqual([third.recipients, third.leftToday], [1, 0]);

  // Three per event in 24 hours.
  const fourth = await call('POST', `/organizer/events/${ev.id}/messages`, blank, org.token);
  assert.equal(fourth.status, 400);
  const list = await ok(call('GET', `/organizer/events/${ev.id}/messages`, undefined, org.token));
  assert.deepEqual([list.messages.length, list.limits.leftToday, list.audience.people, list.audience.stopped], [3, 0, 1, 1]);
  assert.ok(list.limits.nextAt);
  assert.deepEqual(list.messages[1].ticketTypes, ['VIP']);
  assert.equal(list.messages[0].sentBy, 'Mona Organizer');
  assert.equal(await prisma.auditLog.count({ where: { action: 'event.message', entityId: ev.id } }), 3);

  // A cancelled event can't be messaged.
  await prisma.eventMessage.deleteMany({ where: { eventId: ev.id } });
  await prisma.event.update({ where: { id: ev.id }, data: { status: 'CANCELLED' } });
  assert.equal((await call('POST', `/organizer/events/${ev.id}/messages`, blank, org.token)).status, 400);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/messages`, undefined, org.token))).canSend, false);
});
