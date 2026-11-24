/**
 * Hiring a venue on Eventro: managers keep the listing and blocked times; organizers request a time, which has to
 * meet the listing's rules (notice, hours, length, guests, blocked time) and can't overlap another booking's time
 * (including setup and cleanup), even when two requests race; confirming declines overlapping requests; holds expire;
 * either side cancels; messages stay between the two sides; an event held at a booked venue can't be submitted until
 * the venue confirms; instant booking confirms at once. Email is logged (not sent) and pushes are logged per person.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { VenueBookingService } from '../src/venues/venue-bookings';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
let bookings: VenueBookingService;
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
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
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
  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  const { VenueBookingService: Svc } = await import('../src/venues/venue-bookings');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
  bookings = app.get(Svc);
});

after(async () => {
  await app?.close();
});

/** 30 days ahead (well past the notice), as venue wall-clock times. */
const DAY = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const at = (h: number, m = 0, day = DAY) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const LISTING = { active: true, priceMode: 'HOUR', priceCents: 50_000, currency: 'NGN', noticeDays: 3, minHours: 2, bufferMinutes: 60, capacity: 300 };

/** A Lagos venue with an approved manager, listed for hire unless `listing` is null. */
async function venueWithManager(tag: string, listing: Json | null = {}) {
  const mgr = await account(`vb-mgr-${tag}-${run}@test.local`, `Mia ${tag}`);
  const venue = await prisma.venue.create({ data: { slug: `vb-${tag}-${run}`, name: `Hall ${tag} ${run}`, address: '1 Marina Rd', city: 'Lagos', country: 'NG', timezone: 'Africa/Lagos', capacity: 500 } });
  await prisma.venueClaim.create({ data: { venueId: venue.id, userId: mgr.user.id as string, role: 'manager', message: 'I run this venue every day.', status: 'APPROVED' } });
  if (listing) await ok(call('PUT', `/me/venues/${venue.id}/listing`, { ...LISTING, ...listing }, mgr.token));
  return { mgr, venue };
}

async function organizer(tag: string) {
  const user = await account(`vb-org-${tag}-${run}@test.local`, `Oli ${tag}`);
  const org = await ok(call('POST', '/organizer/orgs', { name: `Org ${tag} ${run}` }, user.token));
  return { ...user, org };
}

const request = (orgId: string, token: string, body: Json) => call('POST', `/organizer/orgs/${orgId}/venue-bookings`, body, token);

