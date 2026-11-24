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
  assert.equal((await call('PATCH', `/admin/users/${admin.user.id}`, { suspended: true, reason: 'Testing the guard' }, admin.token)).status, 403);

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

test('admin detail pages: suspending needs a reason, notes land in each record’s history', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dp-org-${run}@test.local`, 'Eli Organizer');
  const fan = await account(`dp-fan-${run}@test.local`, 'Fay Fan');
  const { org: o, ev, tt } = await publishedEvent(org.token, admin.token, 'Detail Hall');
  const fanId = fan.user.id as string;

  // A purchase so the user page has activity
  const hold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: `dp-fan-${run}@test.local`, name: 'Fay Fan' }, fan.token));
  await ok(call('POST', `/orders/${order.orderId}/pay`));

  // Only admins; unknown ids are 404
  assert.equal((await call('GET', `/admin/users/${fanId}`, undefined, fan.token)).status, 403);
  assert.equal((await call('GET', '/admin/users/nope', undefined, admin.token)).status, 404);
  assert.equal((await call('GET', '/admin/orgs/nope', undefined, admin.token)).status, 404);

  // Suspending without a real reason is refused, for users and organizers
  for (const body of [{ suspended: true }, { suspended: true, reason: 'no' }, { suspended: true, reason: '      ' }]) {
    assert.equal((await call('PATCH', `/admin/users/${fanId}`, body, admin.token)).status, 400, JSON.stringify(body));
    assert.equal((await call('PATCH', `/admin/orgs/${o.id}`, body, admin.token)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('GET', '/me/tickets', undefined, fan.token)).status, 200, 'still active');

  // Roles with a note, suspend with a reason and an internal note, reactivate with a note
  await ok(call('PATCH', `/admin/users/${fanId}`, { roles: ['ORGANIZER'], note: 'Runs a comedy night' }, admin.token));
  const s = await ok(call('PATCH', `/admin/users/${fanId}`, { suspended: true, reason: 'Chargeback abuse', note: 'Three disputes in a week' }, admin.token));
  assert.equal(s.suspendReason, 'Chargeback abuse');
  await ok(call('PATCH', `/admin/users/${fanId}`, { suspended: false, note: 'Bank confirmed the disputes were a mistake' }, admin.token));

  const u = await ok(call('GET', `/admin/users/${fanId}`, undefined, admin.token));
  assert.equal(u.email, `dp-fan-${run}@test.local`);
  assert.equal(u.suspendedAt, null);
  assert.deepEqual([...u.roles].sort(), ['FAN', 'ORGANIZER']);
  assert.equal(u.counts.orders, 1);
  assert.equal(u.orders[0].id, order.orderId);
  assert.equal(u.tickets.ACTIVE, 2);
  assert.ok(u.spentUsdCents > 0);
  assert.ok(u.activeAdmins >= 1);
  assert.deepEqual(
    u.history.map((h: Json) => h.action),
    ['user.unsuspend', 'user.suspend', 'user.roles'],
  );
  const [lift, sus, roles] = u.history;
  assert.equal(sus.data.reason, 'Chargeback abuse');
  assert.equal(sus.data.note, 'Three disputes in a week');
  assert.equal(sus.actor.email, 'admin@test.local');
  assert.equal(lift.data.note, 'Bank confirmed the disputes were a mistake');
  assert.equal(lift.data.previousReason, 'Chargeback abuse');
  assert.equal(roles.data.note, 'Runs a comedy night');

  // The organizer who made the event shows their membership
  const ou = await ok(call('GET', `/admin/users/${org.user.id}`, undefined, admin.token));
  assert.equal(ou.memberships[0].org.id, o.id);

  // Organizer page: verify with a note, suspend (pauses sales), lift with a note
  await ok(call('PATCH', `/admin/orgs/${o.id}`, { verified: true, note: 'Checked their venue contract' }, admin.token));
  const os = await ok(call('PATCH', `/admin/orgs/${o.id}`, { suspended: true, reason: 'Misleading lineup', note: 'Fans complained' }, admin.token));
  assert.equal(os.pausedEvents, 1);
  await ok(call('PATCH', `/admin/orgs/${o.id}`, { suspended: false, note: 'Lineup fixed' }, admin.token));
  await ok(call('POST', `/admin/events/${ev.id}/takedown`, { note: 'Checking the takedown shows up' }, admin.token));

  const d = await ok(call('GET', `/admin/orgs/${o.id}`, undefined, admin.token));
  assert.equal(d.name, o.name);
  assert.ok(d.verifiedAt);
  assert.equal(d.suspendedAt, null);
  assert.equal(d.members.length, 1);
  assert.equal(d.members[0].user.id, org.user.id);
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0].status, 'REJECTED');
  assert.ok(d.events[0].previewToken, 'unpublished events carry a preview token');
  assert.equal(d.counts.ticketsSold, 2);
  assert.equal(d.payouts.byCurrency[0].orders, 1);
  assert.equal(d.payouts.ready, false);
  assert.deepEqual(
    d.history.map((h: Json) => h.action),
    ['event.takedown', 'org.unsuspend', 'org.suspend', 'org.verify', 'event.approve'],
  );
  assert.equal(d.history[2].data.reason, 'Misleading lineup');
  assert.equal(d.history[2].data.note, 'Fans complained');
  assert.equal(d.history[1].data.note, 'Lineup fixed');
  assert.equal(d.history[3].data.note, 'Checked their venue contract');
});

test('subscribers: growth counts, custom preheader and recent broadcasts', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const email = `gr-${run}@example.com`;
  await ok(call('POST', '/newsletter', { email, interests: ['Theater'], city: `grow-${run}` }));
  const subs = await ok(call('GET', '/admin/subscribers', undefined, admin.token));
  assert.ok(subs.counts.joined30d >= 1);
  assert.equal(typeof subs.counts.joinedPrev30d, 'number');
  assert.equal(typeof subs.counts.left30d, 'number');

  // A real send to a one-person audience (a city nobody else picked, so others with no city are included too)
  const aud = await ok(call('GET', `/admin/broadcast/audience?category=Theater&city=grow-${run}`, undefined, admin.token));
  assert.ok(aud.count >= 1);
  const subject = `Curtain up ${run}`;
  const before = outbox.length;
  const r = await ok(
    call('POST', '/admin/broadcast', { subject, heading: 'Shows this week', preheader: 'Seats from $20', body: 'Lots of good theater coming up.', category: 'Theater', city: `grow-${run}` }, admin.token),
  );
  assert.equal(r.recipients, aud.count);
  const m = await waitFor(() => outbox.slice(before).find((x) => x.to === email));
  assert.ok(m.html.includes('Seats from $20'), 'custom preheader');

  // Listed with who sent it and, once the background send is logged, how delivery went
  assert.equal((await call('GET', '/admin/broadcasts', undefined, (await account(`gr-fan-${run}@test.local`, 'Gil Fan')).token)).status, 403);
  let b: Json | undefined;
  for (const end = Date.now() + 8000; Date.now() < end; await new Promise((res) => setTimeout(res, 100))) {
    const list = await ok(call('GET', '/admin/broadcasts?limit=5', undefined, admin.token));
    b = (list as unknown as Json[]).find((x) => x.subject === subject);
    if (b && b.delivery.sent >= aud.count) break;
  }
  assert.ok(b, 'listed');
  assert.equal(b.recipients, aud.count);
  assert.equal(b.category, 'Theater');
  assert.equal(b.actor.email, 'admin@test.local');
  assert.equal(b.delivery.sent, aud.count);
  assert.equal(b.delivery.failed, 0);
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

test('gifted tickets: held until delivered and claimed, scheduled gifts wait', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gift-org-${run}@test.local`, 'Gia Organizer');
  const buyer = await account(`gift-buyer-${run}@test.local`, 'Bola Buyer');
  const friend = await account(`gift-friend-${run}@test.local`, 'Fumi Friend');
  const stranger = await account(`gift-stranger-${run}@test.local`, 'Sam Stranger');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Gift Garden');

  // Gifting to yourself is refused.
  const h0 = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }, buyer.token));
  assert.equal((await call('POST', '/orders', { holdId: h0.id, email: `gift-buyer-${run}@test.local`, name: 'Bola Buyer', gift: { name: 'Me', email: `GIFT-BUYER-${run}@test.local` } }, buyer.token)).status, 400);

  // A gift delivered now.
  const before = outbox.length;
  const order = await ok(call('POST', '/orders', { holdId: h0.id, email: `gift-buyer-${run}@test.local`, name: 'Bola Buyer', gift: { name: 'Fumi', email: `gift-friend-${run}@test.local`, message: 'Happy birthday! 🎉' } }, buyer.token));
  const paid = await ok(call('POST', `/orders/${order.orderId}/pay`));
  assert.equal(paid.gift.recipientName, 'Fumi');
  assert.ok(paid.tickets.every((t: Json) => t.status === 'TRANSFER_PENDING' && t.holderName === 'Fumi'), 'held for the gift');

  // The buyer can't scan a gift.
  const mine = await ok(call('GET', '/me/tickets', undefined, buyer.token));
  const held = mine.tickets.find((t: Json) => t.orderId === order.orderId);
  assert.equal(held.order.gift.recipientName, 'Fumi');
  assert.equal((await call('GET', `/tickets/${held.id}/qr`, undefined, buyer.token)).status, 400);

  // The recipient gets the gift email (price hidden by default), with the link.
  const mail = await waitFor(() => outbox.slice(before).find((m) => m.to === `gift-friend-${run}@test.local`));
  assert.match(mail.subject, /Bola sent you tickets/);
  assert.ok(mail.html.includes('Happy birthday!'));
  assert.ok(!/\$\d/.test(mail.html), 'no price in the gift email');
  const tokenFromMail = /\/gift\/([A-Za-z0-9_-]+)/.exec(mail.html)![1];
  // The buyer's receipt says it's a gift.
  const receipt = await waitFor(() => outbox.slice(before).find((m) => m.to === `gift-buyer-${run}@test.local`));
  assert.ok(receipt.html.includes('This is a gift for Fumi'));

  const view = await ok(call('GET', `/gifts/${tokenFromMail}`));
  assert.equal(view.status, 'ready');
  assert.equal(view.from, 'Bola Buyer');
  assert.equal(view.message, 'Happy birthday! 🎉');
  assert.equal(view.quantity, 1);
  assert.equal(view.totalCents, undefined, 'price hidden');

  // The buyer can't claim their own gift; the link holder can, once.
  assert.equal((await call('POST', `/gifts/${tokenFromMail}/claim`, undefined, buyer.token)).status, 400);
  assert.equal((await call('POST', `/gifts/${tokenFromMail}/claim`)).status, 401);
  const claimed = await ok(call('POST', `/gifts/${tokenFromMail}/claim`, undefined, friend.token));
  assert.equal(claimed.tickets, 1);
  assert.equal((await ok(call('POST', `/gifts/${tokenFromMail}/claim`, undefined, friend.token))).already, true);
  assert.equal((await call('POST', `/gifts/${tokenFromMail}/claim`, undefined, stranger.token)).status, 400);
  const friendTickets = await ok(call('GET', '/me/tickets', undefined, friend.token));
  const got = friendTickets.tickets.find((t: Json) => t.orderId === order.orderId);
  assert.equal(got.status, 'ACTIVE');
  await ok(call('GET', `/tickets/${got.id}/qr`, undefined, friend.token));
  assert.equal((await ok(call('GET', `/gifts/${tokenFromMail}`))).status, 'claimed');

  // A scheduled gift: nothing goes out and the link shows nothing until the date; "send now" delivers it.
  const h1 = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }, buyer.token));
  const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const o2 = await ok(call('POST', '/orders', { holdId: h1.id, email: `gift-buyer-${run}@test.local`, name: 'Bola Buyer', gift: { name: 'Fumi', email: `gift-friend-${run}@test.local`, sendAt: later, hidePrice: false } }, buyer.token));
  const p2 = await ok(call('POST', `/orders/${o2.orderId}/pay`));
  assert.equal(p2.gift.sentAt, null);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outbox.filter((m) => m.to === `gift-friend-${run}@test.local`).length, 1, 'scheduled gift not sent yet');
  // Too late a date is refused.
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }, buyer.token));
  const tooLate = new Date(Date.now() + 90 * 86_400_000).toISOString();
  assert.equal((await call('POST', '/orders', { holdId: h2.id, email: `gift-buyer-${run}@test.local`, name: 'Bola Buyer', gift: { name: 'Fumi', email: `gift-friend-${run}@test.local`, sendAt: tooLate } }, buyer.token)).status, 400);

  assert.equal((await call('POST', `/gifts/${p2.gift.id}/resend`, undefined, stranger.token)).status, 404);
  await ok(call('POST', `/gifts/${p2.gift.id}/resend`, undefined, buyer.token));
  const second = await waitFor(() => outbox.filter((m) => m.to === `gift-friend-${run}@test.local`)[1]);
  assert.match(second.html, /\$\d/, 'price shown when not hidden');
  const t2 = /\/gift\/([A-Za-z0-9_-]+)/.exec(second.html)![1];
  const v2 = await ok(call('GET', `/gifts/${t2}`));
  assert.equal(v2.quantity, 2);
  assert.ok(v2.totalCents > 0);
});

