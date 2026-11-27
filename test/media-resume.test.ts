import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import type { AuthUser } from '../src/common/auth';
import type { PrismaService } from '../src/prisma.service';

test('organizer resumes a relayed transfer and cannot read another organizer upload', async (t) => {
  process.env.MEDIAEX_URL = 'https://media.example.test';
  process.env.MEDIAEX_API_KEY = 'isolated-test-key';
  const { MediaService } = await import('../src/media/media.module');
  const id = 'ast_resume123';
  const root = process.env.MEDIAEX_URL + '/api/v1/uploads/' + id;
  const bytes = new Map<number, Buffer>();
  const records = new Map<string, { id: string; userId: string; kind: string }>();
  const owner = { id: 'organizer-a' } as AuthUser;
  const other = { id: 'organizer-b' } as AuthUser;
  const service = new MediaService({ mediaUpload: {
    create: async ({ data }: { data: { id: string; userId: string; kind: string } }) => records.set(data.id, data),
    findUnique: async ({ where }: { where: { id: string } }) => records.get(where.id),
  } } as unknown as PrismaService);
  let destination = 'relay';
  const upstream = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer isolated-test-key');
    if (input.endsWith('/uploads')) {
      const body = JSON.parse(String(init.body));
      return Response.json({ asset: { id }, upload: body.multipart
        ? { kind: 'multipart', partCount: 2, partSize: 4 }
        : { kind: 'single', url: root } });
    }
    if (input === root + '/parts' && init.method === 'POST') {
      const [number] = JSON.parse(String(init.body)).numbers;
      return Response.json({ parts: [{ number, size: number === 1 ? 4 : 2,
        url: destination === 'relay' ? root + '/parts/' + number : 'https://bucket.example.test/signed',
        headers: {} }] });
    }
    if (input === root + '/parts') return Response.json({ uploaded: [...bytes].map(([number, data]) => ({ number, size: data.length })) });
    if (init.method === 'PUT') {
      bytes.set(Number(input.split('/').pop()), Buffer.from(await new Response(init.body).arrayBuffer()));
      return Response.json({ received: true });
    }
    if (input.endsWith('/complete')) {
      assert.deepEqual(Buffer.concat([...bytes.values()]), Buffer.from('abcdef'));
      return Response.json({ asset: { id } });
    }
    if (input.endsWith('/assets/' + id)) return Response.json({ asset: { status: 'ready', duration: 1, progress: 100 } });
    throw Error('Unexpected upstream request');
  });
  const dto = { fileName: 'venue.mp4', size: 6, mimeType: 'video/mp4' };
  assert.equal((await service.startUpload(owner, dto)).upload.through, 'eventro');
  assert.equal((await service.startUpload(owner, { ...dto, multipart: true })).upload.through, 'multipart');
  const request = (data: string) => Object.assign(Readable.from([Buffer.from(data)]), { headers: { 'content-length': String(data.length) } }) as unknown as Request;
  await service.relayPart(id, owner, 1, request('abcd'));
  assert.deepEqual(await service.listParts(id, owner), { uploaded: [{ number: 1, size: 4 }] });
  const prior = upstream.mock.callCount();
  await assert.rejects(service.listParts(id, other), /Upload not found/);
  await assert.rejects(service.partTarget(id, other, 2), /Upload not found/);
  assert.equal(upstream.mock.callCount(), prior);
  await assert.rejects(service.relayPart(id, owner, 2, request('x')), /part size/);
  destination = 'bucket';
  assert.equal((await service.partTarget(id, owner, 2)).through, 'bucket');
  await assert.rejects(service.relayPart(id, owner, 2, request('ef')), /destination/);
  destination = 'relay';
  await service.relayPart(id, owner, 2, request('ef'));
  assert.equal((await service.complete(id, owner)).status, 'ready');
});
