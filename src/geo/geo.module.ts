/**
 * Places, for a ticketing site used worldwide.
 *
 *   GET /geo/countries                    every country, with its currency and calling code
 *   GET /geo/countries/:code/regions      states, provinces or regions of one country
 *   GET /geo/search?q=&country=           address suggestions (OpenStreetMap data via Photon), with time zone
 *   GET /geo/timezone?lat=&lng=           IANA time zone for a point
 *   GET /geo/timezone?country=&region=    best-guess zone for a place without a map position
 *   GET /geo/me                           where the visitor probably is (country, currency), from the request
 *
 * Address lookups go through this API, so visitors' IPs aren't sent to the map service, and results are cached.
 */
import { BadRequestException, Controller, Get, Global, Injectable, Logger, Module, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Country, State } from 'country-state-city';
import { PrismaService } from '../prisma.service';
import tzlookup from '@photostructure/tz-lookup';
import { config } from '../config';
import { Public } from '../common/auth';
import { CURRENCIES, currencyForCountry } from '../domain/currency';

type Suggestion = {
  label: string;
  name: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number;
  lng: number;
  timezone: string | null;
  /** set when this is a venue already on Omoshow (shown first, with how many events it has hosted) */
  venueId?: string;
  events?: number;
};

type PhotonFeature = { geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> };

/** A small time-limited cache (address searches repeat a lot while typing). */
class Cache<T> {
  private readonly map = new Map<string, { at: number; value: T }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 2000,
  ) {}
  get(k: string) {
    const hit = this.map.get(k);
    if (!hit || Date.now() - hit.at > this.ttlMs) return undefined;
    return hit.value;
  }
  set(k: string, value: T) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(k, { at: Date.now(), value });
  }
}

/** True for IANA zone names the runtime knows ("Africa/Lagos", "UTC"). */
export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timezoneAt(lat: number, lng: number): string | null {
  try {
    return tzlookup(lat, lng);
  } catch {
    return null;
  }
}

/**
 * Where most people live in countries that span several zones. The country list's first zone is alphabetical, not
 * the main one (the US would get America/Adak, in the Aleutians), so it can't be used as the default.
 */
const MAIN_ZONE: Record<string, string> = {
  US: 'America/New_York',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  RU: 'Europe/Moscow',
  ID: 'Asia/Jakarta',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  CD: 'Africa/Kinshasa',
  KZ: 'Asia/Almaty',
  MY: 'Asia/Kuala_Lumpur',
  UA: 'Europe/Kyiv',
  NZ: 'Pacific/Auckland',
  EC: 'America/Guayaquil',
  DE: 'Europe/Berlin',
  CN: 'Asia/Shanghai',
  MN: 'Asia/Ulaanbaatar',
  GL: 'America/Nuuk',
  PG: 'Pacific/Port_Moresby',
  KI: 'Pacific/Tarawa',
  FM: 'Pacific/Pohnpei',
  PF: 'Pacific/Tahiti',
  CY: 'Asia/Nicosia',
  DK: 'Europe/Copenhagen',
  NL: 'Europe/Amsterdam',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
};

/** A zone the runtime knows, trying an older alias too (Europe/Kyiv was Europe/Kiev in older ICU data). */
const known = (tz: string | null | undefined) => (!tz ? null : isTimeZone(tz) ? tz : tz === 'Europe/Kyiv' && isTimeZone('Europe/Kiev') ? 'Europe/Kiev' : null);

/** The main time zone of a country: its main zone, its only zone, or the zone at its centre. */
export function countryTimezone(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = Country.getCountryByCode(code.toUpperCase());
  if (!c) return null;
  const zones = (c.timezones ?? []).map((z) => z.zoneName);
  const main = known(MAIN_ZONE[c.isoCode]);
  if (main) return main;
  if (zones.length === 1) return zones[0];
  const centre = Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude)) ? timezoneAt(Number(c.latitude), Number(c.longitude)) : null;
  return centre && zones.includes(centre) ? centre : (zones[0] ?? null);
}

/**
 * The best zone for a place without a map position: the zone in the middle of its state or province when we know
 * which one (Texas → America/Chicago), else the country's main zone. The region can be a name or a code.
 */
export function placeTimezone(country: string | null | undefined, region?: string | null): string | null {
  if (!country) return null;
  const code = country.toUpperCase();
  const r = region?.trim().toLowerCase();
  if (r) {
    const s = State.getStatesOfCountry(code).find((x) => x.name.toLowerCase() === r || x.isoCode.toLowerCase() === r);
    const tz = s && s.latitude && s.longitude ? timezoneAt(Number(s.latitude), Number(s.longitude)) : null;
    // Ocean points come back as Etc/GMT±n; those aren't a place's zone.
    if (tz && !tz.startsWith('Etc/')) return tz;
  }
  return countryTimezone(code);
}

