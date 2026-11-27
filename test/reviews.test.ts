/**
 * Reviews: verified ticket holders rate an event after it ends; organizers reply; flags go to admins, who hide or keep.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { ReviewService } from '../src/reviews/reviews.module';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
let reviews: ReviewService;
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

before(async () => {
  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  const { ReviewService: Svc } = await import('../src/reviews/reviews.module');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
  reviews = app.get(Svc);
});

after(async () => {
  await app?.close();
});

let n = 0;
async function show(org: string, admin: string) {
  n++;
  const o = await ok(call('POST', '/organizer/orgs', { name: `Review Org ${run} ${n}` }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: `Review Show ${run} ${n}`, category: 'CONCERTS', venue: { name: 'Review Hall', address: '1 Review St', city: 'London', country: 'GB' }, timezone: 'UTC', startsAt: new Date(Date.now() + 20 * DAY).toISOString(), ticketTypes: [{ name: 'General', basePriceCents: 3000, capacity: 50 }] },
      org,
    ),
  );
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, org));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin));
  const slug = (await prisma.organization.findUniqueOrThrow({ where: { id: o.id } })).slug;
  return { org: { ...o, slug } as Json, ev, general: (ev.ticketTypes as Json[])[0] };
}
async function buy(fan: { token: string; user: Json }, ticketTypeId: string) {
  const hold = await ok(call('POST', '/holds', { ticketTypeId, quantity: 1 }, fan.token));
  const order = await ok(call('POST', '/orders', { holdId: hold.id, email: fan.user.email, name: fan.user.name }, fan.token));
  return ok(call('POST', `/orders/${order.orderId}/pay`));
}
/** Moves the event so it ended `daysAgo` days ago. */
const ended = (id: string, daysAgo: number) => prisma.event.update({ where: { id }, data: { startsAt: new Date(Date.now() - daysAgo * DAY - 3 * 3600_000), endsAt: new Date(Date.now() - daysAgo * DAY) } });

test('reviews: ticket holders rate an event once it is over; the organizer replies; ratings add up', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rev-o1-${run}@test.local`, 'Olu Organizer');
  const ada = await account(`rev-a1-${run}@test.local`, 'Ada Holder');
  const ben = await account(`rev-b1-${run}@test.local`, 'Ben Holder');
  const stranger = await account(`rev-x1-${run}@test.local`, 'Sly Stranger');
  const { ev, general, org: o } = await show(org.token, admin.token);
  await buy(ada, general.id);
  await buy(ben, general.id);

  // Not over yet: nobody can review.
  const early = await ok(call('GET', `/events/${ev.slug}/reviews`, undefined, ada.token));
  assert.deepEqual([early.canReview, early.summary.count, early.mine], [false, 0, null]);
  assert.match(early.reason, /once it’s over/);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 5 }, ada.token)).status, 403);

  await ended(ev.id, 1);
  // Only people who had a ticket; never the event's own team; signed out sees why.
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 1, body: 'Never went.' }, stranger.token)).status, 403);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 5 }, org.token)).status, 403);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 5 })).status, 401);
  assert.equal((await ok(call('GET', `/events/${ev.slug}/reviews`))).canReview, false);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 6 }, ada.token)).status, 400);

  const first = await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 5, body: '  Great night.\n\n\n\nSound was perfect.  ' }, ada.token));
  assert.deepEqual([first.rating, first.body, first.name, first.mine], [5, 'Great night.\n\nSound was perfect.', 'Ada H.', true]);
  // Writing again changes it: still one review each.
  await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 4, body: 'Great night.' }, ada.token));
  await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 2, body: 'Doors opened an hour late.' }, ben.token));
  assert.equal(await prisma.eventReview.count({ where: { eventId: ev.id } }), 2);

  const seen = await ok(call('GET', `/events/${ev.slug}/reviews`, undefined, ada.token));
  assert.deepEqual([seen.summary.average, seen.summary.count, seen.summary.stars], [3, 2, [0, 1, 0, 1, 0]]);
  assert.deepEqual([seen.organizer.average, seen.organizer.count, seen.mine.rating, seen.canReview], [3, 2, 4, true]);
  assert.deepEqual(seen.reviews.map((r: Json) => [r.name, r.rating, r.mine]), [['Ben H.', 2, false], ['Ada H.', 4, true]]);
  // The organizer's rating shows on their events and their page.
  assert.deepEqual((await ok(call('GET', `/events/${ev.slug}`))).organizer.rating, { average: 3, count: 2 });
  const page = await ok(call('GET', `/organizers/${o.slug}/reviews`));
  assert.deepEqual([page.summary.count, page.reviews[0].event.title], [2, ev.title]);

  // The organizer replies in public (and can take the reply back); nobody else can.
  const benReview = seen.reviews[0];
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/reviews/${benReview.id}/reply`, { reply: 'Hi' }, stranger.token)).status, 404);
  const replied = await ok(call('PUT', `/organizer/events/${ev.id}/reviews/${benReview.id}/reply`, { reply: 'Sorry about the wait, Ben. The venue’s power failed; next time doors open on time.' }, org.token));
  assert.ok(replied.reply.startsWith('Sorry about the wait'));
  assert.ok((await ok(call('GET', `/events/${ev.slug}/reviews`))).reviews[0].repliedAt);
  assert.equal((await ok(call('GET', `/events/${ev.slug}/reviews`))).reviews[0].edited, false, 'a reply is not an edit');
  const mineOrg = await ok(call('GET', `/organizer/events/${ev.id}/reviews`, undefined, org.token));
  assert.deepEqual([mineOrg.reviews.length, mineOrg.summary.average, mineOrg.reviews[0].hidden, mineOrg.reviews[0].flagged], [2, 3, false, false]);
  await ok(call('PUT', `/organizer/events/${ev.id}/reviews/${benReview.id}/reply`, { reply: '' }, org.token));
  assert.equal((await ok(call('GET', `/events/${ev.slug}/reviews`))).reviews[0].reply, null);

  // Removing your own review.
  assert.equal((await ok(call('DELETE', `/events/${ev.slug}/reviews`, undefined, ben.token))).removed, true);
  assert.equal((await ok(call('GET', `/events/${ev.slug}/reviews`))).summary.count, 1);
  // After 60 days the window is closed for new reviews; an existing one can still be changed.
  await ended(ev.id, 70);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 2 }, ben.token)).status, 403);
  await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 5, body: 'Still the best show this year.' }, ada.token));
});