test('listing: only the venue’s managers edit it, and bad terms are refused', async () => {
  const { mgr, venue } = await venueWithManager('listing', null);
  const outsider = await account(`vb-out-listing-${run}@test.local`, 'Otto Outsider');
  const path = `/me/venues/${venue.id}/listing`;

  // Before anything is saved: the defaults, off.
  const empty = await ok(call('GET', path, undefined, mgr.token));
  assert.equal(empty.active, false);
  assert.equal(empty.exists, false);
  assert.equal(empty.timezone, 'Africa/Lagos');
  assert.equal(empty.currency, 'NGN', 'a new listing is priced in the venue country’s currency');
  assert.equal((await ok(call('GET', `/venues/${venue.slug}`))).listing, null);

  // Not a manager: refused, and nothing is written.
  assert.equal((await call('PUT', path, LISTING, outsider.token)).status, 403);
  assert.equal((await call('GET', path, undefined, outsider.token)).status, 403);
  assert.equal((await call('PUT', path, LISTING)).status, 401);
  assert.equal(await prisma.venueListing.count({ where: { venueId: venue.id } }), 0);

  // Validation.
  const bad = async (body: Json, re: RegExp) => {
    const r = await call('PUT', path, { ...LISTING, ...body }, mgr.token);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(r.body.message), re);
  };
  await bad({ hours: [{ day: 1, open: '18:00', close: '09:00' }] }, /after opening/);
  await bad({ hours: [{ day: 1, open: '9am', close: '17:00' }] }, /open should look like/);
  await bad({ hours: [{ day: 7, open: '09:00', close: '17:00' }] }, /day/);
  await bad({ hours: [{ day: 2, open: '09:00', close: '17:00' }, { day: 2, open: '16:00', close: '20:00' }] }, /overlap/);
  await bad({ priceMode: 'HOUR', priceCents: null }, /Set a price per hour/);
  await bad({ capacity: 900 }, /more than the venue holds/);
  await bad({ bufferMinutes: 5000 }, /bufferMinutes/);
  await bad({ priceMode: 'WEEK' }, /priceMode/);
  await bad({ currency: 'XXX' }, /currency/);
  await bad({ photos: [{ url: 'http://insecure.example.com/a.jpg' }] }, /url/);
  await bad({ surprise: true }, /surprise/);

  // A manager saves it; it shows on the public venue page.
  const saved = await ok(
    call('PUT', path, { ...LISTING, amenities: ['Stage', 'stage', ' PA system '], rules: 'No confetti.', hours: [{ day: 6, open: '10:00', close: '24:00' }, { day: 0, open: '00:00', close: '04:00' }] }, mgr.token),
  );
  assert.equal(saved.active, true);
  assert.deepEqual(saved.amenities, ['Stage', 'PA system']);
  assert.deepEqual(saved.hours.map((h: Json) => h.day), [0, 6], 'sorted by day');
  const pub = (await ok(call('GET', `/venues/${venue.slug}`))).listing;
  assert.equal(pub.priceMode, 'HOUR');
  assert.equal(pub.priceCents, 50_000);
  assert.equal(pub.capacity, 300);
  assert.equal(pub.rules, 'No confetti.');
  // A first save without a currency takes the venue country's.
  const { mgr: m2, venue: v2 } = await venueWithManager('listing-ngn', null);
  assert.equal((await ok(call('PUT', `/me/venues/${v2.id}/listing`, { active: true, priceMode: 'QUOTE' }, m2.token))).currency, 'NGN');
  // Partial updates keep the rest; QUOTE drops the price.
  const quote = await ok(call('PUT', path, { priceMode: 'QUOTE' }, mgr.token));
  assert.equal(quote.priceCents, null);
  assert.equal(quote.rules, 'No confetti.');
  assert.equal((await ok(call('GET', '/me/venues', undefined, mgr.token))).managed.find((m: Json) => m.venue.id === venue.id).listing.active, true);
  // Bookable venues search finds it (and filters by guests and city).
  const found = await ok(call('GET', `/venue-listings?q=${encodeURIComponent(`Hall listing ${run}`)}`));
  assert.equal(found.length, 1);
  assert.equal(found[0].venue.slug, venue.slug);
  assert.equal((await ok(call('GET', `/venue-listings?q=${encodeURIComponent(`Hall listing ${run}`)}&guests=400`))).length, 0);
  assert.equal((await ok(call('GET', `/venue-listings?q=${encodeURIComponent(`Hall listing ${run}`)}&city=Accra`))).length, 0);

  // Blocked-out time: managers only.
  const bo = { startsAt: at(9), endsAt: at(17), note: 'Floor repairs' };
  assert.equal((await call('POST', `/me/venues/${venue.id}/blackouts`, bo, outsider.token)).status, 403);
  assert.equal((await call('POST', `/me/venues/${venue.id}/blackouts`, { ...bo, endsAt: at(8) }, mgr.token)).status, 400);
  const b = await ok(call('POST', `/me/venues/${venue.id}/blackouts`, bo, mgr.token));
  assert.deepEqual(b.conflicts, []);
  assert.equal((await ok(call('GET', `/me/venues/${venue.id}/blackouts`, undefined, mgr.token))).length, 1);
  assert.equal((await call('DELETE', `/me/venues/${venue.id}/blackouts/${b.id}`, undefined, outsider.token)).status, 403);
  await ok(call('DELETE', `/me/venues/${venue.id}/blackouts/${b.id}`, undefined, mgr.token));
  assert.equal((await call('DELETE', `/me/venues/${venue.id}/blackouts/${b.id}`, undefined, mgr.token)).status, 404);
});

