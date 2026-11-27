/**
 * Carts: several ticket types of one event bought in one checkout. Holds are all or nothing; each type becomes its
 * own order (so refunds work per order) under one cart id and one payment; a promo code counts once; one receipt.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

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

let n = 0;
/** A published event with Adult ($40), Child ($15) and a small VIP tier (2 left). */
async function family(org: string, admin: string) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Cart Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Family Day ${run} ${n}`,
        category: 'FAMILY',
        venue: { name: 'Cart Hall', address: '1 Cart St', city: 'London', country: 'GB' },
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 20 * DAY).toISOString(),
        ticketTypes: [
          { name: 'Adult', basePriceCents: 4000, capacity: 50 },
          { name: 'Child', basePriceCents: 1500, capacity: 50 },
          { name: 'VIP', basePriceCents: 9000, capacity: 2 },
        ],
      },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  const tier = (name: string) => (ev.ticketTypes as Json[]).find((t) => t.name === name)!;
  return { org: o as Json, ev, adult: tier('Adult'), child: tier('Child'), vip: tier('VIP') };
}

test('cart holds: all or nothing, one event, each type once', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cart-o1-${run}@test.local`, 'Cora Organizer');
  const fan = await account(`cart-f1-${run}@test.local`, 'Fay Fan');
  const a = await family(org.token, admin.token);
  const b = await family(org.token, admin.token);
  // VIP has 2 left: asking for 3 fails, and the Adult line made first is let go.
  const short = await call('POST', '/holds/cart', { items: [{ ticketTypeId: a.adult.id, quantity: 2 }, { ticketTypeId: a.vip.id, quantity: 3 }] }, fan.token);
  assert.equal(short.status, 409);
  assert.equal(await prisma.hold.count({ where: { ticketTypeId: a.adult.id, status: 'ACTIVE' } }), 0, 'nothing stays held');
  assert.equal((await call('POST', '/holds/cart', { items: [{ ticketTypeId: a.adult.id, quantity: 1 }, { ticketTypeId: a.adult.id, quantity: 1 }] }, fan.token)).status, 400);
  assert.equal((await call('POST', '/holds/cart', { items: [{ ticketTypeId: a.adult.id, quantity: 1 }, { ticketTypeId: b.child.id, quantity: 1 }] }, fan.token)).status, 400);
  const held = await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: a.adult.id, quantity: 2 }, { ticketTypeId: a.child.id, quantity: 2 }] }, fan.token));
  assert.equal(held.holds.length, 2);
  assert.ok(held.expiresAt);
});

