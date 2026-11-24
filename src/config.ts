import { existsSync } from 'node:fs';

// Load .env once (Node 22 built-in). Real environment variables win.
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* ignore malformed .env; validation below reports what's missing */
  }
}

function required(name: string, minLength = 1) {
  const v = process.env[name];
  if (!v || v.length < minLength) throw new Error(`Missing or too short environment variable ${name} (see .env.example)`);
  return v;
}

const int = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:3500,http://localhost:3500')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: required('JWT_SECRET', 32),
  qrSecret: required('TICKET_QR_SECRET', 32),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  /** Paystack secret key (sk_test_… or sk_live_…) for NGN, GHS, KES and ZAR. Without it those use the mock provider. */
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  /** Paystack API base; only changed by tests, which run a local stand-in. */
  paystackUrl: (process.env.PAYSTACK_API_URL || 'https://api.paystack.co').replace(/\/$/, ''),
  /** The website's address, for payment return links. */
  webUrl: (process.env.WEB_URL || 'http://127.0.0.1:3500').replace(/\/$/, ''),
  /** Optional ipinfo.io token for visitor location by IP when the host doesn't add a country header. */
  ipinfoToken: process.env.IPINFO_TOKEN || '',
  organizerFeePermille: int('ORGANIZER_FEE_PERMILLE', 35),
  resaleFeePermille: int('RESALE_FEE_PERMILLE', 50),
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  holdMinutes: int('HOLD_MINUTES', 10),
  /** mediaEX hosts event photos and videos. Without a key, uploads are switched off. */
  mediaexUrl: (process.env.MEDIAEX_URL || 'http://localhost:3400').replace(/\/$/, ''),
  mediaexApiKey: process.env.MEDIAEX_API_KEY || '',
  /** Resend (resend.com) sends Eventro's email. Without a key, emails are logged as SKIPPED instead of sent. */
  resendApiKey: process.env.RESEND_API_KEY || '',
  /** Resend API base; only changed by tests, which run a local stand-in. */
  resendUrl: (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/$/, ''),
  mailFrom: process.env.MAIL_FROM || 'Eventro <onboarding@resend.dev>',
  isProduction: process.env.NODE_ENV === 'production',
};

export type Config = typeof config;
