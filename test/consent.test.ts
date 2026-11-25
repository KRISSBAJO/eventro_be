/** Cookie consent records: append-only history, validation, signed-in visitors, the admin lookup and the rate limit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

let app: INestApplication;
let base = '';
let prisma: PrismaClient;
const run = Date.now().toString(36);
const PASSWORD = 'test-password-123';
const V = '2026-11-25';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json, headers: res.headers };
}
const account = async (email: string, name: string) => {
  const s = await call('POST', '/auth/signup', { email, name, password: PASSWORD });
  if (s.status < 300) return s.body as { token: string; user: Json };
  const l = await call('POST', '/auth/login', { email, password: PASSWORD });
  assert.equal(l.status, 200);
  return l.body as { token: string; user: Json };
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

test('every choice appends a row; nothing is overwritten', async () => {
  const consentId = randomUUID();
  const ua = `Mozilla/5.0 ${'x'.repeat(300)}`;
  const first = await call('POST', '/consent', { consentId, policyVersion: V, analytics: true, marketing: true, method: 'banner' }, undefined, { 'user-agent': ua });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true });
  assert.equal((await call('POST', '/consent', { consentId, policyVersion: V, analytics: false, marketing: false, method: 'settings' })).status, 200);

  const rows = await prisma.consentRecord.findMany({ where: { consentId }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.analytics, r.marketing, r.method]), [[true, true, 'banner'], [false, false, 'settings']]);
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].gpc, false);
  assert.equal(rows[0].userAgent?.length, 200, 'user agent is truncated');
  assert.equal(rows[0].policyVersion, V);
  // no IP address is kept anywhere on the row
  assert.ok(!Object.keys(rows[0]).some((k) => /ip/i.test(k)));
});

test('Global Privacy Control always stores marketing off', async () => {
  const consentId = randomUUID();
  assert.equal((await call('POST', '/consent', { consentId, policyVersion: V, analytics: true, marketing: true, gpc: true, method: 'gpc' })).status, 200);
  const row = await prisma.consentRecord.findFirstOrThrow({ where: { consentId } });
  assert.equal(row.gpc, true);
  assert.equal(row.marketing, false);
  assert.equal(row.analytics, true);
});

test('bad input is rejected', async () => {
  const good = { consentId: randomUUID(), policyVersion: V, analytics: false, marketing: false, method: 'banner' };
  assert.equal((await call('POST', '/consent', { ...good, consentId: 'not-a-uuid' })).status, 400);
  assert.equal((await call('POST', '/consent', { ...good, policyVersion: 'latest' })).status, 400);
  assert.equal((await call('POST', '/consent', { ...good, analytics: 'yes' })).status, 400);
  assert.equal((await call('POST', '/consent', { ...good, method: 'popup' })).status, 400);
  assert.equal((await call('POST', '/consent', { ...good, ip: '1.2.3.4' })).status, 400, 'unknown fields are refused');
  const { marketing: _m, ...missing } = good;
  assert.equal((await call('POST', '/consent', missing)).status, 400);
  assert.equal(await prisma.consentRecord.count({ where: { consentId: good.consentId } }), 0);
});

test('a signed-in visitor gets their account attached; admins can look up the history, others get 403', async () => {
  const fan = await account(`consent.fan.${run}@example.com`, 'Consent Fan');
  const admin = await account('admin@test.local', 'Admin');
  const consentId = randomUUID();
  assert.equal((await call('POST', '/consent', { consentId, policyVersion: V, analytics: true, marketing: false, method: 'banner' }, fan.token)).status, 200);
  assert.equal((await call('POST', '/consent', { consentId, policyVersion: V, analytics: false, marketing: false, method: 'settings' }, fan.token)).status, 200);

  const byId = await call('GET', `/admin/consents?consentId=${consentId.toUpperCase()}`, undefined, admin.token);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.items.length, 2);
  assert.equal(byId.body.items[0].method, 'settings', 'newest first');
  assert.equal(byId.body.items[0].userId, fan.user.id);

  const byUser = await call('GET', `/admin/consents?userId=${fan.user.id}`, undefined, admin.token);
  assert.deepEqual(byUser.body.items.map((r: Json) => r.consentId), [consentId, consentId]);

  // the admin user page shows the latest choice
  const page = await call('GET', `/admin/users/${fan.user.id}`, undefined, admin.token);
  assert.equal(page.status, 200);
  assert.equal(page.body.consent.consentId, consentId);
  assert.equal(page.body.consent.analytics, false);
  assert.equal(page.body.consent.method, 'settings');

  assert.equal((await call('GET', '/admin/consents', undefined, admin.token)).status, 400, 'an ID is required');
  assert.equal((await call('GET', `/admin/consents?consentId=${consentId}`, undefined, fan.token)).status, 403);
  assert.equal((await call('GET', `/admin/consents?consentId=${consentId}`)).status, 401);
});

test('recording is rate limited per IP', async () => {
  const { rateLimiter } = await import('../src/common/rate-limit');
  const saved = process.env.RATE_CONSENT_PER_IP;
  try {
    rateLimiter.reset();
    process.env.RATE_CONSENT_PER_IP = '2';
    const body = () => ({ consentId: randomUUID(), policyVersion: V, analytics: false, marketing: false, method: 'banner' });
    assert.equal((await call('POST', '/consent', body())).status, 200);
    assert.equal((await call('POST', '/consent', body())).status, 200);
    const limited = await call('POST', '/consent', body());
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    process.env.RATE_CONSENT_PER_IP = saved;
    rateLimiter.reset();
  }
});
