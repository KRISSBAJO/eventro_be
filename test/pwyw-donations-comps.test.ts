/**
 * Pay what you want, charity donations at checkout, comps and the guest list.
 * Payments and refunds use the mock provider; emails are logged as SKIPPED (no provider in tests).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { buyerPrice, organizerNet } from '../src/domain/money';
import { cleanPwywInput, pwywUnit, checkDonation, ticketLeft } from '../src/domain/pwyw';
import { parseCompLines } from '../src/organizer/comps';
import { parseGuestLines } from '../src/organizer/guest-list';
import { config } from '../src/config';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const HOUR = 3600_000;
const FEE = config.organizerFeePermille;

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
  return { status: res.status, body: parsed as Json, text };
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
async function waitFor<T>(fn: () => Promise<T | undefined | null>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
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

let n = 0;
/** A published event (its own new organization) with the given ticket types and settings. */
async function publishedEvent(org: string, admin: string, ticketTypes: Json[], extra: Json = {}) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `PWYW Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Open Night ${run} ${n}`,
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Open Hall', address: '1 Gate St', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
        ticketTypes,
        ...extra,
      },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  return { ev, org: o as Json };
}
const tier = (ev: Json, name: string) => (ev.ticketTypes as Json[]).find((t) => t.name === name)!;
/** Hold, order (with `extra`) and pay with the mock provider. */
async function buy(buyer: { token: string; user: Json }, ticketTypeId: string, quantity: number, hold: Json = {}, order: Json = {}) {
  const h = await ok(call('POST', '/holds', { ticketTypeId, quantity, ...hold }, buyer.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: buyer.user.email, name: buyer.user.name, ...order }, buyer.token));
  const paid = o.provider === 'free' ? await ok(call('GET', `/orders/${o.orderId}`, undefined, buyer.token)) : await ok(call('POST', `/orders/${o.orderId}/pay`));
  return { hold: h, created: o, order: paid };
}
const setTimes = (eventId: string, startsAt: Date) => prisma.event.update({ where: { id: eventId }, data: { startsAt, endsAt: null, timezone: 'UTC' } });

/* ---------- pay what you want ---------- */

test('pay what you want rules: organizer limits, the fan’s amount (whole units, min to max), fees as for fixed prices', () => {
  assert.deepEqual(cleanPwywInput({ pwywMinCents: 500, pwywSuggestedCents: 1500, pwywQuickPicks: [2000, 1000, 1000] }), { pwywMinCents: 500, pwywSuggestedCents: 1500, pwywMaxCents: null, pwywQuickPicks: [1000, 2000] });
  assert.throws(() => cleanPwywInput({ pwywMinCents: 500, pwywSuggestedCents: 100 }), /suggested price/);
  assert.throws(() => cleanPwywInput({ pwywMinCents: 500, pwywMaxCents: 400 }), /maximum can’t be below/);
  assert.throws(() => cleanPwywInput({ pwywMinCents: 0, pwywQuickPicks: [1, 2, 3, 4, 5] }), /up to 4/);
  assert.throws(() => cleanPwywInput({ pwywMinCents: 100, pwywMaxCents: 1000, pwywQuickPicks: [5000] }), /between the minimum and the maximum/);
  const t = { name: 'Supporter', pricing: 'PWYW' as const, pwywMinCents: 500, pwywSuggestedCents: null, pwywMaxCents: 5000, pwywQuickPicks: [] };
  assert.equal(pwywUnit(t, 1000, 'BUYER', FEE, 'USD'), buyerPrice(1000, 'BUYER', FEE));
  assert.equal(pwywUnit(t, 1000, 'ORGANIZER', FEE, 'USD'), 1000);
  assert.throws(() => pwywUnit(t, 499, 'BUYER', FEE, 'USD'), /minimum for Supporter is \$5\b/);
  assert.throws(() => pwywUnit(t, 5001, 'BUYER', FEE, 'USD'), /most you can pay/);
  assert.throws(() => pwywUnit(t, 1000.5, 'BUYER', FEE, 'USD'), /whole number/);
  assert.throws(() => pwywUnit(t, undefined, 'BUYER', FEE, 'USD'), /Choose how much/);
  assert.equal(pwywUnit({ ...t, pwywMinCents: 0 }, 0, 'BUYER', FEE, 'USD'), 0);
});

