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

- **Mobile (`test/mobile.test.ts`):** refresh-token rotation and reuse detection, device lists and sign-out, sessions
  ended by password changes and suspension; push devices, choices and every trigger against a stand-in Expo push
  service (dead phones disabled, dedupe); QR seeds matching the server, a transfer refusing the old holder's codes;
  door packs and offline check-in sync.
- **Saved events and order history (`test/saved.test.ts`):** saving by id or slug, idempotent puts and deletes,
  newest first in the GET /events card shape, merging a signed-out device's hearts, nothing hidden, unpublished,
  cancelled or past coming back; `GET /me/orders` and refund requests on the order; holds on exact seats the fan picked.
- **Client additions (`test/gaps.test.ts`):** trending sort and `soldRecent`, price filters in the visitor's currency,
  Paystack's return URL for app buyers (orders and resale orders), who scanned a ticket first, `event.currency` in My
  tickets, section names in My resale, and the door scanner's event list.
- **Changing the venue (`test/venue.test.ts`):** the new zone with the same wall-clock times, venues found again,
  the organizer's own zone, refusals (online, cancelled, ended, door staff, seats already sold on the map), and one
  email and one push per holder per change (refunded tickets left out; drafts tell nobody).

Tests never call real services: Stripe, Paystack, mediaEX, Expo push, IP lookups and exchange rates are switched off or replaced
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

## Saved events and order history

- **Saved events** (the hearts): `GET /me/saved` returns `{ ids, slugs, items }`, the signed-in fan's saved events as
  event cards (the same shape as `GET /events` items), newest saved first. `PUT /me/saved/:eventId` and
  `DELETE /me/saved/:eventId` (the event's id or slug) are idempotent. `POST /me/saved/sync { eventIds }` (ids or
  slugs, at most 200) merges hearts made while signed out and answers like `GET`. Only published, public events can be
  saved or are listed: drafts, events in review, taken down, cancelled, unlisted and past events never come back
  (their rows stay, so an event published again shows again). Up to 500 saves per account.
- **Order history:** `GET /me/orders` lists the fan's orders (bought on their account or with their email), newest
  first, without abandoned checkouts, each with the event, ticket type, totals and the latest refund request.
  `GET /orders/:id` now includes `refundRequests` (status `OPEN`, `APPROVED`, `PARTIAL` or `DENIED`).
  Fans ask for a refund with `POST /orders/:id/refund-requests { reason }` (10–1000 characters, paid orders only,
  one open request at a time).

## Picking exact seats

`POST /holds` takes optional `seats: [{ row, seat }]` with a reserved `sectionId`, one per ticket (`quantity`). The
hold reserves exactly those seats (they must exist in the section and be free; otherwise 400, or 409 naming the seats
just taken). Without `seats` the API picks the best seats side by side, as before. `GET /events/:slug/sections/:id/seats`
lists the seats already sold or held (`"ROW:SEAT"`).

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

### Changing an event's venue

`PUT /organizer/events/:id/venue` (org admins and managers; door staff get 403) moves an in-person event to `{ venueId }`
(a venue on Eventro) or `{ venue: { name, address, city, country?, region?, postalCode?, lat?, lng? } }` (a new place,
found again or created with the same rules as creating an event). Optional `timezone` only when the organizer picked the
zone themselves.

- **Times keep their wall-clock value** ("8:00 PM" stays 8:00 PM) and the event takes the new venue's zone: its map
  position, else its state or province, else its country. The answer has `zone: { from, to, changed, fromName, toName }`
  and, when it changed, `notice: "Times stay 8:00 PM, now in Central time."` for the screens to show.
