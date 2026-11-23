/**
 * Places, for a ticketing site used worldwide.
 *
 *   GET /geo/countries                    every country, with its currency and calling code
 *   GET /geo/countries/:code/regions      states, provinces or regions of one country
 *   GET /geo/search?q=&country=           address suggestions (OpenStreetMap data via Photon), with time zone
 *   GET /geo/timezone?lat=&lng=           IANA time zone for a point
 *   GET /geo/me                           where the visitor probably is (country, currency), from the request
 *
 * Address lookups go through this API, so visitors' IPs aren't sent to the map service, and results are cached.
 */
import { BadRequestException, Controller, Get, Global, Injectable, Logger, Module, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Country, State } from 'country-state-city';
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
};

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

/** The main time zone of a country (used when a venue has no coordinates). */
export function countryTimezone(code: string | null | undefined): string | null {
  if (!code) return null;
  return Country.getCountryByCode(code.toUpperCase())?.timezones?.[0]?.zoneName ?? null;
}

const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code', 'x-appengine-country', 'fastly-geo-country'];
const CITY_HEADERS = ['x-vercel-ip-city', 'cf-ipcity', 'x-appengine-city'];

@Injectable()
export class GeoService {
  private readonly log = new Logger('Geo');
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

  async search(q: string, country?: string, lat?: number, lng?: number): Promise<Suggestion[]> {
    const text = q.trim().replace(/\s+/g, ' ');
    if (text.length < 3) return [];
    const cc = country?.toUpperCase();
    const key = `${cc ?? ''}|${text.toLowerCase()}|${lat?.toFixed(1) ?? ''},${lng?.toFixed(1) ?? ''}`;
    const hit = this.searches.get(key);
    if (hit) return hit;

    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', text);
    url.searchParams.set('limit', '12');
    url.searchParams.set('lang', 'en');
    if (lat !== undefined && lng !== undefined) {
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
    }
    let data: { features?: { geometry: { coordinates: [number, number] }; properties: Record<string, string | undefined> }[] };
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Eventro/1.0 (event venue search)' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      data = (await res.json()) as typeof data;
    } catch (e) {
      this.log.warn(`Address search failed: ${(e as Error).message}`);
      return [];
    }
    const out: Suggestion[] = [];
    for (const f of data.features ?? []) {
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
      if (out.length >= 6) break;
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
      timezone: c?.timezones?.[0]?.zoneName ?? null,
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
    return this.geo.search(q, country && /^[A-Za-z]{2}$/.test(country) ? country : undefined, Number.isFinite(la) ? la : undefined, Number.isFinite(ln) ? ln : undefined);
  }

  @Public()
  @Get('timezone')
  timezone(@Query('lat') lat: string, @Query('lng') lng: string) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw new BadRequestException('Give lat and lng.');
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