test('pay what you want: set on create and edit, validated at the hold, the quote and the order; unitCents is the chosen price', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pw-org1-${run}@test.local`, 'Pia Organizer');
  const fan = await account(`pw-fan1-${run}@test.local`, 'Femi Fan');
  const bad = await call(
    'POST',
    `/organizer/orgs/${(await ok(call('POST', '/organizer/orgs', { name: `PWYW Bad ${run}` }, org.token))).id}/events`,
    {
      title: `Bad PWYW ${run}`,
      category: 'CONCERTS',
      startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      online: true,
      ticketTypes: [{ name: 'Supporter', pricing: 'PWYW', pwywMinCents: 1000, pwywSuggestedCents: 500, capacity: 10 }],
    },
    org.token,
  );
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /suggested price/);

  const { ev } = await publishedEvent(org.token, admin.token, [
    { name: 'Supporter', pricing: 'PWYW', pwywMinCents: 500, pwywSuggestedCents: 1500, pwywMaxCents: 10_000, pwywQuickPicks: [1000, 1500, 2500], capacity: 50 },
    { name: 'General', basePriceCents: 2000, capacity: 50 },
  ]);
  const sup = tier(ev, 'Supporter');
  assert.equal(sup.pricing, 'PWYW');
  assert.equal(sup.priceCents, buyerPrice(500, 'BUYER', FEE), 'the "from" price is the minimum, all-in');

  // The event page shows the limits as base amounts and the fee the fan pays on top.
  const page = await ok(call('GET', `/events/${ev.slug}`));
  const pt = (page.ticketTypes as Json[]).find((t) => t.id === sup.id)!;
  assert.deepEqual(pt.pwyw, { minCents: 500, suggestedCents: 1500, maxCents: 10_000, maxSet: true, quickPicks: [1000, 1500, 2500], feePermille: FEE });
  assert.equal(page.feeMode, 'BUYER');
  assert.equal((page.ticketTypes as Json[]).find((t) => t.name === 'General')!.pwyw, null);

  // At the hold: an amount is required, within the limits, in whole units.
  assert.match((await call('POST', '/holds', { ticketTypeId: sup.id, quantity: 2 }, fan.token)).body.message, /Choose how much/);
  assert.match((await call('POST', '/holds', { ticketTypeId: sup.id, quantity: 2, amountCents: 499 }, fan.token)).body.message, /minimum for Supporter is \$5\b/);
  assert.match((await call('POST', '/holds', { ticketTypeId: sup.id, quantity: 2, amountCents: 10_001 }, fan.token)).body.message, /most you can pay/);
  assert.equal((await call('POST', '/holds', { ticketTypeId: sup.id, quantity: 2, amountCents: 12.5 }, fan.token)).status, 400);

  const h = await ok(call('POST', '/holds', { ticketTypeId: sup.id, quantity: 2, amountCents: 1200 }, fan.token));
  assert.equal(h.amountCents, 1200);
  const held = await ok(call('GET', `/holds/${h.id}`));
  assert.equal(held.unitCents, buyerPrice(1200, 'BUYER', FEE));
  assert.equal(held.ticketType.pwyw.minCents, 500);

  // The quote: BUYER mode adds Omoshow's fee to the chosen amount, as for a fixed price.
  const unit = buyerPrice(1200, 'BUYER', FEE);
  const q = await ok(call('POST', '/quote', { holdId: h.id }));
  assert.equal(q.unitCents, unit);
  assert.equal(q.totalCents, unit * 2);
  assert.equal(q.feeCents, (unit - organizerNet(unit, 'BUYER', FEE)) * 2);
  assert.equal(q.amountCents, 1200);
  // Changing the amount at checkout is checked again.
  assert.equal((await call('POST', '/quote', { holdId: h.id, amountCents: 100 })).status, 400);
  assert.equal((await ok(call('POST', '/quote', { holdId: h.id, amountCents: 3000 }))).unitCents, buyerPrice(3000, 'BUYER', FEE));
  assert.equal((await call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, amountCents: 20_000 }, fan.token)).status, 400);

  const o = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, amountCents: 3000 }, fan.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  assert.equal(paid.unitCents, buyerPrice(3000, 'BUYER', FEE), 'everyone in the order pays the same chosen price');
  assert.equal(paid.totalCents, buyerPrice(3000, 'BUYER', FEE) * 2);
  assert.equal(paid.tickets.length, 2);

  // Edit: move the limits; a lower minimum isn't announced as a price drop.
  const edited = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${sup.id}`, { pwywMinCents: 0, pwywMaxCents: null }, org.token));
  assert.equal(edited.pwywMinCents, 0);
  assert.equal(edited.pwywMaxCents, null);
  assert.equal(edited.priceCents, 0);
  assert.equal(edited.priceDrop, null);
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${sup.id}`, { pwywSuggestedCents: 20_000_000 }, org.token)).status, 400);
  // Back to a fixed price needs a price.
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/ticket-types/${sup.id}`, { pricing: 'FIXED' }, org.token)).status, 400);
  const fixed = await ok(call('PATCH', `/organizer/events/${ev.id}/ticket-types/${sup.id}`, { pricing: 'FIXED', basePriceCents: 1000 }, org.token));
  assert.equal(fixed.pricing, 'FIXED');
  assert.equal(fixed.priceCents, buyerPrice(1000, 'BUYER', FEE));
});

test('pay what you want: ORGANIZER fee mode absorbs the fee; promo codes are refused at the quote and the order', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pw-org2-${run}@test.local`, 'Pia Organizer');
  const fan = await account(`pw-fan2-${run}@test.local`, 'Femi Fan');
  const { ev } = await publishedEvent(org.token, admin.token, [{ name: 'Supporter', pricing: 'PWYW', pwywMinCents: 500, capacity: 50 }], { feeMode: 'ORGANIZER' });
  await ok(call('POST', `/organizer/events/${ev.id}/promos`, { code: 'HALF', percent: 50 }, org.token));
  const h = await ok(call('POST', '/holds', { ticketTypeId: tier(ev, 'Supporter').id, quantity: 1, amountCents: 1234 }, fan.token));
  const q = await ok(call('POST', '/quote', { holdId: h.id }));
  assert.equal(q.unitCents, 1234, 'the fan pays the amount; the organizer absorbs the fee');
  assert.equal(q.feeCents, 0);
  const promo = await call('POST', '/quote', { holdId: h.id, promoCode: 'HALF' });
  assert.equal(promo.status, 400);
  assert.match(promo.body.message, /Promo codes don’t apply to pay-what-you-want tickets/);
  assert.equal((await call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, promoCode: 'HALF' }, fan.token)).status, 400);
  assert.equal((await prisma.promo.findFirstOrThrow({ where: { eventId: ev.id, code: 'HALF' } })).used, 0);
});

test('pay what you want and the guarantee: a paid PWYW ticket refunds its share of what was paid; a $0 one is free and not covered', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`pw-org3-${run}@test.local`, 'Pia Organizer');
  const fan = await account(`pw-fan3-${run}@test.local`, 'Femi Fan');
  const { ev } = await publishedEvent(org.token, admin.token, [{ name: 'Supporter', pricing: 'PWYW', pwywMinCents: 0, capacity: 50 }], { feeMode: 'ORGANIZER' });
  const sup = tier(ev, 'Supporter');

  const paid = await buy(fan, sup.id, 3, { amountCents: 1001 });
  assert.equal(paid.order.totalCents, 3003);
  // $0: nothing to pay, so the order is done straight away (no payment provider), and it's a free ticket.
  const free = await buy(fan, sup.id, 1, { amountCents: 0 });
  assert.equal(free.created.provider, 'free');
  assert.equal(free.created.status, 'PAID');
  assert.equal(free.order.totalCents, 0);
  assert.equal(free.order.tickets.length, 1);
  assert.equal((await ok(call('POST', `/orders/${free.created.orderId}/pay`))).status, 'PAID', 'the pay call also answers for a free order');

  await setTimes(ev.id, new Date(Date.now() - HOUR));
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t1 = (mine.tickets as Json[]).find((t) => t.id === paid.order.tickets[0].id)!;
  assert.equal(t1.guarantee.covered, true);
  assert.equal(t1.guarantee.refundCents, 1001);
  const tf = (mine.tickets as Json[]).find((t) => t.id === free.order.tickets[0].id)!;
  assert.equal(tf.guarantee.covered, false);
  assert.equal(tf.guarantee.notCovered, 'FREE');
  assert.match((await call('POST', `/tickets/${tf.id}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token)).body.message, /free/);

  const c = await ok(call('POST', `/tickets/${t1.id}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token));
  assert.equal(c.amountCents, 1001);
  const d = await ok(call('POST', `/admin/guarantee-claims/${c.id}/decide`, { decision: 'APPROVE' }, admin.token));
  assert.equal(d.refundStatus, 'REFUNDED');
  const o = await prisma.order.findUniqueOrThrow({ where: { id: paid.order.id } });
  assert.equal(o.refundedCents, 1001, 'exactly what was paid for that ticket');
  assert.equal(o.status, 'PARTIALLY_REFUNDED');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: t1.id } })).status, 'VOID');
});

/* ---------- donations ---------- */

test('donation rules: the cause is required when on; amounts are checked against the event’s settings', async () => {
  const d = { donationsEnabled: true, donationCause: 'Lagos Children’s Fund', donationDescription: null, donationSuggestedCents: [500, 1000], donationMinCents: 200 };
  assert.equal(checkDonation(d, 0, 'USD'), 0);
  assert.equal(checkDonation(d, 300, 'USD'), 300);
  assert.throws(() => checkDonation(d, 100, 'USD'), /smallest donation is \$2\b/);
  assert.throws(() => checkDonation({ ...d, donationsEnabled: false }, 300, 'USD'), /doesn’t take donations/);
  assert.equal(ticketLeft({ totalCents: 2570, refundedCents: 1035, donationCents: 500, donationRefundedCents: 0 }), 1035);

  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dn-org0-${run}@test.local`, 'Dayo Organizer');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Donations Bad ${run}` }, org.token));
  const body = { title: `Giving Night ${run}`, category: 'CONCERTS', startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), online: true, ticketTypes: [{ name: 'General', basePriceCents: 1000, capacity: 10 }] };
  const noCause = await call('POST', `/organizer/orgs/${o.id}/events`, { ...body, donationsEnabled: true }, org.token);
  assert.equal(noCause.status, 400);
  assert.match(noCause.body.message, /Name the cause/);
  assert.equal((await call('POST', `/organizer/orgs/${o.id}/events`, { ...body, donationsEnabled: true, donationCause: 'x'.repeat(81) }, org.token)).status, 400);
  const ev = await ok(call('POST', `/organizer/orgs/${o.id}/events`, body, org.token));
  const on = await ok(call('PATCH', `/organizer/events/${ev.id}`, { donationsEnabled: true, donationCause: 'Lagos Children’s Fund', donationSuggestedCents: [1000, 500], donationMinCents: 200 }, org.token));
  assert.equal(on.donationsEnabled, true);
  assert.deepEqual(on.donationSuggestedCents, [500, 1000]);
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}`, { donationSuggestedCents: [100] }, org.token)).status, 400, 'below the minimum');
  void admin;
});

