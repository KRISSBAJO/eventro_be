/**
 * Demo data matching the Eventro website (same event slugs).
 * Safe to run more than once: existing records are left alone.
 *
 *   npm run build && npm run db:seed
 */
import 'reflect-metadata';
import { Category, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { config } from '../src/config';
import { buyerPrice } from '../src/domain/money';
import { arenaTemplate, capacityByTicketType } from '../src/domain/seatmap';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_PASSWORD || 'eventro-demo-123';

const img = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=70`;

type Seed = {
  slug: string;
  title: string;
  subtitle: string;
  category: Category;
  venue: { slug: string; name: string; address: string; city: string; lat: number; lng: number; capacity: number };
  startsAt: string;
  image: string;
  description: string;
  tiers: [name: string, baseDollars: number, capacity: number][];
  arena?: boolean;
};

const EVENTS: Seed[] = [
  {
    slug: 'nova-hart',
    title: 'Nova Hart',
    subtitle: 'Neon Hearts World Tour',
    category: 'CONCERTS',
    venue: { slug: 'riverside-arena', name: 'Riverside Arena', address: '400 Riverside Ave, New York, NY 10027', city: 'New York', lat: 40.817, lng: -73.958, capacity: 18000 },
    startsAt: '2026-12-13T01:00:00Z',
    image: img('1470229722913-7c0e2dbbafd3'),
    description: 'A two-hour set spanning the platinum debut, the new record, and an acoustic encore in the round.',
    tiers: [
      ['Floor GA', 176, 1200],
      ['Lower bowl', 142, 1440],
      ['Upper bowl', 86, 2688],
    ],
    arena: true,
  },
  {
    slug: 'harbor-derby',
    title: 'Harbor FC vs. Kingsport',
    subtitle: 'Premier Cup · Matchday 14',
    category: 'SPORTS',
    venue: { slug: 'harbor-stadium', name: 'Harbor Stadium', address: 'Quay Road, London E14', city: 'London', lat: 51.505, lng: -0.02, capacity: 42000 },
    startsAt: '2026-12-06T15:00:00Z',
    image: img('1574629810360-7efbbe195018'),
    description: 'The Harbor derby is back, with a pre-match fan zone from 1:30 PM.',
    tiers: [
      ['Upper tier', 52, 2000],
      ['Lower tier', 109, 900],
      ['Club level', 218, 120],
    ],
  },
  {
    slug: 'solstice',
    title: 'Solstice Festival',
    subtitle: '3 days · 60+ artists',
    category: 'FESTIVALS',
    venue: { slug: 'lakeshore-grounds', name: 'Lakeshore Grounds', address: '2100 Lakeshore Dr, Austin, TX', city: 'Austin', lat: 30.25, lng: -97.72, capacity: 30000 },
    startsAt: '2027-03-19T17:00:00Z',
    image: img('1506157786151-b8491531f063'),
    description: 'Three days, four stages and sixty-plus artists on the shore of Lake Austin.',
    tiers: [
      ['3-Day GA', 173, 8000],
      ['3-Day GA+', 294, 1500],
      ['3-Day VIP', 553, 300],
    ],
  },
  {
    slug: 'dana-okafor',
    title: 'Dana Okafor',
    subtitle: 'Overthinking It — Live',
    category: 'COMEDY',
    venue: { slug: 'the-velvet-room', name: 'The Velvet Room', address: '88 Queen St W, Toronto, ON', city: 'Toronto', lat: 43.65, lng: -79.38, capacity: 420 },
    startsAt: '2026-12-05T02:30:00Z',
    image: img('1585699324551-f6c309eedeca'),
    description: 'A full-length hour about family group chats and leaving parties without saying goodbye.',
    tiers: [
      ['General admission', 41, 340],
      ['Front tables', 65, 60],
    ],
  },
  {
    slug: 'kairo',
    title: 'KAIRO',
    subtitle: 'Afterglow Club Tour',
    category: 'CONCERTS',
    venue: { slug: 'warehouse-9', name: 'Warehouse 9', address: 'Ozumba Mbadiwe Ave, Victoria Island, Lagos', city: 'Lagos', lat: 6.43, lng: 3.42, capacity: 2500 },
    startsAt: '2026-12-27T21:00:00Z',
    image: img('1470225620780-dba8ba36b745'),
    description: 'A late-night, lights-down warehouse set. Four hours, one room, no breaks.',
    tiers: [
      ['General admission', 34, 2000],
      ['VIP deck', 120, 150],
    ],
  },
  {
    slug: 'the-lantern',
    title: 'The Lantern',
    subtitle: 'A new musical',
    category: 'THEATER',
    venue: { slug: 'paramount-hall', name: 'Paramount Hall', address: '14 Strand, London WC2', city: 'London', lat: 51.51, lng: -0.12, capacity: 1200 },
    startsAt: '2026-12-18T19:00:00Z',
    image: img('1503095396549-807759245b35'),
    description: 'A lighthouse keeper, a storm, and a stranger who washes ashore with no memory.',
    tiers: [
      ['Stalls', 63, 600],
      ['Dress circle', 92, 300],
    ],
  },
];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 11);

  const upsertUser = (email: string, name: string, roles: ('FAN' | 'ORGANIZER' | 'ADMIN')[]) =>
    prisma.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash: hash, roles } });

  const organizer = await upsertUser('organizer@eventro.test', 'Demo Organizer', ['FAN', 'ORGANIZER']);
  const adminEmail = config.adminEmail || 'admin@eventro.test';
  await upsertUser(adminEmail, 'Eventro Admin', ['FAN', 'ADMIN']);
  await upsertUser('fan@eventro.test', 'Demo Fan', ['FAN']);

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

  for (const s of EVENTS) {
    if (await prisma.event.findUnique({ where: { slug: s.slug } })) continue;
    const venue = await prisma.venue.upsert({ where: { slug: s.venue.slug }, update: {}, create: s.venue });
    const ev = await prisma.event.create({
      data: {
        slug: s.slug,
        orgId: org.id,
        venueId: venue.id,
        title: s.title,
        subtitle: s.subtitle,
        description: s.description,
        category: s.category,
        imageUrl: s.image,
        startsAt: new Date(s.startsAt),
        status: 'PUBLISHED',
        ticketTypes: {
          create: s.tiers.map(([name, base, capacity], i) => ({
            name,
            priceCents: buyerPrice(base * 100, 'BUYER', config.organizerFeePermille),
            capacity,
            sortOrder: i,
          })),
        },
      },
      include: { ticketTypes: { orderBy: { sortOrder: 'asc' } } },
    });
    if (s.arena) {
      const [floor, lower, upper] = ev.ticketTypes;
      const map = arenaTemplate({ floor: floor.id, lower: lower.id, upper: upper.id });
      await prisma.event.update({ where: { id: ev.id }, data: { seatMap: map } });
      for (const [id, capacity] of capacityByTicketType(map)) await prisma.ticketType.update({ where: { id }, data: { capacity } });
    }
    await prisma.promo.create({ data: { eventId: ev.id, code: 'EVENTRO10', percent: 10 } });
    console.log(`  + ${s.title}`);
  }

  console.log('\nDemo accounts (password: %s)', PASSWORD);
  console.log('  organizer@eventro.test  organizer of all demo events');
  console.log(`  ${adminEmail.padEnd(23)} admin`);
  console.log('  fan@eventro.test        fan');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
