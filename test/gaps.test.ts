/**
 * Small API additions for the clients: trending sort (`sort=popular`, `soldRecent`), Paystack sending app buyers
 * back to the app (`returnTo: 'app'`), price filters in the visitor's currency (`currency`, `fromCentsIn`), who
 * scanned a ticket first (online check-in), event currency in My tickets, section names in My resale, and the
 * door scanner's light event list. Paystack is a local stand-in; nothing real is called.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';

const SECRET = `sk_test_${'g'.repeat(32)}`;
let paystack: Server;
/** reference → what the stand-in reports when it is verified, and the callback URL it was given */
const charges = new Map<string, { amount: number; currency: string; status: string; callback: string }>();

let app: INestApplication;
let base = '';
const run = Date.now().toString(36);
const CITY = `Gapton ${run}`;

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
  paystack = createServer((req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { status: false, message: 'Invalid key' });
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/transaction/initialize') {
        const b = JSON.parse(raw) as { reference: string; amount: number; currency: string; callback_url: string };
        charges.set(b.reference, { amount: b.amount, currency: b.currency, status: 'abandoned', callback: b.callback_url });
        return send(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${b.reference}`, reference: b.reference } });
      }
      const m = /^\/transaction\/verify\/(.+)$/.exec(url);
      if (req.method === 'GET' && m) {
        const c = charges.get(decodeURIComponent(m[1]));
        if (!c) return send(404, { status: false, message: 'Transaction not found' });
        return send(200, { status: true, data: { amount: c.amount, currency: c.currency, status: c.status, reference: m[1] } });
      }
      send(404, { status: false, message: 'not found' });
    });
  });
  await new Promise<void>((r) => paystack.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_API_URL = `http://127.0.0.1:${(paystack.address() as AddressInfo).port}`;
  process.env.PAYSTACK_SECRET_KEY = SECRET;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
  paystack?.close();
});

/** A published event in CITY. USD events are paid with the mock provider, NGN ones through the Paystack stand-in. */
async function publishedEvent(orgToken: string, adminToken: string, orgId: string, opts: { title: string; days: number; currency?: 'USD' | 'NGN'; basePriceCents: number; arena?: boolean }) {
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${orgId}/events`,
      {
        title: `${opts.title} ${run}`,
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + opts.days * 86_400_000).toISOString(),
        ...(opts.currency ? { currency: opts.currency } : {}),
        // One-word names unique to this run, in places no other test uses, so venue matching never joins
        // these events to another test's venue (or another run's).
        venue:
          opts.currency === 'NGN'
            ? { name: `Gapyard${run}`, address: '1 Herbert Macaulay Way', city: CITY, country: 'NG', region: 'FCT', lat: 9.0765, lng: 7.3986 }
            : { name: `Gapworks${run}`, address: '1 Main St', city: CITY, country: 'US', region: 'Idaho', lat: 43.615, lng: -116.2023 },
        ticketTypes: [{ name: 'General', basePriceCents: opts.basePriceCents, capacity: 2000 }],
      },
      orgToken,
    ),
  );
  if (opts.arena) {
    const tt = ev.ticketTypes[0].id;
    await ok(call('POST', `/organizer/events/${ev.id}/seat-map/template`, { template: 'arena', floor: tt, lower: tt, upper: tt }, orgToken));
  }
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, orgToken));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, adminToken));
  return ev as Json;
}

/** Buys `qty` tickets with the mock provider (USD events). */
async function buyMock(fan: { token: string; user: Json }, ticketTypeId: string, qty: number) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity: qty }, fan.token));
  const o = await ok(call('POST', '/orders', { holdId: hold.id, email: fan.user.email, name: fan.user.name }, fan.token));
  assert.equal(o.provider, 'mock');
  return ok(call('POST', `/orders/${o.orderId}/pay`));
}

let shared: { admin: { token: string; user: Json }; org: { token: string; user: Json }; orgId: string } | null = null;
async function setup() {
  if (shared) return shared;
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gap-org-${run}@test.local`, 'Gina Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Gap Promotions ${run}` }, org.token));
  shared = { admin, org, orgId: o.id };
  return shared;
}