test('donations: in the total with no fee, their own line on the order, never in guarantee shares; payouts show them apart', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dn-org1-${run}@test.local`, 'Dayo Organizer');
  const fan = await account(`dn-fan1-${run}@test.local`, 'Femi Fan');
  const { ev, org: o } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1000, capacity: 50 }], {
    donationsEnabled: true,
    donationCause: 'Lagos Children’s Fund',
    donationDescription: 'Books for schools.',
    donationSuggestedCents: [500, 1000],
  });
  const page = await ok(call('GET', `/events/${ev.slug}`));
  assert.deepEqual(page.donations, { cause: 'Lagos Children’s Fund', description: 'Books for schools.', suggestedCents: [500, 1000], minCents: null, maxCents: 10_000_000 });

  const price = buyerPrice(1000, 'BUYER', FEE);
  const h = await ok(call('POST', '/holds', { ticketTypeId: tier(ev, 'General').id, quantity: 2 }, fan.token));
  const q = await ok(call('POST', '/quote', { holdId: h.id, donationCents: 500, protection: true }));
  assert.equal(q.donationCents, 500);
  assert.equal(q.protectionCents, Math.round((price * 2 * 70) / 1000), 'protection is on the tickets only');
  assert.equal(q.totalCents, price * 2 + q.protectionCents + 500);
  assert.equal(q.ticketTotalCents, q.totalCents - 500);
  const created = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, donationCents: 500 }, fan.token));
  assert.equal(created.totalCents, price * 2 + 500);
  const paid = await ok(call('POST', `/orders/${created.orderId}/pay`));
  assert.equal(paid.donationCents, 500);
  assert.equal(paid.donationCause, 'Lagos Children’s Fund');
  assert.equal(paid.totalCents, price * 2 + 500);
  const history = await ok(call('GET', '/me/orders', undefined, fan.token));
  assert.equal((history.orders as Json[]).find((x) => x.id === paid.id)!.donationCents, 500);
  const receipt = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'order.receipt', to: fan.user.email } }));
  assert.ok(receipt);

  // Payouts: the organizer's share of the tickets (after Omoshow's fee), plus the whole donation as its own line.
  const pay = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  const ticketNet = organizerNet(price, 'BUYER', FEE) * 2;
  assert.equal(pay.pendingCents, ticketNet + 500);
  assert.equal(pay.pendingDonationCents, 500);
  assert.equal(pay.donationsCents, 500);
  assert.match(pay.donationNote, /organizer is responsible for passing them to the cause/);
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.donations, { orders: 1, cents: 500, refundedCents: 0, cause: 'Lagos Children’s Fund' });
  assert.equal(stats.grossCents, price * 2, 'ticket revenue leaves the donation out');

  // The guarantee refunds a ticket's share of the ticket total, never the donation.
  await setTimes(ev.id, new Date(Date.now() - HOUR));
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  const t = (mine.tickets as Json[]).find((x) => x.id === paid.tickets[0].id)!;
  assert.equal(t.guarantee.refundCents, price);
  const c = await ok(call('POST', `/tickets/${t.id}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token));
  assert.equal(c.amountCents, price);
  await ok(call('POST', `/admin/guarantee-claims/${c.id}/decide`, { decision: 'APPROVE' }, admin.token));
  const t2 = paid.tickets[1].id;
  const c2 = await ok(call('POST', `/tickets/${t2}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token));
  await ok(call('POST', `/admin/guarantee-claims/${c2.id}/decide`, { decision: 'APPROVE' }, admin.token));
  const after1 = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } });
  assert.equal(after1.refundedCents, price * 2, 'both tickets refunded, the donation kept');
  assert.equal(after1.donationRefundedCents, 0);
  assert.equal(after1.status, 'PARTIALLY_REFUNDED');
  const pay2 = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(pay2.pendingDonationCents, 500, 'guarantee refunds don’t touch the donation line');

  // An admin can refund the donation by hand, once.
  assert.equal((await call('POST', `/admin/orders/${paid.id}/refund-donation`, { reason: 'Asked us to' }, fan.token)).status, 403);
  const r = await ok(call('POST', `/admin/orders/${paid.id}/refund-donation`, { reason: 'Fan asked for it back' }, admin.token));
  assert.equal(r.donationRefundedCents, 500);
  assert.equal(r.refundedCents, price * 2 + 500);
  assert.equal(r.status, 'REFUNDED');
  assert.equal((await call('POST', `/admin/orders/${paid.id}/refund-donation`, { reason: 'Fan asked for it back' }, admin.token)).status, 400, 'nothing left to refund');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'order.donation_refund', entityId: paid.id } }));
  const pay3 = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(pay3.pendingDonationCents, 0);
});

test('donations: a free ticket plus a donation is a paid order for the donation only; cancelling the event refunds the donation too', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`dn-org2-${run}@test.local`, 'Dayo Organizer');
  const fan = await account(`dn-fan2-${run}@test.local`, 'Femi Fan');
  const { ev } = await publishedEvent(
    org.token,
    admin.token,
    [
      { name: 'Free list', basePriceCents: 0, capacity: 50 },
      { name: 'General', basePriceCents: 1000, capacity: 50 },
    ],
    { donationsEnabled: true, donationCause: 'Food Bank', donationMinCents: 300 },
  );
  const freeId = tier(ev, 'Free list').id;
  const h = await ok(call('POST', '/holds', { ticketTypeId: freeId, quantity: 1 }, fan.token));
  assert.equal((await call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, donationCents: 100 }, fan.token)).status, 400, 'below the minimum');
  const created = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, donationCents: 700 }, fan.token));
  assert.equal(created.provider, 'mock', 'a donation means there is something to pay');
  assert.equal(created.status, 'PENDING');
  assert.equal(created.totalCents, 700);
  const paid = await ok(call('POST', `/orders/${created.orderId}/pay`));
  assert.equal(paid.status, 'PAID');
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  assert.equal((mine.tickets as Json[]).find((t) => t.id === paid.tickets[0].id)!.guarantee.notCovered, 'FREE', 'a donation doesn’t make a free ticket covered');

  const second = await buy(fan, tier(ev, 'General').id, 1, {}, { donationCents: 400 });
  const cancel = await ok(call('POST', `/organizer/events/${ev.id}/cancel`, { reason: 'The venue flooded overnight.', confirmTitle: ev.title }, org.token));
  assert.equal(cancel.refunded, 2);
  for (const id of [paid.id, second.order.id]) {
    const o = await prisma.order.findUniqueOrThrow({ where: { id } });
    assert.equal(o.status, 'REFUNDED');
    assert.equal(o.refundedCents, o.totalCents, 'everything, the donation included');
    assert.equal(o.donationRefundedCents, o.donationCents);
  }
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'event.cancelled', to: fan.user.email } })));
});

/* ---------- comps ---------- */

test('comp lines and guest lines parse the pasted formats', () => {
  const c = parseCompLines('Ada Obi, ada@example.com\nBola <BOLA@example.com>\nChi\tchi@example.com\nno email here\n\n  ');
  assert.deepEqual(c.recipients.map((r) => [r.name, r.email]), [
    ['Ada Obi', 'ada@example.com'],
    ['Bola', 'bola@example.com'],
    ['Chi', 'chi@example.com'],
  ]);
  assert.deepEqual(c.errors.map((e) => e.line), [4]);
  const g = parseGuestLines('Ada Obi, ada@example.com, +2, Artist\nBola, +1\nChi\nDayo, +11\nEze, Press', 'Friends');
  assert.deepEqual(
    g.entries.map((e) => [e.name, e.email, e.plusOnes, e.group]),
    [
      ['Ada Obi', 'ada@example.com', 2, 'Artist'],
      ['Bola', null, 1, 'Friends'],
      ['Chi', null, 0, 'Friends'],
      ['Eze', null, 0, 'Press'],
    ],
  );
  assert.deepEqual(g.errors.map((e) => e.line), [4]);
});

test('comps: issued by admins and managers (not door staff), emailed, claimed like a gift, counted against capacity and the comp limit', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cp-org1-${run}@test.local`, 'Chi Organizer');
  const door = await account(`cp-door1-${run}@test.local`, 'Dee Door');
  const guest = await account(`cp-guest1-${run}@test.local`, 'Gina Guest');
  const fan = await account(`cp-fan1-${run}@test.local`, 'Femi Fan');
  const { ev, org: o } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 2000, capacity: 4 }], { compLimit: 3 });
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  const general = tier(ev, 'General');

  // Door staff can look but not issue.
  assert.equal((await call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'Gina Guest', email: guest.user.email }] }, door.token)).status, 403);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/comps`, undefined, door.token))).summary.issued, 0);

  // Bad lines are listed; nothing is issued.
  const bad = await call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, text: `Gina, ${guest.user.email}\nnobody` }, org.token);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: Json) => e.line), [2]);

  const issued = await ok(
    call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, text: `Gina Guest, ${guest.user.email}\nPat Press <pat-${run}@test.local>`, group: 'Press', note: 'Review copy' }, org.token),
  );
  assert.equal(issued.issued, 2);
  const gina = (issued.items as Json[]).find((i) => i.email === guest.user.email)!;
  assert.equal(gina.status, 'SENT');
  assert.equal(gina.group, 'Press');
  const order = await prisma.order.findUniqueOrThrow({ where: { id: gina.orderId }, include: { tickets: true, gift: true } });
  assert.equal(order.kind, 'COMP');
  assert.equal(order.totalCents, 0);
  assert.equal(order.status, 'PAID');
  assert.equal(order.tickets.length, 1);
  assert.equal(order.tickets[0].status, 'TRANSFER_PENDING', 'waits for the guest to claim it');
  assert.equal((await prisma.ticketType.findUniqueOrThrow({ where: { id: general.id } })).sold, 2, 'comps take places in the tier');
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'comp.issued', to: guest.user.email } }));
  assert.match(mail.subject, /You’re on the guest list for/);

  // The comp limit (3), then the tier's capacity (4 places: 2 comps + 1 more comp + 1 sale).
  assert.equal((await call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'A', email: `a-${run}@test.local` }, { name: 'B', email: `b-${run}@test.local` }] }, org.token)).status, 409);
  await ok(call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'Crew One', email: `crew-${run}@test.local` }] }, org.token));
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { compLimit: null }, org.token));
  await buy(fan, general.id, 1);
  const full = await call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'Late', email: `late-${run}@test.local` }] }, org.token);
  assert.equal(full.status, 409);
  assert.match(full.body.message, /sold out/);
  assert.equal((await call('POST', '/holds', { ticketTypeId: general.id, quantity: 1 }, fan.token)).status, 409, 'and fans can’t buy past it either');

  // The guest sees it as incoming (from the organizer) and claims it with the gift link.
  const mine = await ok(call('GET', '/me/tickets', undefined, guest.token));
  assert.equal((mine.tickets as Json[]).length, 0);
  const incoming = (mine.incomingTransfers as Json[]).find((t) => t.id === order.tickets[0].id)!;
  assert.equal(incoming.gift.comp, true);
  assert.equal(incoming.gift.from, o.name);
  const gv = await ok(call('GET', `/gifts/${order.gift!.token}`));
  assert.equal(gv.comp, true);
  assert.equal(gv.group, 'Press');
  assert.equal(gv.from, o.name);
  await ok(call('POST', `/gifts/${order.gift!.token}/claim`, undefined, guest.token));
  const claimed = await ok(call('GET', '/me/tickets', undefined, guest.token));
  const t = (claimed.tickets as Json[]).find((x) => x.id === order.tickets[0].id)!;
  assert.equal(t.status, 'ACTIVE');
  assert.equal(t.order.kind, 'COMP');
  assert.equal(t.guarantee.covered, false);
  assert.equal(t.guarantee.notCovered, 'COMP', 'comps aren’t covered by the guarantee');

  // Not covered: a claim is refused, and comps can't be resold.
  await setTimes(ev.id, new Date(Date.now() - HOUR));
  assert.match((await call('POST', `/tickets/${t.id}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, guest.token)).body.message, /complimentary/);
  assert.equal((await call('POST', `/tickets/${t.id}/listing`, { priceCents: 1000 }, guest.token)).status, 400);

  // At the door: "Comp · Press".
  const scan = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: t.id, deviceId: 'gate-c' }, door.token));
  assert.equal(scan.result, 'ok');
  assert.equal(scan.ticket.comp, true);
  assert.equal(scan.ticket.compGroup, 'Press');
  const pat = (issued.items as Json[]).find((i) => i.email !== guest.user.email)!;
  const unclaimed = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: pat.ticketId }, door.token));
  assert.equal(unclaimed.result, 'invalid');
  assert.match(unclaimed.message, /hasn’t been claimed yet/);

  // Reporting: sales and comps apart; revenue leaves comps out.
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.equal(stats.sold, 1);
  assert.equal(stats.comps.issued, 3);
  assert.equal(stats.comps.claimed, 1);
  assert.equal(stats.comps.checkedIn, 1);
  assert.equal(stats.grossCents, buyerPrice(2000, 'BUYER', FEE));
  const attendees = await ok(call('GET', `/organizer/events/${ev.id}/attendees?type=comp`, undefined, door.token));
  assert.equal((attendees as Json[]).length, 3);
  assert.ok((attendees as Json[]).every((a) => a.type === 'COMP'));
  const list = await ok(call('GET', `/organizer/events/${ev.id}/comps`, undefined, org.token));
  assert.equal(list.items.find((i: Json) => i.orderId === gina.orderId).status, 'CHECKED_IN');
});

