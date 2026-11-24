# Eventro API

Backend for [Eventro](https://github.com/KRISSBAJO/eventro): events, venue seat maps, checkout with seat holds, tickets with rotating QR codes, organizer tools and admin review.

**Stack:** NestJS 11 · Prisma 6 · PostgreSQL · Stripe and Paystack (both optional; a mock provider is used when no key is set).

## Run it locally

```bash
npm install
cp .env.example .env        # then fill JWT_SECRET and TICKET_QR_SECRET (see the file)
npm run db:start            # local Postgres on :55432 (keep this terminal open)
npx prisma migrate deploy   # in a second terminal
npm run build && npm run db:seed
npm run dev                 # API on http://127.0.0.1:4000/api/v1, docs at http://127.0.0.1:4000/docs
```

`npm run db:start` runs a real Postgres from the `embedded-postgres` package. No Docker or system install is needed, and data is kept in `.data/pg`. To use another Postgres, set `DATABASE_URL` in `.env` and skip that step.

**Demo accounts** (password `eventro-demo-123`, set `SEED_PASSWORD` to change):

| Email | Role |
|---|---|
| organizer@eventro.test | Organizer of all demo events |
| admin@eventro.test (or `ADMIN_EMAIL`) | Admin |
| fan@eventro.test | Fan |

Promo code `EVENTRO10` (10% off) works on every demo event.

**Demo data** (`prisma/seed.ts`) loads the website's 16 events from `prisma/catalog.json`: same slugs, prices,
ticket types and seat maps, plus about 59,000 past tickets spread over the last 75 days so seat maps, dashboards and
attendee lists look real. Regenerate the catalog from the website repo with
`node scripts/export-catalog.mjs ../eventro-be/prisma/catalog.json`, then `npx prisma migrate reset --force` to reload.

## Tests

```bash
npm test
```

Runs against a separate `eventro_test` database (created by `db:start`; override with `TEST_DATABASE_URL`). It refuses to run against any database whose name doesn't contain `eventro_test`.

- **Unit:** fees, quotes, QR tokens, seat-map validation, seat assignment, fraud scoring.
- **End to end over HTTP:** holds reserve exact seats that match the availability preview; quotes with promo codes; the organizer creates an event and a seat map, gets reviewed and approved; a fan buys with a promo code and gets seats 104-A1/A2; the next group gets A3/A4; QR check-in (valid, duplicate, invalid, tampered); transfer and accept; resale listing rules, buying a resale ticket and the payout queue; transfer rules and expiry; refund that voids the tickets and returns the seats to sale; stats and audit log.
- **Concurrency:** 12 simultaneous holds on 5 seats, so exactly 5 succeed.
- **Worldwide:** a naira event paid through a stand-in Paystack (underpayments refused, webhook signatures checked,
  tickets issued once); venue time zones from the map position; online events keep the organizer's zone and give
  buyers the stream link; unknown zones and currencies are refused; exchange rates and visitor country.

Tests never call real services: Stripe, Paystack, mediaEX, IP lookups and exchange rates are switched off or replaced
by local stand-ins.

## Payments

Each event has a **currency** (`USD`, `EUR`, `GBP`, `CAD`, `AUD`, `NGN`, `GHS`, `KES`, `ZAR`). Prices, orders, refunds and
payouts are in that currency's minor units (kobo for NGN). Fans are always charged in the event's currency.

- **NGN, GHS, KES, ZAR go through Paystack** (`PAYSTACK_SECRET_KEY`, a `sk_test_…` key for testing). `POST /orders`
  returns `provider: "paystack"` and a `redirectUrl` to Paystack's payment page. Paystack sends the fan back to
  `${WEB_URL}/checkout/return?order=…`, and the website calls `POST /orders/:id/verify`. The API checks the amount
  and currency with Paystack before issuing tickets. Paystack's `charge.success` webhook (`POST /api/v1/webhooks/paystack`,
  HMAC-SHA512 signature) does the same, so whichever arrives first fulfils the order. Set the webhook URL in the
  Paystack dashboard.