test('requests: notice, hours, blocked time, guests, length and roles are checked', async () => {
  const { mgr, venue } = await venueWithManager('rules', { hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '23:00' })) });
  const o = await organizer('rules');
  const base = { venueId: venue.id, startsAt: at(12), endsAt: at(16), guests: 120, message: 'Album launch' };
  const refused = async (body: Json, status: number, re: RegExp) => {
    const r = await request(o.org.id, o.token, { ...base, ...body });
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, re);
    return r;
  };
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await refused({ startsAt: at(12, 0, soon), endsAt: at(16, 0, soon) }, 400, /3 days’ notice/);
  await refused({ startsAt: at(7), endsAt: at(11) }, 400, /isn’t open/);
  await refused({ startsAt: at(20), endsAt: at(23, 30) }, 400, /isn’t open/);
  await refused({ guests: 301 }, 400, /at most 300 guests/);
  await refused({ endsAt: at(13) }, 400, /at least 2 hours/);
  await refused({ endsAt: at(11) }, 400, /end has to be after/);
  await refused({ startsAt: '2020-01-01T10:00:00.000Z', endsAt: '2020-01-01T14:00:00.000Z' }, 400, /already passed/);
  await ok(call('POST', `/me/venues/${venue.id}/blackouts`, { startsAt: at(15), endsAt: at(18) }, mgr.token));
  const closed = await refused({}, 409, /closed for part/);
  assert.equal(closed.body.code, 'VENUE_CLOSED');

  // Door staff can't request; outsiders don't see the org.
  const door = await account(`vb-door-rules-${run}@test.local`, 'Dee Door');
  await ok(call('POST', `/organizer/orgs/${o.org.id}/team`, { email: `vb-door-rules-${run}@test.local`, role: 'DOOR' }, o.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  assert.equal((await request(o.org.id, door.token, { ...base, startsAt: at(10), endsAt: at(14) })).status, 403);
  assert.equal((await request(o.org.id, mgr.token, { ...base, startsAt: at(10), endsAt: at(14) })).status, 404);

  // A listing that's switched off takes nothing.
  await ok(call('PUT', `/me/venues/${venue.id}/listing`, { active: false }, mgr.token));
  await refused({ startsAt: at(10), endsAt: at(14) }, 400, /isn’t taking bookings/);
  assert.equal((await call('GET', `/venues/${venue.slug}/availability`)).status, 404);
  assert.equal(await prisma.venueBooking.count({ where: { venueId: venue.id } }), 0);

  // Back on: a good request is held for 48 hours, priced per hour, with its buffer.
  await ok(call('PUT', `/me/venues/${venue.id}/listing`, { active: true }, mgr.token));
  const b = await ok(request(o.org.id, o.token, { ...base, startsAt: at(9), endsAt: at(13) }));
  assert.match(b.code, /^VB-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(b.status, 'PENDING');
  assert.equal(b.quotedCents, 4 * 50_000);
  assert.equal(b.currency, 'NGN');
  assert.equal(b.blockFrom, at(8));
  assert.equal(b.blockTo, at(14));
  const hold = new Date(b.holdUntil).getTime() - Date.now();
  assert.ok(hold > 47 * 3600_000 && hold <= 48 * 3600_000, 'held for 48 hours');
  // The managers hear about it, by email and push.
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.request:${b.id}:${mgr.user.id}` } }));
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_booking.request', to: `vb-mgr-rules-${run}@test.local` } }));
});

test('overlap: another booking’s time plus the setup/cleanup buffer is taken; availability shows only times', async () => {
  const { venue } = await venueWithManager('overlap');
  const a = await organizer('overlap-a');
  const b = await organizer('overlap-b');
  const first = await ok(request(a.org.id, a.token, { venueId: venue.id, startsAt: at(14), endsAt: at(18), message: 'Secret launch party' }));
  const taken = async (s: string, e: string) => {
    const r = await request(b.org.id, b.token, { venueId: venue.id, startsAt: s, endsAt: e });
    assert.equal(r.status, 409, `${s}–${e}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'VENUE_TIME_TAKEN');
  };
  await taken(at(15), at(17)); // inside
  await taken(at(18, 30), at(20, 30)); // inside the hour of cleanup
  await taken(at(11, 30), at(13, 30)); // ends inside the hour of setup
  await taken(at(12), at(22)); // around it
  // Exactly the buffer away on either side is fine.
  const after = await ok(request(b.org.id, b.token, { venueId: venue.id, startsAt: at(19), endsAt: at(21) }));
  const before = await ok(request(b.org.id, b.token, { venueId: venue.id, startsAt: at(10), endsAt: at(13) }));
  assert.equal(after.status, 'PENDING');
  assert.equal(before.status, 'PENDING');

  // The public sees busy times, never who or why.
  const av = await ok(call('GET', `/venues/${venue.slug}/availability?from=${DAY}&to=${DAY}`));
  assert.equal(av.timezone, 'Africa/Lagos');
  assert.deepEqual(
    av.busy.map((x: Json) => [x.from, x.to, x.kind]),
    [
      [at(9), at(14), 'held'],
      [at(13), at(19), 'held'],
      [at(18), at(22), 'held'],
    ],
  );
  const text = JSON.stringify(av);
  for (const leak of ['Secret launch party', `Org overlap-a ${run}`, `Org overlap-b ${run}`, first.code, first.id]) assert.ok(!text.includes(leak), `availability leaks ${leak}`);
});

