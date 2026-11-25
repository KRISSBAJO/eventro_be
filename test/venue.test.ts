/**
 * Moving an event to another venue (PUT /organizer/events/:id/venue): the wall-clock times stay and the zone follows
 * the new venue; what's refused (online, cancelled, ended, seats already sold on the map, door staff); and ticket
 * holders of a published event are emailed and notified once per change. Email goes to a stand-in Resend.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

const KEY = `re_test_${'v'.repeat(20)}`;
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
  return { status: res.status, body: parsed as Json };
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
async function waitFor<T>(fn: () => T | undefined | null | Promise<T | undefined | null>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

/** 30 days ahead, 8 PM at the venue (stored as wall-clock UTC), doors at 7, ends at 11. */
const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const TIMES = { startsAt: `${day}T20:00:00.000Z`, doorsAt: `${day}T19:00:00.000Z`, endsAt: `${day}T23:00:00.000Z` };
const nyVenue = () => ({ name: `Bowery Hall ${run}`, address: '6 Delancey St', city: 'New York', country: 'US', region: 'New York', lat: 40.7205, lng: -73.9935 });
/** No map position: the zone comes from the state (Texas → Central). */
const austinVenue = () => ({ name: `Red River Room ${run}`, address: '912 Red River St', city: 'Austin', country: 'us', region: 'Texas' });

async function orgWithEvent(token: string, name: string, extra: Json = {}) {
  const o = await ok(call('POST', '/organizer/orgs', { name: `${name} ${run}` }, token));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: `${name} ${run}`, category: 'CONCERTS', ...TIMES, venue: nyVenue(), ticketTypes: [{ name: 'General', basePriceCents: 2500, capacity: 100 }], ...extra },
      token,
    ),
  );
  return { org: o, ev };
}

async function publish(evId: string, orgToken: string, adminToken: string) {
  await ok(call('POST', `/organizer/events/${evId}/submit`, undefined, orgToken));
  await ok(call('POST', `/admin/events/${evId}/approve`, undefined, adminToken));
}

async function buy(ticketTypeId: string, quantity: number, email: string, name: string, token?: string, sectionId?: string) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity, ...(sectionId ? { sectionId } : {}) }, token));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email, name }, token));
  return ok(call('POST', `/orders/${order.orderId}/pay`));
}