test('venue directory: claims, managers, official layouts, admin verify, hide and merge', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`vd-org-${run}@test.local`, 'Vic Organizer');
  const mgr = await account(`vd-mgr-${run}@test.local`, 'Mia Manager');
  const fan = await account(`vd-fan-${run}@test.local`, 'Fred Fan');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Venue Co ${run}` }, org.token));
  const mk = async (title: string, venue: Json) =>
    ok(call('POST', `/organizer/orgs/${o.id}/events`, { title, category: 'CONCERTS', startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), venue, ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 50 }] }, org.token));
  const e1 = await mk(`Night One ${run}`, { name: `Unity Hall ${run}`, address: '9 Unity Rd', city: 'Ibadan', lat: 7.3775, lng: 3.947 });
  // A typo'd copy of the same place, far enough away not to be reused automatically
  const e2 = await mk(`Night Two ${run}`, { name: `The Unity Hall ${run} Ibadan`, address: '9 Unity Road', city: 'Ibadan' });
  const v1 = (await ok(call('GET', `/organizer/events/${e1.id}`, undefined, org.token))).venue;
  const v2 = (await ok(call('GET', `/organizer/events/${e2.id}`, undefined, org.token))).venue;
  assert.notEqual(v1.id, v2.id);

  // Public page
  const page = await ok(call('GET', `/venues/${v1.slug}`));
  assert.equal(page.verified, false);
  assert.equal(page.managed, false);

  // Claim → admin approves → manager edits and saves a layout
  assert.equal((await call('POST', `/venues/${v1.slug}/claims`, { role: 'manager', message: 'short' }, mgr.token)).status, 400);
  await ok(call('POST', `/venues/${v1.slug}/claims`, { role: 'manager', message: 'I run bookings at Unity Hall, email me at bookings@unityhall.example' }, mgr.token));
  assert.equal((await call('POST', `/venues/${v1.slug}/claims`, { role: 'manager', message: 'Again, I run bookings here.' }, mgr.token)).status, 400);
  assert.equal((await call('PATCH', `/me/venues/${v1.id}`, { about: 'Hi' }, mgr.token)).status, 403, 'not a manager yet');
  const queue = await ok(call('GET', '/admin/venue-claims?status=PENDING', undefined, admin.token));
  const claim = queue.items.find((c: Json) => c.venue.id === v1.id);
  assert.equal((await call('POST', `/admin/venue-claims/${claim.id}/decide`, { decision: 'APPROVE' }, fan.token)).status, 403);
  const before = outbox.length;
  await ok(call('POST', `/admin/venue-claims/${claim.id}/decide`, { decision: 'APPROVE' }, admin.token));
  assert.ok(await waitFor(() => outbox.slice(before).find((m) => m.to === `vd-mgr-${run}@test.local` && /You now manage/.test(m.subject))));
  const mine = await ok(call('GET', '/me/venues', undefined, mgr.token));
  assert.equal(mine.managed[0].venue.id, v1.id);
  const upd = await ok(call('PATCH', `/me/venues/${v1.id}`, { about: 'A 600-seat hall in the heart of Ibadan.', website: 'https://unityhall.example', phone: '+234 803 000 0000' }, mgr.token));
  assert.equal(upd.about, 'A 600-seat hall in the heart of Ibadan.');
  assert.equal((await call('PATCH', `/me/venues/${v1.id}`, { website: 'not a url' }, mgr.token)).status, 400);
  // Official layout, from an arena template the organizer used
  const ev1 = await ok(call('GET', `/organizer/events/${e1.id}`, undefined, org.token));
  const tpl = await ok(call('POST', `/organizer/events/${e1.id}/seat-map/template`, { template: 'arena', floor: ev1.ticketTypes[0].id, lower: ev1.ticketTypes[0].id, upper: ev1.ticketTypes[0].id }, org.token));
  const saved = await ok(call('PUT', `/me/venues/${v1.id}/layout`, { layout: tpl.seatMap }, mgr.token));
  assert.ok(saved.places > 1000);
  assert.equal((await call('PUT', `/me/venues/${v1.id}/layout`, { layout: { version: 1, sections: [] } }, mgr.token)).status, 400);
  const official = await ok(call('GET', `/venues/${v1.slug}/layout`));
  assert.equal(official.sections, tpl.seatMap.sections.length);
  assert.equal((await ok(call('GET', `/venues/${v1.slug}`))).managed, true);

  // Admin: duplicates, verify, merge, hide
  const dups = await ok(call('GET', `/admin/venues/${v1.id}/duplicates`, undefined, admin.token));
  assert.ok(dups.some((d: Json) => d.id === v2.id), 'the typo is suggested as a duplicate');
  await ok(call('PATCH', `/admin/venues/${v1.id}`, { verified: true }, admin.token));
  assert.equal((await ok(call('GET', `/venues/${v1.slug}`))).verified, true);
  const merged = await ok(call('POST', `/admin/venues/${v2.id}/merge`, { intoId: v1.id }, admin.token));
  assert.equal(merged.eventsMoved, 1);
  assert.equal((await ok(call('GET', `/organizer/events/${e2.id}`, undefined, org.token))).venue.id, v1.id);
  assert.equal((await call('GET', `/venues/${v2.slug}`)).status, 404);
  await ok(call('PATCH', `/admin/venues/${v1.id}`, { hidden: true }, admin.token));
  assert.equal((await call('GET', `/venues/${v1.slug}`)).status, 404, 'hidden venues have no page');
  const search = await ok(call('GET', `/geo/search?q=${encodeURIComponent(`Unity Hall ${run}`)}`));
  assert.ok(!search.some((s: Json) => s.venueId === v1.id), 'hidden venues are not suggested');
  await ok(call('PATCH', `/admin/venues/${v1.id}`, { hidden: false }, admin.token));
  const audit = await ok(call('GET', '/admin/audit?limit=60', undefined, admin.token));
  for (const a of ['venue.claim', 'venue_claim.approved', 'venue.update', 'venue.layout', 'venue.verify', 'venue.merge', 'venue.hide']) assert.ok(audit.some((x: Json) => x.action === a), `audit has ${a}`);
});

test('gifts: taking a scheduled gift back means no email and nothing to resend', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gtb-org-${run}@test.local`, 'Tara Organizer');
  const buyer = await account(`gtb-buyer-${run}@test.local`, 'Ben Buyer');
  const { tt } = await publishedEvent(org.token, admin.token, 'Takeback Theatre');
  const hold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }, buyer.token));
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const o = await ok(call('POST', '/orders', { holdId: hold.id, email: `gtb-buyer-${run}@test.local`, name: 'Ben Buyer', gift: { name: 'Kemi', email: `gtb-kemi-${run}@test.local`, sendAt: later } }, buyer.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  for (const t of paid.tickets) await ok(call('DELETE', `/tickets/${t.id}/transfer`, undefined, buyer.token));
  const r = await call('POST', `/gifts/${paid.gift.id}/resend`, undefined, buyer.token);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /took these tickets back/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(outbox.filter((m) => m.to === `gtb-kemi-${run}@test.local`).length, 0, 'no gift email');
  // The tickets are the buyer's again.
  const mine = await ok(call('GET', '/me/tickets', undefined, buyer.token));
  assert.ok(mine.tickets.filter((t: Json) => t.orderId === o.orderId).every((t: Json) => t.status === 'ACTIVE'));
});