- **Refused** (400) for cancelled, started or ended events and online events (switching between online and in person
  isn't supported). Seat maps are per event and drawn for the old building, so an event with seats or sections already
  sold, or held at checkout, is refused with 409 `code: "SEATED_SALES"`. A seat map with nothing sold is kept, and the
  answer's `seatMapNote` says to check it in the designer.
- **Ticket holders are told** on published events only: one email per holder address (kind `event.venue`: the new
  venue, its address, a map link, the unchanged date and time) and one push (see the table below). Drafts and events
  in review tell nobody (`notified.reason`). Every move is in the audit log (`event.venue`, from and to, both zones);
  its id is the answer's `changeId`.

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

## Mobile app

Everything the Expo app needs is additive: the website keeps working unchanged.

### Long-lived sign-ins

- `POST /auth/login`, `POST /auth/signup` and `POST /auth/reset` take an optional `device: { name?, platform? }`. With it,
  the answer is the usual `{ token, user }` plus `refreshToken`, `refreshTokenExpiresAt`, `accessTokenExpiresAt` and
  `sessionId`. The access token lasts **1 hour** (website tokens stay at 7 days). The refresh token looks like
  `<sessionId>.<43 base64url chars>` (32 random bytes); only its SHA-256 hash is stored. It lasts 60 days from its last use.
- `POST /auth/refresh { refreshToken }` returns a new access token **and a new refresh token**; the old one stops working.
  If an old refresh token is ever presented again, the whole session is revoked (someone copied it). Send one refresh at a
  time per device. Refusals are 401 with `code`: `REFRESH_INVALID`, `REFRESH_EXPIRED`, `REFRESH_REVOKED`,
  `REFRESH_REUSED`, `ACCOUNT_SUSPENDED`. Limited to `RATE_REFRESH_PER_IP` (default 120) per 15 minutes.
- `POST /auth/logout { refreshToken, pushToken? }` signs this device out (and stops its notifications). Always `{ ok: true }`.
- `GET /me/sessions` lists signed-in devices (`deviceName`, `platform`, `ip`, `createdAt`, `lastUsedAt`, `expiresAt`,
  `current`); `DELETE /me/sessions/:id` signs one out. Access tokens carry the session id (`sid`), so a signed-out
  device's access token stops working at once.
- A password reset ends every session; a password change ends all but the device making it (`POST /auth/password` from
  the app answers with a fresh access token for the same session). An admin suspension ends them all.

### Push notifications

- `POST /me/push-devices { token, platform?, deviceName? }` registers an Expo push token (`ExponentPushToken[…]` or
  `ExpoPushToken[…]`); call it after every sign-in. A token moves to whoever registered it last.
  `DELETE /me/push-devices/:token` (URL-encoded) turns it off.
- `GET /me/notify-prefs`, `PATCH /me/notify-prefs` with any of `orders`, `tickets`, `priceDrops`, `reminders`, `marketing`,
  `sales` (booleans; all on except `marketing`; a key missing from saved choices means its default).
- Sent through Expo (`EXPO_PUSH_URL`, optional `EXPO_ACCESS_TOKEN`) 100 at a time, in the background. Every message is
  logged in `NotificationLog` (SENT, FAILED, or SKIPPED: no phones, or that kind switched off), shown at
  `GET /admin/notifications`. `DeviceNotRegistered` (from the send or from Expo's receipts, checked every 15 minutes)
  switches that phone off. A `dedupeKey` per message means nothing is sent twice.
- Every notification's `data` has `type`, `url` (`eventro://<path>`) and `path` (the website path), plus ids:

| Trigger | To | Choice | `data.path` | Dedupe key |
|---|---|---|---|---|
| Order paid ("You're going to …") | buyer | orders | `/tickets/<ticketId>` | `order.paid:<orderId>` |
| Transfer received | recipient | tickets | `/tickets` | `ticket.transfer:<ticketId>:<expiry ms>` |
| Transfer accepted | sender | tickets | `/tickets` | `ticket.accepted:<ticketId>:<qrVersion>` |
| Gift delivered | recipient | tickets | `/gift/<token>` | `gift.delivered:<giftId>` |
| Resale sold | seller | orders | `/tickets` | `resale.sold:<listingId>` |
| Price drop | watchers | priceDrops | `/events/<slug>` | `price_drop:<dropId>:<userId>` |
| Event cancelled | ticket holders | orders | `/tickets` | `event.cancelled:<eventId>:<userId>` |
| New venue ("Now at …") | ticket holders | orders | `/tickets` | `event.venue:<eventId>:<changeId>:<userId>` |
| "Tomorrow: …" (start 20–24 h away) | holders of ACTIVE tickets | reminders | `/tickets/<ticketId>` | `reminder.day:<eventId>:<userId>` |
| "Doors open soon" (hour before doors, or start) | holders of ACTIVE tickets | reminders | `/tickets/<ticketId>` | `reminder.doors:<eventId>:<userId>` |
| New sale ("New sale: …", quantity × type · total) | the org's active admins and managers (not door staff; resales left out) | sales | `/organizer/events/<eventId>` | `order.sale:<orderId>:<userId>` |

  Only people with an Eventro account get pushes. Reminders run every 5 minutes and use the venue's real time
  (event times are stored as wall-clock in the venue zone).

### Offline tickets (QR seeds)

Each ticket has a seed; the app can make the same rotating codes as `GET /tickets/:id/qr` without a connection.

- `GET /tickets/:id/qr-seed` (owner only, ACTIVE tickets only; `Cache-Control: no-store`) →
  `{ ticketId, seed, version, windowMs: 15000, algorithm: "HMAC-SHA256", format }`. `GET /me/tickets` also puts
  `qrSeed` and `qrVersion` on ACTIVE tickets. Keep seeds in secure storage.
- The code shown at time `t` (Unix milliseconds):

  ```
  window = floor(t / 15000)
  sig    = base64url(HMAC-SHA256(key = base64urlDecode(seed), message = ticketId + "." + window)), first 22 characters
  code   = ticketId + "." + window + "." + sig          e.g. EVT-AB12-CD34-01.115384210.Qm9fX3...
  ```

  base64url is RFC 4648 §5 without `=` padding. Refresh the QR every window (the door accepts one window either side).
- Server side, `seed = HMAC-SHA256(TICKET_QR_SECRET, "seed." + ticketId + "." + qrVersion)`. `qrVersion` goes up when a
  ticket changes hands (transfer accepted, gift claimed; a resale sale issues a new ticket), so the old holder's saved
  seed makes codes the door refuses. Fetch a fresh seed (or `GET /me/tickets`) when the app comes online.

### Door scanning offline

- `GET /organizer/events/:id/door-pack` (team members with DOOR role or higher) →
  `{ eventId, title, startsAt, doorsAt, timezone, generatedAt, windowMs, algorithm, format, tickets: [{ id, seed, version,
  status, checkedInAt, checkedInDevice, holderName, ticketType, section, sectionName, row, seat }] }` for every non-void
  ticket. It holds every seed: `Cache-Control: no-store`, rate-limited (`RATE_DOOR_PACK_PER_IP`, default 30 per 10
  minutes) and each download is in the audit log (`door_pack.download`, who, when, how many tickets). A scanner
  checks a code offline by recomputing it from the ticket's seed for the code's window, and admits only `ACTIVE`
  tickets (or `LISTED`, which the online check-in also admits by ID).
- `POST /organizer/events/:id/check-ins/sync { deviceId, scans: [{ ticketId, scannedAt, code? }] }` (up to 500) applies
  offline scans oldest first. Each answer has `index` (position in the request), `ticketId`, `scannedAt` and `result`:
  `checked_in` (stored with `checkedInAt = scannedAt` and `checkedInDevice`), `already` (with `checkedInAt`,
  `checkedInBy: { id, name }`, `checkedInDevice` of the first scan) or `invalid` with `reason` (`unknown`,
  `wrong-event`, `void`, `transfer-pending`, `bad-code`: the code doesn't match the ticket's current seed, or
  `expired-code`: more than 2 minutes from `scannedAt`). Sending a batch again gives the same answers (`replay: true`).
  `summary` counts each result. `POST …/check-in` takes an optional `deviceId` too.
- Online, `POST …/check-in` answers a repeat scan with `result: "duplicate"` plus the first scan's `checkedInAt`,
  `checkedInBy: { id, name } | null` and `checkedInDevice` (null when it was scanned without a `deviceId`, e.g. on
  the website), so a scanner can say "Already scanned at 7:42 PM by Sam (other device)".
- `GET /organizer/orgs/:orgId/door-events` (DOOR role or higher) is the light list for a scanner's event picker: every
  event that isn't a draft, from 2 days ago to 60 days ahead, soonest first, as `{ id, slug, title, startsAt, doorsAt,
  timezone, venue: { name, city } | null, online, status, ticketsIssued, checkedIn }`. `ticketsIssued` counts non-void
  tickets, the same ones the door pack holds, so "N of M checked in" means the same online and offline.

### Paying with Paystack from the app

`POST /orders` and `POST /resale/:id/orders` take an optional `returnTo: "app"`. Paystack then sends the fan to
`${WEB_URL}/checkout/return?order=<id>&app=1` instead of the plain return page. The website verifies the payment as
usual and, once it's paid, opens `eventro://tickets` (and shows an "Open the Eventro app" button, with the web
confirmation underneath in case the app doesn't open). The app opens Paystack in an auth session that waits for
`eventro://`, so the browser closes itself, and it still calls `POST /orders/:id/verify` afterwards.

### Discover and search

- `GET /events?sort=popular` ranks by paid tickets sold in the last 14 days (PAID and PARTIALLY_REFUNDED orders, by
  `paidAt`), ties soonest first. Every card carries that count as `soldRecent`; the app's Discover rail says
  "Trending" only when something has sold lately.
- `GET /events?currency=NGN&maxPrice=25000`: with `currency` (any event currency), each card's `fromCents` is
  converted into it with the exchange rates (`GET /fx/rates`, approximate) before comparing with `maxPrice` (whole
  units of that currency), and cards get `fromCentsIn: { currency, cents }` for an "≈ $16" hint. Without `currency`,
  `maxPrice` is compared in each event's own currency, as before.
- `GET /me/tickets` has `event.currency`; `GET /me/resale` has `ticket.sectionName` ("Lower Level 104", from the
  event's seat map, like My tickets).

## API overview

All routes are under `/api/v1`. Send `Authorization: Bearer <token>` from `/auth/login` or `/auth/signup`. Interactive docs are at `/docs`.

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login` (both take an optional `device`), `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/forgot`, `POST /auth/reset/check`, `POST /auth/reset`, `POST /auth/password`, `GET /auth/me`, `PATCH /auth/me` (name) |
| Devices & push | `GET /me/sessions`, `DELETE /me/sessions/:id`, `POST /me/push-devices`, `DELETE /me/push-devices/:token`, `GET/PATCH /me/notify-prefs` |
| Browse | `GET /events?q&category&city&country&near&radiusKm&from&to&maxPrice&currency&sort&page` (`sort`: `date`, `price-asc`, `price-desc`, `distance`, `popular`; cards carry `soldRecent`, plus `fromCentsIn` with `currency`), `GET /events/:slug`, `GET /events/:slug/availability?qty`, `GET /events/:slug/sections/:id/seats`, `GET /venues`, `GET /venues/:slug` |
| Checkout | `POST /holds`, `GET /holds/:id`, `DELETE /holds/:id`, `POST /quote`, `POST /orders` (optional `returnTo: "app"`), `GET /orders/:id`, `POST /orders/:id/pay` (mock), `POST /orders/:id/verify` (Paystack), `POST /orders/:id/refund-requests`, `POST /webhooks/stripe`, `POST /webhooks/paystack` |
| Places & money | `GET /geo/countries`, `GET /geo/countries/:code/regions`, `GET /geo/search?q&country`, `GET /geo/timezone?lat&lng`, `GET /geo/me`, `GET /geo/currencies`, `GET /fx/rates` |
| Newsletter | `POST /newsletter` (sign up; returns a private preferences token only when it creates or reopens the subscription), `GET/PATCH/DELETE /newsletter/:token` (preferences and unsubscribe). Limited to `SIGNUPS_PER_IP_PER_HOUR` (default 20) sign-ups per IP per hour. |
| Tickets | `GET /me/tickets` (`event.currency`), `GET /tickets/:id/qr`, `GET /tickets/:id/qr-seed`, `POST/DELETE /tickets/:id/transfer`, `POST /tickets/:id/accept`, `POST/DELETE /tickets/:id/listing` |
| Media | `GET /media/config`, `POST /media/uploads`, `PUT /media/uploads/:id`, `POST /media/uploads/:id/complete`, `GET /media/uploads/:id`, `PUT /organizer/events/:id/media` |
| Organizer | `POST/GET /organizer/orgs`, `PATCH /organizer/orgs/:orgId`, `GET …/orders/recent`, team `GET/POST /organizer/orgs/:orgId/team`, `PATCH/DELETE …/team/:memberId`, `POST /organizer/invites/accept`, payouts `GET /organizer/orgs/:orgId/payouts`, `PUT …/payout-settings`, `POST …/payouts/onboarding` |
| Organizer events | `POST/GET /organizer/orgs/:orgId/events`, `GET /organizer/orgs/:orgId/door-events`, `GET/PATCH /organizer/events/:id`, `PUT …/venue` (move to another venue), ticket types `POST/PATCH/DELETE …/ticket-types/:ttId`, `POST …/submit`, `POST …/pause`, `POST …/resume`, `PUT …/seat-map`, `POST …/seat-map/template`, `GET …/stats?days=30`, `GET …/attendees`, `GET …/attendees.csv`, `POST …/check-in` (duplicates say who scanned first), `DELETE …/check-in/:ticketId`, `GET …/door-pack`, `POST …/check-ins/sync`, promos `GET/POST …/promos`, `PATCH/DELETE …/promos/:code` |
| Resale | `GET /events/:slug/resale`, `POST /resale/:id/hold`, `POST /resale/:id/orders` (optional `returnTo: "app"`), `GET /me/resale` (`ticket.sectionName`) |
| Gifts | `GET /gifts/:token`, `POST /gifts/:token/claim`, `POST /gifts/:id/resend` |
| Price drops | `POST /events/:slug/price-watch`, `GET /events/:slug/price-drop`, `DELETE /price-watch/:token`, `GET /organizer/events/:id/price-drops` |
| Admin console | `GET /admin/overview`, `GET/PATCH /admin/users[/:id]`, `GET/PATCH /admin/orgs[/:id]`, `GET /admin/events`, `POST /admin/events/:id/takedown`, `…/publish`, `…/sales`, `GET /admin/orders`, `POST /admin/orders/:id/refund`, `GET /admin/subscribers`, `GET /admin/subscribers.csv`, `GET /admin/broadcast/audience`, `POST /admin/broadcast`, `GET /admin/price-drops`, `GET /admin/emails`, `GET /admin/notifications?kind&status&q`, `GET /admin/resale?status&q`, `GET /admin/resale/payouts?status`, `POST /admin/resale/:id/delist`, `POST /admin/resale/:id/payout` |
| Admin | `GET /admin/reviews`, `POST /admin/events/:id/approve`, `POST /admin/events/:id/reject`, `GET /admin/refunds`, `POST /admin/refunds/:id/decide`, `GET /admin/fraud`, `POST /admin/fraud/:id/decide`, `GET /admin/audit` |

Team roles: **ADMIN** (everything, including payouts and team), **MANAGER** (events, attendees, promos), **DOOR** (check-in only).

## Not done yet

- **Card payments in the browser:** with Stripe keys set, `POST /orders` returns a PaymentIntent, but the website doesn't load Stripe's card form yet, so it only completes test-mode (mock) payments today.
- **More email:** password reset isn't sent yet (receipts, gifts, transfers, resale sales, newsletter, price drops and broadcasts are).
- **Rate limiting** on auth and checkout. Put it behind a gateway, or add `@nestjs/throttler`.
- **Paying out resale sellers:** the payout queue records PAID, but money isn't moved automatically yet (Stripe Connect transfers to fans).
- **Cancelling a whole event** with bulk refunds.