test('venue change: times keep their wall-clock value, the zone follows the new venue, venues are reused', async () => {
  const org = await account(`vc-org-${run}@test.local`, 'Vera Venue');
  const { ev } = await orgWithEvent(org.token, 'Moving Show');
  assert.equal(ev.timezone, 'America/New_York');
  const nyId = ev.venueId as string;
  const path = `/organizer/events/${ev.id}/venue`;

  // To a new place in Texas with no map position: Central time from the state.
  const r = await ok(call('PUT', path, { venue: austinVenue() }, org.token));
  assert.equal(r.event.timezone, 'America/Chicago');
  assert.equal(r.venue.timezone, 'America/Chicago');
  assert.equal(r.venue.country, 'US');
  assert.equal(r.created, true);
  assert.deepEqual(r.zone, { from: 'America/New_York', to: 'America/Chicago', changed: true, fromName: 'Eastern time', toName: 'Central time' });
  assert.equal(r.notice, 'Times stay 8:00 PM, now in Central time.');
  assert.deepEqual(r.previousVenue, { id: nyId, name: `Bowery Hall ${run}`, city: 'New York' });
  assert.equal(r.notified.emails, 0, 'a draft tells nobody');
  assert.match(r.notified.reason, /Not published/);
  assert.equal(r.seatMapNote, null);

  const saved = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(saved.venueId, r.venue.id);
  assert.equal(saved.timezone, 'America/Chicago');
  assert.equal(saved.startsAt.toISOString(), TIMES.startsAt, '8 PM stays 8 PM');
  assert.equal(saved.doorsAt!.toISOString(), TIMES.doorsAt);
  assert.equal(saved.endsAt!.toISOString(), TIMES.endsAt);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: ev.id, action: 'event.venue' } });
  assert.equal(audit.id, r.changeId);
  assert.equal((audit.data as Json).timezoneFrom, 'America/New_York');
  assert.equal((audit.data as Json).timezoneTo, 'America/Chicago');
  assert.equal((audit.data as Json).to.created, true);

  // The same place again is the same venue: nothing to change.
  const again = await call('PUT', path, { venue: { ...austinVenue(), name: `red river room ${run}` } }, org.token);
  assert.equal(again.status, 400);
  assert.match(again.body.message, /already at/);
  assert.equal(await prisma.venue.count({ where: { name: { equals: `Red River Room ${run}`, mode: 'insensitive' } } }), 1);

  // Back to the first venue by its id: the zone goes back too, and no venue is created.
  const back = await ok(call('PUT', path, { venueId: nyId }, org.token));
  assert.equal(back.event.timezone, 'America/New_York');
  assert.equal(back.created, false);
  assert.equal(back.notice, 'Times stay 8:00 PM, now in Eastern time.');

  // A zone the organizer picked themselves wins over the venue's; the venue keeps its own.
  const picked = await ok(call('PUT', path, { venue: austinVenue(), timezone: 'America/Denver' }, org.token));
  assert.equal(picked.created, false, 'found the Texas venue again');
  assert.equal(picked.event.timezone, 'America/Denver');
  assert.equal(picked.venue.timezone, 'America/Chicago');
  // Moving to a venue in the same zone: no notice.
  const same = await ok(call('PUT', path, { venue: { name: `Denver Hall ${run}`, address: '1 Colfax Ave', city: 'Denver', country: 'US', region: 'Colorado' } }, org.token));
  assert.equal(same.zone.changed, false);
  assert.equal(same.notice, null);

  // Bad requests.
  assert.equal((await call('PUT', path, {}, org.token)).status, 400);
  assert.equal((await call('PUT', path, { venueId: nyId, venue: austinVenue() }, org.token)).status, 400);
  assert.equal((await call('PUT', path, { venueId: 'nope' }, org.token)).status, 400);
  assert.equal((await call('PUT', path, { venue: austinVenue(), timezone: 'Mars/Olympus' }, org.token)).status, 400);
  assert.equal((await call('PUT', path, { venue: { name: 'X' } }, org.token)).status, 400);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).startsAt.toISOString(), TIMES.startsAt);
});

test('venue change: refused for online, cancelled and ended events, and for door staff', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`vc2-org-${run}@test.local`, 'Otto Organizer');
  const door = await account(`vc2-door-${run}@test.local`, 'Dee Door');
  const manager = await account(`vc2-mgr-${run}@test.local`, 'Mo Manager');
  const outsider = await account(`vc2-out-${run}@test.local`, 'Ollie Outsider');
  const { org: o, ev } = await orgWithEvent(org.token, 'Refusals');
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `vc2-door-${run}@test.local`, role: 'DOOR' }, org.token));
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: `vc2-mgr-${run}@test.local`, role: 'MANAGER' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, manager.token));

  // Door staff can't; people outside the org don't see it; managers can.
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() }, door.token)).status, 403);
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() }, outsider.token)).status, 404);
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() })).status, 401);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).venueId, ev.venueId);
  const byManager = await ok(call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() }, manager.token));
  assert.equal(byManager.event.timezone, 'America/Chicago');

  // Online events have no venue to move.
  const online = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: `Online ${run}`, category: 'CONCERTS', ...TIMES, online: true, streamUrl: 'https://stream.example.com/x', timezone: 'Africa/Lagos', ticketTypes: [{ name: 'Stream', basePriceCents: 0, capacity: 100 }] },
      org.token,
    ),
  );
  const r1 = await call('PUT', `/organizer/events/${online.id}/venue`, { venue: austinVenue() }, org.token);
  assert.equal(r1.status, 400);
  assert.match(r1.body.message, /online/);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: online.id } })).venueId, null);

  // Ended (yesterday, in New York).
  const past = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: `Last Night ${run}`, category: 'CONCERTS', startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), venue: nyVenue(), ticketTypes: [{ name: 'General', basePriceCents: 2500, capacity: 10 }] },
      org.token,
    ),
  );
  const r2 = await call('PUT', `/organizer/events/${past.id}/venue`, { venue: austinVenue() }, org.token);
  assert.equal(r2.status, 400);
  assert.match(r2.body.message, /ended/);

  // Cancelled.
  const { ev: called } = await orgWithEvent(org.token, 'Called Off');
  await publish(called.id, org.token, admin.token);
  await ok(call('POST', `/organizer/events/${called.id}/cancel`, { reason: 'The headliner is unwell, sorry.', confirmTitle: called.title }, org.token));
  const r3 = await call('PUT', `/organizer/events/${called.id}/venue`, { venue: austinVenue() }, org.token);
  assert.equal(r3.status, 400);
  assert.match(r3.body.message, /cancelled/);

  // Nothing was written for the refused ones.
  assert.equal(await prisma.auditLog.count({ where: { action: 'event.venue', entityId: { in: [online.id, past.id, called.id] } } }), 0);
});

