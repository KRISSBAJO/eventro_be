/**
 * The Omoshow Guarantee ("if your ticket doesn't scan, you get your money back") and the door scan log behind it.
 * Fan resale tickets are refunded at Omoshow's cost; every other paid ticket per ticket, at the organizer's.
 * Refunds use the mock provider; one test makes it fail to check that admins can retry.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { claimWindow, organizerTicketShare, splitCents, windowOpen } from '../src/guarantee/guarantee';
import { organizerNet } from '../src/domain/money';
import { qrToken } from '../src/domain/qr';
import { config } from '../src/config';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const HOUR = 3600_000;

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
/** A published event with one ticket type (plus `extra` ones), organized by `org`. */
async function publishedEvent(org: string, admin: string, extra: Json[] = []) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Guarantee Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Scan Night ${run} ${n}`,
        category: 'CONCERTS',
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        venue: { name: 'Door Hall', address: '1 Gate St', city: 'Austin', country: 'US', region: 'Texas', lat: 30.2672, lng: -97.7431 },
        ticketTypes: [{ name: 'General', basePriceCents: 4830, capacity: 100 }, ...extra],
      },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  return { ev, org: o as Json, tt: ev.ticketTypes[0] as Json };
}

/** The seller buys `qty` tickets and lists each; the buyer buys every listing on resale. */
async function resaleTickets(ctx: { ev: Json; tt: Json }, seller: { token: string; user: Json }, buyer: { token: string; user: Json }, qty = 1) {
  const h = await ok(call('POST', '/holds', { ticketTypeId: ctx.tt.id, quantity: qty }, seller.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: seller.user.email, name: seller.user.name }, seller.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  const out: { sellerTicketId: string; ticketId: string; listingId: string; orderId: string; price: number }[] = [];
  for (const t of paid.tickets as Json[]) {
    const price = ctx.tt.priceCents + 500;
    const listed = await ok(call('POST', `/tickets/${t.id}/listing`, { priceCents: price }, seller.token));
    const hold = await ok(call('POST', `/resale/${listed.listingId}/hold`, undefined, buyer.token));
    const ro = await ok(call('POST', `/resale/${listed.listingId}/orders`, { holdKey: hold.holdKey, email: buyer.user.email, name: buyer.user.name }, buyer.token));
    const done = await ok(call('POST', `/orders/${ro.orderId}/pay`));
    out.push({ sellerTicketId: t.id, ticketId: done.tickets[0].id, listingId: listed.listingId, orderId: ro.orderId, price });
  }
  return { normalTicketIds: (paid.tickets as Json[]).map((t) => t.id as string), resale: out };
}

/** Moves the event (UTC venue clock, so wall clock = real time). */
const setTimes = (eventId: string, startsAt: Date, endsAt: Date | null = null) => prisma.event.update({ where: { id: eventId }, data: { startsAt, endsAt, timezone: 'UTC' } });

test('claim window: 3 hours before the start to 48 hours after the end (no end: start + 6 h + 48 h)', () => {
  const start = new Date('2026-12-05T20:00:00Z');
  const w = claimWindow({ startsAt: start, endsAt: new Date('2026-12-05T23:30:00Z'), timezone: 'UTC' });
  assert.equal(w.opensAt.toISOString(), '2026-12-05T17:00:00.000Z');
  assert.equal(w.closesAt.toISOString(), '2026-12-07T23:30:00.000Z');
  assert.equal(windowOpen(w, w.opensAt.getTime()), true);
  assert.equal(windowOpen(w, w.opensAt.getTime() - 1), false);
  assert.equal(windowOpen(w, w.closesAt.getTime()), true);
  assert.equal(windowOpen(w, w.closesAt.getTime() + 1), false);
  const noEnd = claimWindow({ startsAt: start, endsAt: null, timezone: 'UTC' });
  assert.equal(noEnd.closesAt.toISOString(), '2026-12-08T02:00:00.000Z');
  // Event times are the venue's wall clock: 20:00 in Lagos (UTC+1) is 19:00Z, so claims open at 16:00Z.
  assert.equal(claimWindow({ startsAt: start, endsAt: null, timezone: 'Africa/Lagos' }).opensAt.toISOString(), '2026-12-05T16:00:00.000Z');
});

test('coverage and window: every paid ticket is covered (resale: Omoshow pays; others: the organizer), free tickets are not', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org1-${run}@test.local`, 'Gia Organizer');
  const seller = await account(`gc-seller1-${run}@test.local`, 'Sam Seller');
  const buyer = await account(`gc-buyer1-${run}@test.local`, 'Bola Buyer');
  const friend = await account(`gc-friend1-${run}@test.local`, 'Fumi Friend');
  const ctx = await publishedEvent(org.token, admin.token, [{ name: 'Free list', basePriceCents: 0, capacity: 50 }]);
  const freeType = (ctx.ev.ticketTypes as Json[]).find((t) => t.name === 'Free list')!;
  const { resale } = await resaleTickets(ctx, seller, buyer, 2);
  const [a, b] = resale;

  // A normal paid ticket: covered, at the organizer's cost, for its share of the order.
  const h = await ok(call('POST', '/holds', { ticketTypeId: ctx.tt.id, quantity: 1 }, seller.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: seller.user.email, name: seller.user.name }, seller.token));
  const normal = (await ok(call('POST', `/orders/${o.orderId}/pay`))).tickets[0].id;
  const sellerTickets = await ok(call('GET', '/me/tickets', undefined, seller.token));
  const ng = sellerTickets.tickets.find((t: Json) => t.id === normal).guarantee;
  assert.equal(ng.covered, true);
  assert.equal(ng.payer, 'ORGANIZER');
  assert.equal(ng.notCovered, null);
  assert.equal(ng.refundCents, o.totalCents, 'a one-ticket order: the whole total, all-in');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: normal } })).resaleGuarantee, false);

  // A free ticket: not covered (nothing to refund), and the UI is told why.
  const fh = await ok(call('POST', '/holds', { ticketTypeId: freeType.id, quantity: 1 }, seller.token));
  const fo = await ok(call('POST', '/orders', { holdId: fh.id, email: seller.user.email, name: seller.user.name }, seller.token));
  assert.equal(fo.totalCents, 0);
  const free = (await ok(call('POST', `/orders/${fo.orderId}/pay`))).tickets[0].id;
  const fg = (await ok(call('GET', '/me/tickets', undefined, seller.token))).tickets.find((t: Json) => t.id === free).guarantee;
  assert.equal(fg.covered, false);
  assert.equal(fg.payer, null);
  assert.equal(fg.notCovered, 'FREE');
  assert.equal(fg.open, false);

  // The resale buyer's new ticket is covered and recorded as such; Omoshow pays.
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).resaleGuarantee, true);
  const mine = await ok(call('GET', '/me/tickets', undefined, buyer.token));
  const g = mine.tickets.find((t: Json) => t.id === a.ticketId).guarantee;
  assert.equal(g.covered, true);
  assert.equal(g.payer, 'OMOSHOW');
  assert.equal(g.open, false, 'a month before the event the window is shut');
  assert.equal(g.claim, null);
  const early = await call('POST', `/tickets/${a.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, buyer.token);
  assert.equal(early.status, 400);
  assert.match(early.body.message, /Claims open 3 hours before/);

  // Transferred on, it stays covered for the new holder.
  await ok(call('POST', `/tickets/${b.ticketId}/transfer`, { email: friend.user.email }, buyer.token));
  await ok(call('POST', `/tickets/${b.ticketId}/accept`, undefined, friend.token));
  assert.equal((await ok(call('GET', `/tickets/${b.ticketId}/guarantee-claims`, undefined, friend.token))).covered, true);

  // Free tickets are refused inside the window too; the normal ticket's window is open like any other.
  await setTimes(ctx.ev.id, new Date(Date.now() + 3 * HOUR - 2 * 60_000));
  const notCovered = await call('POST', `/tickets/${free}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, seller.token);
  assert.equal(notCovered.status, 400);
  assert.match(notCovered.body.message, /was free, so there’s nothing to refund/);
  const ns = await ok(call('GET', `/tickets/${normal}/guarantee-claims`, undefined, seller.token));
  assert.equal(ns.covered, true);
  assert.equal(ns.payer, 'ORGANIZER');
  assert.equal(ns.open, true);

  // Window edges (a couple of minutes either side).
  const open = async () => (await ok(call('GET', `/tickets/${a.ticketId}/guarantee-claims`, undefined, buyer.token))).open as boolean;
  assert.equal(await open(), true, 'just under 3 hours before the start');
  await setTimes(ctx.ev.id, new Date(Date.now() + 3 * HOUR + 2 * 60_000));
  assert.equal(await open(), false, 'just over 3 hours before the start');
  await setTimes(ctx.ev.id, new Date(Date.now() - 60 * HOUR), new Date(Date.now() - 48 * HOUR + 2 * 60_000));
  assert.equal(await open(), true, 'just under 48 hours after the end');
  await setTimes(ctx.ev.id, new Date(Date.now() - 60 * HOUR), new Date(Date.now() - 48 * HOUR - 2 * 60_000));
  assert.equal(await open(), false, 'just over 48 hours after the end');
  const late = await call('POST', `/tickets/${a.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, buyer.token);
  assert.equal(late.status, 400);
  assert.match(late.body.message, /claim window closed/);
  await setTimes(ctx.ev.id, new Date(Date.now() - 54 * HOUR + 2 * 60_000));
  assert.equal(await open(), true, 'no end time: just under start + 54 hours');
  await setTimes(ctx.ev.id, new Date(Date.now() - 54 * HOUR - 2 * 60_000));
  assert.equal(await open(), false, 'no end time: just over start + 54 hours');

  // Validation: reasons are fixed, details at most 1000 characters.
  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));
  assert.equal((await call('POST', `/tickets/${a.ticketId}/guarantee-claims`, { reason: 'BORED' }, buyer.token)).status, 400);
  assert.equal((await call('POST', `/tickets/${a.ticketId}/guarantee-claims`, { reason: 'OTHER', details: 'x'.repeat(1001) }, buyer.token)).status, 400);
});

test('only the holder can claim, only once; a checked-in ticket is declined automatically', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org2-${run}@test.local`, 'Gia Organizer');
  const seller = await account(`gc-seller2-${run}@test.local`, 'Sam Seller');
  const buyer = await account(`gc-buyer2-${run}@test.local`, 'Bola Buyer');
  const stranger = await account(`gc-stranger2-${run}@test.local`, 'Stan Stranger');
  const ctx = await publishedEvent(org.token, admin.token);
  const [r] = (await resaleTickets(ctx, seller, buyer)).resale;
  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));

  assert.equal((await call('POST', `/tickets/${r.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, stranger.token)).status, 404);
  assert.equal((await call('POST', `/tickets/${r.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, seller.token)).status, 404, 'the seller no longer holds it');
  assert.equal((await call('POST', `/tickets/${r.sellerTicketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, seller.token)).status, 400, 'the sold ticket can’t be claimed on');

  // Door staff type the code in (manual check-in), so the ticket is in.
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: r.ticketId, deviceId: 'gate-m' }, org.token))).result, 'ok');

  const c = await ok(call('POST', `/tickets/${r.ticketId}/guarantee-claims`, { reason: 'TURNED_AWAY', details: 'They said it was used.' }, buyer.token));
  assert.equal(c.status, 'DECLINED');
  assert.equal(c.auto, true);
  assert.match(c.message, /^This ticket was scanned in at \d{1,2}:\d{2} [AP]M on /);
  assert.equal((await call('POST', `/tickets/${r.ticketId}/guarantee-claims`, { reason: 'OTHER' }, buyer.token)).status, 409, 'one claim per ticket');

  // Nothing refunded; the ticket is still checked in.
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).status, 'PAID');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).status, 'CHECKED_IN');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'guarantee.auto_decline', entityId: c.id } }));
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.declined', to: buyer.user.email } })));
});

test('a rejected scan at the door: held for review with the evidence; approving refunds, voids the ticket, seller still paid', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org3-${run}@test.local`, 'Gia Organizer');
  const seller = await account(`gc-seller3-${run}@test.local`, 'Sam Seller');
  const buyer = await account(`gc-buyer3-${run}@test.local`, 'Bola Buyer');
  const ctx = await publishedEvent(org.token, admin.token);
  const [r] = (await resaleTickets(ctx, seller, buyer)).resale;
  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));
  const listingBefore = await prisma.resaleListing.findUniqueOrThrow({ where: { id: r.listingId } });
  assert.equal(listingBefore.payoutStatus, 'PENDING');

  // An old code (a screenshot) is turned away at the door.
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } });
  const stale = qrToken(config.qrSecret, t.id, Date.now() - 10 * 60_000, t.qrVersion).token;
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: stale, deviceId: 'gate-q' }, org.token))).result, 'expired-code');

  // A rejection a fan can cause on purpose (a stale screenshot) doesn't refund by itself: it waits for review.
  const filed = await ok(call('POST', `/tickets/${r.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, buyer.token));
  assert.equal(filed.status, 'PENDING');
  assert.equal(filed.auto, false);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).status, 'PAID', 'nothing refunded yet');
  assert.equal(await prisma.auditLog.count({ where: { action: 'guarantee.auto_approve', entityId: filed.id } }), 0);

  // The admin queue shows the door's rejection, then the admin approves.
  const queue = await ok(call('GET', '/admin/guarantee-claims?status=PENDING', undefined, admin.token));
  const row = queue.items.find((x: Json) => x.id === filed.id);
  assert.ok(row.scans.some((s: Json) => s.result === 'EXPIRED_CODE' && s.deviceId === 'gate-q'), 'the rejected scan is shown as evidence');
  const c = await ok(call('POST', `/admin/guarantee-claims/${filed.id}/decide`, { decision: 'APPROVE', note: 'Door log shows the ticket was turned away.' }, admin.token));
  assert.equal(c.status, 'APPROVED');
  assert.equal(c.auto, false);
  assert.equal(c.refundStatus, 'REFUNDED');
  assert.equal(c.amountCents, r.price, 'all-in: what they paid for the resale order');
  assert.equal(c.payer, 'OMOSHOW');
  assert.equal(c.cost.organizerCents, 0, 'resale: Omoshow pays, nothing comes out of the organizer’s payout');
  assert.equal(c.cost.eventroCents, r.price);
  assert.match(c.message, /We’ve refunded/);

  const order = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } });
  assert.equal(order.status, 'REFUNDED');
  assert.equal(order.refundedCents, order.totalCents);
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: r.ticketId } })).status, 'VOID');
  assert.equal((await call('GET', `/tickets/${r.ticketId}/qr`, undefined, buyer.token)).status, 400, 'its QR stops working');

  // Omoshow pays: the seller's payout is untouched.
  const listingAfter = await prisma.resaleListing.findUniqueOrThrow({ where: { id: r.listingId } });
  assert.equal(listingAfter.payoutStatus, 'PENDING');
  assert.equal(listingAfter.payoutCents, listingBefore.payoutCents);
  assert.equal(listingAfter.payoutNote, null);

  // The refunded ticket stays in My tickets with its decision.
  const mine = await ok(call('GET', '/me/tickets', undefined, buyer.token));
  const shown = mine.tickets.find((x: Json) => x.id === r.ticketId);
  assert.equal(shown.status, 'VOID');
  assert.equal(shown.guarantee.claim.status, 'APPROVED');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'guarantee.approve', entityId: c.id } }));
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.approved', to: buyer.user.email } })));
  assert.ok(await waitFor(() => prisma.notificationLog.findFirst({ where: { dedupeKey: `guarantee.approved:${c.id}` } })));
});

test('no scans: pending for review; admin approve refunds, decline doesn’t, failed refunds can be retried', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org4-${run}@test.local`, 'Gia Organizer');
  const seller = await account(`gc-seller4-${run}@test.local`, 'Sam Seller');
  const buyer = await account(`gc-buyer4-${run}@test.local`, 'Bola Buyer');
  const ctx = await publishedEvent(org.token, admin.token);
  const [a, b, c] = (await resaleTickets(ctx, seller, buyer, 3)).resale;
  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));

  const ca = await ok(call('POST', `/tickets/${a.ticketId}/guarantee-claims`, { reason: 'TURNED_AWAY', details: 'The scanner was down.' }, buyer.token));
  assert.equal(ca.status, 'PENDING');
  assert.match(ca.message, /within 24 hours/);
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.received', to: buyer.user.email } })));

  // The queue is admin-only and shows what admins need.
  assert.equal((await call('GET', '/admin/guarantee-claims', undefined, buyer.token)).status, 403);
  const queue = await ok(call('GET', '/admin/guarantee-claims?status=PENDING', undefined, admin.token));
  const item = queue.items.find((x: Json) => x.id === ca.id);
  assert.equal(item.ticket.id, a.ticketId);
  assert.equal(item.claimant.email, buyer.user.email);
  assert.equal(item.event.id, ctx.ev.id);
  assert.equal(item.details, 'The scanner was down.');
  assert.deepEqual(item.scans, []);
  assert.equal(item.ticket.checkedInAt, null);
  assert.equal(item.amountCents, a.price);
  assert.ok(queue.counts.PENDING >= 1);

  // Decline needs a note; it refunds nothing.
  assert.equal((await call('POST', `/admin/guarantee-claims/${ca.id}/decide`, { decision: 'DECLINE' }, admin.token)).status, 400);
  const declined = await ok(call('POST', `/admin/guarantee-claims/${ca.id}/decide`, { decision: 'DECLINE', note: 'The door log shows no attempt to scan this ticket.' }, admin.token));
  assert.equal(declined.status, 'DECLINED');
  assert.equal(declined.auto, false);
  assert.equal(declined.decidedBy.id, admin.user.id);
  assert.equal((await call('POST', `/admin/guarantee-claims/${ca.id}/decide`, { decision: 'DECLINE', note: 'Again, please.' }, admin.token)).status, 409);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: a.orderId } })).status, 'PAID');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).status, 'ACTIVE');
  assert.equal((await ok(call('GET', `/tickets/${a.ticketId}/guarantee-claims`, undefined, buyer.token))).claim.message, 'The door log shows no attempt to scan this ticket.');

  // Approve refunds in full and voids the ticket; the seller's payout stays.
  const cb = await ok(call('POST', `/tickets/${b.ticketId}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, buyer.token));
  assert.equal(cb.status, 'PENDING');
  const approved = await ok(call('POST', `/admin/guarantee-claims/${cb.id}/decide`, { decision: 'APPROVE', note: 'Gate scanners were down at 8pm.' }, admin.token));
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.refundStatus, 'REFUNDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.orderId } })).status, 'REFUNDED');
  assert.equal((await prisma.ticket.findUniqueOrThrow({ where: { id: b.ticketId } })).status, 'VOID');
  assert.equal((await prisma.resaleListing.findUniqueOrThrow({ where: { id: b.listingId } })).payoutStatus, 'PENDING');
  assert.equal((await call('POST', `/admin/guarantee-claims/${cb.id}/decide`, { decision: 'APPROVE' }, admin.token)).status, 409, 'approving twice refunds once');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.orderId } })).refundedCents, b.price);

  // A provider failure leaves it approved with a failed refund; retrying sends it.
  const cc = await ok(call('POST', `/tickets/${c.ticketId}/guarantee-claims`, { reason: 'OTHER' }, buyer.token));
  const { Payments } = await import('../src/checkout/payments');
  const payments = app.get(Payments);
  const real = payments.byName.bind(payments);
  payments.byName = () => ({ name: 'mock' as const, createPayment: async () => ({ paymentRef: 'x' }), refund: async () => { throw new Error('Card network unavailable'); } });
  let failed: Json;
  try {
    failed = await ok(call('POST', `/admin/guarantee-claims/${cc.id}/decide`, { decision: 'APPROVE' }, admin.token));
  } finally {
    payments.byName = real;
  }
  assert.equal(failed.status, 'APPROVED');
  assert.equal(failed.refundStatus, 'FAILED');
  assert.match(failed.refundError, /Card network unavailable/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status, 'PAID');
  const failedList = await ok(call('GET', '/admin/guarantee-claims?refund=FAILED', undefined, admin.token));
  assert.ok(failedList.items.some((x: Json) => x.id === cc.id));
  const retried = await ok(call('POST', `/admin/guarantee-claims/${cc.id}/retry-refund`, undefined, admin.token));
  assert.equal(retried.refundStatus, 'REFUNDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: c.orderId } })).status, 'REFUNDED');
  assert.equal((await call('POST', `/admin/guarantee-claims/${cc.id}/retry-refund`, undefined, admin.token)).status, 400);
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.refunded', to: buyer.user.email } })));

  // Costs are totalled per currency from refunded claims.
  const all = await ok(call('GET', '/admin/guarantee-claims', undefined, admin.token));
  const usd = all.costs.find((x: Json) => x.currency === ctx.ev.currency);
  assert.ok(usd.cents >= b.price + c.price);
  for (const action of ['guarantee.decline', 'guarantee.approve', 'guarantee.refund_failed', 'guarantee.refund_retry', 'guarantee.refund']) {
    assert.ok(await prisma.auditLog.findFirst({ where: { action, entity: 'GuaranteeClaim' } }), action);
  }
  // The console overview counts claims waiting for a decision.
  assert.equal(typeof (await ok(call('GET', '/admin/overview', undefined, admin.token))).counts.openGuaranteeClaims, 'number');
});

test('scan log: online, manual and synced offline scans are recorded (offline keeps its times, resends add nothing)', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org5-${run}@test.local`, 'Gia Organizer');
  const fan = await account(`gc-fan5-${run}@test.local`, 'Fela Fan');
  const ctx = await publishedEvent(org.token, admin.token);
  const h = await ok(call('POST', '/holds', { ticketTypeId: ctx.tt.id, quantity: 3 }, fan.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name }, fan.token));
  const [t1, t2, t3] = (await ok(call('POST', `/orders/${o.orderId}/pay`))).tickets.map((t: Json) => t.id as string);
  const scans = () => prisma.scanAttempt.findMany({ where: { eventId: ctx.ev.id }, orderBy: [{ at: 'asc' }, { createdAt: 'asc' }] });

  // Online: a QR scanned twice, and a code that matches nothing.
  const qr = await ok(call('GET', `/tickets/${t1}/qr`, undefined, fan.token));
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: qr.token, deviceId: 'gate-1' }, org.token))).result, 'ok');
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: qr.token, deviceId: 'gate-1' }, org.token))).result, 'duplicate');
  await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: 'EVT-NOPE-NOPE-01', deviceId: 'gate-1' }, org.token));
  // Manual: the code typed in.
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: t2.toLowerCase(), deviceId: 'gate-1' }, org.token))).result, 'ok');

  let rows = await scans();
  assert.deepEqual(
    rows.map((s) => [s.ticketId, s.result, s.method, s.deviceId, s.userId]),
    [
      [t1, 'ADMITTED', 'QR', 'gate-1', org.user.id],
      [t1, 'ALREADY_USED', 'QR', 'gate-1', org.user.id],
      [null, 'NOT_FOUND', 'MANUAL', 'gate-1', org.user.id],
      [t2, 'ADMITTED', 'MANUAL', 'gate-1', org.user.id],
    ],
  );
  // Only what the scan needs: no codes, names or IPs.
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'createdAt', 'dedupeKey', 'deviceId', 'eventId', 'id', 'method', 'result', 'ticketId', 'userId']);

  // Offline: synced later, with the scanner's own times.
  const at3 = new Date(Date.now() - 20 * 60_000).toISOString();
  const atDup = new Date(Date.now() - 10 * 60_000).toISOString();
  const atUnknown = new Date(Date.now() - 5 * 60_000).toISOString();
  const batch = {
    deviceId: 'gate-2',
    scans: [
      { ticketId: t3, scannedAt: at3 },
      { ticketId: t1, scannedAt: atDup },
      { ticketId: 'EVT-ZZZZ-ZZZZ-01', scannedAt: atUnknown },
    ],
  };
  await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-ins/sync`, batch, org.token));
  rows = await scans();
  const offline = rows.filter((s) => s.method === 'OFFLINE');
  assert.deepEqual(
    offline.map((s) => [s.ticketId, s.result, s.deviceId, s.at.toISOString()]),
    [
      [t3, 'ADMITTED', 'gate-2', at3],
      [t1, 'ALREADY_USED', 'gate-2', atDup],
      [null, 'NOT_FOUND', 'gate-2', atUnknown],
    ],
  );
  // Sending the same batch again logs nothing new.
  await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-ins/sync`, batch, org.token));
  assert.equal((await scans()).length, rows.length);
});