test('sort=popular ranks by paid tickets in the last 14 days, ties soonest first; cards carry soldRecent', async () => {
  const { admin, org, orgId } = await setup();
  const fan = await account(`gap-fan1-${run}@test.local`, 'Pop Fan');
  const soon = await publishedEvent(org.token, admin.token, orgId, { title: 'Soon Show', days: 5, basePriceCents: 2000 });
  const later = await publishedEvent(org.token, admin.token, orgId, { title: 'Later Show', days: 9, basePriceCents: 2000 });
  const quiet1 = await publishedEvent(org.token, admin.token, orgId, { title: 'Quiet One', days: 6, basePriceCents: 2000 });
  const quiet2 = await publishedEvent(org.token, admin.token, orgId, { title: 'Quiet Two', days: 7, basePriceCents: 2000 });
  await buyMock(fan, soon.ticketTypes[0].id, 1);
  const big = await buyMock(fan, later.ticketTypes[0].id, 3);
  await buyMock(fan, later.ticketTypes[0].id, 2);

  const slugs = [soon.slug, later.slug, quiet1.slug, quiet2.slug];
  const list = async (extra: string) => ((await ok(call('GET', `/events?city=${encodeURIComponent(CITY)}&pageSize=100${extra}`))).items as Json[]).filter((c) => slugs.includes(c.slug));

  const byDate = await list('');
  assert.deepEqual(byDate.map((c) => c.slug), [soon.slug, quiet1.slug, quiet2.slug, later.slug]);
  const sold = Object.fromEntries(byDate.map((c) => [c.slug, c.soldRecent]));
  assert.deepEqual(sold, { [soon.slug]: 1, [later.slug]: 5, [quiet1.slug]: 0, [quiet2.slug]: 0 });

  const popular = await list('&sort=popular');
  assert.deepEqual(popular.map((c) => c.slug), [later.slug, soon.slug, quiet1.slug, quiet2.slug], 'most sold first, then soonest');

  // Sales older than 14 days don't count.
  const prisma = app.get(PrismaService);
  await prisma.order.update({ where: { id: big.id }, data: { paidAt: new Date(Date.now() - 20 * 86_400_000) } });
  const after = await list('&sort=popular');
  assert.deepEqual(after.map((c) => [c.slug, c.soldRecent]), [[later.slug, 2], [soon.slug, 1], [quiet1.slug, 0], [quiet2.slug, 0]]);
  // Works alongside near (popularity wins over distance when asked for).
  const near = (await ok(call('GET', `/events?near=43.615,-116.2023&sort=popular&city=${encodeURIComponent(CITY)}`))).items as Json[];
  assert.equal(near.filter((c) => slugs.includes(c.slug))[0].slug, later.slug);
  assert.equal((await call('GET', '/events?sort=hot')).status, 400);
});

test('cards carry resaleCount: active listings only, 0 while held or when resale is off', async () => {
  const { admin, org, orgId } = await setup();
  const fan = await account(`gap-rs-seller-${run}@test.local`, 'Rhea Seller');
  const buyer = await account(`gap-rs-buyer-${run}@test.local`, 'Remi Buyer');
  const listed = await publishedEvent(org.token, admin.token, orgId, { title: 'Resale Rave', days: 15, basePriceCents: 3000 });
  const plain = await publishedEvent(org.token, admin.token, orgId, { title: 'No Resale Night', days: 16, basePriceCents: 3000 });
  const paid = await buyMock(fan, listed.ticketTypes[0].id, 2);
  const [t1, t2] = (paid.tickets as Json[]).map((t) => t.id as string);
  const l1 = await ok(call('POST', `/tickets/${t1}/listing`, { priceCents: 3000 }, fan.token));
  await ok(call('POST', `/tickets/${t2}/listing`, { priceCents: 3300 }, fan.token));

  const slugs = [listed.slug, plain.slug];
  const counts = async () =>
    Object.fromEntries(((await ok(call('GET', `/events?city=${encodeURIComponent(CITY)}&pageSize=100`))).items as Json[]).filter((c) => slugs.includes(c.slug)).map((c) => [c.slug, c.resaleCount]));
  assert.deepEqual(await counts(), { [listed.slug]: 2, [plain.slug]: 0 });

  // A held listing isn't on sale; the public list agrees.
  const hold = await ok(call('POST', `/resale/${l1.listingId}/hold`, undefined, buyer.token));
  assert.ok(hold.holdKey);
  assert.deepEqual(await counts(), { [listed.slug]: 1, [plain.slug]: 0 });
  assert.equal((await ok(call('GET', `/events/${listed.slug}/resale`))).listings.length, 1);

  // Resale switched off: nothing can be bought, so the card says 0.
  await ok(call('PATCH', `/organizer/events/${listed.id}`, { resaleEnabled: false }, org.token));
  assert.deepEqual(await counts(), { [listed.slug]: 0, [plain.slug]: 0 });
});