test('comps: revoking an unused comp voids it (its QR stops working), frees its place and emails the holder', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cp-org2-${run}@test.local`, 'Chi Organizer');
  const guest = await account(`cp-guest2-${run}@test.local`, 'Gina Guest');
  const { ev } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 2000, capacity: 10 }]);
  const general = tier(ev, 'General');
  const issued = await ok(call('POST', `/organizer/events/${ev.id}/comps`, { ticketTypeId: general.id, recipients: [{ name: 'Gina Guest', email: guest.user.email }], group: 'Artist' }, org.token));
  const c = issued.items[0];
  const gift = await prisma.gift.findUniqueOrThrow({ where: { orderId: c.orderId } });
  await waitFor(() => prisma.gift.findFirst({ where: { id: gift.id, sentAt: { not: null } } }));
  await ok(call('POST', `/gifts/${gift.token}/claim`, undefined, guest.token));
  const before = await prisma.ticket.findUniqueOrThrow({ where: { id: c.ticketId } });

  const r = await ok(call('POST', `/organizer/events/${ev.id}/comps/${c.orderId}/revoke`, { reason: 'Wrong person' }, org.token));
  assert.equal(r.status, 'REVOKED');
  const after1 = await prisma.ticket.findUniqueOrThrow({ where: { id: c.ticketId } });
  assert.equal(after1.status, 'VOID');
  assert.equal(after1.qrVersion, before.qrVersion + 1, 'a new seed: saved codes stop working');
  assert.equal((await prisma.ticketType.findUniqueOrThrow({ where: { id: general.id } })).sold, 0, 'the place goes back to the tier');
  const scan = await ok(call('POST', `/organizer/events/${ev.id}/check-in`, { code: c.ticketId }, org.token));
  assert.equal(scan.result, 'invalid');
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'comp.revoked', to: guest.user.email } }));
  assert.match(mail.subject, /Your complimentary ticket was cancelled/);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/comps/${c.orderId}/revoke`, {}, org.token)).status, 400, 'once');
  assert.equal((await ok(call('GET', `/gifts/${gift.token}`))).status, 'cancelled');
});