- **Other currencies go through Stripe.**
- **No `STRIPE_SECRET_KEY`:** the *mock* provider is used. `POST /orders` returns `provider: "mock"`, and `POST /orders/:id/pay` completes the payment.
- **With Stripe (test mode):** `POST /orders` returns a PaymentIntent `clientSecret` for Stripe.js. Stripe calls `POST /api/v1/webhooks/stripe` (signature-checked with `STRIPE_WEBHOOK_SECRET`), and the order is fulfilled there. Locally:
  `stripe listen --forward-to 127.0.0.1:4000/api/v1/webhooks/stripe`
- **Organizer payouts:** use Stripe Connect. `POST /organizer/orgs/:orgId/payouts/onboarding` returns a Stripe-hosted link where organizers enter their bank details. Eventro never sees or stores account numbers.

Fulfilment can safely run more than once. If a hold expired during payment and the seats were sold in the meantime, the order is cancelled and refunded automatically.

## Places, time zones and exchange rates

- **Countries and regions:** `GET /geo/countries` (flag, calling code, default currency) and
  `GET /geo/countries/:code/regions` (states and provinces), from the `country-state-city` package. No network calls.
- **Venue search:** `GET /geo/search?q=&country=` suggests venues and addresses with map positions, from
  OpenStreetMap through Photon (photon.komoot.io). Results are cached for a day. Show "© OpenStreetMap contributors"
  wherever they're displayed (the website does).
- **Time zones:** event times are the venue's wall-clock time, stored with the venue's IANA zone (`Africa/Lagos`).
  The zone comes from the venue's map position (`GET /geo/timezone?lat&lng`), else its country. Online events use the
  zone the organizer picks. Unknown zones are refused.
- **Visitor location:** `GET /geo/me` reads the country from the host's header (`cf-ipcountry`,
  `x-vercel-ip-country` and similar). Without one, it looks up the IP with ipinfo.io when `IPINFO_TOKEN` is set.
  Otherwise it answers "unknown" and the website guesses from the browser's time zone and language. It's used only
  for defaults (currency, country), never to block anyone.
- **Exchange rates:** `GET /fx/rates` (USD base) from ExchangeRate-API's open endpoint, refreshed every 6 hours,
  with built-in fallback rates. They're for display only ("₦25,000 ≈ $16"). Set `FX_OFFLINE=1` to never call out.

## Email, price drops and the admin console

- **Email:** Resend sends receipts (once per paid order), the newsletter welcome, price-drop alerts and admin
  broadcasts. Set `RESEND_API_KEY` and `MAIL_FROM` (a sender on a domain verified in Resend). Every attempt is logged
  (`EmailLog`: SENT, FAILED or SKIPPED) and shown in the admin console; without a key emails are SKIPPED, never sent.
  Newsletter and alert emails carry a `List-Unsubscribe` link. Tests run their own Resend stand-in.
- **Price drops:** when an organizer lowers a ticket price on a published event, the drop is recorded and emailed to
  fans watching the event (`POST /events/:slug/price-watch`) and to newsletter subscribers whose categories and city
  match, one email per address. Cuts under 5%, repeat cuts within 12 hours and events that already started are
  recorded but not emailed. `GET /events/:slug/price-drop` drives the "Price dropped" badge; organizers see the
  audience first at `GET /organizer/events/:id/price-drops`.
- **Admin console** (`ADMIN` role): overview with GMV in USD, users (roles, suspend), organizers (verify, suspend:
  pauses their sales and blocks resuming or submitting), all events (take down, publish, pause sales), orders
  (search, refund), subscribers (CSV export, broadcasts with a test send), price drops, the email log and the audit
  log. Suspended accounts can't sign in and their tokens stop working at once.

## Gifted tickets

`POST /orders` takes an optional `gift: { name, email, message?, sendAt?, hidePrice? }`. A gift's tickets are created
held (`TRANSFER_PENDING`), so nobody can use them yet. At `sendAt` (or right after payment) the recipient gets an
email with a private link to `/gift/:token`; `GET /gifts/:token` shows the gift (no details before delivery) and
`POST /gifts/:token/claim` moves the tickets into the signed-in account. The buyer's receipt says it's a gift; they
can resend or deliver early with `POST /gifts/:id/resend`, or take tickets back by cancelling the transfer. Scheduled
gifts go out within a minute of their time.

