/**
 * Demo data: the same 16 events, venues, ticket types and seat maps as the Eventro website
 * (exported from it into prisma/catalog.json), plus realistic past sales so seat maps,
 * dashboards and attendee lists have something in them.
 *
 *   npm run build && npm run db:seed          (adds what's missing; safe to re-run)
 *   npx prisma migrate reset --force          (wipe and seed from scratch)
 *
 * Regenerate the catalog from the website repo with:
 *   node scripts/export-catalog.mjs ../eventro-be/prisma/catalog.json
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Category, Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { config } from '../src/config';
import { orderCode, slugify, ticketCode } from '../src/domain/codes';
import { capacityByTicketType, rowLabel, sectionCapacity, type SeatMap, type Section } from '../src/domain/seatmap';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_PASSWORD || 'eventro-demo-123';

type CatalogEvent = {
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  startsAt: string; // local wall time, stored as UTC so it prints the same everywhere
  image: string;
  about: string[];
  doors: string;
  venue: { slug: string; name: string; city: string; address: string; lat: number | null; lng: number | null };
  tiers: { key: string; name: string; note: string; priceCents: number; left: number }[];
  seatMap: SeatMap | null;
};

const CATEGORY: Record<string, Category> = {
  Concerts: 'CONCERTS',
  Sports: 'SPORTS',
  Comedy: 'COMEDY',
  Theater: 'THEATER',
  Festivals: 'FESTIVALS',
  Family: 'FAMILY',
};

/* ---------- deterministic randomness, so every reset gives the same venue ---------- */

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Amara', 'Ben', 'Chloe', 'Daniel', 'Ebun', 'Femi', 'Grace', 'Hiro', 'Ines', 'Jamal', 'Kemi', 'Liam', 'Maya', 'Noah', 'Ola', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tolu', 'Uche', 'Vera', 'Wale', 'Yara', 'Zane'];
const LAST = ['Adeyemi', 'Brooks', 'Chen', 'Diaz', 'Eze', 'Fischer', 'Garcia', 'Hughes', 'Ibrahim', 'Johnson', 'Kim', 'Lopez', 'Mensah', 'Nguyen', 'Okafor', 'Patel', 'Reyes', 'Smith', 'Taylor', 'Walker'];

type Sold = { section: string | null; row: string | null; seat: number | null };

/** Front rows sell first, with a few seats in front left open and a few further back taken. */
function soldSeats(s: Section, sold: number, r: () => number): Sold[] {
  const per = s.seatsPerRow ?? 0;
  const total = sectionCapacity(s);
  const flat = Array.from({ length: total }, (_, i) => i < sold);
  const swaps = Math.floor(Math.min(sold, total - sold) * 0.3);
  for (let k = 0; k < swaps; k++) {
    const a = Math.floor(r() * sold);
    const b = sold + Math.floor(r() * (total - sold));
    if (flat[a] && !flat[b]) {
      flat[a] = false;
      flat[b] = true;
    }
  }
  const out: Sold[] = [];
  flat.forEach((taken, i) => taken && out.push({ section: s.id, row: rowLabel(Math.floor(i / per)), seat: (i % per) + 1 }));
  return out;
}