/* ---------- guest list ---------- */

test('guest list: add and paste, edit and remove, check in with plus-ones (2 of 3 here), logged at the door; offline sync applies once', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gl-org1-${run}@test.local`, 'Gus Organizer');
  const door = await account(`gl-door1-${run}@test.local`, 'Dee Door');
  const { ev, org: o } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 2000, capacity: 10 }]);
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));

  assert.equal((await call('POST', `/organizer/events/${ev.id}/guest-list`, { entries: [{ name: 'Nope' }] }, door.token)).status, 403, 'door staff don’t edit the list');
  const bad = await call('POST', `/organizer/events/${ev.id}/guest-list`, { text: 'Ok One\nToo Many, +12' }, org.token);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: Json) => e.line), [2]);

  const added = await ok(
    call('POST', `/organizer/events/${ev.id}/guest-list`, { entries: [{ name: 'Ada Obi', email: `ada-${run}@test.local`, plusOnes: 2, group: 'Artist', note: 'Side door' }], text: 'Bola Bello, +1, Crew\nChi Chukwu', group: 'Friends' }, org.token),
  );
  assert.equal(added.added, 3);
  const ada = (added.items as Json[]).find((g) => g.name === 'Ada Obi')!;
  const bola = (added.items as Json[]).find((g) => g.name === 'Bola Bello')!;
  const chi = (added.items as Json[]).find((g) => g.name === 'Chi Chukwu')!;
  assert.equal(ada.partySize, 3);
  assert.equal(bola.group, 'Crew');
  assert.equal(chi.group, 'Friends');

  const edited = await ok(call('PATCH', `/organizer/events/${ev.id}/guest-list/${chi.id}`, { plusOnes: 1, note: 'Bringing a partner' }, org.token));
  assert.equal(edited.partySize, 2);
  await ok(call('DELETE', `/organizer/events/${ev.id}/guest-list/${bola.id}`, undefined, org.token));
  const found = await ok(call('GET', `/organizer/events/${ev.id}/guest-list?q=ada`, undefined, door.token));
  assert.deepEqual(found.items.map((g: Json) => g.id), [ada.id]);
  assert.deepEqual(found.summary, { entries: 2, expected: 5, arrived: 0 });

  // Online: 2 of 3 arrive, then the last one (asking for 2 lets in only the 1 left), then the party is full.
  const a1 = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/${ada.id}/check-in`, { guests: 2, deviceId: 'gate-g' }, door.token));
  assert.equal(a1.result, 'ok');
  assert.equal(a1.message, '2 of 3 here');
  const a2 = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/${ada.id}/check-in`, { guests: 2 }, door.token));
  assert.equal(a2.entry.arrived, 3);
  assert.match(a2.message, /^3 of 3 here/);
  const a3 = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/${ada.id}/check-in`, {}, door.token));
  assert.equal(a3.result, 'full');
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}/guest-list/${ada.id}`, { plusOnes: 0 }, org.token)).status, 400, 'can’t shrink below who’s in');
  const undone = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/${ada.id}/undo`, { guests: 1 }, door.token));
  assert.equal(undone.entry.arrived, 2);

  // The guest list's door log: each check-in, with how many it let in.
  const log = await prisma.guestCheckIn.findMany({ where: { entryId: ada.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(log.map((l) => [l.result, l.guests, l.offline]), [
    ['ADMITTED', 2, false],
    ['ADMITTED', 1, false],
    ['ALREADY_USED', 0, false],
  ]);
  assert.equal(log[0].deviceId, 'gate-g');
  assert.equal(log[0].userId, door.user.id);
  assert.equal(await prisma.scanAttempt.count({ where: { eventId: ev.id } }), 0, 'ticket scans stay apart');

  // The door pack carries the list for offline use.
  const pack = await ok(call('GET', `/organizer/events/${ev.id}/door-pack`, undefined, door.token));
  assert.equal(pack.guestList.length, 2);

  // Offline: queued check-ins sync once; sending the batch again changes nothing.
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const batch = {
    deviceId: 'phone-1',
    checkIns: [
      { entryId: chi.id, guests: 1, at, opId: `op-1-${run}` },
      { entryId: chi.id, guests: 1, at, opId: `op-2-${run}` },
      { entryId: ada.id, guests: 2, at, opId: `op-3-${run}` },
      { entryId: 'nope', guests: 1, at, opId: `op-4-${run}` },
      { entryId: ada.id, guests: 1, at, opId: `op-5-${run}` },
    ],
  };
  const s1 = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/sync`, batch, door.token));
  assert.deepEqual(s1.summary, { checked_in: 3, full: 1, invalid: 1 });
  assert.equal(s1.results[3].reason, 'unknown');
  assert.equal(s1.results[1].entry.arrived, 2);
  assert.equal(s1.results[2].entry.arrived, 3, 'one place was left in Ada’s party, so asking for 2 lets in 1');
  assert.equal(s1.results[4].result, 'full');
  const s2 = await ok(call('POST', `/organizer/events/${ev.id}/guest-list/sync`, batch, door.token));
  assert.deepEqual(s2.summary, s1.summary);
  assert.ok([0, 1, 2, 4].every((i) => s2.results[i].replay === true));
  assert.equal(s2.results[4].result, 'full', 'answered as the first time');
  const chiNow = await prisma.guestListEntry.findUniqueOrThrow({ where: { id: chi.id } });
  assert.equal(chiNow.arrived, 2, 'applied once');
  assert.equal(chiNow.firstArrivedAt?.toISOString(), at, 'offline check-ins keep the scanner’s time');
  assert.equal(await prisma.guestCheckIn.count({ where: { eventId: ev.id, offline: true } }), 4);

  // Reporting: arrivals apart from sales and comps; the CSV has a Type column.
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.guestList, { entries: 2, expected: 5, arrived: 5 });
  const csv = await call('GET', `/organizer/events/${ev.id}/attendees.csv`, undefined, org.token);
  const [head, ...rows] = csv.text.split('\r\n');
  assert.match(head, /"Type","Group"$/);
  assert.ok(rows.some((r) => r.includes('"Ada Obi +2"') && r.includes('"Guest list"') && r.includes('"3 of 3 here"')));
});

/* ---------- donation gaps: organizer refunds, resale donations, the hold's donation, comp limit on create ---------- */

test('organizer donation refund: org admins only (door 403, strangers 404), emailed, idempotent with an Omoshow admin refund, out of payouts; owed once paid out', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`odr-org-${run}@test.local`, 'Ola Organizer');
  const manager = await account(`odr-mgr-${run}@test.local`, 'Mo Manager');
  const door = await account(`odr-door-${run}@test.local`, 'Dee Door');
  const stranger = await account(`odr-x-${run}@test.local`, 'Sid Stranger');
  const fan = await account(`odr-fan-${run}@test.local`, 'Femi Fan');
  const { ev, org: o } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1000, capacity: 50 }], { donationsEnabled: true, donationCause: 'River Clean-up' });
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: manager.user.email, role: 'MANAGER' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, manager.token));
  await ok(call('POST', `/organizer/orgs/${o.id}/team`, { email: door.user.email, role: 'DOOR' }, org.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  const other = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1000, capacity: 50 }], { donationsEnabled: true, donationCause: 'Other Cause' });

  const price = buyerPrice(1000, 'BUYER', FEE);
  const { order: paid } = await buy(fan, tier(ev, 'General').id, 2, {}, { donationCents: 500 });
  assert.equal(paid.totalCents, price * 2 + 500);

  // The list: door staff can look, only admins can refund.
  const seen = await ok(call('GET', `/organizer/events/${ev.id}/donations`, undefined, door.token));
  assert.equal(seen.canRefund, false);
  assert.equal(seen.cause, 'River Clean-up');
  assert.deepEqual(seen.summary, { orders: 1, cents: 500, refundedCents: 0 });
  assert.equal(seen.items[0].orderId, paid.id);
  assert.equal(seen.items[0].leftCents, 500);
  assert.equal(seen.items[0].cause, 'River Clean-up');
  assert.equal(seen.items[0].resale, false);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/donations`, undefined, org.token))).canRefund, true);
  assert.equal((await call('GET', `/organizer/events/${ev.id}/donations`, undefined, stranger.token)).status, 404);

  const path = `/organizer/events/${ev.id}/orders/${paid.id}/refund-donation`;
  assert.equal((await call('POST', path, {}, door.token)).status, 403, 'door staff can’t refund');
  assert.equal((await call('POST', path, {}, manager.token)).status, 403, 'managers can’t either: refunds are for org admins, like cancelling and payouts');
  assert.equal((await call('POST', path, {}, stranger.token)).status, 404);
  assert.equal((await call('POST', `/organizer/events/${other.ev.id}/orders/${paid.id}/refund-donation`, {}, org.token)).status, 404, 'not an order of that event');

  const r = await ok(call('POST', path, { reason: 'Donated twice by mistake' }, org.token));
  assert.equal(r.refundedNowCents, 500);
  assert.equal(r.donationRefundedCents, 500);
  assert.equal(r.refundedCents, 500);
  assert.equal(r.donationOwedCents, 0, 'sold today: the organizer hasn’t been paid for it yet');
  assert.equal(r.status, 'PARTIALLY_REFUNDED', 'the tickets are kept');
  const tickets = await prisma.ticket.findMany({ where: { orderId: paid.id } });
  assert.ok(tickets.every((t) => t.status === 'ACTIVE'));
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'order.donation_refund', to: fan.user.email } }));
  assert.equal(mail.subject, 'Your donation to River Clean-up was refunded');
  const audit = await prisma.auditLog.findFirst({ where: { action: 'order.donation_refund', entityId: paid.id } });
  assert.equal((audit!.data as Json).by, 'organizer');

  // Once is enough: neither the organizer nor an Omoshow admin can refund it again.
  assert.equal((await call('POST', path, {}, org.token)).status, 400);
  assert.equal((await call('POST', `/admin/orders/${paid.id}/refund-donation`, { reason: 'Fan asked for it back' }, admin.token)).status, 400);

  // Payouts and totals: the donation line is gone, the tickets' share is untouched.
  const pay = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(pay.pendingDonationCents, 0);
  assert.equal(pay.pendingCents, organizerNet(price, 'BUYER', FEE) * 2);
  assert.equal(pay.donationOwedCents, 0);
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.donations, { orders: 1, cents: 0, refundedCents: 500, cause: 'River Clean-up' });
  const after = await ok(call('GET', `/organizer/events/${ev.id}/donations`, undefined, org.token));
  assert.equal(after.items[0].leftCents, 0);

  // An order the organizer was already paid for (sold three days ago, daily payouts): an Omoshow admin refunds it
  // first, it's recorded as owed by the organizer, and the organizer's own refund then finds nothing left.
  const { order: old } = await buy(fan, tier(ev, 'General').id, 1, {}, { donationCents: 400 });
  await prisma.order.update({ where: { id: old.id }, data: { paidAt: new Date(Date.now() - 3 * 86_400_000) } });
  await prisma.organization.update({ where: { id: o.id }, data: { stripeAccountId: `acct_test_${run}` } });
  const byAdmin = await ok(call('POST', `/admin/orders/${old.id}/refund-donation`, { reason: 'Fan asked for it back' }, admin.token));
  assert.equal(byAdmin.donationRefundedCents, 400);
  assert.equal(byAdmin.donationOwedCents, 400);
  assert.equal((await call('POST', `/organizer/events/${ev.id}/orders/${old.id}/refund-donation`, {}, org.token)).status, 400, 'nothing left: one refund between them');
  assert.equal((await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token))).donationOwedCents, 400);
  const row = (await ok(call('GET', `/admin/orders?q=${old.id}`, undefined, admin.token))).items.find((x: Json) => x.id === old.id);
  assert.equal(row.donationOwedCents, 400);
});

