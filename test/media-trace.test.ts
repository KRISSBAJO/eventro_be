import assert from 'node:assert/strict';
import test from 'node:test';
import { Logger } from '@nestjs/common';
import type { AuthUser } from '../src/common/auth';
import type { PrismaService } from '../src/prisma.service';

test('upload trace joins the new asset to MediaEX and distinguishes a refused connection', async t => {
  process.env.MEDIAEX_URL = 'https://media.example.test';
  process.env.MEDIAEX_API_KEY = 'private-fixture-key';
  const { MediaService } = await import('../src/media/media.module');
  const logs: Record<string, unknown>[] = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    t.mock.method(Logger.prototype, level, (entry: Record<string, unknown>) => logs.push(entry));
  }
  const id = 'ast_fixture123';
  const trace = '5b545428-697a-460d-9189-07970ae12340';
  const service = new MediaService({ mediaUpload: { create: async () => ({}) } } as unknown as PrismaService);
  const dto = { fileName: 'private-fixture.jpg', size: 4, mimeType: 'image/jpeg' };
  const upload = () => service.startUpload({ id: 'organizer' } as AuthUser, dto);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    asset: { id }, upload: { kind: 'single', url: 'https://bucket.test/private-signature' },
  }, { headers: { 'x-mediaex-request-id': trace } }));
  await upload();
  assert.deepEqual([logs[0].stage, logs[0].assetId, logs[0].mediaexRequestId, logs[0].status], ['create', id, trace, 200]);
  fetch.mock.mockImplementation(async () => new Response('private-response-body', {
    status: 502, headers: { 'x-mediaex-request-id': 'private-invalid-header' },
  }));
  await assert.rejects(upload(), /unexpected reply/);
  assert.equal(logs[1].invalidJson, true);
  assert.equal(logs[1].status, 502);
  fetch.mock.mockImplementation(async () => { throw new Error('private-error-detail', { cause: { code: 'ECONNREFUSED' } }); });
  await assert.rejects(upload(), /reachable/);
  assert.equal(logs[2].networkCode, 'ECONNREFUSED');
  assert.equal(logs[2].status, null);
  assert.doesNotMatch(JSON.stringify(logs), /private-/);
});
