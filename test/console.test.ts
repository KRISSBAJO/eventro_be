/**
 * Email (against a stand-in Resend; nothing real is sent), price drops and alerts, receipts, account
 * suspension, and the admin console.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';

const KEY = `re_test_${'k'.repeat(20)}`;
let resend: Server;
/** every message the stand-in accepted */
const outbox: { to: string; subject: string; html: string; headers?: Record<string, string> }[] = [];

let app: INestApplication;
let base = '';
const run = Date.now().toString(36);

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
      for (const m of list) outbox.push({ to: m.to[0], subject: m.subject, html: m.html, headers: m.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      const ids = list.map((_: unknown, i: number) => ({ id: `email_${outbox.length}_${i}` }));
      res.end(JSON.stringify(req.url === '/emails/batch' ? { data: ids } : ids[0]));
    });
  });
  await new Promise<void>((r) => resend.listen(0, '127.0.0.1', r));
  process.env.RESEND_API_URL = `http://127.0.0.1:${(resend.address() as AddressInfo).port}`;
  process.env.RESEND_API_KEY = KEY;
  process.env.MAIL_FROM = 'Eventro Test <hello@test.local>';

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
  resend?.close();
});

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

test('newsletter sign-up sends a welcome email with a one-click unsubscribe header', async () => {
  const email = `welcome.${run}@example.com`;
  const r = await ok(call('POST', '/newsletter', { email }));
  const m = await waitFor(() => outbox.find((x) => x.to === email));
  assert.match(m.subject, /on the Eventro list/);
  assert.ok(m.html.includes(`/newsletter/manage?t=${r.token}`));
  assert.ok(m.headers?.['List-Unsubscribe']?.includes(r.token));
});

test('price drops: watchers and matching subscribers get one email; small and repeat cuts are quiet', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pd-org-${run}@test.local`, 'Pat Organizer');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Laugh Track');

  // Who should hear: a watcher, a comedy fan in Austin, an everything-anywhere fan.
  // Who shouldn't: a sports-only fan and a comedy fan in London.
  const watcher = `watch.${run}@example.com`;
  await ok(call('POST', `/events/${ev.slug}/price-watch`, { email: watcher }));
  await ok(call('POST', `/events/${ev.slug}/price-watch`, { email: watcher })); // twice is fine
  const fans = {
    comedyAustin: `ca.${run}@example.com`,
    everything: `all.${run}@example.com`,
    sportsOnly: `sp.${run}@example.com`,
    comedyLondon: `cl.${run}@example.com`,
  };
  await ok(call('POST', '/newsletter', { email: fans.comedyAustin, interests: ['Comedy'], city: 'austin' }));
  await ok(call('POST', '/newsletter', { email: fans.everything }));
  await ok(call('POST', '/newsletter', { email: fans.sportsOnly, interests: ['Sports'] }));
  await ok(call('POST', '/newsletter', { email: fans.comedyLondon, interests: ['Comedy'], city: 'london' }));
  // The watcher also subscribes: still only one price email.
  await ok(call('POST', '/newsletter', { email: watcher }));

  const preview = await ok(call('GET', `/organizer/events/${ev.id}/price-drops`, undefined, org.token));
  assert.equal(preview.watchers, 1);
  assert.ok(preview.subscribers >= 2);

  // Not on sale yet: no drop badge.
  assert.equal((await ok(call('GET', `/events/${ev.slug}/price-drop`))).drop, null);

  // A 2% cut is recorded but quiet.
  const small = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${tt.id}`, { basePriceCents: 4730 }, org.token));
  assert.equal(small.priceDrop.alerting, false);
  assert.match(small.priceDrop.reason, /Less than 5%/);

  // A real cut alerts.
  const before = outbox.length;
  const cut = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${tt.id}`, { basePriceCents: 3864 }, org.token));
  assert.equal(cut.priceDrop.alerting, true);
  const got = await waitFor(() => {
    const mine = outbox.slice(before).filter((m) => m.subject.startsWith('Price drop'));
    return mine.some((m) => m.to === watcher) && mine.some((m) => m.to === fans.everything) && mine.some((m) => m.to === fans.comedyAustin) ? mine : undefined;
  });
  const to = got.map((m) => m.to);
  assert.equal(to.filter((x) => x === watcher).length, 1, 'one email per address');
  assert.ok(!to.includes(fans.sportsOnly) && !to.includes(fans.comedyLondon), 'only matching subscribers');
  const watcherMail = got.find((m) => m.to === watcher)!;
  assert.ok(watcherMail.html.includes('/price-alerts/stop?t='), 'watchers get a stop link');
  assert.ok(watcherMail.html.includes(`$${(cut.priceCents / 100).toFixed(2)}`), 'shows the new all-in price');

  // The event page badge
  const badge = (await ok(call('GET', `/events/${ev.slug}/price-drop`))).drop;
  assert.equal(badge.toCents, cut.priceCents);
  assert.ok(badge.percentOff >= 15);

  // Another cut within 12 hours: recorded, not emailed.
  const again = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${tt.id}`, { basePriceCents: 2898 }, org.token));
  assert.equal(again.priceDrop.alerting, false);
  assert.match(again.priceDrop.reason, /12 hours/);

  // Raising the price again clears the badge.
  await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${tt.id}`, { basePriceCents: 4830 }, org.token));
  assert.equal((await ok(call('GET', `/events/${ev.slug}/price-drop`))).drop, null);

  // Stop link works once, and the watcher stops counting.
  const stopToken = /price-alerts\/stop\?t=([A-Za-z0-9_-]+)/.exec(watcherMail.html)![1];
  assert.equal((await ok(call('DELETE', `/price-watch/${stopToken}`))).stopped, true);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/price-drops`, undefined, org.token))).watchers, 0);
  assert.equal((await call('DELETE', '/price-watch/nope')).status, 404);

  // Admin sees the drops and the emails.
  // The emailed count is saved just after the last email goes out, so give it a moment.
  let notified = 0;
  for (let i = 0; i < 40 && notified < 3; i++) {
    const drops = await ok(call('GET', '/admin/price-drops', undefined, admin.token));
    notified = Math.max(0, ...drops.items.filter((d: Json) => d.eventId === ev.id).map((d: Json) => d.notified as number));
    if (notified < 3) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(notified >= 3, `notified ${notified}`);
  const log = await ok(call('GET', `/admin/emails?kind=price_drop&q=${encodeURIComponent(watcher)}`, undefined, admin.token));
  assert.equal(log.items[0].status, 'SENT');
});