test('fan resale: organizer rules, listing, buying, handover, seller payout and admin controls', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rs-org-${run}@test.local`, 'Rita Organizer');
  const seller = await account(`rs-seller-${run}@test.local`, 'Sola Seller');
  const buyer = await account(`rs-buyer-${run}@test.local`, 'Bayo Buyer');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Resale Rally');
  // Organizer: cap at 120% of face, 5% royalty
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { resaleCapPercent: 120, resaleRoyaltyPermille: 50 }, org.token));

  // Seller buys a ticket
  const h = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }, seller.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: `rs-seller-${run}@test.local`, name: 'Sola Seller' }, seller.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  const ticketId = paid.tickets[0].id;
  const face = tt.priceCents as number;
  // My tickets carries the rules and the fee rate, so the sell sheet can show the breakdown before listing
  const own = await ok(call('GET', '/me/tickets', undefined, seller.token));
  const ownEv = own.tickets.find((t: Json) => t.id === ticketId).event;
  assert.equal(own.resaleFeePermille, 50);
  assert.deepEqual([ownEv.resaleEnabled, ownEv.resaleCapPercent, ownEv.resaleRoyaltyPermille, ownEv.transfersEnabled], [true, 120, 50, true]);

  // Over the cap is refused; within it works
  const over = await call('POST', `/tickets/${ticketId}/listing`, { priceCents: Math.floor(face * 1.3) }, seller.token);
  assert.equal(over.status, 400);
  assert.match(over.body.message, /120%/);
  const price = Math.floor(face * 1.1);
  const listed = await ok(call('POST', `/tickets/${ticketId}/listing`, { priceCents: price }, seller.token));
  assert.equal(listed.payoutCents, price - Math.round(price * 0.05) - Math.round(price * 0.05));
  // The seller's QR stops working while listed
  assert.equal((await call('GET', `/tickets/${ticketId}/qr`, undefined, seller.token)).status, 400);

  // Public listing
  const pub = await ok(call('GET', `/events/${ev.slug}/resale`));
  const listing = pub.listings.find((x: Json) => x.id === listed.listingId);
  assert.equal(listing.priceCents, price);
  // The seller can't buy their own; a buyer holds it, so nobody else can
  assert.equal((await call('POST', `/resale/${listing.id}/hold`, undefined, seller.token)).status, 400);
  const hold = await ok(call('POST', `/resale/${listing.id}/hold`, undefined, buyer.token));
  assert.equal((await call('POST', `/resale/${listing.id}/hold`)).status, 400);
  assert.equal((await ok(call('GET', `/events/${ev.slug}/resale`))).listings.some((x: Json) => x.id === listing.id), false, 'held listings are hidden');
  // and the seller can't pull it mid-checkout
  assert.equal((await call('DELETE', `/tickets/${ticketId}/listing`, undefined, seller.token)).status, 400);
  // Wrong key is refused
  assert.equal((await call('POST', `/resale/${listing.id}/orders`, { holdKey: 'nope', email: `rs-buyer-${run}@test.local`, name: 'Bayo Buyer' }, buyer.token)).status, 409);

  const before = outbox.length;
  const ro = await ok(call('POST', `/resale/${listing.id}/orders`, { holdKey: hold.holdKey, email: `rs-buyer-${run}@test.local`, name: 'Bayo Buyer' }, buyer.token));
  assert.equal(ro.totalCents, price);
  const done = await ok(call('POST', `/orders/${ro.orderId}/pay`));
  assert.equal(done.status, 'PAID');
  assert.equal(done.tickets.length, 1);
  const newId = done.tickets[0].id;
  assert.notEqual(newId, ticketId, 'the buyer gets a new ticket');

  // Handover: the seller's ticket is gone, the buyer's works
  const sellerTickets = await ok(call('GET', '/me/tickets', undefined, seller.token));
  assert.ok(!sellerTickets.tickets.some((t: Json) => t.id === ticketId), 'resold ticket left the seller');
  await ok(call('GET', `/tickets/${newId}/qr`, undefined, buyer.token));
  assert.notEqual((await call('GET', `/tickets/${ticketId}/qr`, undefined, seller.token)).status, 200);

  // Seller: emailed, payout pending until after the event
  assert.ok(await waitFor(() => outbox.slice(before).find((m) => m.to === `rs-seller-${run}@test.local` && /Sold/.test(m.subject))));
  const mine = await ok(call('GET', '/me/resale', undefined, seller.token));
  const sale = mine.listings.find((x: Json) => x.id === listing.id);
  assert.equal(sale.status, 'SOLD');
  assert.equal(sale.payoutStatus, 'PENDING');
  assert.equal(sale.payoutCents, listed.payoutCents);

  // Admin: can't pay before the event; can hold and release
  assert.equal((await call('POST', `/admin/resale/${listing.id}/payout`, { action: 'PAY' }, admin.token)).status, 400);
  assert.equal((await ok(call('POST', `/admin/resale/${listing.id}/payout`, { action: 'HOLD', note: 'Checking a chargeback' }, admin.token))).payoutStatus, 'HELD');
  assert.equal((await ok(call('POST', `/admin/resale/${listing.id}/payout`, { action: 'RELEASE' }, admin.token))).payoutStatus, 'PENDING');
  const payouts = await ok(call('GET', '/admin/resale/payouts?status=PENDING', undefined, admin.token));
  assert.ok(payouts.items.some((x: Json) => x.id === listing.id));

  // Admin take-down of another listing returns the ticket
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 1 }, seller.token));
  const o2 = await ok(call('POST', '/orders', { holdId: h2.id, email: `rs-seller-${run}@test.local`, name: 'Sola Seller' }, seller.token));
  const t2 = (await ok(call('POST', `/orders/${o2.orderId}/pay`))).tickets[0].id;
  const l2 = await ok(call('POST', `/tickets/${t2}/listing`, { priceCents: face }, seller.token));
  await ok(call('POST', `/admin/resale/${l2.listingId}/delist`, { reason: 'Suspicious pricing pattern' }, admin.token));
  await ok(call('GET', `/tickets/${t2}/qr`, undefined, seller.token));

  // Organizer switches resale off: new listings refused
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { resaleEnabled: false }, org.token));
  assert.match((await call('POST', `/tickets/${t2}/listing`, { priceCents: face }, seller.token)).body.message, /allow resale/);
  assert.equal((await ok(call('GET', `/events/${ev.slug}/resale`))).enabled, false);
});

test('transfers: the recipient is emailed, organizers can switch them off', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`tr-org-${run}@test.local`, 'Tom Organizer');
  const from = await account(`tr-from-${run}@test.local`, 'Femi From');
  const to = await account(`tr-to-${run}@test.local`, 'Tolu To');
  const { ev, tt } = await publishedEvent(org.token, admin.token, 'Transfer Tavern');
  const h = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }, from.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: `tr-from-${run}@test.local`, name: 'Femi From' }, from.token));
  const [a, b] = (await ok(call('POST', `/orders/${o.orderId}/pay`))).tickets.map((t: Json) => t.id);
  const before = outbox.length;
  const sent = await ok(call('POST', `/tickets/${a}/transfer`, { email: `tr-to-${run}@test.local` }, from.token));
  assert.ok(sent.transferExpiresAt, 'transfers expire');
  const mail = await waitFor(() => outbox.slice(before).find((m) => m.to === `tr-to-${run}@test.local`));
  assert.match(mail.subject, /Femi sent you a ticket/);
  const incoming = await ok(call('GET', '/me/tickets', undefined, to.token));
  assert.ok(incoming.incomingTransfers.some((x: Json) => x.id === a));
  await ok(call('POST', `/tickets/${a}/accept`, undefined, to.token));
  await ok(call('GET', `/tickets/${a}/qr`, undefined, to.token));
  // Organizer turns transfers off
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { transfersEnabled: false }, org.token));
  assert.match((await call('POST', `/tickets/${b}/transfer`, { email: `tr-to-${run}@test.local` }, from.token)).body.message, /allow transfers/);
});

test('event previews: signed links show unpublished events to their team, never to the public', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pv-org-${run}@test.local`, 'Pat Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Preview Org ${run}` }, org.token));
  const ev = await ok(
    call('POST', `/organizer/orgs/${o.id}/events`, {
      title: `Preview Night ${run}`,
      category: 'COMEDY',
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      venue: { name: 'Cap City Room', address: '1 Congress Ave', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
      ticketTypes: [{ name: 'General', basePriceCents: 4830, capacity: 100 }],
    }, org.token),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));

  // Not public while in review
  assert.equal((await call('GET', `/events/${ev.slug}`)).status, 404);
  // The organizer's list and the admin queue both carry a preview token
  const mine = (await ok(call('GET', `/organizer/orgs/${o.id}/events`, undefined, org.token))).find((x: Json) => x.id === ev.id);
  assert.ok(mine.previewToken, 'organizer gets a preview token');
  const queued = (await ok(call('GET', '/admin/reviews', undefined, admin.token))).find((x: Json) => x.id === ev.id);
  assert.ok(queued.previewToken, 'admin review queue gets a preview token');

  const shown = await ok(call('GET', `/events/${ev.slug}?preview=${encodeURIComponent(mine.previewToken)}`));
  assert.equal(shown.preview, true);
  assert.equal(shown.status, 'IN_REVIEW');
  // A token for another slug, a tampered token or an expired one doesn't open it
  assert.equal((await call('GET', `/events/${ev.slug}?preview=${encodeURIComponent(mine.previewToken.slice(0, -2) + 'xx')}`)).status, 404);
  const [, mac] = mine.previewToken.split('.');
  assert.equal((await call('GET', `/events/${ev.slug}?preview=${(Date.now() - 1000).toString(36)}.${mac}`)).status, 404);
  // Buying still needs the event to be published
  assert.equal((await call('POST', '/holds', { ticketTypeId: ev.ticketTypes[0].id, quantity: 1 }, org.token)).status, 400);

  // Once approved: public, and no preview token any more
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));
  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(pub.preview, undefined);
  const after = (await ok(call('GET', `/organizer/orgs/${o.id}/events`, undefined, org.token))).find((x: Json) => x.id === ev.id);
  assert.equal(after.previewToken, undefined);
});