test('currency: maxPrice compares in the visitor’s currency, and cards get fromCentsIn', async () => {
  const { admin, org, orgId } = await setup();
  const naira = await publishedEvent(org.token, admin.token, orgId, { title: 'Naira Night', days: 12, currency: 'NGN', basePriceCents: 2_500_000 });
  const dollars = await publishedEvent(org.token, admin.token, orgId, { title: 'Dollar Night', days: 13, basePriceCents: 4830 });
  const slugs = [naira.slug, dollars.slug];
  const list = async (extra: string) => ((await ok(call('GET', `/events?city=${encodeURIComponent(CITY)}&pageSize=100${extra}`))).items as Json[]).filter((c) => slugs.includes(c.slug));

  const plain = await list('');
  const ng = plain.find((c) => c.slug === naira.slug)!;
  const us = plain.find((c) => c.slug === dollars.slug)!;
  assert.equal(ng.currency, 'NGN');
  assert.equal(ng.fromCentsIn, undefined, 'no conversion without currency');
  // Built-in test rates: 1 USD = 1550 NGN.
  const ngInUsd = Math.round(ng.fromCents / 1550);
  const usInNgn = Math.round(us.fromCents * 1550);

  const inUsd = await list('&currency=usd');
  assert.deepEqual(inUsd.find((c) => c.slug === naira.slug)!.fromCentsIn, { currency: 'USD', cents: ngInUsd });
  assert.deepEqual(inUsd.find((c) => c.slug === dollars.slug)!.fromCentsIn, { currency: 'USD', cents: us.fromCents });

  // Under $30: the ₦25,000 show (about $17) is in, the $50 show is out.
  const cap = 30;
  assert.ok(ngInUsd <= cap * 100 && us.fromCents > cap * 100);
  assert.deepEqual((await list(`&maxPrice=${cap}&currency=USD`)).map((c) => c.slug), [naira.slug]);
  // Without currency, maxPrice is in each event's own currency (unchanged): ₦26k is far over "30".
  assert.deepEqual((await list(`&maxPrice=${cap}`)).map((c) => c.slug), []);
  // In naira: under ₦30,000 keeps the naira show and drops the $50 (about ₦77,500) one.
  assert.ok(ng.fromCents <= 30_000 * 100 && usInNgn > 30_000 * 100);
  assert.deepEqual((await list('&maxPrice=30000&currency=NGN')).map((c) => c.slug), [naira.slug]);
  assert.equal((await call('GET', '/events?currency=XYZ')).status, 400);
});

test('returnTo: app sends Paystack buyers back with &app=1 (orders and resale orders)', async () => {
  const { admin, org, orgId } = await setup();
  const seller = await account(`gap-seller-${run}@test.local`, 'Sade Seller');
  const buyer = await account(`gap-buyer-${run}@test.local`, 'Bisi Buyer');
  const ev = await publishedEvent(org.token, admin.token, orgId, { title: 'Paystack Party', days: 20, currency: 'NGN', basePriceCents: 1_000_000, arena: true });
  const tt = ev.ticketTypes[0].id;

  // From the website: the usual return URL.
  const h1 = await ok(call('POST', '/holds', { ticketTypeId: tt, quantity: 1 }, buyer.token));
  const web = await ok(call('POST', '/orders', { holdId: h1.id, email: buyer.user.email, name: buyer.user.name }, buyer.token));
  assert.equal(web.provider, 'paystack');
  assert.match(charges.get(web.orderId)!.callback, new RegExp(`/checkout/return\\?order=${web.orderId}$`));

  // From the app: the same page with app=1.
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: tt, quantity: 2 }, seller.token));
  assert.equal((await call('POST', '/orders', { holdId: h2.id, email: seller.user.email, name: seller.user.name, returnTo: 'web' }, seller.token)).status, 400);
  const fromApp = await ok(call('POST', '/orders', { holdId: h2.id, email: seller.user.email, name: seller.user.name, returnTo: 'app' }, seller.token));
  assert.match(charges.get(fromApp.orderId)!.callback, new RegExp(`/checkout/return\\?order=${fromApp.orderId}&app=1$`));
  // Paid on Paystack, then verified as usual.
  charges.get(fromApp.orderId)!.status = 'success';
  charges.get(fromApp.orderId)!.amount = fromApp.totalCents;
  const paid = await ok(call('POST', `/orders/${fromApp.orderId}/verify`));
  assert.equal(paid.status, 'PAID');

  // My tickets: the event's currency is on the event.
  const mine = await ok(call('GET', '/me/tickets', undefined, seller.token));
  const own = (mine.tickets as Json[]).filter((t) => t.event.slug === ev.slug);
  assert.equal(own.length, 2);
  assert.equal(own[0].event.currency, 'NGN');
  assert.equal(own[0].event.seatMap, undefined);

  // Resale: list one ticket, a buyer holds it and pays from the app.
  const ticket = own[0];
  const listed = await ok(call('POST', `/tickets/${ticket.id}/listing`, { priceCents: ticket.ticketType.priceCents }, seller.token));
  const resale = await ok(call('GET', '/me/resale', undefined, seller.token));
  const row = (resale.listings as Json[]).find((l) => l.id === listed.listingId)!;
  assert.ok(ticket.sectionName, 'arena seats have a section name');
  assert.equal(row.ticket.sectionName, ticket.sectionName, 'same section name as My tickets');
  assert.equal(row.event.slug, ev.slug);
  assert.equal(row.event.seatMap, undefined, 'the seat map stays out');
  assert.equal(row.heldBy, undefined);

  const rh = await ok(call('POST', `/resale/${listed.listingId}/hold`, undefined, buyer.token));
  const ro = await ok(call('POST', `/resale/${listed.listingId}/orders`, { holdKey: rh.holdKey, email: buyer.user.email, name: buyer.user.name, returnTo: 'app' }, buyer.token));
  assert.equal(ro.provider, 'paystack');
  assert.match(charges.get(ro.orderId)!.callback, new RegExp(`/checkout/return\\?order=${ro.orderId}&app=1$`));
});