async function main() {
  const catalog = JSON.parse(readFileSync(join(__dirname, '..', '..', 'prisma', 'catalog.json'), 'utf8')) as { events: CatalogEvent[] };
  const hash11 = await bcrypt.hash(PASSWORD, 11);
  const upsertUser = (email: string, name: string, roles: ('FAN' | 'ORGANIZER' | 'ADMIN')[]) =>
    prisma.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash: hash11, roles } });

  const organizer = await upsertUser('organizer@eventro.test', 'Demo Organizer', ['FAN', 'ORGANIZER']);
  const adminEmail = config.adminEmail || 'admin@eventro.test';
  await upsertUser(adminEmail, 'Eventro Admin', ['FAN', 'ADMIN']);
  const fan = await upsertUser('fan@eventro.test', 'Demo Fan', ['FAN']);

  // Your own admin login for local testing, from .env (never committed): SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME.
  const ownEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const ownPassword = process.env.SEED_ADMIN_PASSWORD;
  if (ownEmail && ownPassword) {
    if (ownPassword.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters.');
    const passwordHash = await bcrypt.hash(ownPassword, 11);
    const name = process.env.SEED_ADMIN_NAME?.trim() || ownEmail.split('@')[0];
    await prisma.user.upsert({
      where: { email: ownEmail },
      update: { passwordHash, roles: { set: ['FAN', 'ORGANIZER', 'ADMIN'] } },
      create: { email: ownEmail, name, passwordHash, roles: ['FAN', 'ORGANIZER', 'ADMIN'] },
    });
    console.log(`  admin login ready for ${ownEmail}`);
  }

  let org = await prisma.organization.findFirst({ where: { members: { some: { userId: organizer.id } } } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Eventro Live',
        supportEmail: 'organizer@eventro.test',
        members: { create: { userId: organizer.id, email: organizer.email, role: 'ADMIN', status: 'ACTIVE' } },
      },
    });
  }

  const now = Date.now();
  let ticketsMade = 0;

  for (const c of catalog.events) {
    if (await prisma.event.findUnique({ where: { slug: c.slug } })) continue;
    const r = rng(hash(c.slug));
    const venue = await prisma.venue.upsert({
      where: { slug: c.venue.slug || slugify(c.venue.name) },
      update: {},
      create: { slug: c.venue.slug || slugify(c.venue.name), name: c.venue.name, city: c.venue.city.split(',')[0], address: c.venue.address, lat: c.venue.lat, lng: c.venue.lng },
    });

    // Capacity: the seat map decides for ticket types on it; others get what's left plus past sales.
    const mapCaps = c.seatMap ? capacityByTicketType(c.seatMap) : new Map<string, number>();
    const plan = c.tiers.map((t) => {
      const cap = mapCaps.get(t.key);
      if (cap !== undefined) {
        const left = Math.min(t.left, cap);
        return { ...t, capacity: cap, sold: cap - left };
      }
      const sold = Math.round(t.left * (0.8 + r() * 1.8));
      return { ...t, capacity: sold + t.left, sold };
    });

    const ev = await prisma.event.create({
      data: {
        slug: c.slug,
        orgId: org.id,
        venueId: venue.id,
        title: c.title,
        subtitle: c.subtitle,
        description: c.about.join('\n\n'),
        category: CATEGORY[c.category] ?? 'OTHER',
        imageUrl: c.image,
        startsAt: new Date(`${c.startsAt}Z`),
        status: 'PUBLISHED',
        ticketTypes: {
          create: plan.map((t, i) => ({ name: t.name, description: t.note, priceCents: t.priceCents, capacity: t.capacity, sold: t.sold, sortOrder: i })),
        },
      },
      include: { ticketTypes: { orderBy: { sortOrder: 'asc' } } },
    });
    const idOf = new Map(plan.map((t, i) => [t.key, ev.ticketTypes[i].id]));

    let map: SeatMap | null = null;
    if (c.seatMap) {
      map = { ...c.seatMap, sections: c.seatMap.sections.map((s) => ({ ...s, ticketTypeId: idOf.get(s.ticketTypeId)! })) };
      await prisma.event.update({ where: { id: ev.id }, data: { seatMap: map as unknown as Prisma.InputJsonValue } });
    }
    await prisma.promo.create({ data: { eventId: ev.id, code: 'EVENTRO10', percent: 10 } });

    // Past sales: which seats are gone, per ticket type.
    for (const t of plan) {
      const ttId = idOf.get(t.key)!;
      const sections = map?.sections.filter((s) => s.ticketTypeId === ttId) ?? [];
      let seats: Sold[] = [];
      if (sections.length) {
        // Spread what's sold unevenly over the sections, weighted by size.
        const weights = sections.map((s) => sectionCapacity(s) * (0.4 + r() * 1.2));
        const sum = weights.reduce((a, b) => a + b, 0);
        let rest = t.sold;
        sections.forEach((s, i) => {
          const n = i === sections.length - 1 ? rest : Math.min(sectionCapacity(s), Math.round((t.sold * weights[i]) / sum), rest);
          const take = Math.min(n, sectionCapacity(s));
          rest -= take;
          seats.push(...(s.seating === 'ga' ? Array.from({ length: take }, () => ({ section: s.id, row: null, seat: null })) : soldSeats(s, take, r)));
        });
      } else {
        seats = Array.from({ length: t.sold }, () => ({ section: null, row: null, seat: null }));
      }
      if (seats.length !== t.sold) await prisma.ticketType.update({ where: { id: ttId }, data: { sold: seats.length } });

      // Group neighbouring seats into orders of 1-4, bought over the last 75 days (more recently).
      const orders: Prisma.OrderCreateManyInput[] = [];
      const tickets: Prisma.TicketCreateManyInput[] = [];
      for (let i = 0; i < seats.length; ) {
        const qty = Math.min(seats.length - i, 1 + Math.floor(r() * r() * 4));
        const id = orderCode();
        const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
        const email = `${name.toLowerCase().replace(' ', '.')}${Math.floor(r() * 900) + 100}@example.com`;
        const when = new Date(now - Math.pow(r(), 1.8) * 75 * 86_400_000);
        orders.push({ id, eventId: ev.id, ticketTypeId: ttId, email, buyerName: name, quantity: qty, unitCents: t.priceCents, subtotalCents: t.priceCents * qty, totalCents: t.priceCents * qty, status: 'PAID', provider: 'seed', createdAt: when, paidAt: when });
        for (let k = 0; k < qty; k++) {
          const s = seats[i + k];
          tickets.push({ id: ticketCode(id, k), orderId: id, eventId: ev.id, ticketTypeId: ttId, holderName: name, holderEmail: email, section: s.section, row: s.row, seat: s.seat, createdAt: when });
        }
        i += qty;
      }
      for (let i = 0; i < orders.length; i += 2000) await prisma.order.createMany({ data: orders.slice(i, i + 2000) });
      for (let i = 0; i < tickets.length; i += 4000) await prisma.ticket.createMany({ data: tickets.slice(i, i + 4000) });
      ticketsMade += tickets.length;
    }
    console.log(`  + ${c.title}`);
  }

  // The demo fan owns a couple of orders so My Tickets isn't empty.
  if (!(await prisma.order.findFirst({ where: { buyerId: fan.id } }))) {
    for (const slug of ['nova-hart', 'kairo']) {
      const ev = await prisma.event.findUnique({ where: { slug }, include: { ticketTypes: { orderBy: { sortOrder: 'asc' } } } });
      if (!ev) continue;
      const tt = ev.ticketTypes[1] ?? ev.ticketTypes[0];
      const map = ev.seatMap as SeatMap | null;
      const section = map?.sections.find((s) => s.ticketTypeId === tt.id);
      const taken = new Set(
        (await prisma.ticket.findMany({ where: { eventId: ev.id, section: section?.id ?? '' }, select: { row: true, seat: true } })).map((t) => `${t.row}:${t.seat}`),
      );
      const seats: Sold[] = [];
      if (section?.seating === 'reserved') {
        for (let ri = (section.rows ?? 1) - 1; ri >= 0 && seats.length < 2; ri--) {
          for (let n = 1; n < (section.seatsPerRow ?? 1) && seats.length < 2; n++) {
            if (!taken.has(`${rowLabel(ri)}:${n}`) && !taken.has(`${rowLabel(ri)}:${n + 1}`)) seats.push({ section: section.id, row: rowLabel(ri), seat: n }, { section: section.id, row: rowLabel(ri), seat: n + 1 });
          }
        }
      }
      while (seats.length < 2) seats.push({ section: section?.id ?? null, row: null, seat: null });
      const id = orderCode();
      await prisma.order.create({
        data: {
          id,
          eventId: ev.id,
          ticketTypeId: tt.id,
          buyerId: fan.id,
          email: fan.email,
          buyerName: fan.name,
          quantity: 2,
          unitCents: tt.priceCents,
          subtotalCents: tt.priceCents * 2,
          totalCents: tt.priceCents * 2,
          status: 'PAID',
          provider: 'seed',
          paidAt: new Date(),
          tickets: { create: seats.map((s, k) => ({ id: ticketCode(id, k), eventId: ev.id, ticketTypeId: tt.id, ownerId: fan.id, holderName: fan.name, holderEmail: fan.email, ...s })) },
        },
      });
      await prisma.ticketType.update({ where: { id: tt.id }, data: { sold: { increment: 2 }, capacity: { increment: section ? 0 : 2 } } });
    }
  }

  console.log(`\n${ticketsMade.toLocaleString('en-US')} past tickets created.`);
  console.log('Demo accounts (password: %s)', PASSWORD);
  console.log('  organizer@eventro.test  organizer of all demo events');
  console.log(`  ${adminEmail.padEnd(23)} admin`);
  console.log('  fan@eventro.test        fan with two orders');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
