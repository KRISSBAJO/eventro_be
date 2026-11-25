/**
 * Venue owners joining Omoshow: finding a venue to claim (GET /venues?q=), adding one that isn't on Omoshow yet
 * (POST /me/venues: hidden, with a pending claim marked newVenue, in its place's zone), the duplicate check
 * (409 VENUE_EXISTS), what the person and the admins see while it waits, and what approving or declining does
 * (shown or left hidden; venues hidden by Omoshow are left alone). Email is logged (not sent); pushes are logged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

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
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  prisma = app.get(PrismaService);
});

after(async () => {
  await app?.close();
});

const newVenue = (extra: Json = {}) => ({
  name: `Harbour Lights ${run}`,
  address: '14 Ozumba Mbadiwe Ave',
  city: 'Lagos',
  region: 'Lagos',
  country: 'ng',
  capacity: 800,
  phone: '+234 801 234 5678',
  website: 'https://harbourlights.example.com',
  about: 'A waterfront hall with a stage and a terrace.',
  role: 'owner',
  message: 'I own the venue; email me at the address on our website.',
  ...extra,
});

test('find: GET /venues?q= finds visible venues to claim, never hidden ones', async () => {
  const shown = await prisma.venue.create({ data: { slug: `vo-find-${run}`, name: `Findable Arena ${run}`, address: '3 Broad St', city: 'Accra', country: 'GH' } });
  await prisma.venue.create({ data: { slug: `vo-hidden-${run}`, name: `Findable Secret ${run}`, address: '4 Broad St', city: 'Accra', country: 'GH', hiddenAt: new Date() } });
  const mgr = await account(`vo-find-mgr-${run}@test.local`, 'Fay Finder');
  await prisma.venueClaim.create({ data: { venueId: shown.id, userId: mgr.user.id as string, role: 'manager', message: 'I run this venue every day.', status: 'APPROVED' } });

  const found = await ok(call('GET', `/venues?q=${encodeURIComponent(run)}&country=GH`));
  const mine = found.filter((v: Json) => v.name.startsWith('Findable'));
  assert.deepEqual(mine.map((v: Json) => v.slug), [shown.slug], 'hidden venues never come back');
  assert.equal(mine[0].managed, true);
  assert.equal(mine[0].country, 'GH');
  assert.equal((await ok(call('GET', `/venues?q=${encodeURIComponent(`Findable Arena ${run}`)}&country=NG`))).length, 0, 'country filter');
  assert.deepEqual(await ok(call('GET', '/venues?q=a')), [], 'too short');
  // Without q, the full directory as before.
  const all = await ok(call('GET', '/venues'));
  assert.ok(all.some((v: Json) => v.slug === shown.slug));
  assert.ok(!all.some((v: Json) => v.slug === `vo-hidden-${run}`));
});

test('add a venue: hidden with a pending claim, checked for duplicates, shown on approval', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const owner = await account(`vo-owner-${run}@test.local`, 'Ola Owner');

  // Signed in only, and validated.
  assert.equal((await call('POST', '/me/venues', newVenue())).status, 401);
  const bad = async (body: Json, re: RegExp) => {
    const r = await call('POST', '/me/venues', newVenue(body), owner.token);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(r.body.message), re);
  };
  await bad({ city: '' }, /Give the city/);
  await bad({ country: 'Nigeria' }, /Pick the country/);
  await bad({ role: 'fan' }, /owner, a manager or staff/);
  await bad({ message: 'Hi' }, /at least 10 characters/);
  await bad({ website: 'harbour.example.com' }, /https/);
  await bad({ phone: 'call me' }, /phone number/);
  await bad({ capacity: 0 }, /at least 1/);
  await bad({ surprise: true }, /surprise/);

  // Added: hidden (no page, not in the directory, not bookable), with the place's zone and a pending claim.
  const added = await ok(call('POST', '/me/venues', newVenue(), owner.token));
  assert.equal(added.status, 'PENDING');
  assert.equal(added.newVenue, true);
  const v = await prisma.venue.findUniqueOrThrow({ where: { id: added.venue.id } });
  assert.ok(v.hiddenAt, 'hidden until approved');
  assert.equal(v.timezone, 'Africa/Lagos');
  assert.equal(v.country, 'NG');
  assert.equal(v.capacity, 800);
  assert.equal((await call('GET', `/venues/${v.slug}`)).status, 404);
  assert.ok(!(await ok(call('GET', '/venues'))).some((x: Json) => x.slug === v.slug));
  assert.equal((await call('GET', `/venues/${v.slug}/availability`)).status, 404);
  const claim = await prisma.venueClaim.findUniqueOrThrow({ where: { id: added.id } });
  assert.deepEqual([claim.status, claim.newVenue, claim.role], ['PENDING', true, 'owner']);
  // Not a manager yet: can't edit or list it for hire.
  assert.equal((await call('PATCH', `/me/venues/${v.id}`, { about: 'Changed' }, owner.token)).status, 403);
  assert.equal((await call('PUT', `/me/venues/${v.id}/listing`, { active: true, priceMode: 'QUOTE' }, owner.token)).status, 403);

  // They see it waiting.
  const mine = await ok(call('GET', '/me/venues', undefined, owner.token));
  assert.equal(mine.managed.length, 0);
  const req = mine.requests.find((r: Json) => r.id === added.id);
  assert.deepEqual([req.status, req.newVenue, req.venue.hidden, req.venue.address], ['PENDING', true, true, '14 Ozumba Mbadiwe Ave']);
  // Asking again for the same place is refused while it waits.
  const again = await call('POST', '/me/venues', newVenue({ name: `harbour lights ${run}` }), owner.token);
  assert.equal(again.status, 400);
  assert.match(again.body.message, /already asked to add/);

  // The admin sees what they're approving: a new venue, its address and the owner's message.
  const queue = await ok(call('GET', '/admin/venue-claims?status=PENDING', undefined, admin.token));
  const item = queue.items.find((c: Json) => c.id === added.id);
  assert.equal(item.newVenue, true);
  assert.equal(item.venue.address, '14 Ozumba Mbadiwe Ave');
  assert.equal(item.venue.about, 'A waterfront hall with a stage and a terrace.');
  assert.ok(item.venue.hiddenAt);
  assert.match(item.message, /I own the venue/);
  const listed = await ok(call('GET', `/admin/venues?q=${encodeURIComponent(`Harbour Lights ${run}`)}&status=hidden`, undefined, admin.token));
  assert.equal(listed.items[0].awaitingApproval, true);

  // Approved: the venue goes public and they manage it; they hear by email and push.
  const decided = await ok(call('POST', `/admin/venue-claims/${added.id}/decide`, { decision: 'APPROVE' }, admin.token));
  assert.equal(decided.venueShown, true);
  assert.equal((await prisma.venue.findUniqueOrThrow({ where: { id: v.id } })).hiddenAt, null);
  assert.equal((await ok(call('GET', `/venues/${v.slug}`))).managed, true);
  const after = await ok(call('GET', '/me/venues', undefined, owner.token));
  assert.equal(after.managed[0].venue.id, v.id);
  assert.ok(!after.requests.some((r: Json) => r.id === added.id));
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_claim.approved', to: `vo-owner-${run}@test.local` } }));
  const push = await waitFor(() => prisma.notificationLog.findFirst({ where: { kind: 'venue_claim.approved', userId: owner.user.id as string } }));
  assert.equal((push.data as Json).path, '/venues/manage');
  // Now they can list it for hire.
  await ok(call('PUT', `/me/venues/${v.id}/listing`, { active: true, priceMode: 'QUOTE' }, owner.token));

  // The same name in the same city and country (any case) is on Omoshow now: claim it instead.
  const other = await account(`vo-other-${run}@test.local`, 'Ike Other');
  const dup = await call('POST', '/me/venues', newVenue({ name: `  HARBOUR   lights ${run} `, city: 'lagos', country: 'NG' }), other.token);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'VENUE_EXISTS');
  assert.deepEqual([dup.body.venue.slug, dup.body.venue.name], [v.slug, `Harbour Lights ${run}`]);
  // …but the same name in another city is a different place.
  const abuja = await ok(call('POST', '/me/venues', newVenue({ city: 'Abuja', region: 'Federal Capital Territory' }), other.token));
  assert.equal(abuja.status, 'PENDING');
});

test('declined: the new venue stays hidden; venues hidden by Omoshow stay hidden when a claim is approved', async () => {
  const admin = await account('admin@test.local', 'Admin');
  const owner = await account(`vo-decline-${run}@test.local`, 'Dee Decline');
  const added = await ok(call('POST', '/me/venues', newVenue({ name: `Maybe Hall ${run}`, city: 'Ibadan', region: 'Oyo' }), owner.token));
  await ok(call('POST', `/admin/venue-claims/${added.id}/decide`, { decision: 'REJECT', note: 'We couldn’t find this venue online. Send us a link to its page.' }, admin.token));
  assert.ok((await prisma.venue.findUniqueOrThrow({ where: { id: added.venue.id } })).hiddenAt, 'still hidden');
  const mine = await ok(call('GET', '/me/venues', undefined, owner.token));
  const req = mine.requests.find((r: Json) => r.id === added.id);
  assert.equal(req.status, 'REJECTED');
  assert.match(req.note, /couldn’t find this venue/);
  await waitFor(() => prisma.emailLog.findFirst({ where: { kind: 'venue_claim.rejected', to: `vo-decline-${run}@test.local` } }));
  const push = await waitFor(() => prisma.notificationLog.findFirst({ where: { kind: 'venue_claim.rejected', userId: owner.user.id as string } }));
  assert.equal((push.data as Json).path, '/venues/list');
  // A hidden venue that was declined doesn't count as a duplicate: they can try again with better details.
  const retry = await ok(call('POST', '/me/venues', newVenue({ name: `Maybe Hall ${run}`, city: 'Ibadan', region: 'Oyo', message: 'Here is our page: https://maybehall.example.com' }), owner.token));
  assert.notEqual(retry.venue.id, added.venue.id);

  // Hidden by Omoshow (spam, closed, a duplicate): approving an ordinary claim on it doesn't bring it back.
  const closed = await prisma.venue.create({ data: { slug: `vo-spam-${run}`, name: `Closed Club ${run}`, address: '1 Old Rd', city: 'Lagos', country: 'NG', hiddenAt: new Date() } });
  const c = await prisma.venueClaim.create({ data: { venueId: closed.id, userId: owner.user.id as string, role: 'manager', message: 'I used to run this club.', status: 'PENDING' } });
  const out = await ok(call('POST', `/admin/venue-claims/${c.id}/decide`, { decision: 'APPROVE' }, admin.token));
  assert.equal(out.venueShown, false);
  assert.ok((await prisma.venue.findUniqueOrThrow({ where: { id: closed.id } })).hiddenAt, 'left hidden');
  // Claiming a hidden page through the claim flow isn't possible at all.
  assert.equal((await call('POST', `/venues/${closed.slug}/claims`, { role: 'owner', message: 'Please let me manage it.' }, owner.token)).status, 404);
});

test('add a venue: one person can have at most five waiting', async () => {
  const busy = await account(`vo-busy-${run}@test.local`, 'Bea Busy');
  for (let i = 1; i <= 5; i++) await ok(call('POST', '/me/venues', newVenue({ name: `Spot ${i} ${run}`, city: 'Kano', region: 'Kano' }), busy.token));
  const sixth = await call('POST', '/me/venues', newVenue({ name: `Spot 6 ${run}`, city: 'Kano', region: 'Kano' }), busy.token);
  assert.equal(sixth.status, 400);
  assert.match(sixth.body.message, /several venues waiting/);
  assert.equal(await prisma.venueClaim.count({ where: { userId: busy.user.id as string, newVenue: true } }), 5);
});
