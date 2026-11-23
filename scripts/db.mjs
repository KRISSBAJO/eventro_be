// Starts a local Postgres for development (no Docker, no system install).
// Data lives in ./.data/pg and survives restarts. Stop with Ctrl+C.
//
// Use any other Postgres by setting DATABASE_URL in .env instead.

import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.EVENTRO_DB_PORT || 55432);
const dir = resolve('.data/pg');

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'eventro',
  password: 'eventro-local-dev',
  port: PORT,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
});

const fresh = !existsSync(resolve(dir, 'PG_VERSION'));
if (fresh) {
  console.log('Creating a new local database cluster in .data/pg …');
  await pg.initialise();
}
await pg.start();

if (fresh) {
  await pg.createDatabase('eventro');
  await pg.createDatabase('eventro_test');
}

console.log(`Postgres ready on 127.0.0.1:${PORT}`);
console.log(`DATABASE_URL=postgresql://eventro:eventro-local-dev@127.0.0.1:${PORT}/eventro`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping Postgres …');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Keep the process alive while Postgres runs.
setInterval(() => {}, 1 << 30);
