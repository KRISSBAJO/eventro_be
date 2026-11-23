/** Drops & presales sign-up: subscribe, preferences link, unsubscribe and coming back. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';

let app: INestApplication;
let base = '';
const run = Date.now().toString(36);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

before(async () => {
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
});

test('signing up returns a private preferences link once', async () => {
  const email = `Fan.${run}@Example.com `;
  const first = await call('POST', '/newsletter', { email, interests: ['Concerts'], city: 'lagos' });
  assert.equal(first.status, 200);
  assert.equal(first.body.subscribed, true);
  assert.equal(first.body.already, false);
  assert.ok(typeof first.body.token === 'string' && first.body.token.length >= 30);

  // Same address again (any casing): no token, so nobody can take over someone else's link.
  const again = await call('POST', '/newsletter', { email: email.trim().toUpperCase() });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(again.body.token, undefined);

  const prefs = await call('GET', `/newsletter/${first.body.token}`);
  assert.equal(prefs.status, 200);
  assert.ok(prefs.body.email.startsWith('f') && prefs.body.email.endsWith('@example.com') && !prefs.body.email.includes(run));
  assert.deepEqual(prefs.body.interests, ['Concerts']);
  assert.equal(prefs.body.city, 'lagos');
  assert.equal(prefs.body.subscribed, true);
});

test('preferences can be changed and cleared', async () => {
  const { body } = await call('POST', '/newsletter', { email: `prefs.${run}@example.com`, source: 'newsletter' });
  const up = await call('PATCH', `/newsletter/${body.token}`, { interests: ['Sports', 'Comedy', 'Sports'], city: 'london' });
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.interests, ['Sports', 'Comedy']);
  assert.equal(up.body.city, 'london');

  const cleared = await call('PATCH', `/newsletter/${body.token}`, { interests: [], city: '' });
  assert.deepEqual(cleared.body.interests, []);
  assert.equal(cleared.body.city, null);
});

test('unsubscribing, then signing up again with a fresh link', async () => {
  const email = `leave.${run}@example.com`;
  const { body } = await call('POST', '/newsletter', { email });
  const out = await call('DELETE', `/newsletter/${body.token}`);
  assert.equal(out.status, 200);
  assert.equal(out.body.subscribed, false);
  // unsubscribing twice is fine
  assert.equal((await call('DELETE', `/newsletter/${body.token}`)).body.subscribed, false);

  const back = await call('POST', '/newsletter', { email });
  assert.equal(back.body.already, false);
  assert.ok(back.body.token && back.body.token !== body.token);
  assert.equal((await call('GET', `/newsletter/${body.token}`)).status, 404, 'the old link stops working');
  assert.equal((await call('GET', `/newsletter/${back.body.token}`)).body.subscribed, true);
});

test('bad input is rejected', async () => {
  assert.equal((await call('POST', '/newsletter', { email: 'not-an-email' })).status, 400);
  assert.equal((await call('POST', '/newsletter', { email: `x.${run}@example.com`, interests: ['Opera'] })).status, 400);
  assert.equal((await call('POST', '/newsletter', { email: `y.${run}@example.com`, city: 'New York' })).status, 400);
  assert.equal((await call('GET', '/newsletter/nope')).status, 404);
  assert.equal((await call('PATCH', '/newsletter/nope', { city: 'lagos' })).status, 404);
});
