// Demo venues for a local or staging database: ten fictional venues with a few photos each, capacity and some lines about them,
// in Lagos, Abuja, Accra, London, Austin and New York. Most take bookings (an active hire listing with a price and
// opening hours); a few are verified. Safe to run again: venues are matched by slug and updated.
//
//   node scripts/seed-venues.mjs            add or update them
//   node scripts/seed-venues.mjs --remove   delete them again (only these slugs, and only while they have no events)
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const photo = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1400&q=72`;
const WEEK = (open, close, days = [0, 1, 2, 3, 4, 5, 6]) => days.map((day) => ({ day, open, close }));

/** More venue photos (Unsplash licence) for the galleries. */
const POOL = [
  '1519167758481-83f550bb49b3',
  '1505236858219-8359eb29e329',
  '1464366400600-7168b8af9bc3',
  '1492684223066-81342ee5ff30',
  '1540575467063-178a50c2df87',
  '1507874457470-272b3c8d8ee2',
  '1514525253161-7a46d19cd819',
  '1511578314322-379afb476865',
  '1470229722913-7c0e2dbbafd3',
  '1459749411175-04bf5292ceea',
].map(photo);

/** [slug, name, address, city, region, country, timezone, lat, lng, capacity, photo, verified, about, hire] */
const VENUES = [
  {
    slug: 'lagoon-pavilion-lekki',
    name: 'Lagoon Pavilion',
    address: '14 Admiralty Way, Lekki Phase 1',
    city: 'Lagos',
    region: 'Lagos',
    country: 'NG',
    timezone: 'Africa/Lagos',
    lat: 6.4474,
    lng: 3.4723,
    capacity: 1200,
    imageUrl: photo('1505236858219-8359eb29e329'),
    verified: true,
    about: 'A glass-walled hall on the lagoon with a built-in stage, a full lighting rig and parking for 300 cars. Weddings, galas and concerts.',
    hire: { priceMode: 'DAY', priceCents: 450_000_00, currency: 'NGN', minHours: 6, noticeDays: 14, capacity: 1000, amenities: ['Stage', 'Lighting rig', 'Parking', 'Backup power', 'Green room'], hours: WEEK('10:00', '23:59') },
  },
  {
    slug: 'the-courtyard-ikoyi',
    name: 'The Courtyard Ikoyi',
    address: '3 Bourdillon Road, Ikoyi',
    city: 'Lagos',
    region: 'Lagos',
    country: 'NG',
    timezone: 'Africa/Lagos',
    lat: 6.4541,
    lng: 3.4337,
    capacity: 350,
    imageUrl: photo('1464366400600-7168b8af9bc3'),
    verified: true,
    about: 'An open-air courtyard under string lights, with a covered bar and a lawn for 350. Intimate shows, launches and dinners.',
    hire: { priceMode: 'HOUR', priceCents: 85_000_00, currency: 'NGN', minHours: 3, noticeDays: 7, capacity: 300, amenities: ['Bar', 'Sound system', 'Outdoor', 'Catering kitchen'], hours: WEEK('12:00', '23:00'), instantBook: true },
  },
  {
    slug: 'mainland-arena-yaba',
    name: 'Mainland Arena',
    address: '27 Herbert Macaulay Way, Yaba',
    city: 'Lagos',
    region: 'Lagos',
    country: 'NG',
    timezone: 'Africa/Lagos',
    lat: 6.5095,
    lng: 3.3711,
    capacity: 4000,
    imageUrl: photo('1492684223066-81342ee5ff30'),
    verified: false,
    about: 'A standing arena for big nights: concerts, club events and festivals, with a loading bay straight onto the stage.',
    hire: { priceMode: 'QUOTE', priceCents: null, currency: 'NGN', minHours: 8, noticeDays: 30, capacity: 4000, amenities: ['Loading bay', 'Line array PA', 'Security room', 'Backup power'], hours: null },
  },
  {
    slug: 'harbour-theatre-victoria-island',
    name: 'Harbour Theatre',
    address: '8 Akin Adesola Street, Victoria Island',
    city: 'Lagos',
    region: 'Lagos',
    country: 'NG',
    timezone: 'Africa/Lagos',
    lat: 6.4281,
    lng: 3.4219,
    capacity: 650,
    imageUrl: photo('1540575467063-178a50c2df87'),
    verified: false,
    about: 'A raked 650-seat theatre with a fly tower and an orchestra pit. Plays, comedy and talks.',
    hire: null,
  },
  {
    slug: 'capital-ballroom-abuja',
    name: 'Capital Ballroom',
    address: '22 Aguiyi Ironsi Street, Maitama',
    city: 'Abuja',
    region: 'Federal Capital Territory',
    country: 'NG',
    timezone: 'Africa/Lagos',
    lat: 9.0866,
    lng: 7.4931,
    capacity: 900,
    imageUrl: photo('1519167758481-83f550bb49b3'),
    verified: true,
    about: 'A chandeliered ballroom with its own kitchen and a bridal suite. Weddings, awards nights and conferences.',
    hire: { priceMode: 'DAY', priceCents: 380_000_00, currency: 'NGN', minHours: 8, noticeDays: 21, capacity: 850, amenities: ['Catering kitchen', 'Bridal suite', 'Parking', 'Backup power'], hours: WEEK('09:00', '23:59') },
  },
  {
    slug: 'osu-garden-hall-accra',
    name: 'Osu Garden Hall',
    address: '5 Oxford Street, Osu',
    city: 'Accra',
    region: 'Greater Accra',
    country: 'GH',
    timezone: 'Africa/Accra',
    lat: 5.556,
    lng: -0.1823,
    capacity: 500,
    imageUrl: photo('1507874457470-272b3c8d8ee2'),
    verified: false,
    about: 'A garden hall a short walk from Oxford Street, with a covered terrace and a dance floor for 500.',
    hire: { priceMode: 'HOUR', priceCents: 1_800_00, currency: 'GHS', minHours: 4, noticeDays: 10, capacity: 450, amenities: ['Dance floor', 'Terrace', 'Sound system'], hours: WEEK('11:00', '23:00') },
  },
  {
    slug: 'the-foundry-shoreditch',
    name: 'The Foundry',
    address: '41 Great Eastern Street',
    city: 'London',
    region: 'England',
    country: 'GB',
    timezone: 'Europe/London',
    lat: 51.5246,
    lng: -0.0806,
    capacity: 600,
    imageUrl: photo('1514525253161-7a46d19cd819'),
    verified: true,
    about: 'A brick-and-steel former foundry in Shoreditch: club nights, gigs and product launches, with a mezzanine bar.',
    hire: { priceMode: 'HOUR', priceCents: 450_00, currency: 'GBP', minHours: 4, noticeDays: 14, capacity: 550, amenities: ['Mezzanine bar', 'DJ booth', 'Cloakroom', 'Step-free access'], hours: WEEK('17:00', '23:59', [3, 4, 5, 6]) },
  },
  {
    slug: 'riverside-rooms-southbank',
    name: 'Riverside Rooms',
    address: '9 Belvedere Road, South Bank',
    city: 'London',
    region: 'England',
    country: 'GB',
    timezone: 'Europe/London',
    lat: 51.5034,
    lng: -0.1166,
    capacity: 220,
    imageUrl: photo('1511578314322-379afb476865'),
    verified: false,
    about: 'Three linked rooms by the river with Thames views. Talks, workshops and private dinners for up to 220.',
    hire: { priceMode: 'DAY', priceCents: 2_400_00, currency: 'GBP', minHours: 4, noticeDays: 7, capacity: 200, amenities: ['Projector', 'River view', 'Step-free access', 'Wi-Fi'], hours: WEEK('08:00', '22:00', [1, 2, 3, 4, 5]), instantBook: true },
  },
  {
    slug: 'east-sixth-hall-austin',
    name: 'East Sixth Hall',
    address: '1100 E 6th Street',
    city: 'Austin',
    region: 'Texas',
    country: 'US',
    timezone: 'America/Chicago',
    lat: 30.2652,
    lng: -97.7285,
    capacity: 800,
    imageUrl: photo('1470229722913-7c0e2dbbafd3'),
    verified: true,
    about: 'A music hall on East Sixth with a sprung floor, an outdoor patio stage and a full backline on request.',
    hire: { priceMode: 'HOUR', priceCents: 650_00, currency: 'USD', minHours: 4, noticeDays: 14, capacity: 750, amenities: ['Backline', 'Patio stage', 'Green room', 'Bar'], hours: WEEK('12:00', '23:59') },
  },
  {
    slug: 'pier-nine-loft-brooklyn',
    name: 'Pier Nine Loft',
    address: '90 Kent Avenue, Brooklyn',
    city: 'New York',
    region: 'New York',
    country: 'US',
    timezone: 'America/New_York',
    lat: 40.7219,
    lng: -73.9617,
    capacity: 400,
    imageUrl: photo('1459749411175-04bf5292ceea'),
    verified: false,
    about: 'A waterfront loft in Williamsburg with skyline views, a roof deck and a freight elevator for load-in.',
    hire: { priceMode: 'QUOTE', priceCents: null, currency: 'USD', minHours: 5, noticeDays: 21, capacity: 380, amenities: ['Roof deck', 'Freight elevator', 'Skyline view'], hours: WEEK('10:00', '23:59') },
  },
];

async function add() {
  for (const v of VENUES) {
    const { hire, verified, slug, ...data } = v;
    // The cover plus three more from the pool, different for each venue, so venue pages show a gallery.
    const at = VENUES.indexOf(v);
    const extra = POOL.filter((u) => u !== data.imageUrl);
    const photos = [data.imageUrl, ...[0, 1, 2].map((k) => extra[(at * 3 + k) % extra.length])].map((url) => ({ url }));
    const fields = { ...data, photos, verifiedAt: verified ? new Date() : null, hiddenAt: null };
    const venue = await prisma.venue.upsert({ where: { slug }, create: { slug, ...fields }, update: fields });
    if (hire) {
      const { hours, ...rest } = hire;
      const listing = { active: true, bufferMinutes: 60, instantBook: false, ...rest, hours: hours ?? undefined, rules: 'No confetti cannons indoors. Music ends by midnight unless agreed.' };
      await prisma.venueListing.upsert({ where: { venueId: venue.id }, create: { venueId: venue.id, ...listing }, update: listing });
    } else {
      await prisma.venueListing.deleteMany({ where: { venueId: venue.id } });
    }
  }
  console.log(`${VENUES.length} demo venues ready (${VENUES.filter((v) => v.hire).length} taking bookings).`);
}

async function remove() {
  const rows = await prisma.venue.findMany({ where: { slug: { in: VENUES.map((v) => v.slug) } }, select: { id: true, slug: true, _count: { select: { events: true, bookings: true } } } });
  const used = rows.filter((r) => r._count.events || r._count.bookings);
  if (used.length) console.log(`Kept (they have events or bookings): ${used.map((r) => r.slug).join(', ')}`);
  const ids = rows.filter((r) => !r._count.events && !r._count.bookings).map((r) => r.id);
  const { count } = await prisma.venue.deleteMany({ where: { id: { in: ids } } });
  console.log(`Removed ${count} demo venues.`);
}

(process.argv.includes('--remove') ? remove() : add())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
