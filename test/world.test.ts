/**
 * Worldwide: per-event currency, Paystack for naira (against a small stand-in Paystack, no real service is
 * called), venue time zones, online events, and exchange rates.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';

const SECRET = `sk_test_${'p'.repeat(32)}`;
let mock: Server;
/** reference → what the stand-in reports when it is verified */
const charges = new Map<string, { amount: number; currency: string; status: string }>();

let app: INestApplication;
let base = '';
const run = Date.now().toString(36);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const account = async (email: string, name: string) => {
  const s = await call('POST', '/auth/signup', { email, name, password: 'test-password-123' });
  if (s.status < 300) return s.body.token as string;
  return (await ok(call('POST', '/auth/login', { email, password: 'test-password-123' }))).token as string;
};

before(async () => {
  // Stand-in for the Paystack API: checks the secret key, initializes and verifies transactions.
  mock = createServer((req, res) => {
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
        assert.ok(b.callback_url.includes(`/checkout/return?order=${b.reference}`));
        charges.set(b.reference, { amount: b.amount, currency: b.currency, status: 'abandoned' });
        return send(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${b.reference}`, reference: b.reference } });
      }
      const m = /^\/transaction\/verify\/(.+)$/.exec(url);
      if (req.method === 'GET' && m) {
        const c = charges.get(decodeURIComponent(m[1]));
        if (!c) return send(404, { status: false, message: 'Transaction not found' });
        return send(200, { status: true, data: { ...c, reference: m[1] } });
      }
      send(404, { status: false, message: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_API_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.PAYSTACK_SECRET_KEY = SECRET;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
  mock?.close();
});

test('naira event: priced in NGN, paid through Paystack, verified before tickets are issued', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`ng-org-${run}@test.local`, 'Ada Organizer');
  const fan = await account(`ng-fan-${run}@test.local`, 'Femi Fan');

  const o = await ok(call('POST', '/organizer/orgs', { name: `Naija Nights ${run}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: 'Lagos Live Test',
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
        currency: 'NGN',
        // The time zone comes from the venue's map position.
        venue: { name: 'Eko Hall', address: 'Adetokunbo Ademola St', city: 'Lagos', country: 'NG', region: 'Lagos', postalCode: '101241', lat: 6.4266, lng: 3.4305 },
        ticketTypes: [{ name: 'Regular', basePriceCents: 2_500_000, capacity: 50 }], // ₦25,000 in kobo
      },
      org,
    ),
  );
  assert.equal(ev.currency, 'NGN');
  assert.equal(ev.timezone, 'Africa/Lagos');
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));

  const pub = await ok(call('GET', `/events/${ev.slug}`));
  assert.equal(pub.currency, 'NGN');
  assert.equal(pub.venue.country, 'NG');
  assert.equal(pub.venue.timezone, 'Africa/Lagos');

  const tt = ev.ticketTypes[0];
  const hold = await ok(call('POST', '/holds', { ticketTypeId: tt.id, quantity: 2 }, fan));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: `ng-fan-${run}@test.local`, name: 'Femi Fan' }, fan));
  assert.equal(order.provider, 'paystack');
  assert.equal(order.currency, 'NGN');
  assert.match(order.redirectUrl, /^https:\/\/checkout\.paystack\.test\//);
  assert.equal(charges.get(order.orderId)?.amount, order.totalCents);

  // Not paid yet: verifying reports the status and issues nothing.
  const pending = await ok(call('POST', `/orders/${order.orderId}/verify`));
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.paymentStatus, 'abandoned');

  // A charge for less than the order is refused.
  charges.set(order.orderId, { amount: order.totalCents - 100, currency: 'NGN', status: 'success' });
  assert.equal((await call('POST', `/orders/${order.orderId}/verify`)).status, 400);

  // Webhooks need Paystack's signature.
  const hook = JSON.stringify({ event: 'charge.success', data: { reference: order.orderId } });
  assert.equal((await call('POST', '/webhooks/paystack', hook, undefined, { 'x-paystack-signature': 'nope' })).status, 400);

  // The right amount, through a signed webhook, issues the tickets once.
  charges.set(order.orderId, { amount: order.totalCents, currency: 'NGN', status: 'success' });
  const sig = createHmac('sha512', SECRET).update(hook).digest('hex');
  await ok(call('POST', '/webhooks/paystack', hook, undefined, { 'x-paystack-signature': sig }));
  const paid = await ok(call('POST', `/orders/${order.orderId}/verify`));
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.tickets.length, 2);

  // Payouts are in the event's currency.
  const payouts = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org));
  assert.equal(payouts.currency, 'NGN');
  assert.equal(payouts.converted, false);
});