## Resale and transfers

Organizers set the rules per event with `PATCH /organizer/events/:id`: `resaleEnabled` (default on),
`resaleCapPercent` (highest resale price as a % of face value; default 150, `null` for no cap),
`resaleRoyaltyPermille` (the organizer's cut of each resale, 0–200 = 0–20%), `transfersEnabled` (default on) and
`transferCutoffMinutes` (no transfers or new listings this close to the start; default 60).

- **Listing:** `POST /tickets/:id/listing { priceCents }` checks the rules and returns the breakdown: the cap,
  Eventro's 5% seller fee, the organizer royalty and what the seller receives. `DELETE` takes it down (not while a
  buyer is holding it). A listed ticket has no QR code.
- **Buying:** `GET /events/:slug/resale` lists active listings. `POST /resale/:id/hold` holds one for 10 minutes and
  returns a `holdKey`; `POST /resale/:id/orders { holdKey, email, name }` creates the order, which is paid like any
  other. On payment the seller's ticket is voided and the buyer gets a new ticket (new code) for the same seat, and
  the seller is emailed.
- **Payouts:** the seller's payout is held (`PENDING`) until 24 hours after the event starts, then `AVAILABLE`.
  `GET /me/resale` shows a seller's listings, sales and payouts. Admins work the queue with
  `POST /admin/resale/:id/payout { action: PAY | HOLD | RELEASE, note? }` and can take a listing down with
  `POST /admin/resale/:id/delist { reason }`. Refunding a resale order puts its payout on hold.
- **Transfers:** `POST /tickets/:id/transfer { email }` emails the recipient a link to accept. Unaccepted transfers
  expire after 7 days or at the cutoff, whichever is first, and the ticket goes back to the sender. Every transfer is
  in the audit log.

## Venues

Organizers pick a venue in the create-event wizard: `GET /geo/search?q&country` suggests places from OpenStreetMap
(biased towards the chosen country, and retried as "name, country" when a short name only matches places abroad), or
they type the address themselves. The venue record is created with the event; picking the same place again (same name
in the same city, or within about 150 m with a shared word in the name) reuses the existing venue instead of adding a copy.

## Online events

Events created with `online: true` have no venue; `streamUrl` is the private link. `GET /me/tickets` includes it
only on tickets the holder still has (not ones listed for resale or being transferred). The website shows a
"Watch the stream" button on those tickets instead of the door QR code.

## Photos and videos (mediaEX)

Event media is hosted on mediaEX. Set `MEDIAEX_URL` and `MEDIAEX_API_KEY` (a key with `upload` or `full` scope, from
Developers in mediaEX). The key never leaves this server:

1. `POST /media/uploads` `{ fileName, size, mimeType }` asks mediaEX for an upload slot and records who uploaded it.
2. The browser sends the file either straight to a presigned bucket URL, or to `PUT /media/uploads/:id` here, which
   streams it to mediaEX with the key (when mediaEX stores files on its own disk).
3. `POST /media/uploads/:id/complete`, then `GET /media/uploads/:id` until `status` is `ready` (videos are encoded to HLS).
4. `PUT /organizer/events/:id/media` `{ items: [{ id, kind, alt? }] }` sets the event's photos and videos in order.
   Only files uploaded by the organization's members are accepted. The first item is the cover: a photo, or a video
   (cards show a frame from it, and the event page plays it silently behind the title; ready videos keep their HLS
   `playbackUrl` for that).

Limits: 12 photos (25 MB each) and 3 videos (2 GB each) per event. `GET /media/config` tells the website whether
uploads are on. Public event responses include `media` with ready-to-use URLs (resized images, video posters and the
mediaEX player). Without a key, uploads are off and events use stock covers.

If mediaEX answers with something other than its JSON (usually `MEDIAEX_URL` pointing at the wrong host, e.g. the
mediaEX website instead of its API), uploads fail with a readable 503 and the API logs the status and the first part of
the reply.