const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'x-appengine-country', 'fastly-geo-country'];
const CITY_HEADERS = ['x-vercel-ip-city', 'cf-ipcity', 'x-appengine-city'];

@Injectable()
export class GeoService {
  private readonly log = new Logger('Geo');
  constructor(private readonly prisma: PrismaService) {}

  /** Venues already on Omoshow whose name matches, most-used first. */
  async eventroVenues(q: string, country?: string): Promise<Suggestion[]> {
    const text = q.trim();
    if (text.length < 2) return [];
    const rows = await this.prisma.venue.findMany({
      where: { hiddenAt: null, name: { contains: text, mode: 'insensitive' }, ...(country ? { OR: [{ country: country.toUpperCase() }, { country: null }] } : {}) },
      include: { _count: { select: { events: true } } },
      take: 20,
    });
    return rows
      // verified venues first, then the most used
      .sort((a, b) => Number(!!b.verifiedAt) - Number(!!a.verifiedAt) || b._count.events - a._count.events)
      .slice(0, 4)
      .map((v) => ({
        label: [v.name, v.address, v.city, v.region].filter(Boolean).join(', '),
        name: v.name,
        street: v.address,
        city: v.city,
        region: v.region,
        postalCode: v.postalCode,
        country: v.country,
        lat: v.lat ?? 0,
        lng: v.lng ?? 0,
        timezone: v.timezone,
        venueId: v.id,
        events: v._count.events,
      }));
  }
  private readonly searches = new Cache<Suggestion[]>(24 * 3600_000);
  private readonly ips = new Cache<{ country: string | null; city: string | null; region: string | null }>(6 * 3600_000, 5000);
  private countriesCache: ReturnType<GeoService['buildCountries']> | null = null;