test('review decisions: rejections email the organizer and the other admins; approvals email the organizer', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const other = await account(`rv-admin2-${run}@test.local`, 'Second Admin');
  await ok(call('PATCH', `/admin/users/${other.user.id}`, { roles: ['FAN', 'ADMIN'] }, admin.token));
  const org = await account(`rv-org-${run}@test.local`, 'Remi Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Review Org ${run}` }, org.token));
  const make = async (title: string) => {
    const ev = await ok(
      call('POST', `/organizer/orgs/${o.id}/events`, {
        title: `${title} ${run}`,
        category: 'COMEDY',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Cap City Room', address: '1 Congress Ave', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
        ticketTypes: [{ name: 'General', basePriceCents: 4830, capacity: 100 }],
      }, org.token),
    );
    await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
    return ev;
  };

  const bad = await make('Rejected Show');
  const reason = 'The venue address is incomplete. Please add the street address.';
  await ok(call('POST', `/admin/events/${bad.id}/reject`, { note: reason }, admin.token));
  const toOrg = await waitFor(() => outbox.find((m) => m.to === `rv-org-${run}@test.local` && m.subject.includes('Changes needed')));
  assert.ok(toOrg.html.includes('street address'), 'the organizer sees the reason');
  const toAdmin = await waitFor(() => outbox.find((m) => m.to === `rv-admin2-${run}@test.local` && m.subject.startsWith('Rejected:')));
  assert.ok(toAdmin.html.includes('street address'), 'other admins see the reason');
  assert.ok(!outbox.some((m) => m.to === 'admin@test.local' && m.subject === `Rejected: ${bad.title} (Review Org ${run})`), 'the acting admin is not copied');
  // and the organizer sees it on the event too
  assert.equal((await ok(call('GET', `/organizer/events/${bad.id}`, undefined, org.token))).reviewNote, reason);

  const good = await make('Approved Show');
  await ok(call('POST', `/admin/events/${good.id}/approve`, undefined, admin.token));
  await waitFor(() => outbox.find((m) => m.to === `rv-org-${run}@test.local` && m.subject.startsWith('Approved:')));
});