## How inventory works

- **Holds:** creating a hold locks the ticket type row (`SELECT … FOR UPDATE`). Seats left = capacity − sold − unexpired holds, so seats can't be oversold. Holds last `HOLD_MINUTES` (default 10).
- **Seats:** on a seat map, the hold itself reserves exact seats (side by side, front-most row with room), and nobody else can get them while it lasts. Payment turns those seats into tickets. If a hold expired before payment, seats are picked again. A database unique key on (event, section, row, seat) means a seat can't be sold twice.
- **Previews:** `GET /events/:slug/availability?qty=2` returns, per section, what's left and the exact seats a hold would get right now; `GET /events/:slug/sections/:id/seats` lists sold and held seats for drawing a section.
- **Refunds:** a full refund voids the tickets and returns their seats to sale.

## Seat maps (venue designer format)

`PUT /organizer/events/:id/seat-map` with `{ "seatMap": { … } }`. Coordinates are in canvas units (the frontend scales the canvas to fit).

```jsonc
{
  "version": 1,
  "width": 1200,
  "height": 760,
  "stage": { "x": 450, "y": 60, "w": 300, "h": 80, "label": "STAGE" },
  "sections": [
    // Curved reserved section: rows × seats, linked to a ticket type
    { "id": "104", "label": "104", "ticketTypeId": "<lower bowl id>", "shape": "arc", "seating": "reserved",
      "rows": 12, "seatsPerRow": 20, "geometry": { "cx": 600, "cy": 170, "r0": 290, "r1": 410, "a0": 62.8, "a1": 89.2 } },
    // Rectangular standing area with a capacity
    { "id": "FL", "label": "Floor", "ticketTypeId": "<floor id>", "shape": "rect", "seating": "ga",
      "capacity": 1200, "geometry": { "x": 420, "y": 180, "w": 360, "h": 200, "rotation": 0 } }
  ]
}
```

- `shape`: `arc` (cx, cy, inner radius r0, outer radius r1, angles a0→a1 in degrees, 0° = right, clockwise) or `rect` (x, y, w, h, optional rotation).
- `seating`: `reserved` (rows 1–200 × seatsPerRow 1–200; rows are labelled A, B, … Z, AA) or `ga` (capacity).
- `level` (optional, per section): shown to fans as "Lower Level 104".
- `stage.kind` (optional): `stage`, `rink`, `court` or `field`. The website draws the markings.
- `areas` (optional, up to 100): places that can't be bought, `{ id, label, kind: lounge | bar | entrance | other, geometry: rect }`.
- Saving a map **sets each linked ticket type's capacity** to the total of its sections. It's refused if that would be fewer than already sold, or if it removes a section that has sold seats.
- `POST /organizer/events/:id/seat-map/template` with `{ "template": "arena", "floor", "lower", "upper" }` (ticket type ids) creates a full arena: stage, floor, 6 lower and 8 upper sections.
- `GET /events/:slug` returns the map with an `available` count on every section, so the website can shade sections and show "12 left".
- `POST /holds` accepts an optional `sectionId` for fans who pick a section on the map.

## API overview

