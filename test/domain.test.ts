import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerPrice, organizerNet, quote } from '../src/domain/money';
import { QR_WINDOW_MS, qrToken, verifyQr } from '../src/domain/qr';
import { arenaTemplate, assignSeats, capacityByTicketType, rowLabel, validateSeatMap, type Section } from '../src/domain/seatmap';
import { scoreOrder } from '../src/domain/fraud';

test('fees: buyer price and organizer net round-trip', () => {
  assert.equal(buyerPrice(2500, 'BUYER', 35), 2588); // $25 -> $25.88 all-in
  assert.equal(organizerNet(2588, 'BUYER', 35), 2500);
  assert.equal(buyerPrice(2500, 'ORGANIZER', 35), 2500);
  assert.equal(organizerNet(2500, 'ORGANIZER', 35), 2412); // fee 87.5 rounds to 88
  assert.equal(organizerNet(0, 'BUYER', 35), 0);
});

test('quote: promo off tickets, protection on tickets', () => {
  const q = quote(8900, 2, 20, true);
  assert.deepEqual(q, { unitCents: 8900, quantity: 2, subtotalCents: 17800, discountCents: 3560, protectionCents: 1246, totalCents: 15486 });
});

test('qr: valid now, valid one window later, expired after, tamper-proof', () => {
  const secret = 'x'.repeat(40);
  const t0 = 1_700_000_000_000;
  const { token } = qrToken(secret, 'EVT-AAAA-BBBB-01', t0);
  assert.deepEqual(verifyQr(secret, token, t0), { ok: true, ticketId: 'EVT-AAAA-BBBB-01' });
  assert.equal(verifyQr(secret, token, t0 + QR_WINDOW_MS).ok, true);
  assert.deepEqual(verifyQr(secret, token, t0 + 3 * QR_WINDOW_MS), { ok: false, reason: 'expired' });
  const forged = token.replace('EVT-AAAA-BBBB-01', 'EVT-AAAA-BBBB-02');
  assert.deepEqual(verifyQr(secret, forged, t0), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(verifyQr('y'.repeat(40), token, t0), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(verifyQr(secret, 'nonsense', t0), { ok: false, reason: 'malformed' });
});

test('seat map: arena template validates and capacities add up', () => {
  const map = arenaTemplate({ floor: 'f', lower: 'l', upper: 'u' });
  const r = validateSeatMap(JSON.parse(JSON.stringify(map)), new Set(['f', 'l', 'u']));
  assert.equal(r.ok, true);
  const caps = capacityByTicketType(map);
  assert.equal(caps.get('f'), 1200);
  assert.equal(caps.get('l'), 6 * 12 * 20);
  assert.equal(caps.get('u'), 8 * 14 * 24);
});

test('seat map: rejects bad input with readable errors', () => {
  const r = validateSeatMap(
    {
      version: 1,
      width: 800,
      height: 600,
      sections: [
        { id: 'A', label: 'A', ticketTypeId: 'nope', shape: 'rect', seating: 'reserved', rows: 0, seatsPerRow: 10, geometry: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'A', label: '', ticketTypeId: 't', shape: 'arc', seating: 'ga', capacity: 50, geometry: { cx: 0, cy: 0, r0: 50, r1: 10, a0: 0, a1: 90 } },
      ],
    },
    new Set(['t']),
  );
  assert.equal(r.ok, false);
  const errors = (r as { errors: string[] }).errors.join('\n');
  assert.match(errors, /ticketTypeId must be one of/);
  assert.match(errors, /rows and seatsPerRow/);
  assert.match(errors, /duplicate id "A"/);
  assert.match(errors, /label is required/);
  assert.match(errors, /outer radius must be larger/);
  assert.equal(validateSeatMap(null, new Set()).ok, false);
});

test('seat map: keeps rink surface, lounges and levels; rejects bad ones', () => {
  const base = {
    version: 1,
    width: 1200,
    height: 760,
    stage: { x: 370, y: 270, w: 460, h: 220, label: 'RINK', kind: 'rink' },
    areas: [{ id: 'LX', label: 'Lexus Lounge', kind: 'lounge', geometry: { x: 10, y: 10, w: 100, h: 40 }, extra: 'dropped' }],
    sections: [{ id: '104', label: '104', level: 'Lower Level', ticketTypeId: 't', shape: 'rect', seating: 'reserved', rows: 4, seatsPerRow: 10, geometry: { x: 0, y: 0, w: 100, h: 50 } }],
  };
  const ok = validateSeatMap(base, new Set(['t']));
  assert.equal(ok.ok, true);
  const map = (ok as { map: { stage?: { kind?: string }; areas?: unknown[]; sections: { level?: string }[] } }).map;
  assert.equal(map.stage?.kind, 'rink');
  assert.deepEqual(map.areas, [{ id: 'LX', label: 'Lexus Lounge', kind: 'lounge', geometry: { x: 10, y: 10, w: 100, h: 40 } }]);
  assert.equal(map.sections[0].level, 'Lower Level');

  const bad = validateSeatMap({ ...base, stage: { ...base.stage, kind: 'pool' }, areas: [{ id: 'LX', label: '', kind: 'spa', geometry: { x: 0, y: 0, w: 0, h: 5 } }] }, new Set(['t']));
  assert.equal(bad.ok, false);
  const errors = (bad as { errors: string[] }).errors.join('\n');
  assert.match(errors, /stage: kind must be one of/);
  assert.match(errors, /area 1: label is required/);
  assert.match(errors, /area 1: kind must be one of/);
  assert.match(errors, /area 1: width and height must be positive/);
});

test('seats: rows are labelled A..Z then AA', () => {
  assert.equal(rowLabel(0), 'A');
  assert.equal(rowLabel(25), 'Z');
  assert.equal(rowLabel(26), 'AA');
  assert.equal(rowLabel(27), 'AB');
});

test('seats: best available keeps groups together, then falls back', () => {
  const s: Section = { id: 'S', label: 'S', ticketTypeId: 't', shape: 'rect', seating: 'reserved', rows: 2, seatsPerRow: 4, geometry: { x: 0, y: 0, w: 1, h: 1 } };
  assert.deepEqual(assignSeats(s, new Set(), 2), [{ row: 'A', seat: 1 }, { row: 'A', seat: 2 }]);
  // A2 taken: three together only fit in row B.
  assert.deepEqual(assignSeats(s, new Set(['A:2']), 3), [{ row: 'B', seat: 1 }, { row: 'B', seat: 2 }, { row: 'B', seat: 3 }]);
  // No 4 together anywhere: falls back to scattered seats.
  assert.deepEqual(assignSeats(s, new Set(['A:2', 'B:3']), 4), [{ row: 'A', seat: 1 }, { row: 'A', seat: 3 }, { row: 'A', seat: 4 }, { row: 'B', seat: 1 }]);
  assert.equal(assignSeats(s, new Set(['A:1', 'A:2', 'A:3', 'A:4', 'B:1', 'B:2', 'B:3']), 2), null);
});

test('fraud: explainable scores', () => {
  const clean = scoreOrder({ email: 'a@gmail.com', totalCents: 9000, quantity: 2, maxPerOrder: 8, recentOrdersSameEmail: 1, recentOrdersSameIp: 1, secondsToCheckout: 60 });
  assert.equal(clean.score, 0);
  const risky = scoreOrder({ email: 'x@tempmail.dev', totalCents: 150_000, quantity: 8, maxPerOrder: 8, recentOrdersSameEmail: 4, recentOrdersSameIp: 6, secondsToCheckout: 2 });
  assert.equal(risky.score, 100);
  assert.ok(risky.reasons.includes('Disposable email domain'));
});
