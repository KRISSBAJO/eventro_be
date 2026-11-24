/**
 * Event media through mediaEX, against a small stand-in mediaEX server (no real service is called).
 * Covers: the key stays server-side, the upload relay, processing status, and that events can only use
 * media their own team uploaded.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';

const KEY = `mx_live_${'t'.repeat(32)}`;
let mock: Server;
let setBroken: (b: boolean) => void = () => {};
let mockUrl = '';
const received = new Map<string, number>(); // asset id → bytes received
let seq = 0;

let app: INestApplication;
let base = '';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, token?: string, raw?: { data: Buffer; type: string }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(raw ? { 'content-type': raw.type } : body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}
const ok = async (p: ReturnType<typeof call>) => {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

before(async () => {
  // Stand-in for the mediaEX API: checks the key, accepts single uploads, reports assets as ready.
  let broken = false;
  setBroken = (b) => (broken = b);
  mock = createServer((req, res) => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/api/v1/uploads') {
      // A misconfigured host answers with an HTML page, not mediaEX's JSON.
      if (broken) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<!DOCTYPE html><html><body>404 page not found</body></html>');
      }
      const id = `ast_test${String(++seq).padStart(4, '0')}`;
      return send(201, { asset: { id }, upload: { kind: 'single', url: `${mockUrl}/api/v1/uploads/${id}`, method: 'PUT', headers: {} } });
    }
    let m = /^\/api\/v1\/uploads\/(ast_\w+)$/.exec(url);
    if (req.method === 'PUT' && m) {
      let n = 0;
      req.on('data', (c: Buffer) => (n += c.length));
      req.on('end', () => {
        received.set(m![1], n);
        send(200, { ok: true });
      });
      return;
    }
    m = /^\/api\/v1\/uploads\/(ast_\w+)\/complete$/.exec(url);
    if (req.method === 'POST' && m) return send(200, { asset: { id: m[1], status: 'queued' } });
    m = /^\/api\/v1\/assets\/(ast_\w+)$/.exec(url);
    if (req.method === 'GET' && m) {
      return send(200, { asset: { id: m[1], status: 'ready', progress: 100, error: null, width: 1600, height: 900, duration: 0, playbackUrl: `${mockUrl}/hls/${m[1]}/master.m3u8` } });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.MEDIAEX_URL = mockUrl;
  process.env.MEDIAEX_API_KEY = KEY;

  const { createApp } = await import('../src/main');
  const { PrismaService } = await import('../src/prisma.service');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
  const prisma = app.get(PrismaService);
  await prisma.mediaUpload.deleteMany({ where: { id: { startsWith: 'ast_test' } } });
});

after(async () => {
  await app?.close();
  mock?.close();
});

test('media: upload through Eventro, attach to an event, and only your team’s files', async () => {
  const stamp = Date.now();
  const signup = async (who: string) => (await ok(call('POST', '/auth/signup', { email: `${who}${stamp}@media.test`, name: `${who} Test`, password: 'test-password-123' }))).token as string;
  const org = await signup('owner');
  const stranger = await signup('stranger');

  assert.equal((await ok(call('GET', '/media/config'))).enabled, true);

  const o = await ok(call('POST', '/organizer/orgs', { name: 'Media Org' }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: 'Media Night', category: 'CONCERTS', startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), venue: { name: 'Hall', address: '1 Road', city: 'Lagos' }, ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 50 }] },
      org,
    ),
  );

  // Start an upload: the browser is told to send the file to Eventro (the mock stores files "on disk").
  const photo = Buffer.alloc(2048, 7);
  const s = await ok(call('POST', '/media/uploads', { fileName: 'stage.jpg', size: photo.length, mimeType: 'image/jpeg' }, org));
  assert.equal(s.kind, 'image');
  assert.equal(s.upload.through, 'eventro');
  assert.equal(JSON.stringify(s).includes(KEY), false);

  // Wrong size and someone else's upload are refused; the right file is relayed with the key.
  assert.equal((await call('PUT', `/media/uploads/${s.id}`, undefined, org, { data: Buffer.alloc(10), type: 'image/jpeg' })).status, 400);
  assert.equal((await call('PUT', `/media/uploads/${s.id}`, undefined, stranger, { data: photo, type: 'image/jpeg' })).status, 404);
  await ok(call('PUT', `/media/uploads/${s.id}`, undefined, org, { data: photo, type: 'image/jpeg' }));
  assert.equal(received.get(s.id), photo.length);
  const done = await ok(call('POST', `/media/uploads/${s.id}/complete`, undefined, org));
  assert.equal(done.status, 'ready');
  assert.match(done.url, new RegExp(`^${mockUrl}/api/media/${s.id}/transform`));

  // Photos over 25 MB and non-media files are refused before anything is uploaded.
  assert.equal((await call('POST', '/media/uploads', { fileName: 'big.jpg', size: 30 * 1024 * 1024, mimeType: 'image/jpeg' }, org)).status, 400);
  assert.equal((await call('POST', '/media/uploads', { fileName: 'notes.pdf', size: 100, mimeType: 'application/pdf' }, org)).status, 400);

  // A stranger's upload can't be attached to this event.
  const other = await ok(call('POST', '/media/uploads', { fileName: 'x.jpg', size: 10, mimeType: 'image/jpeg' }, stranger));
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/media`, { items: [{ id: other.id, kind: 'image' }] }, org)).status, 400);
  assert.equal((await call('PUT', `/organizer/events/${ev.id}/media`, { items: [{ id: s.id, kind: 'image' }] }, stranger)).status, 403);

  // The team's own photo is attached and becomes the cover; it shows on the public page once published.
  const set = await ok(call('PUT', `/organizer/events/${ev.id}/media`, { items: [{ id: s.id, kind: 'image', alt: 'The stage' }] }, org));
  assert.match(set.imageUrl, new RegExp(`/api/media/${s.id}/transform`));
  const detail = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org));
  assert.equal(detail.media[0].id, s.id);
  assert.equal(detail.media[0].alt, 'The stage');
  assert.equal(detail.imageUrl, set.imageUrl);
});

test('media: a video can be the cover, and a broken media host gives a clear error instead of a crash', async () => {
  const stamp = Date.now();
  const org = (await ok(call('POST', '/auth/signup', { email: `vid${stamp}@media.test`, name: 'Vid Test', password: 'test-password-123' }))).token as string;
  const o = await ok(call('POST', '/organizer/orgs', { name: 'Video Org' }, org));
  const ev = await ok(
    call(
      'POST',
      `/organizer/orgs/${o.id}/events`,
      { title: 'Video Night', category: 'CONCERTS', startsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), venue: { name: 'Hall', address: '1 Road', city: 'Lagos' }, ticketTypes: [{ name: 'GA', basePriceCents: 1000, capacity: 50 }] },
      org,
    ),
  );
  const upload = async (fileName: string, mimeType: string) => {
    const bytes = Buffer.alloc(4096, 3);
    const s = await ok(call('POST', '/media/uploads', { fileName, size: bytes.length, mimeType }, org));
    await ok(call('PUT', `/media/uploads/${s.id}`, undefined, org, { data: bytes, type: mimeType }));
    return ok(call('POST', `/media/uploads/${s.id}/complete`, undefined, org));
  };
  const clip = await upload('teaser.mp4', 'video/mp4');
  assert.match(clip.playbackUrl, /master\.m3u8$/, 'ready videos report their stream');
  const still = await upload('crowd.jpg', 'image/jpeg');

  // Video first: it's the cover. The card image is a frame from the video; the stream is kept for the event page.
  const set = await ok(call('PUT', `/organizer/events/${ev.id}/media`, { items: [{ id: clip.id, kind: 'video' }, { id: still.id, kind: 'image' }] }, org));
  assert.ok(set.imageUrl.includes(`/api/media/${clip.id}/transform?t=1&`), set.imageUrl);
  assert.equal(set.media[0].kind, 'video');
  assert.match(set.media[0].playbackUrl, /master\.m3u8$/);
  const detail = await ok(call('GET', `/organizer/events/${ev.id}`, undefined, org));
  assert.equal(detail.media[0].playbackUrl, set.media[0].playbackUrl);

  // Photo first again: the photo is the cover.
  const back = await ok(call('PUT', `/organizer/events/${ev.id}/media`, { items: [{ id: still.id, kind: 'image' }, { id: clip.id, kind: 'video' }] }, org));
  assert.ok(back.imageUrl.includes(`/api/media/${still.id}/transform?w=1200`), back.imageUrl);

  // MEDIAEX_URL pointing at the wrong host: a readable 503, not "Internal server error".
  setBroken(true);
  const r = await call('POST', '/media/uploads', { fileName: 'x.jpg', size: 10, mimeType: 'image/jpeg' }, org);
  setBroken(false);
  assert.equal(r.status, 503);
  assert.match(r.body.message, /media service/);
});