test('online check-in: a duplicate says when, by whom and on which device', async () => {
  const { admin, org, orgId } = await setup();
  const fan = await account(`gap-fan2-${run}@test.local`, 'Dee Fan');
  const ev = await publishedEvent(org.token, admin.token, orgId, { title: 'Door Test', days: 1, basePriceCents: 2000 });
  const paid = await buyMock(fan, ev.ticketTypes[0].id, 1);
  const ticketId = paid.tickets[0].id as string;

  const first = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ticketId, deviceId: 'door-a' }, org.token));
  assert.equal(first.result, 'ok');
  const again = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ticketId, deviceId: 'door-b' }, org.token));
  assert.equal(again.result, 'duplicate');
  assert.equal(again.ticket.id, ticketId);
  assert.ok(Math.abs(new Date(again.checkedInAt).getTime() - Date.now()) < 60_000);
  assert.deepEqual(again.checkedInBy, { id: org.user.id, name: 'Gina Organizer' });
  assert.equal(again.checkedInDevice, 'door-a');

  // A scan without a device id (the website) reports null.
  await ok(call('DELETE', `/organizer/events/${ev.id}/check-in/${ticketId}`, undefined, org.token));
  await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ticketId }, org.token));
  const web = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: ticketId, deviceId: 'door-a' }, org.token));
  assert.equal(web.checkedInDevice, null);
  assert.equal(web.checkedInBy.name, 'Gina Organizer');
});

test('door-events: light list for the scanner, counts non-void tickets, DOOR role and up', async () => {
  const { admin, org, orgId } = await setup();
  const fan = await account(`gap-fan3-${run}@test.local`, 'Eve Fan');
  const stranger = await account(`gap-stranger-${run}@test.local`, 'Stan Stranger');
  const door = await account(`gap-door-${run}@test.local`, 'Sam Door');
  await ok(call('POST', `/organizer/orgs/${orgId}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));

  const ev = await publishedEvent(org.token, admin.token, orgId, { title: 'Door List', days: 2, basePriceCents: 2000 });
  const far = await publishedEvent(org.token, admin.token, orgId, { title: 'Far Future', days: 90, basePriceCents: 2000 });
  const paid = await buyMock(fan, ev.ticketTypes[0].id, 3);
  await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: paid.tickets[0].id }, door.token));
  // A voided ticket doesn't count.
  const prisma = app.get(PrismaService);
  await prisma.ticket.update({ where: { id: paid.tickets[2].id }, data: { status: 'VOID' } });

  const list = (await ok(call('GET', `/organizer/orgs/${orgId}/door-events`, undefined, door.token))) as Json[];
  assert.ok(!list.some((e) => e.id === far.id), 'only the next 60 days');
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].startsAt <= list[i].startsAt, 'soonest first');
  const row = list.find((e) => e.id === ev.id)!;
  assert.deepEqual(Object.keys(row).sort(), ['checkedIn', 'doorsAt', 'id', 'online', 'slug', 'startsAt', 'status', 'ticketsIssued', 'timezone', 'title', 'venue'].sort());
  assert.equal(row.ticketsIssued, 2);
  assert.equal(row.checkedIn, 1);
  assert.deepEqual(row.venue, { name: `Gapworks${run}`, city: CITY });
  assert.equal(row.online, false);
  assert.equal(row.status, 'PUBLISHED');

  // Same count as the door pack.
  const pack = await ok(call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, door.token));
  assert.equal(pack.tickets.length, row.ticketsIssued);

  // Events that started more than 2 days ago drop off.
  await prisma.event.update({ where: { id: ev.id }, data: { startsAt: new Date(Date.now() - 3 * 86_400_000) } });
  assert.ok(!((await ok(call('GET', `/organizer/orgs/${orgId}/door-events`, undefined, door.token))) as Json[]).some((e) => e.id === ev.id));
  assert.equal((await call('GET', `/organizer/orgs/${orgId}/door-events`, undefined, stranger.token)).status, 404);
});
