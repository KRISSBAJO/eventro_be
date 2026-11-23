// Runs the test suite against the separate `eventro_test` database.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const url =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL || '').replace(/\/eventro(\?|$)/, '/eventro_test$1');
if (!url.includes('eventro_test')) {
  console.error('Refusing to run tests: set TEST_DATABASE_URL to a database whose name contains "eventro_test".');
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: url,
  ADMIN_EMAIL: 'admin@test.local',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
};
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env, shell: true });

run('npx tsc -p tsconfig.build.json');
run('npx prisma migrate deploy');
run('node --test --test-concurrency=1 "dist/test/*.test.js"');