test('reviews: flags go to admins, who hide or keep; ticket holders are asked once after the event', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const org = await account(`rev-o2-${run}@test.local`, 'Oma Organizer');
  const ada = await account(`rev-a2-${run}@test.local`, 'Ada Holder');
  const ben = await account(`rev-b2-${run}@test.local`, 'Ben');
  const { ev, general } = await show(org.token, admin.token);
  await buy(ada, general.id);
  await buy(ben, general.id);
  await ended(ev.id, 1);

  // The day after: each ticket holder is asked once.
  await prisma.event.updateMany({ where: { reviewAskedAt: null, id: { not: ev.id } }, data: { reviewAskedAt: new Date() } }); // other tests' events
  assert.equal(await reviews.askAll(), 2);
  assert.equal(await prisma.emailLog.count({ where: { kind: 'review_request', to: { in: [ada.user.email, ben.user.email] } } }), 2);
  assert.equal(await reviews.askAll(), 0);

  const mine = await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 1, body: 'Total scam, call this number for refunds.' }, ada.token));
  await ok(call('PUT', `/events/${ev.slug}/reviews`, { rating: 5 }, ben.token));
  assert.equal(mine.name, 'Ada H.');
  // Flagging: not your own, once per person, signed in.
  assert.equal((await call('POST', `/reviews/${mine.id}/flag`, { reason: 'SPAM' }, ada.token)).status, 400);
  assert.equal((await call('POST', `/reviews/${mine.id}/flag`, { reason: 'SPAM' })).status, 401);
  assert.equal((await call('POST', `/reviews/${mine.id}/flag`, { reason: 'NOPE' }, ben.token)).status, 400);
  await ok(call('POST', `/reviews/${mine.id}/flag`, { reason: 'SPAM', note: 'It’s an advert.' }, ben.token));
  await ok(call('POST', `/reviews/${mine.id}/flag`, { reason: 'FAKE' }, ben.token));
  await ok(call('POST', `/reviews/${mine.id}/flag`, { reason: 'OFFENSIVE' }, org.token));
  assert.equal((await prisma.eventReview.findUniqueOrThrow({ where: { id: mine.id } })).flags, 2);

  assert.equal((await call('GET', '/admin/event-reviews', undefined, ben.token)).status, 403);
  const queue = (await ok(call('GET', '/admin/event-reviews', undefined, admin.token))).reviews as Json[];
  const row = queue.find((r) => r.id === mine.id)!;
  assert.deepEqual([row.flags, row.event.title, row.reasons.length, row.hidden], [2, ev.title, 2, false]);
  assert.equal((await call('POST', `/admin/event-reviews/${mine.id}/hide`, { reason: 'no' }, admin.token)).status, 400);
  assert.equal((await ok(call('POST', `/admin/event-reviews/${mine.id}/hide`, { reason: 'Advertising, not a review.' }, admin.token))).status, 'HIDDEN');

  // Hidden: gone from the public list and the rating; its author sees why and can't change it.
  const pub = await ok(call('GET', `/events/${ev.slug}/reviews`));
  assert.deepEqual([pub.summary.count, pub.summary.average, pub.reviews.length], [1, 5, 1]);
  const own = await ok(call('GET', `/events/${ev.slug}/reviews`, undefined, ada.token));
  assert.deepEqual([own.mine.hidden, own.mine.hideReason], [true, 'Advertising, not a review.']);
  assert.equal((await call('PUT', `/events/${ev.slug}/reviews`, { rating: 5 }, ada.token)).status, 403);
  assert.equal(((await ok(call('GET', '/admin/event-reviews?status=HIDDEN', undefined, admin.token))).reviews as Json[]).filter((r) => r.id === mine.id).length, 1);
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}/reviews`, undefined, org.token))).reviews.find((r: Json) => r.id === mine.id).hidden, true);

  // Restored: back in the list, flags cleared. "Keep" clears flags without hiding.
  await ok(call('POST', `/admin/event-reviews/${mine.id}/restore`, undefined, admin.token));
  assert.equal((await ok(call('GET', `/events/${ev.slug}/reviews`))).summary.count, 2);
  await ok(call('POST', `/reviews/${mine.id}/flag`, { reason: 'OTHER' }, ben.token));
  await ok(call('POST', `/admin/event-reviews/${mine.id}/keep`, undefined, admin.token));
  const after2 = await prisma.eventReview.findUniqueOrThrow({ where: { id: mine.id } });
  assert.deepEqual([after2.flags, after2.status], [0, 'VISIBLE']);
  assert.equal(await prisma.auditLog.count({ where: { action: { in: ['review.hide', 'review.restore', 'review.keep'] }, entityId: ev.id } }), 3);
});
