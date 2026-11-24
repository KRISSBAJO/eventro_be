# Deploying Eventro

Eventro is three pieces:

| Piece | Repo | Runs as | Needs |
|---|---|---|---|
| API | `eventro_be` (this repo) | Docker image (`Dockerfile`), port 4000 | Postgres 15+, secrets below |
| Website | `eventro` | Docker image (`Dockerfile`, Next.js standalone), port 3000 — or Vercel | `NEXT_PUBLIC_API_URL` at build time |
| Database | — | Managed Postgres (Neon, Supabase, Railway, Render, RDS…) | Daily backups |

Any host that runs a Docker image works (Render, Railway, Fly.io, a VPS with Docker, or Hoist once it's live). A common split:
website on Vercel, API + Postgres on Render or Railway.

Suggested domains: `eventro.example` → website, `api.eventro.example` → API.

## 1. Database

Create a Postgres database and copy its connection string into `DATABASE_URL` (use the provider's SSL string,
e.g. `?sslmode=require`). The API applies migrations itself on every start (`prisma migrate deploy`), so a new
release brings the schema up to date before it serves traffic.

Turn on daily backups (point-in-time recovery if the provider offers it). Test a restore once before launch.

## 2. API

Build and run:

```
docker build -t eventro-api .
docker run -p 4000:4000 --env-file .env.production eventro-api
```

Environment (see `.env.example` for every option):

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (set in the image). Test payments are refused and the mock payout bank list is off. |
| `DATABASE_URL` | from step 1 |
| `JWT_SECRET`, `TICKET_QR_SECRET` | two **different** random strings, 48+ characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Never reuse the development ones. |
| `WEB_URL` | `https://eventro.example` (links in emails, payment return pages) |
| `CORS_ORIGINS` | `https://eventro.example` (add `https://www.eventro.example` if used) |
| `ADMIN_EMAIL` | the email that becomes the first admin when it signs up |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from Stripe (live keys `sk_live_…`, `whsec_…`) |
| `PAYSTACK_SECRET_KEY` | from Paystack (`sk_live_…`) |
| `RESEND_API_KEY`, `MAIL_FROM` | from Resend; the `MAIL_FROM` domain must be verified in Resend (SPF + DKIM DNS records) |
| `MEDIAEX_URL`, `MEDIAEX_API_KEY` | mediaEX for photos and videos |
| `PORT`, `HOST` | set by the image (`4000`, `0.0.0.0`); most hosts override `PORT` themselves |

Without `STRIPE_SECRET_KEY` the API logs an error and card currencies (USD, GBP, EUR…) can't be sold; without
`PAYSTACK_SECRET_KEY` the same goes for NGN, GHS, KES and ZAR. Nothing falls back to free test payments in production.

Health check: `GET /api/v1/health` (the image's `HEALTHCHECK` uses it). API docs: `/docs`.

Run one instance to start with. Rate limits, the gift/price-drop timers and the bank-list cache live in memory, so if
you scale to several instances later, move them to Redis first.

## 3. Website

```
docker build -t eventro-web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.eventro.example/api/v1 \
  --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_... .
docker run -p 3000:3000 eventro-web
```

`NEXT_PUBLIC_*` values are compiled into the site, so changing them means rebuilding. On Vercel, set the same
variables in the project settings and deploy the repo as is.

## 4. Payment webhooks

| Provider | Webhook URL | Events |
|---|---|---|
| Stripe | `https://api.eventro.example/api/v1/webhooks/stripe` | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` |
| Paystack | `https://api.eventro.example/api/v1/webhooks/paystack` | `charge.success` (set it under Settings → API Keys & Webhooks) |

Copy Stripe's signing secret into `STRIPE_WEBHOOK_SECRET`. Paystack signs with your secret key, so nothing else is needed.
The website also confirms each payment directly with the provider, so a late webhook never leaves a fan waiting.

Stripe: turn on Apple Pay / Google Pay in the Dashboard (Settings → Payment methods) and register the website's
domain for Apple Pay. Stripe Connect (organizer payouts outside Africa) must be enabled on the account.

## 5. Before launch — checklist

- [ ] Production secrets are new (not copied from a development `.env`), stored in the host's secret settings, never committed.
- [ ] `WEB_URL`, `CORS_ORIGINS` and `NEXT_PUBLIC_API_URL` all use the real `https://` domains.
- [ ] Stripe and Paystack in **live** mode; a real low-value purchase in each currency succeeds and shows up in My tickets.
- [ ] Refund that purchase from the admin console; the money goes back.
- [ ] Webhooks show "succeeded" deliveries in the Stripe and Paystack dashboards.
- [ ] Resend domain verified; sign-up, receipt, gift and password-reset emails arrive (check spam).
- [ ] Sign up with `ADMIN_EMAIL`, confirm the admin console opens; create a second admin so you're never locked out.
- [ ] A Nigerian organizer connects a real bank account (name check shows the right name) and receives a split payout.
- [ ] Database backups on; one restore tested.
- [ ] Uptime monitor on `/api/v1/health` and the home page.
- [ ] Error alerts: watch the API logs for `ERROR` lines (payment mismatches and refund failures are logged there).