test('online events keep the organizer’s time zone; unknown zones and currencies are refused', async () => {
  const org = await account(`online-org-${run}@test.local`, 'Oni Online');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Stream Co ${run}` }, org));
  const body = {
    title: 'Global Livestream',
    category: 'CONCERTS',
    startsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    online: true,
    streamUrl: 'https://stream.example.com/live',
    timezone: 'Europe/London',
    currency: 'GBP',
    ticketTypes: [{ name: 'Stream pass', basePriceCents: 1000, capacity: 1000 }],
  };
  const ev = await ok(call('POST', `/organizer/orgs/${o.id}/events`, body, org));
  assert.equal(ev.timezone, 'Europe/London');
  assert.equal(ev.currency, 'GBP');
  assert.equal(ev.online, true);

  // Buyers get the private stream link with their tickets; a ticket listed for resale doesn't carry it.
  const admin = await account('admin@test.local', 'Admin');
  const fan = await account(`online-fan-${run}@test.local`, 'Wale Watcher');
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  const hold = await ok(call('POST', '/holds', { ticketTypeId: ev.ticketTypes[0].id, quantity: 2 }, fan));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: `online-fan-${run}@test.local`, name: 'Wale Watcher' }, fan));
  assert.equal(order.currency, 'GBP');
  await ok(call('POST', `/orders/${order.orderId}/pay`));
  const mine = await ok(call('GET', '/me/tickets', undefined, fan));
  const [t1, t2] = mine.tickets;
  assert.equal(t1.event.streamUrl, 'https://stream.example.com/live');
  assert.equal(t1.event.timezone, 'Europe/London');
  await ok(call('POST', `/tickets/${t2.id}/listing`, { priceCents: 1000 }, fan));
  const after = await ok(call('GET', '/me/tickets', undefined, fan));
  assert.equal(after.tickets.find((t: Json) => t.id === t2.id).event.streamUrl, null);

  const badZone = await call('POST', `/organizer/orgs/${o.id}/events`, { ...body, timezone: 'Mars/Olympus' }, org);
  assert.equal(badZone.status, 400);
  assert.match(String(badZone.body.message), /time zone/i);
  assert.equal((await call('POST', `/organizer/orgs/${o.id}/events`, { ...body, currency: 'XYZ' }, org)).status, 400);
});

test('geo and exchange rates', async () => {
  const fx = await ok(call('GET', '/fx/rates'));
  assert.equal(fx.base, 'USD');
  assert.ok(fx.rates.NGN > 100);
  const ng = await ok(call('GET', '/geo/countries/NG/regions'));
  assert.ok(ng.some((r: Json) => r.name === 'Lagos'));
  const tz = await ok(call('GET', '/geo/timezone?lat=51.5&lng=-0.12'));
  assert.equal(tz.timezone, 'Europe/London');
  // Without a map position: the state's zone, else the country's main zone (never the alphabetical first, America/Adak).
  const zone = async (q: string) => (await ok(call('GET', `/geo/timezone?${q}`))).timezone;
  assert.equal(await zone('country=US&region=Texas'), 'America/Chicago');
  assert.equal(await zone('country=US&region=CA'), 'America/Los_Angeles');
  assert.equal(await zone('country=US'), 'America/New_York');
  assert.equal(await zone('country=CA&region=British Columbia'), 'America/Vancouver');
  assert.equal(await zone('country=AU'), 'Australia/Sydney');
  assert.equal(await zone('country=NG&region=Lagos'), 'Africa/Lagos');
  assert.equal(await zone('country=GH'), 'Africa/Accra');
  assert.equal((await call('GET', '/geo/timezone?country=XX')).status, 400);
  // Behind a CDN that reports the visitor's country.
  const me = await ok(call('GET', '/geo/me', undefined, undefined, { 'cf-ipcountry': 'NG' }));
  assert.equal(me.country, 'NG');
  assert.equal(me.currency, 'NGN');
});

test('venues without a map position get their state’s time zone; existing venues keep theirs', async () => {
  const org = await account(`tz-org-${run}@test.local`, 'Tess Zone');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Zone Works ${run}` }, org));
  const body = {
    title: 'Austin Zone Test',
    category: 'CONCERTS',
    startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    currency: 'USD',
    venue: { name: `Zone Hall ${run}`, address: '1 Congress Ave', city: 'Austin', country: 'US', region: 'Texas' },
    ticketTypes: [{ name: 'GA', basePriceCents: 2_000, capacity: 10 }],
  };
  const ev = await ok(call('POST', `/organizer/orgs/${o.id}/events`, body, org));
  assert.equal(ev.timezone, 'America/Chicago');
  const full = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org));
  const venueId = full.venue?.id ?? full.venueId;
  assert.ok(venueId, 'the event has a venue id');
  // A second event at that venue, picked by id and with no zone given, takes the venue's zone (it used to be UTC).
  const again = await ok(call('POST', `/organizer/orgs/${o.id}/events`, { ...body, title: 'Austin Zone Test 2', venue: undefined, venueId }, org));
  assert.equal(again.timezone, 'America/Chicago');
});