All routes are under `/api/v1`. Send `Authorization: Bearer <token>` from `/auth/login` or `/auth/signup`. Interactive docs are at `/docs`.

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `PATCH /auth/me` (name) |
| Browse | `GET /events?q&category&city&from&to&maxPrice&sort&page`, `GET /events/:slug`, `GET /events/:slug/availability?qty`, `GET /events/:slug/sections/:id/seats`, `GET /venues`, `GET /venues/:slug` |
| Checkout | `POST /holds`, `GET /holds/:id`, `DELETE /holds/:id`, `POST /quote`, `POST /orders`, `GET /orders/:id`, `POST /orders/:id/pay` (mock), `POST /orders/:id/verify` (Paystack), `POST /orders/:id/refund-requests`, `POST /webhooks/stripe`, `POST /webhooks/paystack` |
| Places & money | `GET /geo/countries`, `GET /geo/countries/:code/regions`, `GET /geo/search?q&country`, `GET /geo/timezone?lat&lng`, `GET /geo/me`, `GET /geo/currencies`, `GET /fx/rates` |
| Newsletter | `POST /newsletter` (sign up; returns a private preferences token only when it creates or reopens the subscription), `GET/PATCH/DELETE /newsletter/:token` (preferences and unsubscribe). Limited to `SIGNUPS_PER_IP_PER_HOUR` (default 20) sign-ups per IP per hour. |
| Tickets | `GET /me/tickets`, `GET /tickets/:id/qr`, `POST/DELETE /tickets/:id/transfer`, `POST /tickets/:id/accept`, `POST/DELETE /tickets/:id/listing` |
| Media | `GET /media/config`, `POST /media/uploads`, `PUT /media/uploads/:id`, `POST /media/uploads/:id/complete`, `GET /media/uploads/:id`, `PUT /organizer/events/:id/media` |
| Organizer | `POST/GET /organizer/orgs`, `PATCH /organizer/orgs/:orgId`, `GET …/orders/recent`, team `GET/POST /organizer/orgs/:orgId/team`, `PATCH/DELETE …/team/:memberId`, `POST /organizer/invites/accept`, payouts `GET /organizer/orgs/:orgId/payouts`, `PUT …/payout-settings`, `POST …/payouts/onboarding` |
| Organizer events | `POST/GET /organizer/orgs/:orgId/events`, `GET/PATCH /organizer/events/:id`, ticket types `POST/PATCH/DELETE …/ticket-types/:ttId`, `POST …/submit`, `POST …/pause`, `POST …/resume`, `PUT …/seat-map`, `POST …/seat-map/template`, `GET …/stats?days=30`, `GET …/attendees`, `GET …/attendees.csv`, `POST …/check-in`, `DELETE …/check-in/:ticketId`, promos `GET/POST …/promos`, `PATCH/DELETE …/promos/:code` |
| Resale | `GET /events/:slug/resale`, `POST /resale/:id/hold`, `POST /resale/:id/orders`, `GET /me/resale` |
| Gifts | `GET /gifts/:token`, `POST /gifts/:token/claim`, `POST /gifts/:id/resend` |
| Price drops | `POST /events/:slug/price-watch`, `GET /events/:slug/price-drop`, `DELETE /price-watch/:token`, `GET /organizer/events/:id/price-drops` |
| Admin console | `GET /admin/overview`, `GET/PATCH /admin/users[/:id]`, `GET/PATCH /admin/orgs[/:id]`, `GET /admin/events`, `POST /admin/events/:id/takedown`, `…/publish`, `…/sales`, `GET /admin/orders`, `POST /admin/orders/:id/refund`, `GET /admin/subscribers`, `GET /admin/subscribers.csv`, `GET /admin/broadcast/audience`, `POST /admin/broadcast`, `GET /admin/price-drops`, `GET /admin/emails`, `GET /admin/resale?status&q`, `GET /admin/resale/payouts?status`, `POST /admin/resale/:id/delist`, `POST /admin/resale/:id/payout` |
| Admin | `GET /admin/reviews`, `POST /admin/events/:id/approve`, `POST /admin/events/:id/reject`, `GET /admin/refunds`, `POST /admin/refunds/:id/decide`, `GET /admin/fraud`, `POST /admin/fraud/:id/decide`, `GET /admin/audit` |

Team roles: **ADMIN** (everything, including payouts and team), **MANAGER** (events, attendees, promos), **DOOR** (check-in only).

## Not done yet

- **Card payments in the browser:** with Stripe keys set, `POST /orders` returns a PaymentIntent, but the website doesn't load Stripe's card form yet, so it only completes test-mode (mock) payments today.
- **More email:** password reset isn't sent yet (receipts, gifts, transfers, resale sales, newsletter, price drops and broadcasts are).
- **Rate limiting** on auth and checkout. Put it behind a gateway, or add `@nestjs/throttler`.
- **Paying out resale sellers:** the payout queue records PAID, but money isn't moved automatically yet (Stripe Connect transfers to fans).
- **Cancelling a whole event** with bulk refunds.