test('cart checkout: one payment, one order per type, a promo counted once, one receipt, refunds per order', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cart-o2-${run}@test.local`, 'Cade Organizer');
  const fan = await account(`cart-f2-${run}@test.local`, 'Finn Fan');
  const { ev, adult, child } = await family(org.token, admin.token);
  await ok(call('POST', `/organizer/events/${ev.id}/promos`, { code: 'FAMILY10', percent: 10 }, org.token));
  const held = await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: adult.id, quantity: 2 }, { ticketTypeId: child.id, quantity: 2 }] }, fan.token));
  const holdIds = (held.holds as Json[]).map((h) => h.id);

  const plain = await ok(call('POST', '/quote/cart', { holdIds }));
  assert.equal(plain.lines.length, 2);
  assert.equal(plain.totalCents, plain.lines[0].totalCents + plain.lines[1].totalCents);
  assert.equal(plain.quantity, 4);
  const q = await ok(call('POST', '/quote/cart', { holdIds, promoCode: 'family10' }));
  assert.equal(q.discountCents, Math.round(plain.subtotalCents * 0.1));
  assert.equal(q.promo.code, 'FAMILY10');

  const created = await ok(call('POST', '/orders/cart', { holdIds, email: fan.user.email, name: fan.user.name, promoCode: 'FAMILY10' }, fan.token));
  assert.match(created.groupId, /^CRT-/);
  assert.equal(created.orderId, created.groupId);
  assert.equal(created.orderIds.length, 2);
  assert.equal(created.totalCents, q.totalCents);
  assert.equal(created.provider, 'mock');
  // The same holds can't be checked out twice.
  assert.equal((await call('POST', '/orders/cart', { holdIds, email: fan.user.email, name: fan.user.name }, fan.token)).status, 409);

  const paid = await ok(call('POST', `/orders/${created.groupId}/pay`));
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.tickets.length, 4);
  assert.equal(paid.orders.length, 2);
  assert.equal(paid.totalCents, q.totalCents);
  const orders = await prisma.order.findMany({ where: { groupId: created.groupId }, orderBy: { createdAt: 'asc' }, include: { ticketType: true } });
  assert.deepEqual(orders.map((o) => [o.ticketType.name, o.quantity, o.status]), [['Adult', 2, 'PAID'], ['Child', 2, 'PAID']]);
  assert.equal(new Set(orders.map((o) => o.paymentRef)).size, 1, 'one payment');
  assert.ok(orders.every((o) => (o.snapshot as Json).tierName === o.ticketType.name));
  assert.equal((await prisma.promo.findFirstOrThrow({ where: { eventId: ev.id, code: 'FAMILY10' } })).used, 1, 'a promo is used once per checkout');
  assert.deepEqual((await prisma.ticketType.findMany({ where: { id: { in: [adult.id, child.id] } }, orderBy: { name: 'asc' } })).map((t) => t.sold), [2, 2]);
  // Paying again changes nothing.
  assert.equal((await ok(call('POST', `/orders/${created.groupId}/pay`))).tickets.length, 4);
  assert.equal(await prisma.ticket.count({ where: { order: { groupId: created.groupId } } }), 4);
  // One receipt, for the cart.
  const receipt = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'order.receipt', to: fan.user.email, subject: { contains: created.groupId } } }));
  assert.ok(receipt);
  assert.equal(await prisma.emailLog.count({ where: { kind: 'order.receipt', to: fan.user.email } }), 1);

  // The buyer (or a guest with the email) can open the cart; nobody else.
  const mine = await ok(call('GET', `/orders/${created.groupId}`, undefined, fan.token));
  assert.equal(mine.orders.length, 2);
  assert.equal((await call('GET', `/orders/${created.groupId}?email=someone@else.com`)).status, 404);
  // Their wallet has all four tickets.
  const wallet = await ok(call('GET', '/me/tickets', undefined, fan.token));
  assert.equal((wallet.tickets as Json[]).filter((t) => created.orderIds.includes(t.orderId)).length, 4);

  // Refunding one type leaves the other as it is.
  const childOrder = orders[1];
  await ok(call('POST', `/admin/orders/${childOrder.id}/refund`, { reason: 'Child tickets not needed' }, admin.token));
  const after = await prisma.order.findMany({ where: { groupId: created.groupId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(after.map((o) => o.status), ['PAID', 'REFUNDED']);
  assert.equal(await prisma.ticket.count({ where: { orderId: orders[0].id, status: 'ACTIVE' } }), 2);
});

test('free cart: confirmed at once; a donation rides on the first line', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cart-o3-${run}@test.local`, 'Cleo Organizer');
  const fan = await account(`cart-f3-${run}@test.local`, 'Femi Fan');
  const o = await ok(call('POST', '/organizer/orgs', { name: `Cart Free ${run}` }, org.token));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      {
        title: `Open Day ${run}`,
        category: 'FAMILY',
        online: true,
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 20 * DAY).toISOString(),
        ticketTypes: [
          { name: 'Adult', basePriceCents: 0, capacity: 50 },
          { name: 'Child', basePriceCents: 0, capacity: 50 },
        ],
      },
      org.token,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));
  const held = await ok(call('POST', '/holds/cart', { items: (ev.ticketTypes as Json[]).map((t) => ({ ticketTypeId: t.id, quantity: 1 })) }, fan.token));
  const done = await ok(call('POST', '/orders/cart', { holdIds: (held.holds as Json[]).map((h) => h.id), email: fan.user.email, name: fan.user.name }, fan.token));
  assert.equal(done.status, 'PAID');
  assert.equal(done.provider, 'free');
  assert.equal(await prisma.ticket.count({ where: { order: { groupId: done.groupId } } }), 2);
});

