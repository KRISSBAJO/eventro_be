-- Import the public catalog once on the Omoshow database. Existing records keep their current settings.
BEGIN;
INSERT INTO "Organization" ("id", "name", "slug", "supportEmail", "website", "about", "verifiedAt", "suspendedAt")
SELECT "id", "name", "slug", "supportEmail", "website", "about", "verifiedAt", "suspendedAt"
FROM jsonb_populate_recordset(NULL::"Organization", $catalog$[
 {
  "id": "cmwtfcz5f0003r9h42cqrallm",
  "name": "Eventro Live",
  "slug": "eventro-live-9b88",
  "supportEmail": "organizer@eventro.test",
  "website": null,
  "about": null,
  "verifiedAt": null,
  "suspendedAt": null
 },
 {
  "id": "cmwu281lq0000r9osww5fm9l7",
  "name": "LogaXP",
  "slug": "logaxp-8e2d",
  "supportEmail": "krissbajo@gmail.com",
  "website": null,
  "about": null,
  "verifiedAt": null,
  "suspendedAt": null
 }
]$catalog$::jsonb)
WHERE current_database() = 'rkdb_eb0ba5b80188'
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "Venue" ("id", "slug", "name", "address", "city", "country", "region", "postalCode", "timezone", "lat", "lng", "capacity", "layout", "about", "imageUrl", "photos", "website", "phone", "verifiedAt", "hiddenAt", "createdAt", "updatedAt")
SELECT "id", "slug", "name", "address", "city", "country", "region", "postalCode", "timezone", "lat", "lng", "capacity", "layout", "about", "imageUrl", "photos", "website", "phone", "verifiedAt", "hiddenAt", "createdAt", "updatedAt"
FROM jsonb_populate_recordset(NULL::"Venue", $catalog$[
 {
  "id": "cmwtozs910000r9i85ee3pjse",
  "slug": "hall-b-52ep",
  "name": "Hall B",
  "address": "1108 Berry Street",
  "city": "Nashville",
  "country": null,
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T20:02:24.325Z",
  "updatedAt": "2026-11-23T20:06:53.773Z"
 },
 {
  "id": "cmwu1sjw20000r9y0lx0bv5cq",
  "slug": "soso-street-qwq6",
  "name": "Soso Street",
  "address": "Soso Street",
  "city": "Las Vegas",
  "country": "US",
  "region": "Nevada",
  "postalCode": "89117",
  "timezone": "America/Los_Angeles",
  "lat": 36.1657277,
  "lng": -115.2808137,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-24T02:00:41.906Z",
  "updatedAt": "2026-11-23T20:06:53.773Z"
 },
 {
  "id": "cmwtfcz5n0006r9h43w2e3qlu",
  "slug": "riverside-arena",
  "name": "Riverside Arena",
  "address": "400 Riverside Ave, New York, NY 10027",
  "city": "New York",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 40.817,
  "lng": -73.958,
  "capacity": 18000,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.644Z",
  "updatedAt": "2026-11-24T03:59:38.824Z"
 },
 {
  "id": "cmwtmxsvj001or91gawc1ee0b",
  "slug": "liberty-playhouse",
  "name": "Liberty Playhouse",
  "address": "Liberty Playhouse, 220 W 44th St, New York, NY",
  "city": "New York",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 40.69248,
  "lng": -74.1439,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:52.591Z",
  "updatedAt": "2026-11-24T03:59:38.824Z"
 },
 {
  "id": "cmwtfcz6k000er9h47fvl6alt",
  "slug": "harbor-stadium",
  "name": "Harbor Stadium",
  "address": "Quay Road, London E14",
  "city": "London",
  "country": "GB",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 51.505,
  "lng": -0.02,
  "capacity": 42000,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.677Z",
  "updatedAt": "2026-11-24T03:59:38.830Z"
 },
 {
  "id": "cmwtfcz7d0018r9h4pgke88cl",
  "slug": "paramount-hall",
  "name": "Paramount Hall",
  "address": "14 Strand, London WC2",
  "city": "London",
  "country": "GB",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 51.51,
  "lng": -0.12,
  "capacity": 1200,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.705Z",
  "updatedAt": "2026-11-24T03:59:38.830Z"
 },
 {
  "id": "cmwtmxotf000zr91gzklauv3m",
  "slug": "thameside-concert-hall",
  "name": "Thameside Concert Hall",
  "address": "Thameside Concert Hall, 1 Riverside Walk, London SE1",
  "city": "London",
  "country": "GB",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 51.4698,
  "lng": -0.09839999999999999,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:47.332Z",
  "updatedAt": "2026-11-24T03:59:38.830Z"
 },
 {
  "id": "cmwtfcz6r000mr9h4o7ok3bu1",
  "slug": "lakeshore-grounds",
  "name": "Lakeshore Grounds",
  "address": "2100 Lakeshore Dr, Austin, TX",
  "city": "Austin",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 30.25,
  "lng": -97.72,
  "capacity": 30000,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.684Z",
  "updatedAt": "2026-11-24T03:59:38.833Z"
 },
 {
  "id": "cmwtmxqkk0018r91ge8mq4tkm",
  "slug": "riverbend-park",
  "name": "Riverbend Park",
  "address": "Riverbend Park, 3000 E Riverside Dr, Austin, TX",
  "city": "Austin",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 30.26128,
  "lng": -97.84819999999999,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:49.604Z",
  "updatedAt": "2026-11-24T03:59:38.833Z"
 },
 {
  "id": "cmwtfcz6z000ur9h4syt9n938",
  "slug": "the-velvet-room",
  "name": "The Velvet Room",
  "address": "88 Queen St W, Toronto, ON",
  "city": "Toronto",
  "country": "CA",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 43.65,
  "lng": -79.38,
  "capacity": 420,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.691Z",
  "updatedAt": "2026-11-24T03:59:38.834Z"
 },
 {
  "id": "cmwtmxrvk001gr91gnrxrw8xy",
  "slug": "harbourfront-cinemas",
  "name": "Harbourfront Cinemas",
  "address": "Harbourfront Cinemas, 235 Queens Quay W, Toronto, ON",
  "city": "Toronto",
  "country": "CA",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 43.64544,
  "lng": -79.491,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:51.296Z",
  "updatedAt": "2026-11-24T03:59:38.834Z"
 },
 {
  "id": "cmwtmxjxs0003r91gyskfp4h6",
  "slug": "central-court",
  "name": "Central Court",
  "address": "Central Court, 1901 W Madison St, Chicago, IL",
  "city": "Chicago",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 41.90218,
  "lng": -87.6774,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:41.008Z",
  "updatedAt": "2026-11-24T03:59:38.836Z"
 },
 {
  "id": "cmwtfcz760011r9h4jhnlq3ik",
  "slug": "warehouse-9",
  "name": "Warehouse 9",
  "address": "Ozumba Mbadiwe Ave, Victoria Island, Lagos",
  "city": "Lagos",
  "country": "NG",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 6.43,
  "lng": 3.42,
  "capacity": 2500,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T15:32:43.698Z",
  "updatedAt": "2026-11-24T03:59:38.838Z"
 },
 {
  "id": "cmwtmxoly000sr91gj2xmssyw",
  "slug": "lagoon-arts-theatre",
  "name": "Lagoon Arts Theatre",
  "address": "Lagoon Arts Theatre, Awolowo Rd, Ikoyi, Lagos",
  "city": "Lagos",
  "country": "NG",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 6.53736,
  "lng": 3.3546,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:47.062Z",
  "updatedAt": "2026-11-24T03:59:38.838Z"
 },
 {
  "id": "cmwtmxt85001wr91gnjguw2ci",
  "slug": "tarkwa-bay-beach",
  "name": "Tarkwa Bay Beach",
  "address": "Tarkwa Bay Beach, Lagos",
  "city": "Lagos",
  "country": "NG",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 6.4916,
  "lng": 3.2541,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:53.046Z",
  "updatedAt": "2026-11-24T03:59:38.838Z"
 },
 {
  "id": "cmwtnorfb0000r9nsuj1rpbda",
  "slug": "skyline-terrace-3rfg",
  "name": "Skyline Terrace",
  "address": "12 Marina Rd, Lagos Island",
  "city": "Lagos",
  "country": "NG",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:25:50.424Z",
  "updatedAt": "2026-11-24T03:59:38.838Z"
 },
 {
  "id": "cmwtohiya0000r9g0g6jrb3c4",
  "slug": "eko-convention-arena-vk5h",
  "name": "Eko Convention Arena",
  "address": "1 Water Corporation Dr, Victoria Island",
  "city": "Lagos",
  "country": "NG",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:48:12.467Z",
  "updatedAt": "2026-11-24T03:59:38.838Z"
 },
 {
  "id": "cmwtmxlbv000br91ghowl9par",
  "slug": "northgate-center",
  "name": "Northgate Center",
  "address": "Northgate Center, 500 Northgate Blvd, Denver, CO",
  "city": "Denver",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 39.76576,
  "lng": -105.0134,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:42.812Z",
  "updatedAt": "2026-11-24T03:59:38.840Z"
 },
 {
  "id": "cmwtmxmou000jr91gujuzk2va",
  "slug": "pier-40-amphitheatre",
  "name": "Pier 40 Amphitheatre",
  "address": "Pier 40 Amphitheatre, Ocean Front Walk, Los Angeles, CA",
  "city": "Los Angeles",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": null,
  "lat": 34.01964,
  "lng": -118.3808,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-23T19:04:44.574Z",
  "updatedAt": "2026-11-24T03:59:38.841Z"
 },
 {
  "id": "cmwxt5url0000r9iwodj2a8w9",
  "slug": "lagoon-pavilion-lekki",
  "name": "Lagoon Pavilion",
  "address": "14 Admiralty Way, Lekki Phase 1",
  "city": "Lagos",
  "country": "NG",
  "region": "Lagos",
  "postalCode": null,
  "timezone": "Africa/Lagos",
  "lat": 6.4474,
  "lng": 3.4723,
  "capacity": 1200,
  "layout": null,
  "about": "A glass-walled hall on the lagoon with a built-in stage, a full lighting rig and parking for 300 cars. Weddings, galas and concerts.",
  "imageUrl": "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.689Z",
  "updatedAt": "2026-11-26T19:04:29.224Z"
 },
 {
  "id": "cmwvn87tg001ar9hcfyyilk3t",
  "slug": "roller-star-65g6",
  "name": "Roller Star",
  "address": "1108 Bery Street",
  "city": "Nashville",
  "country": "US",
  "region": "Tennessee",
  "postalCode": "37138",
  "timezone": "America/Chicago",
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-25T04:48:30.869Z",
  "updatedAt": "2026-11-25T04:48:30.869Z"
 },
 {
  "id": "cmww9ibwk0072r90o9q471n31",
  "slug": "test-venue-tty8",
  "name": "Test venue",
  "address": "100 Example Street",
  "city": "Nashville",
  "country": "US",
  "region": null,
  "postalCode": null,
  "timezone": "America/New_York",
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-25T15:12:14.277Z",
  "updatedAt": "2026-11-25T15:12:14.277Z"
 },
 {
  "id": "cmww9wrfj0000r9tg5rcf1c90",
  "slug": "eko-hotel-5r9r",
  "name": "Eko Hotel",
  "address": "11 bell road",
  "city": "Lagos",
  "country": "NG",
  "region": "Lagos",
  "postalCode": "332543",
  "timezone": "Africa/Lagos",
  "lat": null,
  "lng": null,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-25T15:23:27.584Z",
  "updatedAt": "2026-11-25T15:23:27.584Z"
 },
 {
  "id": "cmwxqkdg2000pr94g1dwqjboi",
  "slug": "cap-city-room-2nu9",
  "name": "Cap City Room",
  "address": "1 Congress Ave",
  "city": "Austin",
  "country": "US",
  "region": "Texas",
  "postalCode": null,
  "timezone": "America/Chicago",
  "lat": 30.2672,
  "lng": -97.7431,
  "capacity": null,
  "layout": null,
  "about": null,
  "imageUrl": null,
  "photos": null,
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T15:57:29.234Z",
  "updatedAt": "2026-11-26T15:57:29.234Z"
 },
 {
  "id": "cmwxt5ury0002r9iwywygdfun",
  "slug": "mainland-arena-yaba",
  "name": "Mainland Arena",
  "address": "27 Herbert Macaulay Way, Yaba",
  "city": "Lagos",
  "country": "NG",
  "region": "Lagos",
  "postalCode": null,
  "timezone": "Africa/Lagos",
  "lat": 6.5095,
  "lng": 3.3711,
  "capacity": 4000,
  "layout": null,
  "about": "A standing arena for big nights: concerts, club events and festivals, with a loading bay straight onto the stage.",
  "imageUrl": "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.702Z",
  "updatedAt": "2026-11-26T19:04:29.235Z"
 },
 {
  "id": "cmwxt5us00003r9iwdivkha4w",
  "slug": "harbour-theatre-victoria-island",
  "name": "Harbour Theatre",
  "address": "8 Akin Adesola Street, Victoria Island",
  "city": "Lagos",
  "country": "NG",
  "region": "Lagos",
  "postalCode": null,
  "timezone": "Africa/Lagos",
  "lat": 6.4281,
  "lng": 3.4219,
  "capacity": 650,
  "layout": null,
  "about": "A raked 650-seat theatre with a fly tower and an orchestra pit. Plays, comedy and talks.",
  "imageUrl": "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.705Z",
  "updatedAt": "2026-11-26T19:04:29.239Z"
 },
 {
  "id": "cmwxt5us30004r9iwxwliwyam",
  "slug": "capital-ballroom-abuja",
  "name": "Capital Ballroom",
  "address": "22 Aguiyi Ironsi Street, Maitama",
  "city": "Abuja",
  "country": "NG",
  "region": "Federal Capital Territory",
  "postalCode": null,
  "timezone": "Africa/Lagos",
  "lat": 9.0866,
  "lng": 7.4931,
  "capacity": 900,
  "layout": null,
  "about": "A chandeliered ballroom with its own kitchen and a bridal suite. Weddings, awards nights and conferences.",
  "imageUrl": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1507874457470-272b3c8d8ee2?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.708Z",
  "updatedAt": "2026-11-26T19:04:29.243Z"
 },
 {
  "id": "cmwxt5usf0008r9iw0a2uediq",
  "slug": "east-sixth-hall-austin",
  "name": "East Sixth Hall",
  "address": "1100 E 6th Street",
  "city": "Austin",
  "country": "US",
  "region": "Texas",
  "postalCode": null,
  "timezone": "America/Chicago",
  "lat": 30.2652,
  "lng": -97.7285,
  "capacity": 800,
  "layout": null,
  "about": "A music hall on East Sixth with a sprung floor, an outdoor patio stage and a full backline on request.",
  "imageUrl": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.719Z",
  "updatedAt": "2026-11-26T19:04:29.254Z"
 },
 {
  "id": "cmwxt5uru0001r9iwisfl7s7j",
  "slug": "the-courtyard-ikoyi",
  "name": "The Courtyard Ikoyi",
  "address": "3 Bourdillon Road, Ikoyi",
  "city": "Lagos",
  "country": "NG",
  "region": "Lagos",
  "postalCode": null,
  "timezone": "Africa/Lagos",
  "lat": 6.4541,
  "lng": 3.4337,
  "capacity": 350,
  "layout": null,
  "about": "An open-air courtyard under string lights, with a covered bar and a lawn for 350. Intimate shows, launches and dinners.",
  "imageUrl": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1507874457470-272b3c8d8ee2?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.699Z",
  "updatedAt": "2026-11-26T19:04:29.232Z"
 },
 {
  "id": "cmwxt5us60005r9iw5r8mfc39",
  "slug": "osu-garden-hall-accra",
  "name": "Osu Garden Hall",
  "address": "5 Oxford Street, Osu",
  "city": "Accra",
  "country": "GH",
  "region": "Greater Accra",
  "postalCode": null,
  "timezone": "Africa/Accra",
  "lat": 5.556,
  "lng": -0.1823,
  "capacity": 500,
  "layout": null,
  "about": "A garden hall a short walk from Oxford Street, with a covered terrace and a dance floor for 500.",
  "imageUrl": "https://images.unsplash.com/photo-1507874457470-272b3c8d8ee2?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1507874457470-272b3c8d8ee2?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.711Z",
  "updatedAt": "2026-11-26T19:04:29.246Z"
 },
 {
  "id": "cmwxt5us90006r9iweuqmernd",
  "slug": "the-foundry-shoreditch",
  "name": "The Foundry",
  "address": "41 Great Eastern Street",
  "city": "London",
  "country": "GB",
  "region": "England",
  "postalCode": null,
  "timezone": "Europe/London",
  "lat": 51.5246,
  "lng": -0.0806,
  "capacity": 600,
  "layout": null,
  "about": "A brick-and-steel former foundry in Shoreditch: club nights, gigs and product launches, with a mezzanine bar.",
  "imageUrl": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.713Z",
  "updatedAt": "2026-11-26T19:04:29.249Z"
 },
 {
  "id": "cmwxt5usb0007r9iwlqtapdhl",
  "slug": "riverside-rooms-southbank",
  "name": "Riverside Rooms",
  "address": "9 Belvedere Road, South Bank",
  "city": "London",
  "country": "GB",
  "region": "England",
  "postalCode": null,
  "timezone": "Europe/London",
  "lat": 51.5034,
  "lng": -0.1166,
  "capacity": 220,
  "layout": null,
  "about": "Three linked rooms by the river with Thames views. Talks, workshops and private dinners for up to 220.",
  "imageUrl": "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1507874457470-272b3c8d8ee2?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.716Z",
  "updatedAt": "2026-11-26T19:04:29.251Z"
 },
 {
  "id": "cmwxt5ush0009r9iw0c33gp9m",
  "slug": "pier-nine-loft-brooklyn",
  "name": "Pier Nine Loft",
  "address": "90 Kent Avenue, Brooklyn",
  "city": "New York",
  "country": "US",
  "region": "New York",
  "postalCode": null,
  "timezone": "America/New_York",
  "lat": 40.7219,
  "lng": -73.9617,
  "capacity": 400,
  "layout": null,
  "about": "A waterfront loft in Williamsburg with skyline views, a roof deck and a freight elevator for load-in.",
  "imageUrl": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1400&q=72",
  "photos": [
   {
    "url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1400&q=72"
   },
   {
    "url": "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?auto=format&fit=crop&w=1400&q=72"
   }
  ],
  "website": null,
  "phone": null,
  "verifiedAt": null,
  "hiddenAt": null,
  "createdAt": "2026-11-26T17:10:10.721Z",
  "updatedAt": "2026-11-26T19:04:29.256Z"
 }
]$catalog$::jsonb)
WHERE current_database() = 'rkdb_eb0ba5b80188'
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "VenueListing" ("venueId", "active", "priceMode", "priceCents", "currency", "minHours", "noticeDays", "bufferMinutes", "capacity", "amenities", "rules", "photos", "instantBook", "hours", "createdAt", "updatedAt")
SELECT "venueId", "active", "priceMode", "priceCents", "currency", "minHours", "noticeDays", "bufferMinutes", "capacity", "amenities", "rules", "photos", "instantBook", "hours", "createdAt", "updatedAt"
FROM jsonb_populate_recordset(NULL::"VenueListing", $catalog$[
 {
  "venueId": "cmwxt5ury0002r9iwywygdfun",
  "active": false,
  "priceMode": "QUOTE",
  "priceCents": null,
  "currency": "NGN",
  "minHours": 8,
  "noticeDays": 30,
  "bufferMinutes": 60,
  "capacity": 4000,
  "amenities": [
   "Loading bay",
   "Line array PA",
   "Security room",
   "Backup power"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": null,
  "createdAt": "2026-11-26T17:10:10.703Z",
  "updatedAt": "2026-11-26T19:04:29.237Z"
 },
 {
  "venueId": "cmwxt5us30004r9iwxwliwyam",
  "active": false,
  "priceMode": "DAY",
  "priceCents": 38000000,
  "currency": "NGN",
  "minHours": 8,
  "noticeDays": 21,
  "bufferMinutes": 60,
  "capacity": 850,
  "amenities": [
   "Catering kitchen",
   "Bridal suite",
   "Parking",
   "Backup power"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 1,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 2,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 3,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 4,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 5,
    "open": "09:00",
    "close": "23:59"
   },
   {
    "day": 6,
    "open": "09:00",
    "close": "23:59"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.709Z",
  "updatedAt": "2026-11-26T19:04:29.245Z"
 },
 {
  "venueId": "cmwxt5us90006r9iweuqmernd",
  "active": false,
  "priceMode": "HOUR",
  "priceCents": 45000,
  "currency": "GBP",
  "minHours": 4,
  "noticeDays": 14,
  "bufferMinutes": 60,
  "capacity": 550,
  "amenities": [
   "Mezzanine bar",
   "DJ booth",
   "Cloakroom",
   "Step-free access"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 3,
    "open": "17:00",
    "close": "23:59"
   },
   {
    "day": 4,
    "open": "17:00",
    "close": "23:59"
   },
   {
    "day": 5,
    "open": "17:00",
    "close": "23:59"
   },
   {
    "day": 6,
    "open": "17:00",
    "close": "23:59"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.714Z",
  "updatedAt": "2026-11-26T19:04:29.250Z"
 },
 {
  "venueId": "cmwxt5usb0007r9iwlqtapdhl",
  "active": false,
  "priceMode": "DAY",
  "priceCents": 240000,
  "currency": "GBP",
  "minHours": 4,
  "noticeDays": 7,
  "bufferMinutes": 60,
  "capacity": 200,
  "amenities": [
   "Projector",
   "River view",
   "Step-free access",
   "Wi-Fi"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 1,
    "open": "08:00",
    "close": "22:00"
   },
   {
    "day": 2,
    "open": "08:00",
    "close": "22:00"
   },
   {
    "day": 3,
    "open": "08:00",
    "close": "22:00"
   },
   {
    "day": 4,
    "open": "08:00",
    "close": "22:00"
   },
   {
    "day": 5,
    "open": "08:00",
    "close": "22:00"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.718Z",
  "updatedAt": "2026-11-26T19:04:29.253Z"
 },
 {
  "venueId": "cmwxt5usf0008r9iw0a2uediq",
  "active": false,
  "priceMode": "HOUR",
  "priceCents": 65000,
  "currency": "USD",
  "minHours": 4,
  "noticeDays": 14,
  "bufferMinutes": 60,
  "capacity": 750,
  "amenities": [
   "Backline",
   "Patio stage",
   "Green room",
   "Bar"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 1,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 2,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 3,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 4,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 5,
    "open": "12:00",
    "close": "23:59"
   },
   {
    "day": 6,
    "open": "12:00",
    "close": "23:59"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.720Z",
  "updatedAt": "2026-11-26T19:04:29.255Z"
 },
 {
  "venueId": "cmwxt5ush0009r9iw0c33gp9m",
  "active": false,
  "priceMode": "QUOTE",
  "priceCents": null,
  "currency": "USD",
  "minHours": 5,
  "noticeDays": 21,
  "bufferMinutes": 60,
  "capacity": 380,
  "amenities": [
   "Roof deck",
   "Freight elevator",
   "Skyline view"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 1,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 2,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 3,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 4,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 5,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 6,
    "open": "10:00",
    "close": "23:59"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.723Z",
  "updatedAt": "2026-11-26T19:04:29.258Z"
 },
 {
  "venueId": "cmwxt5url0000r9iwodj2a8w9",
  "active": false,
  "priceMode": "DAY",
  "priceCents": 45000000,
  "currency": "NGN",
  "minHours": 6,
  "noticeDays": 14,
  "bufferMinutes": 60,
  "capacity": 1000,
  "amenities": [
   "Stage",
   "Lighting rig",
   "Parking",
   "Backup power",
   "Green room"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 1,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 2,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 3,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 4,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 5,
    "open": "10:00",
    "close": "23:59"
   },
   {
    "day": 6,
    "open": "10:00",
    "close": "23:59"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.694Z",
  "updatedAt": "2026-11-26T19:04:29.229Z"
 },
 {
  "venueId": "cmwxt5uru0001r9iwisfl7s7j",
  "active": false,
  "priceMode": "HOUR",
  "priceCents": 8500000,
  "currency": "NGN",
  "minHours": 3,
  "noticeDays": 7,
  "bufferMinutes": 60,
  "capacity": 300,
  "amenities": [
   "Bar",
   "Sound system",
   "Outdoor",
   "Catering kitchen"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 1,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 2,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 3,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 4,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 5,
    "open": "12:00",
    "close": "23:00"
   },
   {
    "day": 6,
    "open": "12:00",
    "close": "23:00"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.700Z",
  "updatedAt": "2026-11-26T19:04:29.234Z"
 },
 {
  "venueId": "cmwxt5us60005r9iw5r8mfc39",
  "active": false,
  "priceMode": "HOUR",
  "priceCents": 180000,
  "currency": "GHS",
  "minHours": 4,
  "noticeDays": 10,
  "bufferMinutes": 60,
  "capacity": 450,
  "amenities": [
   "Dance floor",
   "Terrace",
   "Sound system"
  ],
  "rules": "No confetti cannons indoors. Music ends by midnight unless agreed.",
  "photos": null,
  "instantBook": false,
  "hours": [
   {
    "day": 0,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 1,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 2,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 3,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 4,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 5,
    "open": "11:00",
    "close": "23:00"
   },
   {
    "day": 6,
    "open": "11:00",
    "close": "23:00"
   }
  ],
  "createdAt": "2026-11-26T17:10:10.712Z",
  "updatedAt": "2026-11-26T19:04:29.247Z"
 }
]$catalog$::jsonb)
WHERE current_database() = 'rkdb_eb0ba5b80188'
ON CONFLICT ("venueId") DO NOTHING;
INSERT INTO "Event" ("id", "slug", "orgId", "venueId", "title", "subtitle", "description", "category", "imageUrl", "startsAt", "doorsAt", "endsAt", "timezone", "online", "status", "visibility", "feeMode", "currency", "salesPaused", "cancelledAt", "cancelReason", "seatMap", "media", "dateMode", "publishedAt", "spotlightAt", "createdAt", "updatedAt", "resaleEnabled", "resaleCapPercent", "resaleRoyaltyPermille", "transfersEnabled", "transferCutoffMinutes", "donationsEnabled", "donationCause", "donationDescription", "donationSuggestedCents", "donationMinCents", "compLimit")
SELECT "id", "slug", "orgId", "venueId", "title", "subtitle", "description", "category", "imageUrl", "startsAt", "doorsAt", "endsAt", "timezone", "online", "status", "visibility", "feeMode", "currency", "salesPaused", "cancelledAt", "cancelReason", "seatMap", "media", "dateMode", "publishedAt", "spotlightAt", "createdAt", "updatedAt", "resaleEnabled", "resaleCapPercent", "resaleRoyaltyPermille", "transfersEnabled", "transferCutoffMinutes", "donationsEnabled", "donationCause", "donationDescription", "donationSuggestedCents", "donationMinCents", "compLimit"
FROM jsonb_populate_recordset(NULL::"Event", $catalog$[
 {
  "id": "cmwtfcz6n000gr9h4mhn2f7i8",
  "slug": "harbor-derby",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz6k000er9h47fvl6alt",
  "title": "Harbor FC vs. Kingsport",
  "subtitle": "Premier Cup · Matchday 14",
  "description": "The Harbor derby is back, with a pre-match fan zone from 1:30 PM.",
  "category": "SPORTS",
  "imageUrl": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-06T15:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Europe/London",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.679Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.679Z",
  "updatedAt": "2026-11-24T05:05:52.172Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxom0000ur91g8bkaas1j",
  "slug": "eko-laughs",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxoly000sr91gj2xmssyw",
  "title": "Eko Laughs Live",
  "subtitle": "Six comedians, one wild night",
  "description": "Lagos’ biggest comedy night is back: six of the city’s sharpest stand-ups, one host who refuses to behave, and a crowd that heckles with love.",
  "category": "COMEDY",
  "imageUrl": "https://images.unsplash.com/photo-1527224538127-2104bb71c51b?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-19T19:30:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Africa/Lagos",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "BAR",
     "kind": "bar",
     "label": "Bar",
     "geometry": {
      "h": 250,
      "w": 160,
      "x": 960,
      "y": 220
     }
    },
    {
     "id": "DOOR",
     "kind": "entrance",
     "label": "Entrance",
     "geometry": {
      "h": 120,
      "w": 120,
      "x": 1000,
      "y": 560
     }
    }
   ],
   "stage": {
    "h": 90,
    "w": 360,
    "x": 420,
    "y": 50,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "GA",
     "label": "Floor",
     "shape": "rect",
     "seating": "ga",
     "capacity": 900,
     "geometry": {
      "h": 330,
      "w": 600,
      "x": 300,
      "y": 180
     },
     "ticketTypeId": "cmwtmxom0000vr91ghkv21cdw"
    },
    {
     "id": "BT",
     "label": "Bar terrace",
     "shape": "rect",
     "seating": "ga",
     "capacity": 150,
     "geometry": {
      "h": 250,
      "w": 170,
      "x": 80,
      "y": 220
     },
     "ticketTypeId": "cmwtmxom0000vr91ghkv21cdw"
    },
    {
     "id": "VIP",
     "rows": 4,
     "label": "VIP balcony",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 120,
      "w": 600,
      "x": 300,
      "y": 560
     },
     "seatsPerRow": 30,
     "ticketTypeId": "cmwtmxom0000wr91g42guynhr"
    },
    {
     "id": "S1",
     "label": "Suite 1",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 500
     },
     "ticketTypeId": "cmwtmxom0000wr91g42guynhr"
    },
    {
     "id": "S2",
     "label": "Suite 2",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 562
     },
     "ticketTypeId": "cmwtmxom0000wr91g42guynhr"
    },
    {
     "id": "S3",
     "label": "Suite 3",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 624
     },
     "ticketTypeId": "cmwtmxom0000wr91g42guynhr"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:47.064Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:47.064Z",
  "updatedAt": "2026-11-24T05:05:52.226Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtfcz6u000or9h45ob56g25",
  "slug": "solstice",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz6r000mr9h4o7ok3bu1",
  "title": "Solstice Festival",
  "subtitle": "3 days · 60+ artists",
  "description": "Three days, four stages and sixty-plus artists on the shore of Lake Austin.",
  "category": "FESTIVALS",
  "imageUrl": "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-03-19T12:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Chicago",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.686Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.686Z",
  "updatedAt": "2026-11-24T05:05:52.178Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtfcz71000wr9h400h8p0h7",
  "slug": "dana-okafor",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz6z000ur9h4syt9n938",
  "title": "Dana Okafor",
  "subtitle": "Overthinking It — Live",
  "description": "A full-length hour about family group chats and leaving parties without saying goodbye.",
  "category": "COMEDY",
  "imageUrl": "https://images.unsplash.com/photo-1585699324551-f6c309eedeca?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-04T21:30:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Toronto",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.693Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.693Z",
  "updatedAt": "2026-11-24T05:05:52.184Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtnorfe0002r9ns73bv6r6h",
  "slug": "sunset-rooftop-sessions-9zan",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtnorfb0000r9nsuj1rpbda",
  "title": "Sunset Rooftop Sessions",
  "subtitle": "Live DJ sets over the city",
  "description": "An evening of deep house and afrobeats on the rooftop, with a view over the lagoon.",
  "category": "NIGHTLIFE",
  "imageUrl": "https://owner-mediaex-xs7qr.test.hoiststack.com/api/media/ast_bbedf2nagmns/transform?w=1200&h=675&fit=cover&pos=attention&f=auto&q=78",
  "startsAt": "2027-02-14T19:00:00.000Z",
  "doorsAt": "2027-02-14T18:00:00.000Z",
  "endsAt": null,
  "timezone": "UTC",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "BAR",
     "kind": "bar",
     "label": "Bar",
     "geometry": {
      "h": 250,
      "w": 160,
      "x": 960,
      "y": 220
     }
    },
    {
     "id": "DOOR",
     "kind": "entrance",
     "label": "Entrance",
     "geometry": {
      "h": 120,
      "w": 120,
      "x": 1000,
      "y": 560
     }
    }
   ],
   "stage": {
    "h": 90,
    "w": 360,
    "x": 420,
    "y": 50,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "GA",
     "label": "Floor",
     "shape": "rect",
     "seating": "ga",
     "capacity": 900,
     "geometry": {
      "h": 330,
      "w": 600,
      "x": 300,
      "y": 180
     },
     "ticketTypeId": "cmwtnorfe0003r9nss626idtm"
    },
    {
     "id": "BT",
     "label": "Bar terrace",
     "shape": "rect",
     "seating": "ga",
     "capacity": 150,
     "geometry": {
      "h": 250,
      "w": 170,
      "x": 80,
      "y": 220
     },
     "ticketTypeId": "cmwtnorfe0003r9nss626idtm"
    },
    {
     "id": "VIP",
     "rows": 4,
     "label": "VIP balcony",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 120,
      "w": 600,
      "x": 300,
      "y": 560
     },
     "seatsPerRow": 30,
     "ticketTypeId": "cmwtnorfe0004r9ns8nvvru71"
    },
    {
     "id": "S1",
     "label": "Suite 1",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 500
     },
     "ticketTypeId": "cmwtnorfe0004r9ns8nvvru71"
    },
    {
     "id": "S2",
     "label": "Suite 2",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 562
     },
     "ticketTypeId": "cmwtnorfe0004r9ns8nvvru71"
    },
    {
     "id": "S3",
     "label": "Suite 3",
     "shape": "rect",
     "seating": "ga",
     "capacity": 12,
     "geometry": {
      "h": 54,
      "w": 170,
      "x": 80,
      "y": 624
     },
     "ticketTypeId": "cmwtnorfe0004r9ns8nvvru71"
    }
   ]
  },
  "media": [
   {
    "id": "ast_bbedf2nagmns",
    "kind": "image"
   },
   {
    "id": "ast_hlhdu3g7qnkb",
    "kind": "video"
   }
  ],
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:25:50.426Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:25:50.426Z",
  "updatedAt": "2026-11-23T19:46:44.704Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtfcz7f001ar9h46xww6kyk",
  "slug": "the-lantern",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz7d0018r9h4pgke88cl",
  "title": "The Lantern",
  "subtitle": "A new musical",
  "description": "A lighthouse keeper, a storm, and a stranger who washes ashore with no memory.",
  "category": "THEATER",
  "imageUrl": "https://images.unsplash.com/photo-1503095396549-807759245b35?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-18T19:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Europe/London",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.707Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.707Z",
  "updatedAt": "2026-11-24T05:05:52.199Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtfcz780013r9h4io3x9sdr",
  "slug": "kairo",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz760011r9h4jhnlq3ik",
  "title": "KAIRO",
  "subtitle": "Afterglow Club Tour",
  "description": "A late-night, lights-down warehouse set. Four hours, one room, no breaks.",
  "category": "CONCERTS",
  "imageUrl": "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-27T22:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Africa/Lagos",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.700Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.700Z",
  "updatedAt": "2026-11-24T05:05:52.205Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxlbx000dr91gkotu34i4",
  "slug": "ice-gala",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxlbv000br91ghowl9par",
  "title": "Winter Ice Gala",
  "subtitle": "Family holiday show",
  "description": "The Winter Ice Gala turns Northgate Center into a frozen storybook, with Olympic skaters, aerialists and a snowfall finale over the rink.",
  "category": "FAMILY",
  "imageUrl": "https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-21T14:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Denver",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "HOME",
     "kind": "other",
     "label": "Home bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 470,
      "y": 222
     }
    },
    {
     "id": "AWAY",
     "kind": "other",
     "label": "Away bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 620,
      "y": 222
     }
    }
   ],
   "stage": {
    "h": 220,
    "w": 460,
    "x": 370,
    "y": 270,
    "kind": "rink",
    "label": "RINK"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "101",
     "rows": 14,
     "label": "101",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "102",
     "rows": 14,
     "label": "102",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000fr91gnxy0qdv5"
    },
    {
     "id": "103",
     "rows": 14,
     "label": "103",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000fr91gnxy0qdv5"
    },
    {
     "id": "104",
     "rows": 14,
     "label": "104",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "105",
     "rows": 14,
     "label": "105",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -45.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "106",
     "rows": 14,
     "label": "106",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -44.2,
      "a1": -0.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "107",
     "rows": 14,
     "label": "107",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 0.8,
      "a1": 44.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "108",
     "rows": 14,
     "label": "108",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 45.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "109",
     "rows": 14,
     "label": "109",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "110",
     "rows": 14,
     "label": "110",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000fr91gnxy0qdv5"
    },
    {
     "id": "111",
     "rows": 14,
     "label": "111",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000fr91gnxy0qdv5"
    },
    {
     "id": "112",
     "rows": 14,
     "label": "112",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "113",
     "rows": 14,
     "label": "113",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 134.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "114",
     "rows": 14,
     "label": "114",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 135.8,
      "a1": 179.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "115",
     "rows": 14,
     "label": "115",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 180.8,
      "a1": 224.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "116",
     "rows": 14,
     "label": "116",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 225.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "201",
     "rows": 12,
     "label": "201",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "202",
     "rows": 12,
     "label": "202",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "203",
     "rows": 12,
     "label": "203",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "204",
     "rows": 12,
     "label": "204",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "205",
     "rows": 12,
     "label": "205",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "206",
     "rows": 12,
     "label": "206",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -54.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "207",
     "rows": 12,
     "label": "207",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -53.2,
      "a1": -18.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "208",
     "rows": 12,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -17.2,
      "a1": 17.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "209",
     "rows": 12,
     "label": "209",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 18.8,
      "a1": 53.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "210",
     "rows": 12,
     "label": "210",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 54.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "211",
     "rows": 12,
     "label": "211",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "212",
     "rows": 12,
     "label": "212",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "213",
     "rows": 12,
     "label": "213",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "214",
     "rows": 12,
     "label": "214",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "215",
     "rows": 12,
     "label": "215",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "216",
     "rows": 12,
     "label": "216",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 125.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "217",
     "rows": 12,
     "label": "217",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 126.8,
      "a1": 161.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "218",
     "rows": 12,
     "label": "218",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 162.8,
      "a1": 197.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "219",
     "rows": 12,
     "label": "219",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 198.8,
      "a1": 233.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    },
    {
     "id": "220",
     "rows": 12,
     "label": "220",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 234.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxlbx000er91gebu9s075"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:42.814Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:42.814Z",
  "updatedAt": "2026-11-24T05:05:52.211Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxsvl001qr91g1byns55i",
  "slug": "hall-of-mirrors",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxsvj001or91gawc1ee0b",
  "title": "Hall of Mirrors",
  "subtitle": "A magic show for the whole family",
  "description": "Illusionist Theo Marsh turns Liberty Playhouse into a hall of mirrors: disappearing acts, mind reading, and a finale that has kids talking for weeks.",
  "category": "FAMILY",
  "imageUrl": "https://images.unsplash.com/photo-1460723237483-7a6dc9d0b212?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-29T13:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/New_York",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 90,
    "w": 400,
    "x": 400,
    "y": 40,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "OL",
     "rows": 14,
     "label": "Left",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 262,
      "y": 196,
      "rotation": -14
     },
     "seatsPerRow": 8,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "OC",
     "rows": 14,
     "label": "Centre",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 240,
      "w": 320,
      "x": 440,
      "y": 180
     },
     "seatsPerRow": 16,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "OR",
     "rows": 14,
     "label": "Right",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 788,
      "y": 196,
      "rotation": 14
     },
     "seatsPerRow": 8,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "M1",
     "rows": 8,
     "label": "M1",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 122,
      "a1": 141.2,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxsvl001rr91go6bf0zj8"
    },
    {
     "id": "M2",
     "rows": 8,
     "label": "M2",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 101.2,
      "a1": 120.4,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxsvl001rr91go6bf0zj8"
    },
    {
     "id": "M3",
     "rows": 8,
     "label": "M3",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 80.4,
      "a1": 99.6,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxsvl001rr91go6bf0zj8"
    },
    {
     "id": "M4",
     "rows": 8,
     "label": "M4",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 59.6,
      "a1": 78.8,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxsvl001rr91go6bf0zj8"
    },
    {
     "id": "M5",
     "rows": 8,
     "label": "M5",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 38.8,
      "a1": 58,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxsvl001rr91go6bf0zj8"
    },
    {
     "id": "B1",
     "rows": 10,
     "label": "B1",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 119.6,
      "a1": 137.2,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "B2",
     "rows": 10,
     "label": "B2",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 100.4,
      "a1": 118,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "B3",
     "rows": 10,
     "label": "B3",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 81.2,
      "a1": 98.8,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "B4",
     "rows": 10,
     "label": "B4",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 62,
      "a1": 79.6,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    },
    {
     "id": "B5",
     "rows": 10,
     "label": "B5",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 42.8,
      "a1": 60.4,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxsvl001sr91g6elsdiaa"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:52.593Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:52.593Z",
  "updatedAt": "2026-11-24T05:05:52.256Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtfcz5x0008r9h46zwhpo30",
  "slug": "nova-hart",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz5n0006r9h43w2e3qlu",
  "title": "Nova Hart",
  "subtitle": "Neon Hearts World Tour",
  "description": "A two-hour set spanning the platinum debut, the new record, and an acoustic encore in the round.",
  "category": "CONCERTS",
  "imageUrl": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-12T20:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/New_York",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 80,
    "w": 300,
    "x": 450,
    "y": 60,
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "FL",
     "label": "Floor",
     "shape": "arc",
     "seating": "ga",
     "capacity": 1200,
     "geometry": {
      "a0": 28,
      "a1": 152,
      "cx": 600,
      "cy": 170,
      "r0": 120,
      "r1": 270
     },
     "ticketTypeId": "cmwtfcz5x0009r9h4ir83lub2"
    },
    {
     "id": "101",
     "rows": 12,
     "label": "101",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 146.8,
      "a1": 173.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "102",
     "rows": 12,
     "label": "102",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 118.8,
      "a1": 145.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "103",
     "rows": 12,
     "label": "103",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 117.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "104",
     "rows": 12,
     "label": "104",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 62.8,
      "a1": 89.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "105",
     "rows": 12,
     "label": "105",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 34.8,
      "a1": 61.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "106",
     "rows": 12,
     "label": "106",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 6.8,
      "a1": 33.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtfcz5x000ar9h46g8ncsid"
    },
    {
     "id": "201",
     "rows": 14,
     "label": "201",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 168.8,
      "a1": 193.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "202",
     "rows": 14,
     "label": "202",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 142.8,
      "a1": 167.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "203",
     "rows": 14,
     "label": "203",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 116.8,
      "a1": 141.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "204",
     "rows": 14,
     "label": "204",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 115.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "205",
     "rows": 14,
     "label": "205",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 64.8,
      "a1": 89.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "206",
     "rows": 14,
     "label": "206",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 38.8,
      "a1": 63.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "207",
     "rows": 14,
     "label": "207",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 12.8,
      "a1": 37.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    },
    {
     "id": "208",
     "rows": 14,
     "label": "208",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -13.2,
      "a1": 11.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtfcz5x000br9h4isv09ftv"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T15:32:43.653Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T15:32:43.653Z",
  "updatedAt": "2026-11-24T05:05:52.161Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxqkm001ar91go7isr007",
  "slug": "austin-bolts",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxqkk0018r91ge8mq4tkm",
  "title": "Austin Bolts vs. Denver Peaks",
  "subtitle": "Season opener",
  "description": "The Bolts open the season at home against the Peaks. Expect fireworks at kickoff and a sold-out supporters’ end.",
  "category": "SPORTS",
  "imageUrl": "https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-02-28T18:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Chicago",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "HOME",
     "kind": "other",
     "label": "Home bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 470,
      "y": 222
     }
    },
    {
     "id": "AWAY",
     "kind": "other",
     "label": "Away bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 620,
      "y": 222
     }
    }
   ],
   "stage": {
    "h": 200,
    "w": 420,
    "x": 390,
    "y": 280,
    "kind": "court",
    "label": "COURT"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "101",
     "rows": 14,
     "label": "101",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "102",
     "rows": 14,
     "label": "102",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001dr91g5x4169bx"
    },
    {
     "id": "103",
     "rows": 14,
     "label": "103",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001dr91g5x4169bx"
    },
    {
     "id": "104",
     "rows": 14,
     "label": "104",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "105",
     "rows": 14,
     "label": "105",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -45.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "106",
     "rows": 14,
     "label": "106",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -44.2,
      "a1": -0.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "107",
     "rows": 14,
     "label": "107",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 0.8,
      "a1": 44.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "108",
     "rows": 14,
     "label": "108",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 45.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "109",
     "rows": 14,
     "label": "109",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "110",
     "rows": 14,
     "label": "110",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001dr91g5x4169bx"
    },
    {
     "id": "111",
     "rows": 14,
     "label": "111",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001dr91g5x4169bx"
    },
    {
     "id": "112",
     "rows": 14,
     "label": "112",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "113",
     "rows": 14,
     "label": "113",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 134.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "114",
     "rows": 14,
     "label": "114",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 135.8,
      "a1": 179.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "115",
     "rows": 14,
     "label": "115",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 180.8,
      "a1": 224.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "116",
     "rows": 14,
     "label": "116",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 225.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxqkm001cr91g8e29r4q3"
    },
    {
     "id": "201",
     "rows": 12,
     "label": "201",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "202",
     "rows": 12,
     "label": "202",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "203",
     "rows": 12,
     "label": "203",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "204",
     "rows": 12,
     "label": "204",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "205",
     "rows": 12,
     "label": "205",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "206",
     "rows": 12,
     "label": "206",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -54.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "207",
     "rows": 12,
     "label": "207",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -53.2,
      "a1": -18.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "208",
     "rows": 12,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -17.2,
      "a1": 17.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "209",
     "rows": 12,
     "label": "209",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 18.8,
      "a1": 53.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "210",
     "rows": 12,
     "label": "210",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 54.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "211",
     "rows": 12,
     "label": "211",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "212",
     "rows": 12,
     "label": "212",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "213",
     "rows": 12,
     "label": "213",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "214",
     "rows": 12,
     "label": "214",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "215",
     "rows": 12,
     "label": "215",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "216",
     "rows": 12,
     "label": "216",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 125.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "217",
     "rows": 12,
     "label": "217",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 126.8,
      "a1": 161.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "218",
     "rows": 12,
     "label": "218",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 162.8,
      "a1": 197.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "219",
     "rows": 12,
     "label": "219",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 198.8,
      "a1": 233.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    },
    {
     "id": "220",
     "rows": 12,
     "label": "220",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 234.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxqkm001br91gqiy6ikr6"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:49.607Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:49.607Z",
  "updatedAt": "2026-11-24T05:05:52.243Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxrvm001ir91g7c8fd6p1",
  "slug": "northern-lights-film",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxrvk001gr91gnrxrw8xy",
  "title": "Northern Lights Film Festival",
  "subtitle": "10 days · 120 films",
  "description": "Ten days of premieres, director Q&As and late-night midnight madness screenings on Toronto’s waterfront.\n\nFestival passes include every regular screening; galas need a separate ticket.",
  "category": "FESTIVALS",
  "imageUrl": "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-04-08T17:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Toronto",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "FOOD",
     "kind": "bar",
     "label": "Food court",
     "geometry": {
      "h": 80,
      "w": 290,
      "x": 170,
      "y": 640
     }
    },
    {
     "id": "BARS",
     "kind": "bar",
     "label": "Bars",
     "geometry": {
      "h": 80,
      "w": 200,
      "x": 480,
      "y": 640
     }
    },
    {
     "id": "GATE",
     "kind": "entrance",
     "label": "Entrance",
     "geometry": {
      "h": 80,
      "w": 330,
      "x": 700,
      "y": 640
     }
    },
    {
     "id": "TOWER",
     "kind": "other",
     "label": "Sound tower",
     "geometry": {
      "h": 60,
      "w": 80,
      "x": 560,
      "y": 470
     }
    }
   ],
   "stage": {
    "h": 100,
    "w": 360,
    "x": 420,
    "y": 36,
    "kind": "stage",
    "label": "MAIN STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "GA",
     "label": "Festival field",
     "shape": "rect",
     "seating": "ga",
     "capacity": 6000,
     "geometry": {
      "h": 460,
      "w": 860,
      "x": 170,
      "y": 160
     },
     "ticketTypeId": "cmwtmxrvm001jr91g9m51k1j1"
    },
    {
     "id": "PLUS",
     "label": "GA+ lounge",
     "shape": "rect",
     "seating": "ga",
     "capacity": 800,
     "geometry": {
      "h": 380,
      "w": 120,
      "x": 30,
      "y": 200
     },
     "ticketTypeId": "cmwtmxrvm001kr91gmghurlon"
    },
    {
     "id": "VIP",
     "label": "VIP deck",
     "shape": "rect",
     "seating": "ga",
     "capacity": 300,
     "geometry": {
      "h": 380,
      "w": 120,
      "x": 1050,
      "y": 200
     },
     "ticketTypeId": "cmwtmxrvm001lr91g1hztmxv4"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:51.298Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:51.298Z",
  "updatedAt": "2026-11-24T05:05:52.250Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmww9wrfn0002r9tgw2p07y6u",
  "slug": "haruna-wedding-kfpr",
  "orgId": "cmwu281lq0000r9osww5fm9l7",
  "venueId": "cmww9wrfj0000r9tg5rcf1c90",
  "title": "Haruna Wedding",
  "subtitle": "Come and see",
  "description": "We are waiting for you guys  ti get married",
  "category": "COMEDY",
  "imageUrl": "https://images.unsplash.com/photo-1767755255170-c79c863f1849?auto=format&fit=crop&w=1200&q=70",
  "startsAt": "2026-11-30T19:15:00.000Z",
  "doorsAt": "2026-11-30T18:45:00.000Z",
  "endsAt": "2026-11-30T20:30:00.000Z",
  "timezone": "Africa/Lagos",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "NGN",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-25T15:23:27.587Z",
  "spotlightAt": null,
  "createdAt": "2026-11-25T15:23:27.587Z",
  "updatedAt": "2026-11-25T15:24:26.896Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": 4
 },
 {
  "id": "cmwtmxubd0026r91g4jid4312",
  "slug": "velvet-hour",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtfcz7d0018r9h4pgke88cl",
  "title": "The Velvet Hour",
  "subtitle": "A late-night jazz revue",
  "description": "A smoky, late-night revue of jazz standards with a seven-piece band, dancers and a cocktail bar on stage.",
  "category": "THEATER",
  "imageUrl": "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-02-06T21:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Europe/London",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 90,
    "w": 400,
    "x": 400,
    "y": 40,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "OL",
     "rows": 14,
     "label": "Left",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 262,
      "y": 196,
      "rotation": -14
     },
     "seatsPerRow": 8,
     "ticketTypeId": "cmwtmxubd0028r91g5x9hlquw"
    },
    {
     "id": "OC",
     "rows": 14,
     "label": "Centre",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 240,
      "w": 320,
      "x": 440,
      "y": 180
     },
     "seatsPerRow": 16,
     "ticketTypeId": "cmwtmxubd0028r91g5x9hlquw"
    },
    {
     "id": "OR",
     "rows": 14,
     "label": "Right",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 788,
      "y": 196,
      "rotation": 14
     },
     "seatsPerRow": 8,
     "ticketTypeId": "cmwtmxubd0028r91g5x9hlquw"
    },
    {
     "id": "M1",
     "rows": 8,
     "label": "M1",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 122,
      "a1": 141.2,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxubd0029r91gmgrchy8l"
    },
    {
     "id": "M2",
     "rows": 8,
     "label": "M2",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 101.2,
      "a1": 120.4,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxubd0029r91gmgrchy8l"
    },
    {
     "id": "M3",
     "rows": 8,
     "label": "M3",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 80.4,
      "a1": 99.6,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxubd0029r91gmgrchy8l"
    },
    {
     "id": "M4",
     "rows": 8,
     "label": "M4",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 59.6,
      "a1": 78.8,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxubd0029r91gmgrchy8l"
    },
    {
     "id": "M5",
     "rows": 8,
     "label": "M5",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 38.8,
      "a1": 58,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxubd0029r91gmgrchy8l"
    },
    {
     "id": "B1",
     "rows": 10,
     "label": "B1",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 119.6,
      "a1": 137.2,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxubd0027r91gcoxtv6r6"
    },
    {
     "id": "B2",
     "rows": 10,
     "label": "B2",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 100.4,
      "a1": 118,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxubd0027r91gcoxtv6r6"
    },
    {
     "id": "B3",
     "rows": 10,
     "label": "B3",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 81.2,
      "a1": 98.8,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxubd0027r91gcoxtv6r6"
    },
    {
     "id": "B4",
     "rows": 10,
     "label": "B4",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 62,
      "a1": 79.6,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxubd0027r91gcoxtv6r6"
    },
    {
     "id": "B5",
     "rows": 10,
     "label": "B5",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 42.8,
      "a1": 60.4,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxubd0027r91gcoxtv6r6"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:54.458Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:54.458Z",
  "updatedAt": "2026-11-24T05:05:52.267Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwvn87tk001cr9hczbbxegyt",
  "slug": "sdsdvf-5czq",
  "orgId": "cmwu281lq0000r9osww5fm9l7",
  "venueId": "cmwvn87tg001ar9hcfyyilk3t",
  "title": "The Night of Glory",
  "subtitle": "An Atmosphere of Worship. An Encounter with Glory",
  "description": "Prepare for an extraordinary evening of praise, worship, and divine encounters at The Night of Glory.\n\nJoin us as we lift our voices in celebration, experience the power of God's presence, and create unforgettable moments of spiritual renewal. Through inspiring gospel music, passionate worship, and powerful ministrations, this gathering promises to be an uplifting experience for everyone.\n\nBring your family, invite your friends, and come with great expectations.\n\nA night of praise. A night of transformation. A night to remember.",
  "category": "CONCERTS",
  "imageUrl": "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?auto=format&fit=crop&w=1200&q=70",
  "startsAt": "2026-11-27T19:15:00.000Z",
  "doorsAt": "2026-11-27T18:30:00.000Z",
  "endsAt": "2026-11-27T22:30:00.000Z",
  "timezone": "America/Chicago",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": null,
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-25T04:48:30.872Z",
  "spotlightAt": null,
  "createdAt": "2026-11-25T04:48:30.872Z",
  "updatedAt": "2026-11-25T15:17:00.146Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwu0gy9i0001r9fkr85w09su",
  "slug": "night-of-worship-smf5",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": null,
  "title": "Night of Worship",
  "subtitle": "AllForGod",
  "description": "A night of worship dance and celebrations of all kind all to the glory of God",
  "category": "FESTIVALS",
  "imageUrl": "https://owner-mediaex-xs7qr.test.hoiststack.com/api/media/ast_ooxyyib569g/transform?w=1200&h=675&fit=cover&pos=attention&f=auto&q=78",
  "startsAt": "2026-11-26T19:00:00.000Z",
  "doorsAt": "2026-11-26T07:04:00.000Z",
  "endsAt": "2026-11-26T21:06:00.000Z",
  "timezone": "Pacific/Wake",
  "online": true,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "NGN",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 90,
    "w": 400,
    "x": 400,
    "y": 40,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "OL",
     "rows": 6,
     "label": "Left",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 262,
      "y": 196,
      "rotation": -14
     },
     "seatsPerRow": 4,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "OC",
     "rows": 4,
     "label": "Centre",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 240,
      "w": 320,
      "x": 440,
      "y": 180
     },
     "seatsPerRow": 11,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "OR",
     "rows": 7,
     "label": "Right",
     "level": "Orchestra",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 230,
      "w": 150,
      "x": 788,
      "y": 196,
      "rotation": 14
     },
     "seatsPerRow": 3,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "M1",
     "rows": 4,
     "label": "M1",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 122,
      "a1": 141.2,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 10,
     "ticketTypeId": "cmwu0gy9i0003r9fkuqwzmtjp"
    },
    {
     "id": "M2",
     "rows": 4,
     "label": "M2",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 101.2,
      "a1": 120.4,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 10,
     "ticketTypeId": "cmwu0gy9i0003r9fkuqwzmtjp"
    },
    {
     "id": "M3",
     "rows": 4,
     "label": "M3",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 80.4,
      "a1": 99.6,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 10,
     "ticketTypeId": "cmwu0gy9i0003r9fkuqwzmtjp"
    },
    {
     "id": "M4",
     "rows": 4,
     "label": "M4",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 59.6,
      "a1": 78.8,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 10,
     "ticketTypeId": "cmwu0gy9i0003r9fkuqwzmtjp"
    },
    {
     "id": "M5",
     "rows": 4,
     "label": "M5",
     "level": "Mezzanine",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 38.8,
      "a1": 58,
      "cx": 600,
      "cy": 90,
      "r0": 400,
      "r1": 500
     },
     "seatsPerRow": 10,
     "ticketTypeId": "cmwu0gy9i0003r9fkuqwzmtjp"
    },
    {
     "id": "B1",
     "rows": 6,
     "label": "B1",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 119.6,
      "a1": 137.2,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "B2",
     "rows": 6,
     "label": "B2",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 100.4,
      "a1": 118,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "B3",
     "rows": 6,
     "label": "B3",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 81.2,
      "a1": 98.8,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "B4",
     "rows": 4,
     "label": "B4",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 62,
      "a1": 79.6,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 11,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    },
    {
     "id": "B5",
     "rows": 6,
     "label": "B5",
     "level": "Balcony",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 42.8,
      "a1": 60.4,
      "cx": 600,
      "cy": 90,
      "r0": 520,
      "r1": 640
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmwu0gy9i0002r9fkrbdx5rre"
    }
   ]
  },
  "media": [
   {
    "id": "ast_ooxyyib569g",
    "kind": "image"
   },
   {
    "id": "ast_rgj5cghavtdf",
    "kind": "image"
   }
  ],
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-24T01:23:41.044Z",
  "spotlightAt": null,
  "createdAt": "2026-11-24T01:23:41.044Z",
  "updatedAt": "2026-11-24T03:40:12.696Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmww9ibws0074r90o243mb9n8",
  "slug": "nonso-wedding-egjf",
  "orgId": "cmwu281lq0000r9osww5fm9l7",
  "venueId": "cmww9ibwk0072r90o9q471n31",
  "title": "Nonso Wedding",
  "subtitle": "kach2026Dec",
  "description": "A local test event to verify cover image uploads.",
  "category": "OTHER",
  "imageUrl": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1200&q=70",
  "startsAt": "2027-01-15T19:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Chicago",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 80,
    "w": 300,
    "x": 450,
    "y": 60,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "FL",
     "label": "Floor",
     "shape": "arc",
     "seating": "ga",
     "capacity": 500,
     "geometry": {
      "a0": 28,
      "a1": 152,
      "cx": 600,
      "cy": 170,
      "r0": 120,
      "r1": 270
     },
     "ticketTypeId": "cmww9ibwt0075r90oj9urgyvp"
    },
    {
     "id": "101",
     "rows": 12,
     "label": "101",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 146.8,
      "a1": 173.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 14,
     "ticketTypeId": "cmww9ibwt0076r90ol6pbzsrk"
    },
    {
     "id": "102",
     "rows": 3,
     "label": "102",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 118.8,
      "a1": 145.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "103",
     "rows": 3,
     "label": "103",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 117.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "104",
     "rows": 3,
     "label": "104",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 62.8,
      "a1": 89.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 7,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "105",
     "rows": 12,
     "label": "105",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 34.8,
      "a1": 61.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 14,
     "ticketTypeId": "cmww9ibwt0076r90ol6pbzsrk"
    },
    {
     "id": "106",
     "rows": 11,
     "label": "106",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 6.8,
      "a1": 33.2,
      "cx": 600,
      "cy": 170,
      "r0": 290,
      "r1": 410
     },
     "seatsPerRow": 15,
     "ticketTypeId": "cmww9ibwt0076r90ol6pbzsrk"
    },
    {
     "id": "201",
     "rows": 5,
     "label": "201",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 168.8,
      "a1": 193.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "202",
     "rows": 5,
     "label": "202",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 142.8,
      "a1": 167.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "203",
     "rows": 5,
     "label": "203",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 116.8,
      "a1": 141.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "204",
     "rows": 5,
     "label": "204",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 115.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "205",
     "rows": 5,
     "label": "205",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 64.8,
      "a1": 89.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "206",
     "rows": 5,
     "label": "206",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 38.8,
      "a1": 63.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "207",
     "rows": 5,
     "label": "207",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 12.8,
      "a1": 37.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 6,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    },
    {
     "id": "208",
     "rows": 3,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -13.2,
      "a1": 11.2,
      "cx": 600,
      "cy": 170,
      "r0": 430,
      "r1": 570
     },
     "seatsPerRow": 9,
     "ticketTypeId": "cmww9ibwt0077r90ogod7v59q"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-25T15:12:14.284Z",
  "spotlightAt": null,
  "createdAt": "2026-11-25T15:12:14.284Z",
  "updatedAt": "2026-11-25T15:17:02.585Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": 3
 },
 {
  "id": "cmwu1sjw50002r9y0qrv6fo2d",
  "slug": "night-with-the-king-brbu",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwu1sjw20000r9y0lx0bv5cq",
  "title": "Night with the King",
  "subtitle": "One Night. One Encounter. A Life Transformed.",
  "description": "Step into an atmosphere of divine presence at Night with the King — a special gathering of heartfelt worship, powerful praise, fervent prayers, and life-transforming encounters with God.\n\nExperience a night of spiritual renewal, supernatural breakthroughs, and divine visitation as we unite in worship before the King of kings.\n\nCome expectant, come prepared, and come with a heart ready to receive. Whether you are seeking healing, restoration, direction, or a deeper relationship with God, this is an opportunity to experience His transforming power.\n\nInvite your family, friends, and loved ones for an unforgettable night in His presence.\n\nAdmission is open to all. Come and encounter the King!",
  "category": "FAITH",
  "imageUrl": "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1200&q=70",
  "startsAt": "2026-11-27T19:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Los_Angeles",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "stage": {
    "h": 84,
    "w": 300,
    "x": 450,
    "y": 40,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "101",
     "rows": 28,
     "label": "101",
     "level": "VVIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 206.62,
      "w": 228.76,
      "x": 112.79,
      "y": 156
     },
     "seatsPerRow": 31,
     "ticketTypeId": "cmwu1sjw50004r9y08bmo3pz6"
    },
    {
     "id": "102",
     "rows": 28,
     "label": "102",
     "level": "VVIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 206.62,
      "w": 464.9,
      "x": 367.55,
      "y": 156
     },
     "seatsPerRow": 63,
     "ticketTypeId": "cmwu1sjw50004r9y08bmo3pz6"
    },
    {
     "id": "103",
     "rows": 28,
     "label": "103",
     "level": "VVIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 206.62,
      "w": 228.76,
      "x": 858.45,
      "y": 156
     },
     "seatsPerRow": 31,
     "ticketTypeId": "cmwu1sjw50004r9y08bmo3pz6"
    },
    {
     "id": "201",
     "rows": 20,
     "label": "201",
     "level": "Special VIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 147.59,
      "w": 184.48,
      "x": 205.03,
      "y": 392.62
     },
     "seatsPerRow": 25,
     "ticketTypeId": "cmwu1sjw50003r9y0366v7542"
    },
    {
     "id": "202",
     "rows": 20,
     "label": "202",
     "level": "Special VIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 147.59,
      "w": 368.97,
      "x": 415.52,
      "y": 392.62
     },
     "seatsPerRow": 50,
     "ticketTypeId": "cmwu1sjw50003r9y0366v7542"
    },
    {
     "id": "203",
     "rows": 20,
     "label": "203",
     "level": "Special VIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 147.59,
      "w": 184.48,
      "x": 810.48,
      "y": 392.62
     },
     "seatsPerRow": 25,
     "ticketTypeId": "cmwu1sjw50003r9y0366v7542"
    },
    {
     "id": "301",
     "rows": 10,
     "label": "301",
     "level": "VIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 73.79,
      "w": 147.59,
      "x": 439.41,
      "y": 570.21
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwu1sjw50005r9y0e0ytomid"
    },
    {
     "id": "302",
     "rows": 10,
     "label": "302",
     "level": "VIP",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 73.79,
      "w": 147.59,
      "x": 613,
      "y": 570.21
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwu1sjw50005r9y0e0ytomid"
    },
    {
     "id": "Z4",
     "label": "General admission",
     "shape": "rect",
     "seating": "ga",
     "capacity": 122,
     "geometry": {
      "h": 46,
      "w": 160,
      "x": 520,
      "y": 674
     },
     "ticketTypeId": "cmwu1sjw50006r9y0tzj4xwjq"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-24T02:00:41.909Z",
  "spotlightAt": null,
  "createdAt": "2026-11-24T02:00:41.909Z",
  "updatedAt": "2026-11-24T02:58:58.457Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxjxy0005r91gbi06hlme",
  "slug": "metro-hoops",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxjxs0003r91gyskfp4h6",
  "title": "Metro Hawks vs. Bay Comets",
  "subtitle": "Regular season",
  "description": "The Hawks host the Comets in a rematch of last spring’s conference semifinal. Doors open early for warm-ups and the kids’ shooting clinic.",
  "category": "SPORTS",
  "imageUrl": "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-09T19:30:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Chicago",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "HOME",
     "kind": "other",
     "label": "Home bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 470,
      "y": 222
     }
    },
    {
     "id": "AWAY",
     "kind": "other",
     "label": "Away bench",
     "geometry": {
      "h": 30,
      "w": 110,
      "x": 620,
      "y": 222
     }
    }
   ],
   "stage": {
    "h": 200,
    "w": 420,
    "x": 390,
    "y": 280,
    "kind": "court",
    "label": "COURT"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "101",
     "rows": 14,
     "label": "101",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "102",
     "rows": 14,
     "label": "102",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0008r91g77qw9pwe"
    },
    {
     "id": "103",
     "rows": 14,
     "label": "103",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0008r91g77qw9pwe"
    },
    {
     "id": "104",
     "rows": 14,
     "label": "104",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 140,
      "rotation": 180
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "105",
     "rows": 14,
     "label": "105",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -45.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "106",
     "rows": 14,
     "label": "106",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -44.2,
      "a1": -0.8,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "107",
     "rows": 14,
     "label": "107",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 0.8,
      "a1": 44.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "108",
     "rows": 14,
     "label": "108",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 45.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "109",
     "rows": 14,
     "label": "109",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 704,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "110",
     "rows": 14,
     "label": "110",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 604,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0008r91g77qw9pwe"
    },
    {
     "id": "111",
     "rows": 14,
     "label": "111",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 504,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0008r91g77qw9pwe"
    },
    {
     "id": "112",
     "rows": 14,
     "label": "112",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 92,
      "x": 404,
      "y": 540
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "113",
     "rows": 14,
     "label": "113",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 134.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "114",
     "rows": 14,
     "label": "114",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 135.8,
      "a1": 179.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "115",
     "rows": 14,
     "label": "115",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 180.8,
      "a1": 224.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "116",
     "rows": 14,
     "label": "116",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 225.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 160,
      "r1": 240
     },
     "seatsPerRow": 18,
     "ticketTypeId": "cmwtmxjxy0007r91gvlwz18j3"
    },
    {
     "id": "201",
     "rows": 12,
     "label": "201",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "202",
     "rows": 12,
     "label": "202",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "203",
     "rows": 12,
     "label": "203",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "204",
     "rows": 12,
     "label": "204",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "205",
     "rows": 12,
     "label": "205",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "206",
     "rows": 12,
     "label": "206",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -54.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "207",
     "rows": 12,
     "label": "207",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -53.2,
      "a1": -18.8,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "208",
     "rows": 12,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -17.2,
      "a1": 17.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "209",
     "rows": 12,
     "label": "209",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 18.8,
      "a1": 53.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "210",
     "rows": 12,
     "label": "210",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 54.8,
      "a1": 89.2,
      "cx": 800,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "211",
     "rows": 12,
     "label": "211",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 724,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "212",
     "rows": 12,
     "label": "212",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 644,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "213",
     "rows": 12,
     "label": "213",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 564,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "214",
     "rows": 12,
     "label": "214",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 484,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "215",
     "rows": 12,
     "label": "215",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 72,
      "x": 404,
      "y": 640
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "216",
     "rows": 12,
     "label": "216",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 90.8,
      "a1": 125.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "217",
     "rows": 12,
     "label": "217",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 126.8,
      "a1": 161.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "218",
     "rows": 12,
     "label": "218",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 162.8,
      "a1": 197.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "219",
     "rows": 12,
     "label": "219",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 198.8,
      "a1": 233.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    },
    {
     "id": "220",
     "rows": 12,
     "label": "220",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 234.8,
      "a1": 269.2,
      "cx": 400,
      "cy": 380,
      "r0": 260,
      "r1": 340
     },
     "seatsPerRow": 22,
     "ticketTypeId": "cmwtmxjxy0006r91ghfcf2act"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:41.014Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:41.014Z",
  "updatedAt": "2026-11-24T05:05:52.192Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxmow000lr91g5ktlaiyz",
  "slug": "the-wild-coast",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxmou000jr91gujuzk2va",
  "title": "The Wild Coast",
  "subtitle": "Sunset Sessions",
  "description": "The Wild Coast close out their Sunset Sessions on the water at Pier 40: a golden-hour set built for warm evenings and slow dancing.",
  "category": "CONCERTS",
  "imageUrl": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-01-15T19:30:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "America/Los_Angeles",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "SOUND",
     "kind": "other",
     "label": "Sound desk",
     "geometry": {
      "h": 70,
      "w": 80,
      "x": 730,
      "y": 345
     }
    }
   ],
   "stage": {
    "h": 260,
    "w": 100,
    "x": 100,
    "y": 250,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1300,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "FL",
     "label": "Floor",
     "shape": "rect",
     "seating": "ga",
     "capacity": 1800,
     "geometry": {
      "h": 260,
      "w": 450,
      "x": 240,
      "y": 250
     },
     "ticketTypeId": "cmwtmxmow000or91g8ugm0of1"
    },
    {
     "id": "101",
     "rows": 14,
     "label": "101",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 274,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "102",
     "rows": 14,
     "label": "102",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 384,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "103",
     "rows": 14,
     "label": "103",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 494,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "104",
     "rows": 14,
     "label": "104",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 604,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "105",
     "rows": 14,
     "label": "105",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 714,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "106",
     "rows": 14,
     "label": "106",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 824,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "107",
     "rows": 14,
     "label": "107",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -45.8,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "108",
     "rows": 14,
     "label": "108",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -44.2,
      "a1": -0.8,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "109",
     "rows": 14,
     "label": "109",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 0.8,
      "a1": 44.2,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "110",
     "rows": 14,
     "label": "110",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 45.8,
      "a1": 89.2,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "111",
     "rows": 14,
     "label": "111",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 824,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "112",
     "rows": 14,
     "label": "112",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 714,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "113",
     "rows": 14,
     "label": "113",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 604,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "114",
     "rows": 14,
     "label": "114",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 494,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "115",
     "rows": 14,
     "label": "115",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 384,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "116",
     "rows": 14,
     "label": "116",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 274,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxmow000nr91g4pt9nhoa"
    },
    {
     "id": "201",
     "rows": 12,
     "label": "201",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 274,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "202",
     "rows": 12,
     "label": "202",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 368.29,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "203",
     "rows": 12,
     "label": "203",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 462.57,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "204",
     "rows": 12,
     "label": "204",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 556.86,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "205",
     "rows": 12,
     "label": "205",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 651.14,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "206",
     "rows": 12,
     "label": "206",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 745.43,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "207",
     "rows": 12,
     "label": "207",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 839.71,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "208",
     "rows": 12,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -54.8,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "209",
     "rows": 12,
     "label": "209",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -53.2,
      "a1": -18.8,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "210",
     "rows": 12,
     "label": "210",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -17.2,
      "a1": 17.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "211",
     "rows": 12,
     "label": "211",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 18.8,
      "a1": 53.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "212",
     "rows": 12,
     "label": "212",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 54.8,
      "a1": 89.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "213",
     "rows": 12,
     "label": "213",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 839.71,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "214",
     "rows": 12,
     "label": "214",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 745.43,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "215",
     "rows": 12,
     "label": "215",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 651.14,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "216",
     "rows": 12,
     "label": "216",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 556.86,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "217",
     "rows": 12,
     "label": "217",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 462.57,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "218",
     "rows": 12,
     "label": "218",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 368.29,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    },
    {
     "id": "219",
     "rows": 12,
     "label": "219",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 274,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxmow000mr91gocmd7en7"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:44.576Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:44.576Z",
  "updatedAt": "2026-11-24T05:05:52.219Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxoti0011r91gemmsgqvn",
  "slug": "midnight-orchestra",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxotf000zr91gzklauv3m",
  "title": "The Midnight Orchestra",
  "subtitle": "Film scores by candlelight",
  "description": "A 60-piece orchestra plays the great film scores of the last forty years, lit only by a thousand candles.\n\nArrive early to hear the open rehearsal in the foyer.",
  "category": "CONCERTS",
  "imageUrl": "https://images.unsplash.com/photo-1465847899084-d164df4dedc6?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2027-01-23T20:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Europe/London",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "SOUND",
     "kind": "other",
     "label": "Sound desk",
     "geometry": {
      "h": 70,
      "w": 80,
      "x": 730,
      "y": 345
     }
    }
   ],
   "stage": {
    "h": 260,
    "w": 100,
    "x": 100,
    "y": 250,
    "kind": "stage",
    "label": "STAGE"
   },
   "width": 1300,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "FL",
     "label": "Floor",
     "shape": "rect",
     "seating": "ga",
     "capacity": 1800,
     "geometry": {
      "h": 260,
      "w": 450,
      "x": 240,
      "y": 250
     },
     "ticketTypeId": "cmwtmxoti0014r91gv3mdjzcy"
    },
    {
     "id": "101",
     "rows": 14,
     "label": "101",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 274,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "102",
     "rows": 14,
     "label": "102",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 384,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "103",
     "rows": 14,
     "label": "103",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 494,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "104",
     "rows": 14,
     "label": "104",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 604,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "105",
     "rows": 14,
     "label": "105",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 714,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "106",
     "rows": 14,
     "label": "106",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 824,
      "y": 130,
      "rotation": 180
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "107",
     "rows": 14,
     "label": "107",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -45.8,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "108",
     "rows": 14,
     "label": "108",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -44.2,
      "a1": -0.8,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "109",
     "rows": 14,
     "label": "109",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 0.8,
      "a1": 44.2,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "110",
     "rows": 14,
     "label": "110",
     "level": "Lower Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 45.8,
      "a1": 89.2,
      "cx": 930,
      "cy": 380,
      "r0": 170,
      "r1": 250
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "111",
     "rows": 14,
     "label": "111",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 824,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "112",
     "rows": 14,
     "label": "112",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 714,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "113",
     "rows": 14,
     "label": "113",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 604,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "114",
     "rows": 14,
     "label": "114",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 494,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "115",
     "rows": 14,
     "label": "115",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 384,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "116",
     "rows": 14,
     "label": "116",
     "level": "Lower Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 80,
      "w": 102,
      "x": 274,
      "y": 550
     },
     "seatsPerRow": 20,
     "ticketTypeId": "cmwtmxoti0013r91gcqcp38gd"
    },
    {
     "id": "201",
     "rows": 12,
     "label": "201",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 274,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "202",
     "rows": 12,
     "label": "202",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 368.29,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "203",
     "rows": 12,
     "label": "203",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 462.57,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "204",
     "rows": 12,
     "label": "204",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 556.86,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "205",
     "rows": 12,
     "label": "205",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 651.14,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "206",
     "rows": 12,
     "label": "206",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 745.43,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "207",
     "rows": 12,
     "label": "207",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 839.71,
      "y": 40,
      "rotation": 180
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "208",
     "rows": 12,
     "label": "208",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -89.2,
      "a1": -54.8,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "209",
     "rows": 12,
     "label": "209",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -53.2,
      "a1": -18.8,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "210",
     "rows": 12,
     "label": "210",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": -17.2,
      "a1": 17.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "211",
     "rows": 12,
     "label": "211",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 18.8,
      "a1": 53.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "212",
     "rows": 12,
     "label": "212",
     "level": "Upper Level",
     "shape": "arc",
     "seating": "reserved",
     "geometry": {
      "a0": 54.8,
      "a1": 89.2,
      "cx": 930,
      "cy": 380,
      "r0": 270,
      "r1": 340
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "213",
     "rows": 12,
     "label": "213",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 839.71,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "214",
     "rows": 12,
     "label": "214",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 745.43,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "215",
     "rows": 12,
     "label": "215",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 651.14,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "216",
     "rows": 12,
     "label": "216",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 556.86,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "217",
     "rows": 12,
     "label": "217",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 462.57,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "218",
     "rows": 12,
     "label": "218",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 368.29,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    },
    {
     "id": "219",
     "rows": 12,
     "label": "219",
     "level": "Upper Level",
     "shape": "rect",
     "seating": "reserved",
     "geometry": {
      "h": 70,
      "w": 86.29,
      "x": 274,
      "y": 650
     },
     "seatsPerRow": 24,
     "ticketTypeId": "cmwtmxoti0012r91g9hfkr135"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:47.334Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:47.334Z",
  "updatedAt": "2026-11-24T05:05:52.234Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 },
 {
  "id": "cmwtmxt88001yr91g7kghf7y8",
  "slug": "lagoon-sound",
  "orgId": "cmwtfcz5f0003r9h42cqrallm",
  "venueId": "cmwtmxt85001wr91gnjguw2ci",
  "title": "Lagoon Sound Festival",
  "subtitle": "2 days on the water",
  "description": "Two days of Afrobeats, amapiano and highlife on the sand at Tarkwa Bay, with boats running from the city all day.",
  "category": "FESTIVALS",
  "imageUrl": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=900&q=70",
  "startsAt": "2026-12-31T16:00:00.000Z",
  "doorsAt": null,
  "endsAt": null,
  "timezone": "Africa/Lagos",
  "online": false,
  "status": "PUBLISHED",
  "visibility": "PUBLIC",
  "feeMode": "BUYER",
  "currency": "USD",
  "salesPaused": true,
  "cancelledAt": null,
  "cancelReason": null,
  "seatMap": {
   "areas": [
    {
     "id": "FOOD",
     "kind": "bar",
     "label": "Food court",
     "geometry": {
      "h": 80,
      "w": 290,
      "x": 170,
      "y": 640
     }
    },
    {
     "id": "BARS",
     "kind": "bar",
     "label": "Bars",
     "geometry": {
      "h": 80,
      "w": 200,
      "x": 480,
      "y": 640
     }
    },
    {
     "id": "GATE",
     "kind": "entrance",
     "label": "Entrance",
     "geometry": {
      "h": 80,
      "w": 330,
      "x": 700,
      "y": 640
     }
    },
    {
     "id": "TOWER",
     "kind": "other",
     "label": "Sound tower",
     "geometry": {
      "h": 60,
      "w": 80,
      "x": 560,
      "y": 470
     }
    }
   ],
   "stage": {
    "h": 100,
    "w": 360,
    "x": 420,
    "y": 36,
    "kind": "stage",
    "label": "MAIN STAGE"
   },
   "width": 1200,
   "height": 760,
   "version": 1,
   "sections": [
    {
     "id": "GA",
     "label": "Festival field",
     "shape": "rect",
     "seating": "ga",
     "capacity": 6000,
     "geometry": {
      "h": 460,
      "w": 860,
      "x": 170,
      "y": 160
     },
     "ticketTypeId": "cmwtmxt88001zr91gxfb4wvnc"
    },
    {
     "id": "PLUS",
     "label": "GA+ lounge",
     "shape": "rect",
     "seating": "ga",
     "capacity": 800,
     "geometry": {
      "h": 380,
      "w": 120,
      "x": 30,
      "y": 200
     },
     "ticketTypeId": "cmwtmxt880020r91gk2ezmej8"
    },
    {
     "id": "VIP",
     "label": "VIP deck",
     "shape": "rect",
     "seating": "ga",
     "capacity": 300,
     "geometry": {
      "h": 380,
      "w": 120,
      "x": 1050,
      "y": 200
     },
     "ticketTypeId": "cmwtmxt880021r91grrn70pfp"
    }
   ]
  },
  "media": null,
  "dateMode": "SINGLE",
  "publishedAt": "2026-11-23T19:04:53.048Z",
  "spotlightAt": null,
  "createdAt": "2026-11-23T19:04:53.048Z",
  "updatedAt": "2026-11-24T05:05:52.261Z",
  "resaleEnabled": true,
  "resaleCapPercent": 150,
  "resaleRoyaltyPermille": 0,
  "transfersEnabled": true,
  "transferCutoffMinutes": 60,
  "donationsEnabled": false,
  "donationCause": null,
  "donationDescription": null,
  "donationSuggestedCents": [],
  "donationMinCents": null,
  "compLimit": null
 }
]$catalog$::jsonb)
WHERE current_database() = 'rkdb_eb0ba5b80188'
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "TicketType" ("id", "eventId", "name", "description", "priceCents", "capacity", "sold", "maxPerOrder", "sortOrder", "perks", "badge", "style", "pricing", "pwywMinCents", "pwywSuggestedCents", "pwywMaxCents", "pwywQuickPicks", "salesStart", "salesEnd", "eventDateId", "tierKey", "validDateIds")
SELECT "id", "eventId", "name", "description", "priceCents", "capacity", "sold", "maxPerOrder", "sortOrder", "perks", "badge", "style", "pricing", "pwywMinCents", "pwywSuggestedCents", "pwywMaxCents", "pwywQuickPicks", "salesStart", "salesEnd", "eventDateId", "tierKey", "validDateIds"
FROM jsonb_populate_recordset(NULL::"TicketType", $catalog$[
 {
  "id": "cmwtfcz5x0009r9h4ir83lub2",
  "eventId": "cmwtfcz5x0008r9h46zwhpo30",
  "name": "Floor GA",
  "description": "",
  "priceCents": 18216,
  "capacity": 1200,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxjxy0006r91ghfcf2act",
  "eventId": "cmwtmxjxy0005r91gbi06hlme",
  "name": "Upper tier",
  "description": "Full view of the action",
  "priceCents": 3800,
  "capacity": 5280,
  "sold": 4239,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz5x000br9h4isv09ftv",
  "eventId": "cmwtfcz5x0008r9h46zwhpo30",
  "name": "Upper bowl",
  "description": "",
  "priceCents": 8901,
  "capacity": 2688,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6n000hr9h46e78w67g",
  "eventId": "cmwtfcz6n000gr9h4mhn2f7i8",
  "name": "Upper tier",
  "description": "",
  "priceCents": 5382,
  "capacity": 2000,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6n000ir9h4lgltg67o",
  "eventId": "cmwtfcz6n000gr9h4mhn2f7i8",
  "name": "Lower tier",
  "description": "",
  "priceCents": 11282,
  "capacity": 900,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6n000jr9h4768q9wxz",
  "eventId": "cmwtfcz6n000gr9h4mhn2f7i8",
  "name": "Club level",
  "description": "",
  "priceCents": 22563,
  "capacity": 120,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6u000qr9h49f6t9snc",
  "eventId": "cmwtfcz6u000or9h45ob56g25",
  "name": "3-Day GA+",
  "description": "",
  "priceCents": 30429,
  "capacity": 1500,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6u000rr9h4zwvwcz98",
  "eventId": "cmwtfcz6u000or9h45ob56g25",
  "name": "3-Day VIP",
  "description": "",
  "priceCents": 57236,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz71000xr9h4hlddaljf",
  "eventId": "cmwtfcz71000wr9h400h8p0h7",
  "name": "General admission",
  "description": "",
  "priceCents": 4244,
  "capacity": 340,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz71000yr9h4khltzjj6",
  "eventId": "cmwtfcz71000wr9h400h8p0h7",
  "name": "Front tables",
  "description": "",
  "priceCents": 6728,
  "capacity": 60,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz780014r9h4qjsxw5jm",
  "eventId": "cmwtfcz780013r9h4io3x9sdr",
  "name": "General admission",
  "description": "",
  "priceCents": 3519,
  "capacity": 2000,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz7f001br9h4u68ncacw",
  "eventId": "cmwtfcz7f001ar9h46xww6kyk",
  "name": "Stalls",
  "description": "",
  "priceCents": 6521,
  "capacity": 600,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz7f001cr9h48yxxb2fg",
  "eventId": "cmwtfcz7f001ar9h46xww6kyk",
  "name": "Dress circle",
  "description": "",
  "priceCents": 9522,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxjxy0008r91g77qw9pwe",
  "eventId": "cmwtmxjxy0005r91gbi06hlme",
  "name": "Club level",
  "description": "Padded seats, lounge, in-seat service",
  "priceCents": 16000,
  "capacity": 1008,
  "sold": 980,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtnorfe0004r9ns8nvvru71",
  "eventId": "cmwtnorfe0002r9ns73bv6r6h",
  "name": "VIP lounge",
  "description": "",
  "priceCents": 6210,
  "capacity": 156,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxlbx000gr91grmerfcd4",
  "eventId": "cmwtmxlbx000dr91gkotu34i4",
  "name": "Family 4-pack",
  "description": "Four seats together, snacks included",
  "priceCents": 9900,
  "capacity": 298,
  "sold": 208,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxlbx000er91gebu9s075",
  "eventId": "cmwtmxlbx000dr91gkotu34i4",
  "name": "Standard",
  "description": "Reserved seating",
  "priceCents": 2900,
  "capacity": 8304,
  "sold": 7051,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxlbx000fr91gnxy0qdv5",
  "eventId": "cmwtmxlbx000dr91gkotu34i4",
  "name": "Rinkside",
  "description": "First two rows, meet the skaters",
  "priceCents": 7500,
  "capacity": 1008,
  "sold": 917,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxmow000or91g8ugm0of1",
  "eventId": "cmwtmxmow000lr91g5ktlaiyz",
  "name": "Floor GA",
  "description": "Standing, closest to the stage",
  "priceCents": 11900,
  "capacity": 1800,
  "sold": 1764,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxmow000pr91g8otopwx9",
  "eventId": "cmwtmxmow000lr91g5ktlaiyz",
  "name": "VIP package",
  "description": "Premium seat, merch bundle, early entry",
  "priceCents": 20900,
  "capacity": 16,
  "sold": 7,
  "maxPerOrder": 8,
  "sortOrder": 3,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxmow000mr91gocmd7en7",
  "eventId": "cmwtmxmow000lr91g5ktlaiyz",
  "name": "Upper bowl",
  "description": "Reserved seating",
  "priceCents": 5800,
  "capacity": 5472,
  "sold": 4580,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxmow000nr91g4pt9nhoa",
  "eventId": "cmwtmxmow000lr91g5ktlaiyz",
  "name": "Lower bowl",
  "description": "Reserved, closer to the stage",
  "priceCents": 9600,
  "capacity": 4480,
  "sold": 3785,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxom0000wr91g42guynhr",
  "eventId": "cmwtmxom0000ur91g8bkaas1j",
  "name": "Front tables",
  "description": "Reserved, first three rows",
  "priceCents": 3800,
  "capacity": 156,
  "sold": 143,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxoti0014r91gv3mdjzcy",
  "eventId": "cmwtmxoti0011r91gemmsgqvn",
  "name": "Floor GA",
  "description": "Standing, closest to the stage",
  "priceCents": 9800,
  "capacity": 1800,
  "sold": 1764,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxoti0015r91gkr9eh7h5",
  "eventId": "cmwtmxoti0011r91gemmsgqvn",
  "name": "VIP package",
  "description": "Premium seat, merch bundle, early entry",
  "priceCents": 17300,
  "capacity": 31,
  "sold": 22,
  "maxPerOrder": 8,
  "sortOrder": 3,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxoti0013r91gcqcp38gd",
  "eventId": "cmwtmxoti0011r91gemmsgqvn",
  "name": "Lower bowl",
  "description": "Reserved, closer to the stage",
  "priceCents": 7900,
  "capacity": 4480,
  "sold": 3939,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxqkm001br91gqiy6ikr6",
  "eventId": "cmwtmxqkm001ar91go7isr007",
  "name": "Upper tier",
  "description": "Full view of the action",
  "priceCents": 3200,
  "capacity": 5280,
  "sold": 4102,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxqkm001cr91g8e29r4q3",
  "eventId": "cmwtmxqkm001ar91go7isr007",
  "name": "Lower tier",
  "description": "Close to the field, sideline views",
  "priceCents": 6700,
  "capacity": 3024,
  "sold": 2561,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxqkm001dr91g5x4169bx",
  "eventId": "cmwtmxqkm001ar91go7isr007",
  "name": "Club level",
  "description": "Padded seats, lounge, in-seat service",
  "priceCents": 13400,
  "capacity": 1008,
  "sold": 885,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxrvm001jr91g9m51k1j1",
  "eventId": "cmwtmxrvm001ir91g7c8fd6p1",
  "name": "3-Day GA",
  "description": "All stages, all three days",
  "priceCents": 7900,
  "capacity": 6000,
  "sold": 4760,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxrvm001kr91gmghurlon",
  "eventId": "cmwtmxrvm001ir91g7c8fd6p1",
  "name": "3-Day GA+",
  "description": "Shaded lounge, faster entry, private restrooms",
  "priceCents": 13400,
  "capacity": 800,
  "sold": 490,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxrvm001lr91g1hztmxv4",
  "eventId": "cmwtmxrvm001ir91g7c8fd6p1",
  "name": "3-Day VIP",
  "description": "Front-of-stage viewing, artist lounge",
  "priceCents": 25300,
  "capacity": 300,
  "sold": 258,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxsvl001rr91go6bf0zj8",
  "eventId": "cmwtmxsvl001qr91g1byns55i",
  "name": "Standard",
  "description": "Reserved seating",
  "priceCents": 3900,
  "capacity": 720,
  "sold": 200,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxsvl001tr91gof0z927m",
  "eventId": "cmwtmxsvl001qr91g1byns55i",
  "name": "Family 4-pack",
  "description": "Four seats together, snacks included",
  "priceCents": 13300,
  "capacity": 212,
  "sold": 122,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxsvl001sr91g6elsdiaa",
  "eventId": "cmwtmxsvl001qr91g1byns55i",
  "name": "Rinkside",
  "description": "First two rows, meet the skaters",
  "priceCents": 10100,
  "capacity": 1548,
  "sold": 1343,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxt88001zr91gxfb4wvnc",
  "eventId": "cmwtmxt88001yr91g7kghf7y8",
  "name": "3-Day GA",
  "description": "All stages, all three days",
  "priceCents": 6500,
  "capacity": 6000,
  "sold": 4760,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxt880020r91gk2ezmej8",
  "eventId": "cmwtmxt88001yr91g7kghf7y8",
  "name": "3-Day GA+",
  "description": "Shaded lounge, faster entry, private restrooms",
  "priceCents": 11100,
  "capacity": 800,
  "sold": 490,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxt880021r91grrn70pfp",
  "eventId": "cmwtmxt88001yr91g7kghf7y8",
  "name": "3-Day VIP",
  "description": "Front-of-stage viewing, artist lounge",
  "priceCents": 20800,
  "capacity": 300,
  "sold": 258,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxubd0027r91gcoxtv6r6",
  "eventId": "cmwtmxubd0026r91g4jid4312",
  "name": "Upper bowl",
  "description": "Reserved seating",
  "priceCents": 5500,
  "capacity": 1100,
  "sold": 460,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxubd0028r91g5x9hlquw",
  "eventId": "cmwtmxubd0026r91g4jid4312",
  "name": "Lower bowl",
  "description": "Reserved, closer to the stage",
  "priceCents": 9100,
  "capacity": 448,
  "sold": 268,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxubd002ar91gqki8m5ot",
  "eventId": "cmwtmxubd0026r91g4jid4312",
  "name": "VIP package",
  "description": "Premium seat, merch bundle, early entry",
  "priceCents": 19800,
  "capacity": 20,
  "sold": 11,
  "maxPerOrder": 8,
  "sortOrder": 3,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxubd0029r91gmgrchy8l",
  "eventId": "cmwtmxubd0026r91g4jid4312",
  "name": "Floor GA",
  "description": "Standing, closest to the stage",
  "priceCents": 11300,
  "capacity": 720,
  "sold": 599,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz5x000ar9h46g8ncsid",
  "eventId": "cmwtfcz5x0008r9h46zwhpo30",
  "name": "Lower bowl",
  "description": "",
  "priceCents": 14697,
  "capacity": 1440,
  "sold": 2,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz780015r9h4tbz2da7d",
  "eventId": "cmwtfcz780013r9h4io3x9sdr",
  "name": "VIP deck",
  "description": "",
  "priceCents": 12420,
  "capacity": 152,
  "sold": 2,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtnorfe0003r9nss626idtm",
  "eventId": "cmwtnorfe0002r9ns73bv6r6h",
  "name": "General admission",
  "description": "",
  "priceCents": 2588,
  "capacity": 1050,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtfcz6u000pr9h4v0eymuf9",
  "eventId": "cmwtfcz6u000or9h45ob56g25",
  "name": "3-Day GA",
  "description": "",
  "priceCents": 17906,
  "capacity": 8000,
  "sold": 1,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxom0000vr91ghkv21cdw",
  "eventId": "cmwtmxom0000ur91g8bkaas1j",
  "name": "General admission",
  "description": "First come, first seated",
  "priceCents": 2400,
  "capacity": 1050,
  "sold": 986,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxoti0012r91g9hfkr135",
  "eventId": "cmwtmxoti0011r91gemmsgqvn",
  "name": "Upper bowl",
  "description": "Reserved seating",
  "priceCents": 4800,
  "capacity": 5472,
  "sold": 4381,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu0gy9i0004r9fkgal2hrf4",
  "eventId": "cmwu0gy9i0001r9fkr85w09su",
  "name": "VVIP",
  "description": "",
  "priceCents": 517500,
  "capacity": 200,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu0gy9i0002r9fkrbdx5rre",
  "eventId": "cmwu0gy9i0001r9fkr85w09su",
  "name": "General admission",
  "description": "",
  "priceCents": 124200,
  "capacity": 301,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu1sjw50004r9y08bmo3pz6",
  "eventId": "cmwu1sjw50002r9y0qrv6fo2d",
  "name": "VVIP",
  "description": "",
  "priceCents": 310500,
  "capacity": 3500,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [
   "Everything in VIP",
   "Dedicated entrance",
   "Complimentary drinks",
   "Meet & greet",
   "Fast-track entry"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu1sjw50003r9y0366v7542",
  "eventId": "cmwu1sjw50002r9y0qrv6fo2d",
  "name": "Special VIP",
  "description": "",
  "priceCents": 207000,
  "capacity": 2000,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [
   "Everything in VVIP",
   "Front-row seating",
   "Personal host or usher",
   "Reserved parking",
   "Priority entry"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu1sjw50005r9y0e0ytomid",
  "eventId": "cmwu1sjw50002r9y0qrv6fo2d",
  "name": "VIP",
  "description": "",
  "priceCents": 155250,
  "capacity": 400,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [
   "Priority entry",
   "Reserved seating near the stage",
   "VIP lounge access"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu1sjw50006r9y0tzj4xwjq",
  "eventId": "cmwu1sjw50002r9y0qrv6fo2d",
  "name": "General admission",
  "description": "",
  "priceCents": 10350,
  "capacity": 122,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 3,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwtmxjxy0007r91gvlwz18j3",
  "eventId": "cmwtmxjxy0005r91gbi06hlme",
  "name": "Lower tier",
  "description": "Close to the field, sideline views",
  "priceCents": 8000,
  "capacity": 3024,
  "sold": 2542,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwu0gy9i0003r9fkuqwzmtjp",
  "eventId": "cmwu0gy9i0001r9fkr85w09su",
  "name": "VIP",
  "description": "",
  "priceCents": 207000,
  "capacity": 200,
  "sold": 1,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwvn87tk001dr9hces7gvj9e",
  "eventId": "cmwvn87tk001cr9hczbbxegyt",
  "name": "Special Seat",
  "description": "",
  "priceCents": 310500,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [
   "Everything in VIP",
   "Dedicated entrance",
   "Complimentary drinks",
   "Meet & greet"
  ],
  "badge": "PT",
  "style": "platinum",
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwvn87tk001er9hc5irf8jw7",
  "eventId": "cmwvn87tk001cr9hczbbxegyt",
  "name": "VIP",
  "description": "",
  "priceCents": 155250,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [
   "Priority entry",
   "Reserved seating near the stage",
   "VIP lounge access"
  ],
  "badge": "BG",
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmwvn87tk001fr9hc0n9a0e50",
  "eventId": "cmwvn87tk001cr9hczbbxegyt",
  "name": "General admission",
  "description": "",
  "priceCents": 0,
  "capacity": 200,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [
   "Open seating or standing"
  ],
  "badge": "LE",
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmww9ibwt0075r90oj9urgyvp",
  "eventId": "cmww9ibws0074r90o243mb9n8",
  "name": "VVIP",
  "description": "",
  "priceCents": 414000,
  "capacity": 500,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [
   "Everything in VIP",
   "Dedicated entrance",
   "Complimentary drinks",
   "Meet & greet"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmww9ibwt0076r90ol6pbzsrk",
  "eventId": "cmww9ibws0074r90o243mb9n8",
  "name": "VIP",
  "description": "",
  "priceCents": 207000,
  "capacity": 501,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [
   "Priority entry",
   "Reserved seating near the stage",
   "VIP lounge access"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmww9ibwt0077r90ogod7v59q",
  "eventId": "cmww9ibws0074r90o243mb9n8",
  "name": "General admission",
  "description": "",
  "priceCents": 0,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 2,
  "perks": [
   "Access to bars and food",
   "Fast-track entry"
  ],
  "badge": "Most popular",
  "style": "platinum",
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmww9wrfn0003r9tg1yv8y3p5",
  "eventId": "cmww9wrfn0002r9tgw2p07y6u",
  "name": "VIP",
  "description": "",
  "priceCents": 310500,
  "capacity": 4000,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 0,
  "perks": [
   "Priority entry",
   "Reserved seating near the stage",
   "VIP lounge access"
  ],
  "badge": null,
  "style": null,
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 },
 {
  "id": "cmww9wrfo0004r9tgv06q6aj9",
  "eventId": "cmww9wrfn0002r9tgw2p07y6u",
  "name": "General admission",
  "description": "",
  "priceCents": 1242,
  "capacity": 300,
  "sold": 0,
  "maxPerOrder": 8,
  "sortOrder": 1,
  "perks": [
   "Entry to the event",
   "Access to bars and food"
  ],
  "badge": null,
  "style": "early",
  "pricing": "FIXED",
  "pwywMinCents": null,
  "pwywSuggestedCents": null,
  "pwywMaxCents": null,
  "pwywQuickPicks": [],
  "salesStart": null,
  "salesEnd": null,
  "eventDateId": null,
  "tierKey": null,
  "validDateIds": []
 }
]$catalog$::jsonb)
WHERE current_database() = 'rkdb_eb0ba5b80188'
ON CONFLICT ("id") DO NOTHING;
COMMIT;