test('races: five requests for the same time at once, exactly one gets it', async () => {
  const { venue } = await venueWithManager('race');
  const orgs = await Promise.all([1, 2, 3, 4, 5].map((i) => organizer(`race-${i}`)));
  const results = await Promise.all(orgs.map((o) => request(o.org.id, o.token, { venueId: venue.id, startsAt: at(18), endsAt: at(22) })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.code, 'VENUE_TIME_TAKEN');
  assert.equal(await prisma.venueBooking.count({ where: { venueId: venue.id } }), 1);
});

test('confirm: declines the other requests that overlap, and the time is then taken', async () => {
  const { mgr, venue } = await venueWithManager('confirm');
  const a = await organizer('confirm-a');
  const b = await organizer('confirm-b');
  const outsider = await account(`vb-out-confirm-${run}@test.local`, 'Otto Outsider');
  const mine = await ok(request(a.org.id, a.token, { venueId: venue.id, startsAt: at(14), endsAt: at(18), guests: 80 }));
  // An overlapping request still waiting (as when a request was made before the venue lengthened its buffer).
  const theirs = await prisma.venueBooking.create({
    data: { code: `VB-TEST-${run.slice(-4).toUpperCase()}`, venueId: venue.id, orgId: b.org.id, requestedById: b.user.id as string, startsAt: new Date(at(18)), endsAt: new Date(at(21)), blockFrom: new Date(at(18)), blockTo: new Date(at(21)), status: 'PENDING', holdUntil: new Date(Date.now() + 86_400_000), currency: 'NGN' },
  });

  // Only the venue's managers confirm; the organizer can't confirm their own request.
  assert.equal((await call('POST', `/me/venue-bookings/${mine.id}/confirm`, {}, outsider.token)).status, 404);
  assert.equal((await call('POST', `/me/venue-bookings/${mine.id}/confirm`, {}, a.token)).status, 404);
  const inbox = await ok(call('GET', '/me/venue-bookings?status=PENDING', undefined, mgr.token));
  assert.ok(inbox.items.some((x: Json) => x.id === mine.id));
  assert.equal(inbox.items.find((x: Json) => x.id === mine.id).org.name, `Org confirm-a ${run}`);

  const confirmed = await ok(call('POST', `/me/venue-bookings/${mine.id}/confirm`, { quotedCents: 175_000, note: 'See you then. Load-in from the back gate.' }, mgr.token));
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.quotedCents, 175_000);
  assert.equal(confirmed.autoDeclined, 1);
  const declined = await prisma.venueBooking.findUniqueOrThrow({ where: { id: theirs.id } });
  assert.equal(declined.status, 'DECLINED');
  assert.match(declined.declineReason!, /confirmed another booking/);
  // Both organizers hear; the note is on the thread.
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.confirmed:${mine.id}:${a.user.id}` } }));
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.declined:${theirs.id}:${b.user.id}` } }));
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_booking.declined', to: `vb-org-confirm-b-${run}@test.local` } }));
  const thread = await ok(call('GET', `/organizer/venue-bookings/${mine.id}/messages`, undefined, a.token));
  assert.equal(thread[0].side, 'VENUE');
  assert.match(thread[0].body, /back gate/);

  // Can't be confirmed or declined again, and the time is taken now.
  assert.equal((await call('POST', `/me/venue-bookings/${mine.id}/confirm`, {}, mgr.token)).status, 400);
  assert.equal((await call('POST', `/me/venue-bookings/${mine.id}/decline`, { reason: 'Changed my mind' }, mgr.token)).status, 400);
  const late = await request(b.org.id, b.token, { venueId: venue.id, startsAt: at(15), endsAt: at(17) });
  assert.equal(late.status, 409);
  const av = await ok(call('GET', `/venues/${venue.slug}/availability?from=${DAY}&to=${DAY}`));
  assert.ok(av.busy.some((x: Json) => x.kind === 'booked' && x.from === at(13) && x.to === at(19)));

  // Declining needs a reason and tells the organizer.
  const c = await organizer('confirm-c');
  const other = await ok(request(c.org.id, c.token, { venueId: venue.id, startsAt: at(8), endsAt: at(11) }));
  assert.equal((await call('POST', `/me/venue-bookings/${other.id}/decline`, {}, mgr.token)).status, 400);
  const d = await ok(call('POST', `/me/venue-bookings/${other.id}/decline`, { reason: 'We have a private event that morning.' }, mgr.token));
  assert.equal(d.status, 'DECLINED');
  assert.equal(d.declineReason, 'We have a private event that morning.');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.declined:${other.id}:${c.user.id}` } }));
});

test('expiry: a request nobody answered stops holding its time, and the sweep marks it EXPIRED', async () => {
  const { mgr, venue } = await venueWithManager('expiry');
  const a = await organizer('expiry-a');
  const b = await organizer('expiry-b');
  const old = await ok(request(a.org.id, a.token, { venueId: venue.id, startsAt: at(14), endsAt: at(18) }));
  assert.equal((await request(b.org.id, b.token, { venueId: venue.id, startsAt: at(14), endsAt: at(18) })).status, 409);

  // Its hold runs out (before the sweep has run): it shows as expired, and the time is free.
  await prisma.venueBooking.update({ where: { id: old.id }, data: { holdUntil: new Date(Date.now() - 60_000) } });
  assert.equal((await ok(call('GET', `/organizer/venue-bookings/${old.id}`, undefined, a.token))).status, 'EXPIRED');
  assert.equal((await ok(call('GET', `/venues/${venue.slug}/availability?from=${DAY}&to=${DAY}`))).busy.length, 0);
  const fresh = await ok(request(b.org.id, b.token, { venueId: venue.id, startsAt: at(14), endsAt: at(18) }));
  assert.equal(fresh.status, 'PENDING');
  // Too late to confirm.
  const late = await call('POST', `/me/venue-bookings/${old.id}/confirm`, {}, mgr.token);
  assert.equal(late.status, 400);
  assert.match(late.body.message, /expired/);

  const again = await prisma.venueBooking.create({
    data: { code: `VB-EXP2-${run.slice(-4).toUpperCase()}`, venueId: venue.id, orgId: a.org.id, requestedById: a.user.id as string, startsAt: new Date(at(8)), endsAt: new Date(at(10)), blockFrom: new Date(at(7)), blockTo: new Date(at(11)), status: 'PENDING', holdUntil: new Date(Date.now() - 1000), currency: 'NGN' },
  });
  const r = await bookings.expireDue();
  assert.ok(r.expired >= 1);
  assert.equal((await prisma.venueBooking.findUniqueOrThrow({ where: { id: again.id } })).status, 'EXPIRED');
  assert.equal((await prisma.venueBooking.findUniqueOrThrow({ where: { id: old.id } })).status, 'EXPIRED');
  assert.equal((await prisma.venueBooking.findUniqueOrThrow({ where: { id: fresh.id } })).status, 'PENDING', 'live holds stay');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.expired:${again.id}:${a.user.id}` } }));
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_booking.expired', to: `vb-org-expiry-a-${run}@test.local` } }));
  // Running it again changes nothing.
  const twice = await bookings.expireDue();
  assert.equal(await prisma.notificationLog.count({ where: { dedupeKey: `venue_booking.expired:${again.id}:${a.user.id}` } }), 1);
  void twice;
});