test('paid orders get one receipt', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rc-org-${run}@test.local`, 'Rae Organizer');
  const { tt } = await publishedEvent(org.token, admin.token, 'Receipt Room');
  const email = `buyer.${run}@example.com`;
  const hold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email, name: 'Bea Buyer' }));
  await ok(call('POST', `/orders/${order.orderId}/pay`));
  await ok(call('POST', `/orders/${order.orderId}/pay`)); // retry: no second receipt
  const m = await waitFor(() => outbox.find((x) => x.to === email));
  assert.ok(m.subject.includes(order.orderId));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outbox.filter((x) => x.to === email).length, 1);
});

test('admin console: overview, people, organizers, events, orders and subscribers', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`ac-org-${run}@test.local`, 'Cam Organizer');
  const fan = await account(`ac-fan-${run}@test.local`, 'Dee Fan');
  const { org: o, ev, tt } = await publishedEvent(org.token, admin.token, 'Console Club');

  // Only admins
  assert.equal((await call('GET', '/admin/overview', undefined, fan.token)).status, 403);
  const ov = await ok(call('GET', '/admin/overview', undefined, admin.token));
  assert.equal(ov.daily.length, 30);
  assert.ok(ov.counts.users >= 3 && ov.counts.events.PUBLISHED >= 1);
  assert.equal(ov.email.enabled, true);

  // Users: find, change roles, suspend, unsuspend
  const users = await ok(call('GET', `/admin/users?q=${encodeURIComponent(`ac-fan-${run}`)}`, undefined, admin.token));
  assert.equal(users.total, 1);
  const fanId = users.items[0].id;
  const promoted = await ok(call('PATCH', `/admin/users/${fanId}`, { roles: ['ORGANIZER'] }, admin.token));
  assert.deepEqual([...promoted.roles].sort(), ['FAN', 'ORGANIZER']);
  await ok(call('PATCH', `/admin/users/${fanId}`, { suspended: true, reason: 'Chargebacks' }, admin.token));
  assert.equal((await call('GET', '/me/tickets', undefined, fan.token)).status, 403, 'suspended token refused');
  assert.equal((await call('POST', '/auth/login', { email: `ac-fan-${run}@test.local`, password: 'test-password-123' })).status, 403);
  await ok(call('PATCH', `/admin/users/${fanId}`, { suspended: false }, admin.token));
  await ok(call('GET', '/me/tickets', undefined, fan.token));
  // Admins can't lock themselves out
  assert.equal((await call('PATCH', `/admin/users/${admin.user.id}`, { suspended: true }, admin.token)).status, 403);

  // Organizers: verify, suspend (pauses sales and blocks resuming), lift
  const orgs = await ok(call('GET', `/admin/orgs?q=${encodeURIComponent(o.name)}`, undefined, admin.token));
  assert.equal(orgs.items[0].events.published, 1);
  assert.ok((await ok(call('PATCH', `/admin/orgs/${o.id}`, { verified: true }, admin.token))).verifiedAt);
  const sus = await ok(call('PATCH', `/admin/orgs/${o.id}`, { suspended: true, reason: 'Unpaid venue' }, admin.token));
  assert.equal(sus.pausedEvents, 1);
  assert.equal((await call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 })).status, 409, 'sales paused');
  assert.equal((await call('POST', `/organizer/events/${ev.id}/resume`, undefined, org.token)).status, 403);
  await ok(call('PATCH', `/admin/orgs/${o.id}`, { suspended: false }, admin.token));
  await ok(call('POST', `/organizer/events/${ev.id}/resume`, undefined, org.token));

  // Events: take down, publish again
  const evs = await ok(call('GET', `/admin/events?q=${encodeURIComponent(ev.title)}`, undefined, admin.token));
  assert.equal(evs.items[0].org.verified, true);
  assert.equal((await call('POST', `/admin/events/${ev.id}/takedown`, { note: 'no' }, admin.token)).status, 400, 'note too short');
  await ok(call('POST', `/admin/events/${ev.id}/takedown`, { note: 'Misleading lineup' }, admin.token));
  assert.equal((await call('GET', `/events/${ev.slug}`)).status, 404);
  await ok(call('POST', `/admin/events/${ev.id}/publish`, undefined, admin.token));
  await ok(call('GET', `/events/${ev.slug}`));

  // Orders: search and refund
  const hold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: `ac-buyer-${run}@example.com`, name: 'Ari Buyer' }));
  await ok(call('POST', `/orders/${order.orderId}/pay`));
  const found = await ok(call('GET', `/admin/orders?q=${order.orderId}`, undefined, admin.token));
  assert.equal(found.items[0].status, 'PAID');
  const refunded = await ok(call('POST', `/admin/orders/${order.orderId}/refund`, { reason: 'Customer moved away' }, admin.token));
  assert.equal(refunded.status, 'REFUNDED');
  assert.equal((await call('POST', `/admin/orders/${order.orderId}/refund`, { reason: 'Again please' }, admin.token)).status, 400);

  // Subscribers, CSV, broadcast audience and a test send
  await ok(call('POST', '/newsletter', { email: `ac-sub-${run}@example.com`, interests: ['Family'] }));
  const subs = await ok(call('GET', `/admin/subscribers?q=ac-sub-${run}`, undefined, admin.token));
  assert.equal(subs.items[0].interests[0], 'Family');
  const csv = await fetch(`${base}/admin/subscribers.csv`, { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes(`ac-sub-${run}@example.com`));
  const aud = await ok(call('GET', '/admin/broadcast/audience?category=Family', undefined, admin.token));
  assert.ok(aud.count >= 1);
  const before = outbox.length;
  const t = await ok(call('POST', '/admin/broadcast', { subject: 'Hello fans', heading: 'Big news', body: 'First paragraph here.\n\nSecond one.', test: true }, admin.token));
  assert.equal(t.sent, true);
  const testMail = outbox.slice(before).find((m) => m.to === 'admin@test.local');
  assert.ok(testMail && testMail.subject === '[Test] Hello fans');
  assert.equal((await call('POST', '/admin/broadcast', { subject: 'x', heading: 'y', body: 'short' }, admin.token)).status, 400);

  // Every change is in the audit log
  const audit = await ok(call('GET', '/admin/audit?limit=50', undefined, admin.token));
  const actions = new Set(audit.map((a: Json) => a.action));
  for (const a of ['user.roles', 'user.suspend', 'org.verify', 'org.suspend', 'event.takedown', 'event.publish', 'order.refund']) assert.ok(actions.has(a), `audit has ${a}`);
});

test('seat maps can be resized, but never under a seat that is already sold', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`sm-org-${run}@test.local`, 'Sam Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Seat Shop ${run}` }, org.token));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Seat Shop Night ${run}`,
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Seat Shop Hall', address: '2 Test Rd', city: 'Lagos' },
        ticketTypes: [
          { name: 'Floor', basePriceCents: 5000, capacity: 100 },
          { name: 'Lower', basePriceCents: 4000, capacity: 100 },
          { name: 'Upper', basePriceCents: 3000, capacity: 100 },
        ],
      },
      org.token,
    ),
  );
  const [floor, lower, upper] = ev.ticketTypes.sort((a: Json, b: Json) => a.sortOrder - b.sortOrder);
  const tpl = await ok(call('POST', `/organizer/events/${ev.id}/seat-map/template`, { template: 'arena', floor: floor.id, lower: lower.id, upper: upper.id }, org.token));
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));

  // Three seats side by side in section 104: row A, seats 1-3.
  const hold = await ok(call('POST', '/holds', { ticketTypeId: lower.id, quantity: 3, sectionId: '104' }));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: `seats.${run}@example.com`, name: 'Sid Seat' }));
  const paid = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.deepEqual(paid.tickets.map((t: Json) => `${t.row}${t.seat}`), ['A1', 'A2', 'A3']);

  const map = tpl.seatMap as Json;
  const resized = (seatsPerRow: number, rows: number) => ({ ...map, sections: map.sections.map((s: Json) => (s.id === '104' ? { ...s, rows, seatsPerRow } : s)) });

  // Two seats per row would drop seat A3, which is sold: refused, naming the seat.
  const bad = await call('PUT', `/organizer/events/${ev.id}/seat-map`, { seatMap: resized(2, 50) }, org.token);
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /104 row A seat 3/);

  // Fewer rows but every sold seat kept: fine.
  await ok(call('PUT', `/organizer/events/${ev.id}/seat-map`, { seatMap: resized(3, 1) }, org.token));
});

test('ticket tiers: perks, badges and the order fans see them in', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`tier-org-${run}@test.local`, 'Tia Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Tier Hall ${run}` }, org.token));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Tier Night ${run}`,
        category: 'FAITH',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Grace Hall', address: '5 Church Rd', city: 'Lagos' },
        ticketTypes: [
          { name: 'Special VIP', basePriceCents: 0, capacity: 10, perks: ['Front-row seating', ' Personal usher ', 'front-row seating', 'Parking'], badge: 'Limited' },
          { name: 'VIP', basePriceCents: 0, capacity: 40, perks: ['Priority entry'] },
          { name: 'General', basePriceCents: 0, capacity: 300 },
        ],
      },
      org.token,
    ),
  );
  const [svip, vip, gen] = ev.ticketTypes.sort((a: Json, b: Json) => a.sortOrder - b.sortOrder);
  // Trimmed and de-duplicated, order kept.
  assert.deepEqual(svip.perks, ['Front-row seating', 'Personal usher', 'Parking']);
  assert.equal(svip.badge, 'Limited');
  assert.deepEqual(gen.perks, []);

  // Too many or too short perks are refused.
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { perks: Array.from({ length: 9 }, (_, i) => `Perk ${i}`) }, org.token)).status, 400);
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { perks: ['x'] }, org.token)).status, 400);
  const upd = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { perks: ['Priority entry', 'Lounge access'], badge: 'Most popular' }, org.token));
  assert.deepEqual(upd.perks, ['Priority entry', 'Lounge access']);
  assert.equal((await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${vip.id}`, { badge: '' }, org.token))).badge, null);

  // Reorder: every id once, or it's refused.
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/ticket-types/order`, { ids: [gen.id, vip.id] }, org.token)).status, 400);
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/ticket-types/order`, { ids: [gen.id, gen.id, vip.id] }, org.token)).status, 400);
  const ordered = await ok(call('PUT', `/organizer/events/${ev.id}/ticket-types/order`, { ids: [vip.id, svip.id, gen.id] }, org.token));
  assert.deepEqual(ordered.map((t: Json) => t.name), ['VIP', 'Special VIP', 'General']);

  // Fans see the perks, badge and order once it's published.
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual(pub.ticketTypes.map((t: Json) => t.name), ['VIP', 'Special VIP', 'General']);
  assert.deepEqual(pub.ticketTypes[1].perks, ['Front-row seating', 'Personal usher', 'Parking']);
  assert.equal(pub.ticketTypes[1].badge, 'Limited');
  assert.equal(pub.category, 'FAITH');
});
