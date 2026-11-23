# Eventro API

Backend for [Eventro](https://github.com/KRISSBAJO/eventro): events, venue seat maps, checkout with seat holds, tickets with rotating QR codes, organizer tools and admin review.

**Stack:** NestJS 11 · Prisma 6 · PostgreSQL · Stripe (optional; a mock provider is used when no key is set).

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

## Tests

```bash
npm test
```

Runs against a separate `eventro_test` database (created by `db:start`; override with `TEST_DATABASE_URL`). It refuses to run against any database whose name doesn't contain `eventro_test`.

- **Unit:** fees, quotes, QR tokens, seat-map validation, seat assignment, fraud scoring.
- **End to end over HTTP:** the organizer creates an event and a seat map, gets reviewed and approved; a fan buys with a promo code and gets seats 104-A1/A2; the next group gets A3/A4; QR check-in (valid, duplicate, invalid, tampered); transfer and accept; resale cap; refund that voids the tickets and returns the seats to sale; stats and audit log.
- **Concurrency:** 12 simultaneous holds on 5 seats, so exactly 5 succeed.

## Payments

- **No `STRIPE_SECRET_KEY`:** the *mock* provider is used. `POST /orders` returns `provider: "mock"`, and `POST /orders/:id/pay` completes the payment.
- **With Stripe (test mode):** `POST /orders` returns a PaymentIntent `clientSecret` for Stripe.js. Stripe calls `POST /api/v1/webhooks/stripe` (signature-checked with `STRIPE_WEBHOOK_SECRET`), and the order is fulfilled there. Locally:
  `stripe listen --forward-to 127.0.0.1:4000/api/v1/webhooks/stripe`
- **Organizer payouts:** use Stripe Connect. `POST /organizer/orgs/:orgId/payouts/onboarding` returns a Stripe-hosted link where organizers enter their bank details. Eventro never sees or stores account numbers.

Fulfilment can safely run more than once. If a hold expired during payment and the seats were sold in the meantime, the order is cancelled and refunded automatically.

## How inventory works

- **Holds:** creating a hold locks the ticket type row (`SELECT … FOR UPDATE`). Seats left = capacity − sold − unexpired holds, so seats can't be oversold. Holds last `HOLD_MINUTES` (default 10).
- **Seats:** assigned at payment, best available. The group sits together in the front-most row with room, otherwise in the first free seats. A database unique key on (event, section, row, seat) means a seat can't be sold twice.
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
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` |
| Browse | `GET /events?q&category&city&from&to&maxPrice&sort&page`, `GET /events/:slug`, `GET /venues`, `GET /venues/:slug` |
| Checkout | `POST /holds`, `DELETE /holds/:id`, `POST /orders`, `GET /orders/:id`, `POST /orders/:id/pay` (mock), `POST /orders/:id/refund-requests`, `POST /webhooks/stripe` |
| Tickets | `GET /me/tickets`, `GET /tickets/:id/qr`, `POST/DELETE /tickets/:id/transfer`, `POST /tickets/:id/accept`, `POST/DELETE /tickets/:id/listing` |
| Organizer | `POST/GET /organizer/orgs`, `PATCH /organizer/orgs/:orgId`, team `GET/POST /organizer/orgs/:orgId/team`, `PATCH/DELETE …/team/:memberId`, `POST /organizer/invites/accept`, payouts `GET /organizer/orgs/:orgId/payouts`, `PUT …/payout-settings`, `POST …/payouts/onboarding` |
| Organizer events | `POST/GET /organizer/orgs/:orgId/events`, `GET/PATCH /organizer/events/:id`, ticket types `POST/PATCH/DELETE …/ticket-types/:ttId`, `POST …/submit`, `POST …/pause`, `POST …/resume`, `PUT …/seat-map`, `POST …/seat-map/template`, `GET …/stats?days=30`, `GET …/attendees`, `GET …/attendees.csv`, `POST …/check-in`, `DELETE …/check-in/:ticketId`, promos `GET/POST …/promos`, `PATCH/DELETE …/promos/:code` |
| Admin | `GET /admin/reviews`, `POST /admin/events/:id/approve`, `POST /admin/events/:id/reject`, `GET /admin/refunds`, `POST /admin/refunds/:id/decide`, `GET /admin/fraud`, `POST /admin/fraud/:id/decide`, `GET /admin/audit` |

Team roles: **ADMIN** (everything, including payouts and team), **MANAGER** (events, attendees, promos), **DOOR** (check-in only).

## Not done yet

- **The website still uses its browser-only demo data.** Connecting the pages to this API is the next step.
- **Email** (receipts, transfer invites, password reset).
- **Rate limiting** on auth and checkout. Put it behind a gateway, or add `@nestjs/throttler`.
- **Resale purchases:** listing works, but buying a listed ticket doesn't yet.
- **Cancelling a whole event** with bulk refunds.