test('cancel: organizers withdraw or cancel, venues cancel confirmed bookings, and the other side hears', async () => {
  const { mgr, venue } = await venueWithManager('cancel');
  const o = await organizer('cancel');
  const outsider = await account(`vb-out-cancel-${run}@test.local`, 'Otto Outsider');

  // Organizer withdraws a request: the managers hear, the time is free.
  const req = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(10), endsAt: at(13) }));
  assert.equal((await call('POST', `/organizer/venue-bookings/${req.id}/cancel`, { reason: 'Plans changed' }, outsider.token)).status, 404);
  assert.equal((await call('POST', `/organizer/venue-bookings/${req.id}/cancel`, {}, o.token)).status, 400, 'a reason is needed');
  const venueSide = await call('POST', `/me/venue-bookings/${req.id}/cancel`, { reason: 'No thanks' }, mgr.token);
  assert.equal(venueSide.status, 400);
  assert.match(venueSide.body.message, /Decline the request/);
  const withdrawn = await ok(call('POST', `/organizer/venue-bookings/${req.id}/cancel`, { reason: 'Plans changed' }, o.token));
  assert.equal(withdrawn.status, 'CANCELLED');
  assert.equal(withdrawn.cancelledBy, 'ORGANIZER');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.cancelled:${req.id}:${mgr.user.id}` } }));
  assert.equal((await call('POST', `/organizer/venue-bookings/${req.id}/cancel`, { reason: 'Again' }, o.token)).status, 400);
  await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(10), endsAt: at(13) }));

  // The venue cancels a confirmed booking: the organizer hears.
  const conf = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(18), endsAt: at(22) }));
  await ok(call('POST', `/me/venue-bookings/${conf.id}/confirm`, {}, mgr.token));
  const byVenue = await ok(call('POST', `/me/venue-bookings/${conf.id}/cancel`, { reason: 'Burst pipe in the hall' }, mgr.token));
  assert.equal(byVenue.status, 'CANCELLED');
  assert.equal(byVenue.cancelledBy, 'VENUE');
  assert.equal(byVenue.cancelReason, 'Burst pipe in the hall');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.cancelled:${conf.id}:${o.user.id}` } }));
  const list = await ok(call('GET', `/organizer/orgs/${o.org.id}/venue-bookings?status=CANCELLED`, undefined, o.token));
  assert.deepEqual(list.map((x: Json) => x.id).sort(), [req.id, conf.id].sort());
});

test('messages: only the organizer’s team and the venue’s managers see or write them', async () => {
  const { mgr, venue } = await venueWithManager('msg');
  const other = await venueWithManager('msg-other');
  const o = await organizer('msg');
  const outsider = await organizer('msg-outsider');
  const door = await account(`vb-door-msg-${run}@test.local`, 'Dee Door');
  await ok(call('POST', `/organizer/orgs/${o.org.id}/team`, { email: `vb-door-msg-${run}@test.local`, role: 'DOOR' }, o.token));
  await ok(call('POST', '/organizer/invites/accept', undefined, door.token));
  const b = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(12), endsAt: at(16), message: 'Do you have a green room?' }));

  const m1 = await ok(call('POST', `/organizer/venue-bookings/${b.id}/messages`, { body: 'Also: can we bring our own sound?' }, o.token));
  assert.equal(m1.side, 'ORGANIZER');
  const m2 = await ok(call('POST', `/me/venue-bookings/${b.id}/messages`, { body: 'Yes to both.' }, mgr.token));
  assert.equal(m2.side, 'VENUE');
  // The other side hears about each message.
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.message:${m1.id}:${mgr.user.id}` } }));
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.message:${m2.id}:${o.user.id}` } }));

  const seenByVenue = await ok(call('GET', `/me/venue-bookings/${b.id}/messages`, undefined, mgr.token));
  assert.deepEqual(seenByVenue.map((m: Json) => [m.side, m.body, m.mine]), [
    ['ORGANIZER', 'Also: can we bring our own sound?', false],
    ['VENUE', 'Yes to both.', true],
  ]);
  // Door staff can read but not write.
  assert.equal((await ok(call('GET', `/organizer/venue-bookings/${b.id}/messages`, undefined, door.token))).length, 2);
  assert.equal((await call('POST', `/organizer/venue-bookings/${b.id}/messages`, { body: 'Hi' }, door.token)).status, 403);
  // Nobody else, from either door.
  for (const token of [outsider.token, other.mgr.token]) {
    assert.equal((await call('GET', `/organizer/venue-bookings/${b.id}/messages`, undefined, token)).status, 404);
    assert.equal((await call('GET', `/me/venue-bookings/${b.id}/messages`, undefined, token)).status, 404);
    assert.equal((await call('POST', `/organizer/venue-bookings/${b.id}/messages`, { body: 'Hi' }, token)).status, 404);
    assert.equal((await call('POST', `/me/venue-bookings/${b.id}/messages`, { body: 'Hi' }, token)).status, 404);
    assert.equal((await call('GET', `/organizer/venue-bookings/${b.id}`, undefined, token)).status, 404);
    assert.equal((await call('GET', `/me/venue-bookings/${b.id}`, undefined, token)).status, 404);
  }
  // The organizer isn't a manager of the venue, so the venue's side of the booking is closed to them.
  assert.equal((await call('POST', `/me/venue-bookings/${b.id}/messages`, { body: 'Hi' }, o.token)).status, 404);
  assert.equal((await call('POST', `/organizer/venue-bookings/${b.id}/messages`, { body: '' }, o.token)).status, 400);
  // The detail includes the thread.
  const detail = await ok(call('GET', `/organizer/venue-bookings/${b.id}`, undefined, o.token));
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.can.cancel, true);
  assert.equal(detail.can.confirm, false);
});