test('card declined, then paid: a failed attempt keeps the order; only a cancelled payment ends it', async () => {
  const { CheckoutService } = await import('../src/checkout/checkout.service');
  const svc = app.get(CheckoutService);
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cart-o4-${run}@test.local`, 'Cyd Organizer');
  const fan = await account(`cart-f4-${run}@test.local`, 'Flo Fan');
  const { adult, child } = await family(org.token, admin.token);
  const held = await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: adult.id, quantity: 1 }, { ticketTypeId: child.id, quantity: 1 }] }, fan.token));
  const cart = await ok(call('POST', '/orders/cart', { holdIds: (held.holds as Json[]).map((h) => h.id), email: fan.user.email, name: fan.user.name }, fan.token));
  // The card is declined: the orders and the seats stay.
  await svc.handleStripeEvent('payment_intent.payment_failed', { metadata: { orderId: cart.groupId } });
  assert.deepEqual((await prisma.order.findMany({ where: { groupId: cart.groupId } })).map((o) => o.status), ['PENDING', 'PENDING']);
  // The retry goes through: tickets are issued.
  await svc.handleStripeEvent('payment_intent.succeeded', { metadata: { orderId: cart.groupId } });
  assert.equal(await prisma.ticket.count({ where: { order: { groupId: cart.groupId } } }), 2);

  // A single order behaves the same way, and a cancelled payment releases the seats.
  const h = await ok(call('POST', '/holds', { ticketTypeId: adult.id, quantity: 1 }, fan.token));
  const one = await ok(call('POST', '/orders', { holdId: h.id, email: fan.user.email, name: fan.user.name }, fan.token));
  await svc.handleStripeEvent('payment_intent.payment_failed', { metadata: { orderId: one.orderId } });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: one.orderId } })).status, 'PENDING');
  await svc.handleStripeEvent('payment_intent.canceled', { metadata: { orderId: one.orderId } });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: one.orderId } })).status, 'CANCELLED');
  assert.equal((await prisma.hold.findUniqueOrThrow({ where: { id: h.id } })).status, 'RELEASED');
});

test('a cart sent as a gift: one email to the recipient, one claim for every ticket type', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`cart-o5-${run}@test.local`, 'Cleo Organizer');
  const fan = await account(`cart-f5-${run}@test.local`, 'Gabe Giver');
  const friend = await account(`cart-r5-${run}@test.local`, 'Rita Receiver');
  const { adult, child } = await family(org.token, admin.token);
  const held = await ok(call('POST', '/holds/cart', { items: [{ ticketTypeId: adult.id, quantity: 2 }, { ticketTypeId: child.id, quantity: 1 }] }, fan.token));
  const holdIds = (held.holds as Json[]).map((h) => h.id);
  const who = { holdIds, email: fan.user.email, name: fan.user.name };
  // A gift goes to someone else.
  assert.equal((await call('POST', '/orders/cart', { ...who, gift: { name: 'Me', email: fan.user.email } }, fan.token)).status, 400);
  const created = await ok(call('POST', '/orders/cart', { ...who, gift: { name: 'Rita Receiver', email: friend.user.email, message: 'See you there!' } }, fan.token));
  const paid = await ok(call('POST', `/orders/${created.groupId}/pay`));
  assert.equal(paid.tickets.length, 3);
  // Every order carries the gift; the tickets wait for the recipient; one email goes out.
  const gifts = await waitFor(async () => {
    const g = await prisma.gift.findMany({ where: { order: { groupId: created.groupId } }, orderBy: { order: { createdAt: 'asc' } } });
    return g.length === 2 && g.every((x) => x.sentAt) ? g : null;
  });
  assert.ok(gifts, 'both gifts delivered');
  assert.equal(await prisma.ticket.count({ where: { order: { groupId: created.groupId }, status: 'TRANSFER_PENDING', transferTo: friend.user.email } }), 3);
  const mails = await prisma.emailLog.findMany({ where: { kind: 'gift.delivered', to: friend.user.email } });
  assert.equal(mails.length, 1, 'one gift email for the whole cart');
  // The gift page names the other ticket type; the buyer can't claim it; the recipient gets all three tickets.
  const page = await ok(call('GET', `/gifts/${gifts![0].token}`));
  assert.deepEqual([page.quantity, page.also], [2, [{ quantity: 1, name: 'Child' }]]);
  assert.equal((await call('POST', `/gifts/${gifts![0].token}/claim`, undefined, fan.token)).status, 400);
  const claimed = await ok(call('POST', `/gifts/${gifts![0].token}/claim`, undefined, friend.token));
  assert.equal(claimed.tickets, 3);
  assert.equal(await prisma.ticket.count({ where: { order: { groupId: created.groupId }, status: 'ACTIVE', holderEmail: friend.user.email } }), 3);
  assert.equal(await prisma.gift.count({ where: { order: { groupId: created.groupId }, claimedBy: friend.user.id } }), 2);
  assert.equal((await ok(call('GET', '/me/tickets', undefined, friend.token))).tickets.length, 3);
});