test('resale orders with a donation: the total, the seller’s payout unchanged, the organizer’s donations; the guarantee refunds the ticket only, cancelling refunds both', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rd-org-${run}@test.local`, 'Ria Organizer');
  const seller = await account(`rd-seller-${run}@test.local`, 'Sam Seller');
  const buyer = await account(`rd-buyer-${run}@test.local`, 'Bola Buyer');
  const { ev, org: o } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 2000, capacity: 50 }], {
    donationsEnabled: true,
    donationCause: 'Music Schools',
    donationMinCents: 200,
  });
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { resaleRoyaltyPermille: 50 }, org.token));
  const tt = tier(ev, 'General');
  /** The seller buys one ticket and lists it; the buyer holds it. */
  const listAndHold = async () => {
    const { order } = await buy(seller, tt.id, 1);
    const price = tt.priceCents + 300;
    const listed = await ok(call('POST', `/tickets/${order.tickets[0].id}/listing`, { priceCents: price }, seller.token));
    const hold = await ok(call('POST', `/resale/${listed.listingId}/hold`, undefined, buyer.token));
    return { listingId: listed.listingId as string, holdKey: hold.holdKey as string, price, sellerOrderId: order.id as string };
  };

  const a = await listAndHold();
  const body = { holdKey: a.holdKey, email: buyer.user.email, name: buyer.user.name };
  assert.equal((await call('POST', `/resale/${a.listingId}/orders`, { ...body, donationCents: 100 }, buyer.token)).status, 400, 'below the minimum donation');
  const created = await ok(call('POST', `/resale/${a.listingId}/orders`, { ...body, donationCents: 700 }, buyer.token));
  assert.equal(created.donationCents, 700);
  assert.equal(created.ticketTotalCents, a.price);
  assert.equal(created.totalCents, a.price + 700, 'no fee on the donation');
  const paid = await ok(call('POST', `/orders/${created.orderId}/pay`));
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.donationCents, 700);
  assert.equal(paid.donationCause, 'Music Schools');
  assert.equal(paid.totalCents, a.price + 700);

  // The seller is paid from the listing price only, as without a donation.
  const listing = await prisma.resaleListing.findUniqueOrThrow({ where: { id: a.listingId } });
  const fee = Math.round((a.price * config.resaleFeePermille) / 1000);
  const royalty = Math.round((a.price * 50) / 1000);
  assert.equal(listing.sellerFeeCents, fee);
  assert.equal(listing.royaltyCents, royalty);
  assert.equal(listing.payoutCents, a.price - fee - royalty);

  // The organizer: the donation in their totals and payouts; of the resale ticket, only the royalty.
  const stats = await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token));
  assert.deepEqual(stats.donations, { orders: 1, cents: 700, refundedCents: 0, cause: 'Music Schools' });
  const pay = await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token));
  assert.equal(pay.pendingDonationCents, 700);
  assert.equal(pay.pendingCents, organizerNet(tt.priceCents, 'BUYER', FEE) + royalty + 700, 'the seller’s original sale, the royalty and the donation');
  const list = await ok(call('GET', `/organizer/events/${ev.id}/donations`, undefined, org.token));
  assert.equal(list.items[0].resale, true);
  assert.equal(list.items[0].orderId, paid.id);

  // A second resale order, to be refunded by cancelling the event.
  const b = await listAndHold();
  const createdB = await ok(call('POST', `/resale/${b.listingId}/orders`, { holdKey: b.holdKey, email: buyer.user.email, name: buyer.user.name, donationCents: 300 }, buyer.token));
  await ok(call('POST', `/orders/${createdB.orderId}/pay`));

  // Omoshow Guarantee claim on the first: the ticket's price only, at Omoshow's cost; the donation and the seller's payout stay.
  await setTimes(ev.id, new Date(Date.now() - HOUR));
  const ticketId = paid.tickets[0].id;
  const claim = await ok(call('POST', `/tickets/${ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, buyer.token));
  assert.equal(claim.payer, 'OMOSHOW');
  assert.equal(claim.amountCents, a.price);
  await ok(call('POST', `/admin/guarantee-claims/${claim.id}/decide`, { decision: 'APPROVE' }, admin.token));
  const afterClaim = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } });
  assert.equal(afterClaim.refundedCents, a.price);
  assert.equal(afterClaim.donationRefundedCents, 0, 'the guarantee never refunds the donation');
  assert.equal(afterClaim.status, 'PARTIALLY_REFUNDED');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status, 'VOID', 'the refunded ticket is voided');
  assert.equal((await prisma.resaleListing.findUniqueOrThrow({ where: { id: a.listingId } })).payoutStatus, 'PENDING', 'the seller is still paid');
  assert.equal((await ok(call('GET', `/organizer/orgs/${o.id}/payouts`, undefined, org.token))).pendingDonationCents, 1000, 'both donations still count');

  // Cancelling refunds everything left: the second order's ticket and donation, and the first one's donation.
  await setTimes(ev.id, new Date(Date.now() + 5 * 86_400_000));
  await ok(call('POST', `/organizer/events/${ev.id}/cancel`, { reason: 'The headliner is ill.', confirmTitle: ev.title }, org.token));
  const cb = await prisma.order.findUniqueOrThrow({ where: { id: createdB.orderId } });
  assert.equal(cb.status, 'REFUNDED');
  assert.equal(cb.refundedCents, b.price + 300);
  assert.equal(cb.donationRefundedCents, 300);
  assert.equal((await prisma.resaleListing.findUniqueOrThrow({ where: { id: b.listingId } })).payoutStatus, 'HELD', 'a cancelled resale order holds the seller’s payout, as before');
  const ca = await prisma.order.findUniqueOrThrow({ where: { id: paid.id } });
  assert.equal(ca.status, 'REFUNDED');
  assert.equal(ca.donationRefundedCents, 700);
  assert.equal(ca.refundedCents, a.price + 700);
});