test('events: held at a booked venue, they can’t be submitted until the venue confirms', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const { mgr, venue } = await venueWithManager('event');
  const o = await organizer('event');
  const b = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(17), endsAt: at(23), guests: 200 }));
  const eventBody = (extra: Json = {}) => ({
    title: `Booked Show ${run}`,
    category: 'CONCERTS',
    startsAt: at(19),
    doorsAt: at(18),
    endsAt: at(22, 30),
    venueBookingId: b.id,
    ticketTypes: [{ name: 'General', basePriceCents: 500_000, capacity: 200 }],
    currency: 'NGN',
    ...extra,
  });

  // The event has to happen within the booking (doors included).
  const outside = await call('POST', `/organizer/orgs/${o.org.id}/events`, eventBody({ doorsAt: at(16) }), o.token);
  assert.equal(outside.status, 400);
  assert.equal(outside.body.code, 'OUTSIDE_VENUE_BOOKING');
  const ev = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, eventBody({ timezone: 'America/Chicago' }), o.token));
  assert.equal(ev.venueId, venue.id, 'the event is at the booked venue');
  assert.equal(ev.timezone, 'Africa/Lagos', 'in the venue’s zone');
  assert.equal(ev.venueBooking.status, 'PENDING');
  // One event per booking.
  const twice = await call('POST', `/organizer/orgs/${o.org.id}/events`, eventBody({ title: `Second ${run}` }), o.token);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'BOOKING_IN_USE');

  // Waiting for the venue: submit is refused, and the event screen says so.
  const detail = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, o.token));
  assert.deepEqual([detail.venueBooking.code, detail.venueBooking.status], [b.code, 'PENDING']);
  const listed = (await ok(call('GET', `/organizer/orgs/${o.org.id}/events`, undefined, o.token))).find((e: Json) => e.id === ev.id);
  assert.equal(listed.venueBooking.status, 'PENDING');
  const held = await call('POST', `/organizer/events/${ev.id}/submit`, undefined, o.token);
  assert.equal(held.status, 409);
  assert.equal(held.body.code, 'VENUE_BOOKING_PENDING');
  assert.match(held.body.message, /Waiting for Hall event/);
  // It stays at the booked venue: moving it is refused while the booking is live, and times stay inside it.
  const move = await call('PUT', `/organizer/events/${ev.id}/venue`, { venue: { name: `Elsewhere ${run}`, address: '2 Broad St', city: 'Lagos', country: 'NG' } }, o.token);
  assert.equal(move.status, 409);
  assert.equal(move.body.code, 'VENUE_BOOKED');
  assert.equal((await call('PATCH', `/organizer/events/${ev.id}`, { endsAt: at(23, 30) }, o.token)).status, 400);
  // The manager sees which event it's for.
  assert.equal((await ok(call('GET', `/me/venue-bookings/${b.id}`, undefined, mgr.token))).event.title, `Booked Show ${run}`);

  // Confirmed: submit works, and it can be published.
  await ok(call('POST', `/me/venue-bookings/${b.id}/confirm`, {}, mgr.token));
  assert.equal((await ok(call('GET', `/organizer/events/${ev.id}`, undefined, o.token))).venueBooking.status, 'CONFIRMED');
  await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, o.token));
  await ok(call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token));

  // The venue cancels after it's on sale: the organizer is told to act, and the event isn't cancelled.
  await ok(call('POST', `/me/venue-bookings/${b.id}/cancel`, { reason: 'Our licence was suspended' }, mgr.token));
  const mail = await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_booking.cancelled', to: `vb-org-event-${run}@test.local` } }));
  assert.match(mail.subject, /^Action needed: /);
  const push = await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.cancelled:${b.id}:${o.user.id}` } }));
  assert.match(push.title, /^Action needed/);
  assert.equal((push.data as Json).path, `/organizer/events/${ev.id}`);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).status, 'PUBLISHED');

  // A booking that fell through: submit says to pick another venue; moving it lets go of the booking.
  const b2 = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(9), endsAt: at(15) }));
  const ev2 = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, eventBody({ title: `Daytime ${run}`, startsAt: at(10), doorsAt: at(9, 30), endsAt: at(14), venueBookingId: b2.id }), o.token));
  await ok(call('POST', `/me/venue-bookings/${b2.id}/decline`, { reason: 'Fully booked that day' }, mgr.token));
  const gone = await call('POST', `/organizer/events/${ev2.id}/submit`, undefined, o.token);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, 'VENUE_BOOKING_UNAVAILABLE');
  assert.match(gone.body.message, /Pick another venue or time/);
  await ok(call('PUT', `/organizer/events/${ev2.id}/venue`, { venue: { name: `Elsewhere ${run}`, address: '2 Broad St', city: 'Lagos', country: 'NG' } }, o.token));
  assert.equal((await prisma.venueBooking.findUniqueOrThrow({ where: { id: b2.id } })).eventId, null);
  await ok(call('POST', `/organizer/events/${ev2.id}/submit`, undefined, o.token));

  // Attaching later, and requesting with a draft event: the event moves to the venue and waits again.
  const ev3 = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, eventBody({ title: `Later ${run}`, venueBookingId: undefined, venue: { name: `Own Place ${run}`, address: '9 Allen Ave', city: 'Lagos', country: 'NG' }, startsAt: at(19, 0, nextDay()), doorsAt: undefined, endsAt: at(21, 0, nextDay()) }), o.token));
  const b3 = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(18, 0, nextDay()), endsAt: at(22, 0, nextDay()), eventId: ev3.id }));
  const moved = await prisma.event.findUniqueOrThrow({ where: { id: ev3.id }, include: { venueBooking: true } });
  assert.equal(moved.venueId, venue.id);
  assert.equal(moved.venueBooking?.id, b3.id);
  assert.equal((await call('POST', `/organizer/events/${ev3.id}/submit`, undefined, o.token)).body.code, 'VENUE_BOOKING_PENDING');
  // Detaching lets them go ahead at that venue on their own terms.
  await ok(call('DELETE', `/organizer/events/${ev3.id}/venue-booking`, undefined, o.token));
  await ok(call('POST', `/organizer/events/${ev3.id}/submit`, undefined, o.token));
  // …and attaching again needs a draft (or a confirmed booking).
  const again = await call('PUT', `/organizer/events/${ev3.id}/venue-booking`, { bookingId: b3.id }, o.token);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'VENUE_BOOKING_PENDING');
});

/** `n` days after DAY. */
function nextDay(n = 1) {
  return new Date(new Date(`${DAY}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