test('payouts: Nigerian organizers pick a bank, confirm the account name, and get a Paystack subaccount', async () => {
  const org = await account(`po-org-${run}@test.local`, 'Ada Payouts');
  const stranger = await account(`po-x-${run}@test.local`, 'Not A Member');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Payout Org ${run}` }, org.token));

  const countries = await ok(call('GET', '/organizer/payout-countries', undefined, org.token));
  assert.equal(countries.countries.find((c: Json) => c.code === 'NG').provider, 'paystack');
  assert.equal(countries.countries.find((c: Json) => c.code === 'US').provider, 'stripe');

  const banks = await ok(call('GET', `/organizer/orgs/${o.id}/payouts/banks?country=NG`, undefined, org.token));
  assert.ok(banks.banks.some((b: Json) => b.code === '044'));
  assert.equal((await call('GET', `/organizer/orgs/${o.id}/payouts/banks?country=NG`, undefined, stranger.token)).status, 403, 'only org admins');
  assert.equal((await call('GET', `/organizer/orgs/${o.id}/payouts/banks?country=US`, undefined, org.token)).status, 400, 'US is Stripe, not a bank list');

  // Name check
  const named = await ok(call('POST', `/organizer/orgs/${o.id}/payouts/resolve`, { country: 'NG', bankCode: '044', accountNumber: '0123456789' }, org.token));
  assert.equal(named.accountName, 'TEST ACCOUNT HOLDER');
  assert.equal(named.last4, '6789');
  assert.equal((await call('POST', `/organizer/orgs/${o.id}/payouts/resolve`, { country: 'NG', bankCode: '044', accountNumber: '0000000000' }, org.token)).status, 400);
  assert.equal((await call('POST', `/organizer/orgs/${o.id}/payouts/resolve`, { country: 'NG', bankCode: '999', accountNumber: '0123456789' }, org.token)).status, 400, 'unknown bank');
  assert.equal((await call('POST', `/organizer/orgs/${o.id}/payouts/resolve`, { country: 'NG', bankCode: '044', accountNumber: '01234-56789' }, org.token)).status, 400, 'digits only');

  // First account: no hold, admins emailed
  const saved = await ok(call('PUT', `/organizer/orgs/${o.id}/payouts/bank`, { country: 'NG', bankCode: '044', accountNumber: '0123456789' }, org.token));
  assert.equal(saved.bankName, 'Access Bank');
  assert.equal(saved.holdUntil, null);
  let p = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(p.payoutMethod.provider, 'paystack');
  assert.equal(p.payoutMethod.bankLast4, '6789');
  assert.equal(p.payoutMethod.accountName, 'TEST ACCOUNT HOLDER');
  assert.ok(!JSON.stringify(p).includes('0123456789'), 'the full account number is never returned');
  await waitFor(() => outbox.find((m) => m.to === `po-org-${run}@test.local` && m.subject.startsWith('Payout account added')));

  // Changing it: 24-hour hold and a warning email
  await ok(call('PUT', `/organizer/orgs/${o.id}/payouts/bank`, { country: 'NG', bankCode: '058', accountNumber: '0987654321' }, org.token));
  p = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(p.payoutMethod.bankName, 'Guaranty Trust Bank');
  assert.ok(new Date(p.holdUntil).getTime() > Date.now() + 23 * 3600_000, 'payouts pause for a day after a change');
  const warn = await waitFor(() => outbox.find((m) => m.to === `po-org-${run}@test.local` && m.subject.startsWith('Payout account changed')));
  assert.ok(warn.html.includes('4321'));
});

test('payouts: a Paystack split sends the organizer share to their subaccount', async () => {
  const { PaystackProvider } = await import('../src/checkout/payments');
  const seen: Json[] = [];
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.test/x', reference: 'ord_1' } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const { config } = await import('../src/config');
  const was = config.paystackUrl;
  (config as { paystackUrl: string }).paystackUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  try {
    const p = new PaystackProvider('sk_test_stub');
    await p.createPayment({ orderId: 'ord_1', amountCents: 1_000_000, currency: 'NGN', email: 'fan@test.local', description: 'x', split: { subaccount: 'ACCT_abc', platformCents: 35_000 } });
    const init = seen.find((s) => s.url === '/transaction/initialize')!;
    assert.equal(init.body.subaccount, 'ACCT_abc');
    assert.equal(init.body.transaction_charge, 35_000);
    assert.equal(init.body.bearer, 'account');
  } finally {
    (config as { paystackUrl: string }).paystackUrl = was;
    stub.close();
  }
});