test('a hold carries the fan’s donation (the app’s card handoff): stored with PATCH /holds/:id, validated, and used by the quote and the order', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`hd-org-${run}@test.local`, 'Hana Organizer');
  const fan = await account(`hd-fan-${run}@test.local`, 'Femi Fan');
  const { ev } = await publishedEvent(
    org.token,
    admin.token,
    [
      { name: 'General', basePriceCents: 1500, capacity: 50 },
      { name: 'Supporter', pricing: 'PWYW', pwywMinCents: 500, capacity: 50 },
    ],
    { donationsEnabled: true, donationCause: 'Clinic Fund', donationMinCents: 300 },
  );
  const plain = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1500, capacity: 50 }]);
  const price = buyerPrice(1500, 'BUYER', FEE);

  const h = await ok(call('POST', '/holds', { ticketTypeId: tier(ev, 'General').id, quantity: 2 }, fan.token));
  assert.equal((await ok(call('GET', `/holds/${h.id}`))).donationCents, 0);
  assert.equal((await call('PATCH', `/holds/${h.id}`, { donationCents: 100 })).status, 400, 'below the minimum');
  assert.equal((await call('PATCH', `/holds/${h.id}`, { donationCents: 1.5 })).status, 400);
  assert.equal((await call('PATCH', `/holds/${h.id}`, { amountCents: 900 })).status, 400, 'a set price can’t be changed');
  const set = await ok(call('PATCH', `/holds/${h.id}`, { donationCents: 600 }));
  assert.equal(set.donationCents, 600);
  assert.equal((await ok(call('GET', `/holds/${h.id}`))).donationCents, 600);
  assert.equal((await ok(call('POST', '/quote', { holdId: h.id }))).donationCents, 600, 'the quote uses the hold’s donation');
  assert.equal((await ok(call('POST', '/quote', { holdId: h.id, donationCents: 0 }))).donationCents, 0, '0 removes it');
  const created = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name }, fan.token));
  assert.equal(created.donationCents, 600);
  assert.equal(created.totalCents, price * 2 + 600);
  const paid = await ok(call('POST', `/orders/${created.orderId}/pay`));
  assert.equal(paid.donationCents, 600);
  assert.equal(paid.donationCause, 'Clinic Fund');
  assert.equal((await call('PATCH', `/holds/${h.id}`, { donationCents: 900 })).status, 409, 'the order exists');

  // The hold's donation is checked again at the order: the event stopped taking donations in between.
  const h2 = await ok(call('POST', '/holds', { ticketTypeId: tier(ev, 'General').id, quantity: 1 }, fan.token));
  await ok(call('PATCH', `/holds/${h2.id}`, { donationCents: 400 }));
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { donationsEnabled: false }, org.token));
  assert.equal((await call('POST', '/orders', { holdId: h2.id, email: fan.user.email, name: fan.user.name }, fan.token)).status, 400);
  const plainOrder = await ok(call('POST', '/orders', { holdId: h2.id, email: fan.user.email, name: fan.user.name, donationCents: 0 }, fan.token));
  assert.equal(plainOrder.donationCents, 0);
  await ok(call('PATCH', `/organizer/events/${ev.id}`, { donationsEnabled: true }, org.token));

  // Pay what you want: the amount per ticket travels the same way.
  const h3 = await ok(call('POST', '/holds', { ticketTypeId: tier(ev, 'Supporter').id, quantity: 1, amountCents: 500 }, fan.token));
  assert.equal((await call('PATCH', `/holds/${h3.id}`, { amountCents: 400 })).status, 400, 'below the tier’s minimum');
  const moved = await ok(call('PATCH', `/holds/${h3.id}`, { amountCents: 2000, donationCents: 300 }));
  assert.equal(moved.amountCents, 2000);
  assert.equal(moved.unitCents, buyerPrice(2000, 'BUYER', FEE));
  const o3 = await ok(call('POST', '/orders', { holdId: h3.id, email: fan.user.email, name: fan.user.name }, fan.token));
  assert.equal(o3.totalCents, buyerPrice(2000, 'BUYER', FEE) + 300);

  // An event that takes no donations refuses one on the hold.
  const h4 = await ok(call('POST', '/holds', { ticketTypeId: tier(plain.ev, 'General').id, quantity: 1 }, fan.token));
  assert.equal((await call('PATCH', `/holds/${h4.id}`, { donationCents: 500 })).status, 400);
  assert.equal((await ok(call('PATCH', `/holds/${h4.id}`, { donationCents: 0 }))).donationCents, 0);
});

test('comp limit: set on create (or left empty), shown in the event and its stats', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cl-org-${run}@test.local`, 'Cleo Organizer');
  const { ev } = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1000, capacity: 50 }], { compLimit: 3 });
  assert.equal(ev.compLimit, 3);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org.token))).compLimit, 3);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/stats`, undefined, org.token))).comps.limit, 3);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/comps`, undefined, org.token))).limit, 3);
  const none = await publishedEvent(org.token, admin.token, [{ name: 'General', basePriceCents: 1000, capacity: 50 }]);
  assert.equal(none.ev.compLimit, null);
});