test('instant booking: a free time is confirmed at once, priced per day', async () => {
  const { mgr, venue } = await venueWithManager('instant', { instantBook: true, priceMode: 'DAY', priceCents: 1_000_000, minHours: 4 });
  const o = await organizer('instant');
  const b = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(10), endsAt: at(10, 0, nextDay()), guests: 50 }));
  assert.equal(b.status, 'CONFIRMED');
  assert.equal(b.quotedCents, 1_000_000, 'one day');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.request:${b.id}:${mgr.user.id}` } }));
  const push = await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.confirmed:${b.id}:${o.user.id}` } }));
  assert.equal((push.data as Json).path, `/organizer/bookings/${b.id}`);
  const longer = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(10, 0, nextDay(2)), endsAt: at(18, 0, nextDay(3)) }));
  assert.equal(longer.quotedCents, 2 * 1_000_000, 'a day and a bit is two days');
  // The time is taken for everyone else.
  const other = await organizer('instant-b');
  assert.equal((await request(other.org.id, other.token, { venueId: venue.id, startsAt: at(12), endsAt: at(16) })).status, 409);
  // Bookings go into the manager's inbox as confirmed.
  const inbox = await ok(call('GET', `/me/venue-bookings?status=CONFIRMED&venueId=${venue.id}`, undefined, mgr.token));
  assert.equal(inbox.items.length, 2);
  assert.equal((await call('GET', `/me/venue-bookings?venueId=${venue.id}`, undefined, o.token)).status, 403);
});