test('venue change: every ticket holder of a published event is emailed and notified once per change', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`vc3-org-${run}@test.local`, 'Pia Publisher');
  const fanEmail = `vc3-fan-${run}@test.local`;
  const fan = await account(fanEmail, 'Fay Fan');
  const { ev } = await orgWithEvent(org.token, 'Big Move');
  await publish(ev.id, org.token, admin.token);
  const tt = ev.ticketTypes[0] as Json;

  // Fay buys 2 on her account; Gus buys twice as a guest; Rita buys and is refunded in full (tickets void).
  await buy(tt.id, 2, fanEmail, 'Fay Fan', fan.token);
  await buy(tt.id, 1, `vc3-gus-${run}@example.com`, 'Gus Guest');
  await buy(tt.id, 1, `VC3-gus-${run}@example.com`, 'Gus Guest');
  const rita = await buy(tt.id, 1, `vc3-rita-${run}@example.com`, 'Rita Refund');
  await ok(call('POST', `/admin/orders/${rita.id}/refund`, { amountCents: rita.totalCents, reason: 'Can’t make it' }, admin.token));

  const sent = outbox.length;
  const r = await ok(call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() }, org.token));
  assert.equal(r.notice, 'Times stay 8:00 PM, now in Central time.');
  assert.deepEqual(r.notified, { emails: 2, pushes: 1 });

  const mails = await waitFor(() => {
    const m = outbox.slice(sent).filter((x) => /^New venue for /.test(x.subject));
    return m.length >= 2 ? m : undefined;
  });
  await new Promise((res) => setTimeout(res, 300));
  const venueMails = outbox.slice(sent).filter((x) => /^New venue for /.test(x.subject));
  assert.equal(venueMails.length, 2, 'one per holder');
  const fays = venueMails.filter((x) => x.to === fanEmail);
  assert.equal(fays.length, 1);
  assert.equal(venueMails.filter((x) => x.to.toLowerCase() === `vc3-gus-${run}@example.com`).length, 1, 'two orders, one email');
  assert.equal(venueMails.filter((x) => x.to.includes('rita')).length, 0, 'refunded tickets don’t count');
  const html = fays[0].html;
  assert.equal(fays[0].subject, `New venue for ${ev.title}: Red River Room ${run}`);
  assert.ok(html.includes(`Red River Room ${run}`) && html.includes('912 Red River St') && html.includes('Austin, Texas'));
  assert.ok(html.includes('https://www.google.com/maps/search/?api=1&amp;query='), 'a map link');
  assert.ok(html.includes('8:00 PM') && html.includes('Central time') && html.includes('2 tickets stay'));
  assert.ok(html.includes(`Bowery Hall ${run}`), 'says where it was');
  assert.equal(mails.length, 2);
  assert.equal(await prisma.emailLog.count({ where: { kind: 'event.venue', to: fanEmail } }), 1);

  // One push to the only holder with an account, keyed by event and change.
  const key = `event.venue:${ev.id}:${r.changeId}:${fan.user.id}`;
  const log = await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: key } }));
  assert.equal(log.kind, 'event.venue');
  assert.equal(log.userId, fan.user.id);
  assert.equal((log.data as Json).eventId, ev.id);
  assert.equal(await prisma.notificationLog.count({ where: { dedupeKey: { startsWith: `event.venue:${ev.id}:` } } }), 1);

  // Moving again is a new change: one more email and push each.
  const r2 = await ok(call('PUT', `/organizer/events/${ev.id}/venue`, { venueId: ev.venueId }, org.token));
  assert.notEqual(r2.changeId, r.changeId);
  await waitFor(() => outbox.slice(sent).filter((x) => /^New venue for /.test(x.subject)).length >= 4 || undefined);
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `event.venue:${ev.id}:${r2.changeId}:${fan.user.id}` } }));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(outbox.slice(sent).filter((x) => x.to === fanEmail && /^New venue for /.test(x.subject)).length, 2);
  assert.equal(await prisma.notificationLog.count({ where: { dedupeKey: { startsWith: `event.venue:${ev.id}:` } } }), 2);
  assert.equal(await prisma.auditLog.count({ where: { action: 'event.venue', entityId: ev.id } }), 2);
});