  private buildCountries() {
    return Country.getAllCountries()
      .map((c) => ({ code: c.isoCode, name: c.name, flag: c.flag, phoneCode: c.phonecode, currency: currencyForCountry(c.isoCode, c.currency), localCurrency: c.currency }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  countries() {
    this.countriesCache ??= this.buildCountries();
    return this.countriesCache;
  }

  regions(code: string) {
    const c = Country.getCountryByCode(code.toUpperCase());
    if (!c) throw new NotFoundException('Unknown country.');
    return State.getStatesOfCountry(c.isoCode)
      .map((s) => ({ code: s.isoCode, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One Photon (OpenStreetMap) query; null when the service can't be reached. */
  private async photon(q: string, bias: { lat: number; lng: number } | undefined, limit: number): Promise<PhotonFeature[] | null> {
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('lang', 'en');
    if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
      url.searchParams.set('lat', String(bias.lat));
      url.searchParams.set('lon', String(bias.lng));
    }
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Omoshow/1.0 (event venue search)' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return ((await res.json()) as { features?: PhotonFeature[] }).features ?? [];
    } catch (e) {
      this.log.warn(`Address search failed: ${(e as Error).message}`);
      return null;
    }
  }

  async search(q: string, country?: string, lat?: number, lng?: number): Promise<Suggestion[]> {
    const text = q.trim().replace(/\s+/g, ' ');
    if (text.length < 3) return [];
    const cc = country?.toUpperCase();
    const key = `${cc ?? ''}|${text.toLowerCase()}|${lat?.toFixed(1) ?? ''},${lng?.toFixed(1) ?? ''}`;
    const hit = this.searches.get(key);
    if (hit) return hit;

    // Short names ("Eko") match places worldwide first, so a country search is biased towards that country and,
    // if that still finds little, asked again as "Eko, Nigeria".
    const countryInfo = cc ? Country.getCountryByCode(cc) : undefined;
    const bias = lat !== undefined && lng !== undefined ? { lat, lng } : countryInfo ? { lat: Number(countryInfo.latitude), lng: Number(countryInfo.longitude) } : undefined;
    const out: Suggestion[] = [];
    const collect = (features: PhotonFeature[]) => {
      for (const f of features) {
        if (out.length >= 6) return;
        const p = f.properties;
        const code = p.countrycode?.toUpperCase() ?? null;
        if (cc && code !== cc) continue;
        const [lngF, latF] = f.geometry.coordinates;
        const street = [p.housenumber, p.street].filter(Boolean).join(' ') || null;
        const city = p.city ?? p.town ?? p.village ?? p.county ?? null;
        const name = p.name && p.name !== p.street ? p.name : null;
        const label = [name, street, city, p.state, code ? Country.getCountryByCode(code)?.name : null].filter(Boolean).join(', ');
        if (!label || out.some((o) => o.label === label)) continue;
        out.push({ label, name, street, city, region: p.state ?? null, postalCode: p.postcode ?? null, country: code, lat: latF, lng: lngF, timezone: timezoneAt(latF, lngF) });
      }
    };
    const first = await this.photon(text, bias, cc ? 30 : 12);
    if (!first) return [];
    collect(first);
    if (cc && out.length < 3 && countryInfo && !text.toLowerCase().includes(countryInfo.name.toLowerCase())) {
      collect((await this.photon(`${text}, ${countryInfo.name}`, bias, 30)) ?? []);
    }
    this.searches.set(key, out);
    return out;
  }

  /**
   * Where a visitor probably is. In production the host or CDN usually adds a country header; without one, an
   * optional ipinfo.io lookup is used (IPINFO_TOKEN). Locally neither exists, so the website falls back to the
   * browser's time zone and language.
   */
  async me(req: Request) {
    const header = (names: string[]) => {
      for (const n of names) {
        const v = req.headers[n];
        const s = Array.isArray(v) ? v[0] : v;
        if (s && s !== 'XX' && s !== 'T1') return decodeURIComponent(s);
      }
      return null;
    };
    let country = header(COUNTRY_HEADERS)?.toUpperCase() ?? null;
    let city = header(CITY_HEADERS);
    let region: string | null = null;
    let source: 'header' | 'ip' | 'unknown' = country ? 'header' : 'unknown';

    const ip = (req.ip ?? '').replace(/^::ffff:/, '');
    const isPrivate = !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip.startsWith('fc') || ip.startsWith('fd');
    if (!country && config.ipinfoToken && !isPrivate) {
      let hit = this.ips.get(ip);
      if (!hit) {
        try {
          const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${config.ipinfoToken}`, { signal: AbortSignal.timeout(3000) });
          const j = (await res.json()) as { country?: string; city?: string; region?: string };
          hit = { country: j.country ?? null, city: j.city ?? null, region: j.region ?? null };
          this.ips.set(ip, hit);
        } catch {
          hit = { country: null, city: null, region: null };
        }
      }
      if (hit.country) {
        country = hit.country;
        city = hit.city;
        region = hit.region;
        source = 'ip';
      }
    }
    const c = country ? Country.getCountryByCode(country) : undefined;
    return {
      country: c ? c.isoCode : null,
      countryName: c?.name ?? null,
      city,
      region,
      currency: c ? currencyForCountry(c.isoCode, c.currency) : null,
      timezone: c ? placeTimezone(c.isoCode, region) : null,
      source,
    };
  }
}

@ApiTags('geo')
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Public()
  @Get('countries')
  countries() {
    return this.geo.countries();
  }

  @Public()
  @Get('countries/:code/regions')
  regions(@Param('code') code: string) {
    return this.geo.regions(code);
  }

  @Public()
  @Get('search')
  search(@Query('q') q = '', @Query('country') country?: string, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    if (q.length > 120) throw new BadRequestException('Search text is too long.');
    const la = lat === undefined ? undefined : Number(lat);
    const ln = lng === undefined ? undefined : Number(lng);
    const cc = country && /^[A-Za-z]{2}$/.test(country) ? country : undefined;
    return this.combined(q, cc, Number.isFinite(la) ? la : undefined, Number.isFinite(ln) ? ln : undefined);
  }

  /** Venues already on Omoshow first (so organizers reuse them), then new places from the map, without repeats. */
  private async combined(q: string, country?: string, lat?: number, lng?: number) {
    const [mine, map] = await Promise.all([this.geo.eventroVenues(q, country), this.geo.search(q, country, lat, lng)]);
    const key = (s: { name: string | null; city: string | null }) => `${(s.name ?? '').toLowerCase()}|${(s.city ?? '').toLowerCase()}`;
    const seen = new Set(mine.map(key));
    return [...mine, ...map.filter((m) => !seen.has(key(m)))].slice(0, 8);
  }

  @Public()
  @Get('timezone')
  timezone(@Query('lat') lat?: string, @Query('lng') lng?: string, @Query('country') country?: string, @Query('region') region?: string) {
    if (lat === undefined && lng === undefined && country) {
      if (!Country.getCountryByCode(country.toUpperCase())) throw new BadRequestException('Unknown country.');
      return { timezone: placeTimezone(country, region) };
    }
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw new BadRequestException('Give lat and lng, or a country (and region).');
    return { timezone: timezoneAt(la, ln) };
  }

  @Public()
  @Get('me')
  me(@Req() req: Request) {
    return this.geo.me(req);
  }

  /** Currencies an event can be priced in. */
  @Public()
  @Get('currencies')
  currencies() {
    return Object.entries(CURRENCIES).map(([code, c]) => ({ code, ...c }));
  }
}

@Global()
@Module({ controllers: [GeoController], providers: [GeoService], exports: [GeoService] })
export class GeoModule {}