test('cancelling an event cancels its venue booking, and the venue’s managers hear', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const { mgr, venue } = await venueWithManager('evcancel');
  const o = await organizer('evcancel');
  const show = (title: string, b: Json, start: number, day = nextDay(5)) => ({
    title,
    category: 'CONCERTS',
    startsAt: at(start, 0, day),
    endsAt: at(start + 2, 0, day),
    venueBookingId: b.id,
    ticketTypes: [{ name: 'General', basePriceCents: 500_000, capacity: 100 }],
    currency: 'NGN',
  });

  // A confirmed booking, cancelled by the organizer with the event.
  const b1 = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(9, 0, nextDay(5)), endsAt: at(13, 0, nextDay(5)) }));
  await ok(call('POST', `/me/venue-bookings/${b1.id}/confirm`, {}, mgr.token));
  const ev1 = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, show(`Morning Gig ${run}`, b1, 10), o.token));
  const out = await ok(call('POST', `/organizer/events/${ev1.id}/cancel`, { reason: 'The headliner is unwell.', confirmTitle: `Morning Gig ${run}` }, o.token));
  assert.equal(out.venueBookingCancelled, b1.code);
  const c1 = await prisma.venueBooking.findUniqueOrThrow({ where: { id: b1.id } });
  assert.deepEqual([c1.status, c1.cancelReason, c1.cancelledById], ['CANCELLED', 'The event was cancelled', o.user.id]);
  const push = await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.cancelled:${b1.id}:${mgr.user.id}` } }));
  assert.match(push.body, /was cancelled/);
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_booking.cancelled', to: `vb-mgr-evcancel-${run}@test.local` } }));
  // The time is free again.
  const av = await ok(call('GET', `/venues/${venue.slug}/availability?from=${nextDay(5)}&to=${nextDay(5)}`));
  assert.equal(av.busy.length, 0);
  // Cancelling again (a retry) leaves it alone.
  const retry = await ok(call('POST', `/organizer/events/${ev1.id}/cancel`, { reason: 'The headliner is unwell.', confirmTitle: `Morning Gig ${run}` }, o.token));
  assert.equal(retry.venueBookingCancelled, null);

  // A request still waiting, cancelled by Eventro with the event.
  const b2 = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(15, 0, nextDay(5)), endsAt: at(19, 0, nextDay(5)) }));
  const ev2 = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, show(`Afternoon Gig ${run}`, b2, 16), o.token));
  const byAdmin = await ok(call('POST', `/admin/events/${ev2.id}/cancel`, { reason: 'Cancelled by Eventro support.' }, admin.token));
  assert.equal(byAdmin.venueBookingCancelled, b2.code);
  assert.equal((await prisma.venueBooking.findUniqueOrThrow({ where: { id: b2.id } })).status, 'CANCELLED');
  await waitFor(() => prisma.notificationLog.findUnique({ where: { dedupeKey: `venue_booking.cancelled:${b2.id}:${mgr.user.id}` } }));

  // A booking that already fell through is left as it was.
  const b3 = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(9, 0, nextDay(6)), endsAt: at(13, 0, nextDay(6)) }));
  const ev3 = await ok(call('POST', `/organizer/orgs/${o.org.id}/events`, show(`Declined Gig ${run}`, b3, 10, nextDay(6)), o.token));
  await ok(call('POST', `/me/venue-bookings/${b3.id}/decline`, { reason: 'Closed for a private event.' }, mgr.token));
  const none = await ok(call('POST', `/organizer/events/${ev3.id}/cancel`, { reason: 'No venue for it after all.', confirmTitle: `Declined Gig ${run}` }, o.token));
  assert.equal(none.venueBookingCancelled, null);
  const c3 = await prisma.venueBooking.findUniqueOrThrow({ where: { id: b3.id } });
  assert.deepEqual([c3.status, c3.cancelReason], ['DECLINED', null]);
});

test('admin console publish: refused, like review approval, while the venue booking isn’t confirmed', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const { mgr, venue } = await venueWithManager('publish');
  const o = await organizer('publish');
  const booked = async (title: string, day: string, from: number, to: number) => {
    const b = await ok(request(o.org.id, o.token, { venueId: venue.id, startsAt: at(from, 0, day), endsAt: at(to, 0, day) }));
    await ok(call('POST', `/me/venue-bookings/${b.id}/confirm`, {}, mgr.token));
    const ev = await ok(
      call(
        'POST',
        `/organizer/orgs/${o.org.id}/events`,
        { title, category: 'CONCERTS', startsAt: at(from + 1, 0, day), endsAt: at(to - 1, 0, day), venueBookingId: b.id, ticketTypes: [{ name: 'General', basePriceCents: 500_000, capacity: 100 }], currency: 'NGN' },
        o.token,
      ),
    );
    await ok(call('POST', `/organizer/events/${ev.id}/submit`, undefined, o.token));
    return { b, ev };
  };
  const refused = async (evId: string) => {
    const r = await call('POST', `/admin/events/${evId}/publish`, undefined, admin.token);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'VENUE_BOOKING_NOT_CONFIRMED');
    assert.match(r.body.message, /cancelled, not confirmed/);
  };

  // In review, the venue cancels: neither approval nor the console's publish lets it go live.
  const { b, ev } = await booked(`Publish Test ${run}`, nextDay(7), 17, 23);
  await ok(call('POST', `/me/venue-bookings/${b.id}/cancel`, { reason: 'Double-booked by mistake' }, mgr.token));
  assert.equal((await call('POST', `/admin/events/${ev.id}/approve`, undefined, admin.token)).body.code, 'VENUE_BOOKING_NOT_CONFIRMED');
  await refused(ev.id);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).status, 'IN_REVIEW');

  // Taken down after going live: publishing again works while the booking is confirmed, and not once it's gone.
  const t = await booked(`Takedown Test ${run}`, nextDay(8), 9, 15);
  await ok(call('POST', `/admin/events/${t.ev.id}/approve`, undefined, admin.token));
  await ok(call('POST', `/admin/events/${t.ev.id}/takedown`, { note: 'Checking the venue licence' }, admin.token));
  await ok(call('POST', `/admin/events/${t.ev.id}/publish`, undefined, admin.token));
  await ok(call('POST', `/admin/events/${t.ev.id}/takedown`, { note: 'Checking the venue licence' }, admin.token));
  await ok(call('POST', `/me/venue-bookings/${t.b.id}/cancel`, { reason: 'Licence not renewed' }, mgr.token));
  await refused(t.ev.id);
  assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: t.ev.id } })).status, 'REJECTED');
});