test('venue change: refused once seats on the seat map are sold; an unsold map is kept with a note', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`vc4-org-${run}@test.local`, 'Sam Seats');
  const tiers = [
    { name: 'Floor', basePriceCents: 5000, capacity: 100 },
    { name: 'Lower', basePriceCents: 4000, capacity: 100 },
    { name: 'Upper', basePriceCents: 3000, capacity: 100 },
  ];
  const withMap = async (name: string) => {
    const { ev } = await orgWithEvent(org.token, name, { ticketTypes: tiers });
    const [floor, lower, upper] = [...ev.ticketTypes].sort((a: Json, b: Json) => a.sortOrder - b.sortOrder).map((t: Json) => t.id);
    await ok(call('POST', `/organizer/events/${ev.id}/seat-map/template`, { template: 'arena', floor, lower, upper }, org.token));
    return { ev, lower };
  };

  // Nothing sold: allowed, and the map stays, with a reminder to check it.
  const { ev: quiet } = await withMap('Seated Draft');
  const r = await ok(call('PUT', `/organizer/events/${quiet.id}/venue`, { venue: austinVenue() }, org.token));
  assert.match(r.seatMapNote, /seat map was drawn for Bowery Hall/);
  assert.ok((await prisma.event.findUniqueOrThrow({ where: { id: quiet.id } })).seatMap);

  // Seats sold in section 104: refused, and nothing changes.
  const { ev, lower } = await withMap('Seated Sale');
  await publish(ev.id, org.token, admin.token);
  await buy(lower, 2, `vc4-buyer-${run}@example.com`, 'Bea Buyer', undefined, '104');
  const sent = outbox.length;
  const refused = await call('PUT', `/organizer/events/${ev.id}/venue`, { venue: austinVenue() }, org.token);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'SEATED_SALES');
  assert.match(refused.body.message, /2 tickets are sold for seats or sections/);
  const still = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
  assert.equal(still.venueId, ev.venueId);
  assert.equal(still.timezone, 'America/New_York');
  assert.equal(await prisma.auditLog.count({ where: { action: 'event.venue', entityId: ev.id } }), 0);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(outbox.slice(sent).filter((x) => /^New venue for /.test(x.subject)).length, 0);
});