/** A fan buys `qty` normal tickets in one order, with a promo code and ticket protection. */
async function promoOrder(ctx: { ev: Json; tt: Json }, fan: { token: string; user: Json }, qty: number, code: string) {
  const h = await ok(call('POST', '/holds', { ticketTypeId: ctx.tt.id, quantity: qty }, fan.token));
  const o = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name, promoCode: code, protection: true }, fan.token));
  const paid = await ok(call('POST', `/orders/${o.orderId}/pay`));
  return { orderId: o.orderId as string, ticketIds: (paid.tickets as Json[]).map((t) => t.id as string).sort() };
}

test('normal tickets: a claim refunds that ticket’s share only, out of the organizer’s payout (Omoshow returns its fee); all three refund the order', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org6-${run}@test.local`, 'Gia Organizer');
  const fan = await account(`gc-fan6-${run}@test.local`, 'Fela Fan');
  const stranger = await account(`gc-stranger6-${run}@test.local`, 'Stan Stranger');
  const door = await account(`gc-door6-${run}@test.local`, 'Dayo Door');
  const ctx = await publishedEvent(org.token, admin.token);
  await ok(call('POST', `/organizer/events/${ctx.ev.id}/promos`, { code: 'TENOFF', percent: 10 }, org.token));
  const { orderId, ticketIds } = await promoOrder(ctx, fan, 3, 'TENOFF');
  const [t1, t2, t3] = ticketIds;
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.ok(order.discountCents > 0 && order.protectionCents > 0, 'the order has a promo discount and protection');
  assert.equal(order.totalCents, order.subtotalCents - order.discountCents + order.protectionCents);

  // Each ticket's share: the order total split evenly, adding up to the total exactly.
  const shares = [0, 1, 2].map((i) => splitCents(order.totalCents, 3, i));
  assert.equal(shares.reduce((a, b) => a + b, 0), order.totalCents);
  const mine = await ok(call('GET', '/me/tickets', undefined, fan.token));
  assert.deepEqual(
    ticketIds.map((id) => mine.tickets.find((t: Json) => t.id === id).guarantee.refundCents),
    shares,
  );
  for (const id of ticketIds) assert.equal(mine.tickets.find((t: Json) => t.id === id).guarantee.payer, 'ORGANIZER');

  const payouts = async () => (await ok(call('GET', `/organizer/orgs/${ctx.org.id}/payouts`, undefined, org.token))).pendingCents as number;
  const orgNet = organizerNet(order.unitCents, 'BUYER', config.organizerFeePermille) * 3 - order.discountCents;
  assert.equal(await payouts(), orgNet, 'before: the organizer’s share of the three tickets, after the discount');

  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));

  // Ticket 1: claim, review, approve.
  const c1 = await ok(call('POST', `/tickets/${t1}/guarantee-claims`, { reason: 'DID_NOT_SCAN', details: 'Red light at gate 2.' }, fan.token));
  assert.equal(c1.status, 'PENDING');
  assert.equal(c1.payer, 'ORGANIZER');
  assert.equal(c1.amountCents, shares[0]);

  // The admin queue: who pays, the split, and the rest of the order.
  const queued = (await ok(call('GET', '/admin/guarantee-claims?status=PENDING&payer=ORGANIZER', undefined, admin.token))).items.find((x: Json) => x.id === c1.id);
  assert.equal(queued.payer, 'ORGANIZER');
  assert.equal(queued.share.ticketCents, shares[0]);
  assert.equal(queued.share.restCents, order.totalCents - shares[0]);
  assert.equal(queued.share.remainingCents, order.totalCents);
  assert.equal(queued.share.tickets.length, 3);
  const orgShare = organizerTicketShare(order, 'BUYER', t1);
  assert.equal(queued.cost.refundCents, shares[0]);
  assert.equal(queued.cost.organizerCents, orgShare);
  assert.equal(queued.cost.eventroCents, shares[0] - orgShare);
  assert.ok(queued.cost.eventroCents > 0, 'Omoshow’s fee and protection on the ticket');
  assert.equal(queued.cost.organizerPaidOut, false, 'sold today: not paid out yet');

  const a1 = await ok(call('POST', `/admin/guarantee-claims/${c1.id}/decide`, { decision: 'APPROVE', note: 'Gate 2 scanner fault.' }, admin.token));
  assert.equal(a1.refundStatus, 'REFUNDED');
  assert.equal(a1.amountCents, shares[0]);
  assert.equal(a1.cost.organizerCents, orgShare);
  assert.equal(a1.cost.organizerOwedCents, 0);

  // Only that ticket is voided; the order is partly refunded.
  let o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(o.status, 'PARTIALLY_REFUNDED');
  assert.equal(o.refundedCents, shares[0]);
  const statuses = async () => (await prisma.ticket.findMany({ where: { orderId }, orderBy: { id: 'asc' } })).map((t) => t.status);
  assert.deepEqual(await statuses(), ['VOID', 'ACTIVE', 'ACTIVE']);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'order.partial_refund', entityId: orderId } }));

  // The organizer's payout drops by their share of the ticket only: Omoshow returned its fee and protection.
  assert.equal(await payouts(), orgNet - orgShare);

  // The organizer's admins are told, once.
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.organizer', to: org.user.email } }));
  assert.match(mail.subject, /Guarantee refund/);
  assert.ok(await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.approved', to: fan.user.email } })));

  // The organizer's read-only list, for org admins and managers only.
  const list = await ok(call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, org.token));
  assert.equal(list.count, 1);
  assert.equal(list.refundedCents, shares[0]);
  assert.equal(list.payoutReductionCents, orgShare);
  assert.equal(list.items[0].ticketId, t1);
  assert.equal(list.items[0].amountCents, shares[0]);
  assert.ok(list.items[0].refundedAt);
  assert.equal((await call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, stranger.token)).status, 404);
  assert.equal((await call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, fan.token)).status, 404);
  await prisma.organizationMember.create({ data: { orgId: ctx.org.id, userId: door.user.id, email: door.user.email, role: 'DOOR', status: 'ACTIVE' } });
  assert.equal((await call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, door.token)).status, 403);

  // Tickets 2 and 3: the order ends up refunded in full.
  for (const id of [t2, t3]) {
    const c = await ok(call('POST', `/tickets/${id}/guarantee-claims`, { reason: 'TURNED_AWAY' }, fan.token));
    const a = await ok(call('POST', `/admin/guarantee-claims/${c.id}/decide`, { decision: 'APPROVE' }, admin.token));
    assert.equal(a.refundStatus, 'REFUNDED');
    o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(o.status, id === t3 ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
  }
  assert.equal(o.refundedCents, o.totalCents);
  assert.deepEqual(await statuses(), ['VOID', 'VOID', 'VOID']);
  const claims = await prisma.guaranteeClaim.findMany({ where: { orderId }, orderBy: { ticketId: 'asc' } });
  assert.deepEqual(claims.map((c) => c.amountCents), shares);
  assert.equal(claims.reduce((s, c) => s + c.organizerCents, 0), orgNet, 'the organizer’s shares add up to their net for the order');
  assert.equal(await payouts(), 0, 'nothing left to pay the organizer for this order');
  assert.equal((await ok(call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, org.token))).count, 3);

  // Admin totals split by who paid.
  const all = await ok(call('GET', '/admin/guarantee-claims', undefined, admin.token));
  const byOrg = all.costsByPayer.find((x: Json) => x.payer === 'ORGANIZER' && x.currency === o.currency);
  assert.ok(byOrg.cents >= o.totalCents);
  assert.equal(byOrg.eventroCents, byOrg.cents - byOrg.organizerCents);
});

test('normal tickets: the organizer already paid out for the order owes their share; checked-in and listed tickets follow the same rules', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`gc-org7-${run}@test.local`, 'Gia Organizer');
  const fan = await account(`gc-fan7-${run}@test.local`, 'Fela Fan');
  const ctx = await publishedEvent(org.token, admin.token);
  await ok(call('POST', `/organizer/events/${ctx.ev.id}/promos`, { code: 'FIVEOFF', percent: 5 }, org.token));
  const { orderId, ticketIds } = await promoOrder(ctx, fan, 3, 'FIVEOFF');
  const [t1, t2, t3] = ticketIds;
  // Sold ten days ago: on a daily schedule (with a payout account) the organizer has been paid for it.
  await prisma.order.update({ where: { id: orderId }, data: { paidAt: new Date(Date.now() - 10 * 86_400_000) } });
  await prisma.organization.update({ where: { id: ctx.org.id }, data: { stripeAccountId: `acct_test_${run}` } });
  await setTimes(ctx.ev.id, new Date(Date.now() - HOUR));

  const c1 = await ok(call('POST', `/tickets/${t1}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token));
  const a1 = await ok(call('POST', `/admin/guarantee-claims/${c1.id}/decide`, { decision: 'APPROVE' }, admin.token));
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const orgShare = organizerTicketShare(order, 'BUYER', t1);
  assert.equal(a1.cost.organizerPaidOut, true);
  assert.equal(a1.cost.organizerCents, orgShare);
  assert.equal(a1.cost.organizerOwedCents, orgShare, 'recorded as owed to Omoshow');
  const stored = await prisma.guaranteeClaim.findUniqueOrThrow({ where: { id: c1.id } });
  assert.equal(stored.organizerOwedCents, orgShare);
  const list = await ok(call('GET', `/organizer/events/${ctx.ev.id}/guarantee-refunds`, undefined, org.token));
  assert.equal(list.owedCents, orgShare);
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'guarantee.organizer', to: org.user.email } }));
  assert.ok(mail);
  const all = await ok(call('GET', '/admin/guarantee-claims?payer=ORGANIZER', undefined, admin.token));
  assert.ok(all.items.every((x: Json) => x.payer === 'ORGANIZER'));
  assert.ok(all.costsByPayer.find((x: Json) => x.payer === 'ORGANIZER' && x.currency === order.currency).owedCents >= orgShare);

  // Same rules as resale: a checked-in ticket is declined automatically…
  assert.equal((await ok(call('POST', `/organizer/events/${ctx.ev.id}/check-in`, { code: t2, deviceId: 'gate-7' }, org.token))).result, 'ok');
  const c2 = await ok(call('POST', `/tickets/${t2}/guarantee-claims`, { reason: 'TURNED_AWAY' }, fan.token));
  assert.equal(c2.status, 'DECLINED');
  assert.equal(c2.auto, true);
  assert.equal((await call('POST', `/tickets/${t2}/guarantee-claims`, { reason: 'OTHER' }, fan.token)).status, 409, 'one claim per ticket');
  // …and a ticket listed for resale can't be claimed on.
  await prisma.ticket.update({ where: { id: t3 }, data: { status: 'LISTED' } });
  const listed = await call('POST', `/tickets/${t3}/guarantee-claims`, { reason: 'DID_NOT_SCAN' }, fan.token);
  assert.equal(listed.status, 400);
  assert.match(listed.body.message, /listed for resale/);
  await prisma.ticket.update({ where: { id: t3 }, data: { status: 'ACTIVE' } });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status, 'PARTIALLY_REFUNDED');
});
