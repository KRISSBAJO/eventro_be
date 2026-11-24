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
  // Tests never touch the real media service; media.test.ts runs its own stand-in.
  MEDIAEX_API_KEY: '',
  MEDIAEX_URL: 'http://127.0.0.1:9',
  // Same for payments and IP lookups; paystack.test.ts runs its own Paystack stand-in.
  PAYSTACK_SECRET_KEY: '',
  PAYSTACK_API_URL: 'http://127.0.0.1:9',
  IPINFO_TOKEN: '',
  // Email: never sent from tests (logged as SKIPPED); mail tests run their own Resend stand-in.
  RESEND_API_KEY: '',
  // Every test request comes from 127.0.0.1, so the anti-spam limit would trip across runs.
  SIGNUPS_PER_IP_PER_HOUR: '100000',
  // Same for the other rate limits (src/common/rate-limit.ts); launch.test.ts tightens one on purpose.
  RATE_LOGIN_PER_IP_EMAIL: '100000',
  RATE_LOGIN_PER_IP: '100000',
  RATE_FORGOT_PER_IP: '100000',
  RATE_PASSWORD_PER_IP: '100000',
  RATE_CHECKOUT_PER_IP: '100000',
  RATE_RESALE_HOLD_PER_IP: '100000',
  RESEND_API_URL: 'http://127.0.0.1:9',
  FX_OFFLINE: '1',
};
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env, shell: true });

run('npx tsc -p tsconfig.build.json');
run('npx prisma migrate deploy');
run('node --test --test-concurrency=1 "dist/test/*.test.js"');
