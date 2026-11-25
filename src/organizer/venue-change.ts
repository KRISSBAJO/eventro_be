/**
 * Moving an in-person event to another venue (PUT /organizer/events/:id/venue), by the org's admins and managers.
 *
 * The new venue is an existing one (`venueId`) or a new place (`venue`), found again or created with the same rules
 * as creating an event. Event times are wall-clock times in the venue's zone, so they keep their value ("8:00 PM")
 * and the event takes the new venue's zone: from its map position, else its state, else its country (or the zone the
 * organizer picked themselves). The answer says when the zone changed, so the screens can warn about it.
 *
 * Refused for cancelled, started or ended events, online events, and seat-mapped events with seats or sections
 * already sold or held (the map was drawn for the old building). A seat map with nothing sold is kept, with a note.
 *
 * On a published event every ticket holder gets one email (new venue, address and a map link) and one push
 * (dedupe key `event.venue:<eventId>:<changeId>:<userId>`, where the change id is the audit entry's id). Drafts,
 * events in review and rejected events tell nobody.
 */
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Venue } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { MailService, render, type Mail } from '../mail/mail.module';
import { NoticeService } from '../push/notices';
import { config } from '../config';
import type { AuthUser } from '../common/auth';
import { randomSuffix, slugify } from '../domain/codes';
import { isTimeZone, placeTimezone, timezoneAt } from '../geo/geo.module';
import { wallClockLabel, wallClockToInstant } from '../domain/wallclock';
import type { ChangeVenueDto, VenueInputDto } from './organizer.dto';

/** "Central time", "West Africa time": a zone's everyday name, for "now in Central time". */
export function zoneName(tz: string, at = new Date()) {
  try {
    const v = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    if (v && !/^GMT[+-]/.test(v)) return v.replace(/ Time$/, ' time');
  } catch {
    /* fall through */
  }
  return tz.split('/').pop()!.replace(/_/g, ' ') + ' time';
}

/** "CST", "GMT+1" at that moment. */
function zoneAbbr(tz: string, at: Date) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function countryName(code: string | null) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A Google Maps link to the venue: its map position when known, else its name and address. */
export function mapLink(v: Pick<Venue, 'name' | 'address' | 'city' | 'region' | 'country' | 'lat' | 'lng'>) {
  const q = v.lat !== null && v.lng !== null ? `${v.lat},${v.lng}` : [v.name, v.address, v.city, v.region, countryName(v.country)].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

const addressOf = (v: Pick<Venue, 'address' | 'city' | 'region' | 'postalCode' | 'country'>) =>
  [v.address, v.city, v.region, v.postalCode, countryName(v.country)].filter((x) => x && x.trim()).join(', ');

type Ev = Prisma.EventGetPayload<{ include: { ticketTypes: true } }>;

@Injectable()
export class VenueChange {
  private readonly log = new Logger('VenueChange');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly notices: NoticeService,
  ) {}

  /**
   * The same place picked again (same name in the same city, or within ~150 m on the map with a word of the name in
   * common) is the venue already on Eventro, as when creating an event.
   */
  async sameVenue(v: { name: string; city: string; lat?: number; lng?: number }, country: string | undefined) {
    const named = await this.prisma.venue.findFirst({
      where: { hiddenAt: null, name: { equals: v.name.trim(), mode: 'insensitive' }, city: { equals: v.city.trim(), mode: 'insensitive' }, ...(country ? { OR: [{ country }, { country: null }] } : {}) },
    });
    if (named || v.lat === undefined || v.lng === undefined) return named;
    const d = 0.0014;
    const near = await this.prisma.venue.findMany({ where: { hiddenAt: null, lat: { gte: v.lat - d, lte: v.lat + d }, lng: { gte: v.lng - d, lte: v.lng + d } }, take: 10 });
    const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const mine = words(v.name);
    return near.find((n) => [...words(n.name)].some((w) => mine.has(w))) ?? null;
  }

  /** The zone of a new place: its map position, else its state or province, else its country's main zone. */
  static zoneOf(v: VenueInputDto, country: string | undefined) {
    return (v.lat !== undefined && v.lng !== undefined ? timezoneAt(v.lat, v.lng) : null) ?? placeTimezone(country, v.region);
  }

  async change(ev: Ev, user: AuthUser, dto: ChangeVenueDto) {
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled, so its venue can’t be changed.');
    if (ev.online) throw new BadRequestException('This is an online event. Moving an online event to a venue isn’t supported: create a new in-person event instead.');
    const now = Date.now();
    const start = wallClockToInstant(ev.startsAt, ev.timezone).getTime();
    const end = ev.endsAt ? wallClockToInstant(ev.endsAt, ev.timezone).getTime() : start;
    if (end <= now) throw new BadRequestException('This event has ended, so its venue can’t be changed.');
    if (start <= now) throw new BadRequestException('This event has already started, so its venue can’t be changed.');
    if (!dto.venueId === !dto.venue) throw new BadRequestException('Send either venueId (a venue on Eventro) or venue (a new place), not both.');
    if (dto.timezone && !isTimeZone(dto.timezone)) throw new BadRequestException(`Unknown time zone "${dto.timezone}". Use an IANA name such as America/Chicago.`);

    // Where it's going (nothing is created until every check has passed).
    let existing: Venue | null = null;
    let zone: string | null;
    const country = dto.venue?.country?.toUpperCase();
    if (dto.venueId) {
      existing = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
      if (!existing || existing.hiddenAt) throw new BadRequestException('That venue doesn’t exist.');
      zone = existing.timezone ?? placeTimezone(existing.country, existing.region);
    } else {
      existing = await this.sameVenue(dto.venue!, country);
      zone = VenueChange.zoneOf(dto.venue!, country);
    }
    const timezone = dto.timezone ?? zone ?? 'UTC';
    const old = ev.venueId ? await this.prisma.venue.findUnique({ where: { id: ev.venueId } }) : null;
    if (existing && existing.id === ev.venueId) throw new BadRequestException(`This event is already at ${existing.name}.`);

    // A seat map belongs to the building it was drawn for. Once seats or sections are sold (or held at checkout),
    // moving would leave buyers with seats that may not exist at the new venue.
    let seatMapNote: string | null = null;
    if (ev.seatMap) {
      const [seated, held] = await Promise.all([
        this.prisma.ticket.count({ where: { eventId: ev.id, status: { not: 'VOID' }, section: { not: null } } }),
        this.prisma.hold.count({ where: { eventId: ev.id, status: 'ACTIVE', expiresAt: { gt: new Date() }, OR: [{ sectionId: { not: null } }, { seats: { not: Prisma.DbNull } }] } }),
      ]);
      if (seated || held) {
        throw new ConflictException({
          statusCode: 409,
          code: 'SEATED_SALES',
          message: seated
            ? `${seated.toLocaleString('en-US')} ${seated === 1 ? 'ticket is' : 'tickets are'} sold for seats or sections on this event’s seat map, which was drawn for ${old?.name ?? 'the current venue'}. Moving would leave those buyers with seats that may not exist at the new venue. Contact Eventro support to move a seated event.`
            : 'Fans are checking out with seats from this event’s seat map right now. Pause sales, wait 10 minutes for their holds to end, then try again.',
        });
      }
      seatMapNote = `The seat map was drawn for ${old?.name ?? 'the old venue'}. Check it fits ${existing?.name ?? dto.venue!.name.trim()} in the seat designer before tickets sell.`;
    }

    const venue =
      existing ??
      (await this.prisma.venue.create({ data: { ...dto.venue!, country, timezone: zone, slug: `${slugify(dto.venue!.name)}-${randomSuffix()}` } }));
    const from = ev.timezone;
    const changed = from !== timezone;
    await this.prisma.event.update({ where: { id: ev.id }, data: { venueId: venue.id, timezone } });

    // Who hears about it: holders of every ticket that still counts, on published events only.
    const published = ev.status === 'PUBLISHED';
    const tickets = published
      ? await this.prisma.ticket.findMany({ where: { eventId: ev.id, status: { not: 'VOID' } }, select: { holderEmail: true, holderName: true } })
      : [];
    const byEmail = new Map<string, { email: string; name: string; count: number }>();
    for (const t of tickets) {
      const k = t.holderEmail.trim().toLowerCase();
      const cur = byEmail.get(k) ?? { email: t.holderEmail.trim(), name: t.holderName, count: 0 };
      cur.count++;
      byEmail.set(k, cur);
    }
    const holders = published ? await this.notices.holders(ev.id).catch(() => [] as string[]) : [];

    const entry = await this.audit.log(user.id, 'event.venue', 'Event', ev.id, {
      from: old ? { venueId: old.id, name: old.name, city: old.city } : null,
      to: { venueId: venue.id, name: venue.name, city: venue.city, created: !existing },
      timezoneFrom: from,
      timezoneTo: timezone,
      status: ev.status,
      emailed: byEmail.size,
      pushed: holders.length,
    });

    const at = wallClockToInstant(ev.startsAt, timezone);
    const time = wallClockLabel(ev.startsAt, { hour: 'numeric', minute: '2-digit' });
    const toName = zoneName(timezone, at);
    const notice = changed ? `Times stay ${time}, now in ${toName}.` : null;

    if (published && byEmail.size) {
      const org = await this.prisma.organization.findUnique({ where: { id: ev.orgId }, select: { name: true } });
      void this.emailHolders(ev, org?.name ?? 'The organizer', venue, old, [...byEmail.values()], { changed, timezone, toName, at }).catch((err) =>
        this.log.warn(`Venue change emails for ${ev.id}: ${(err as Error).message}`),
      );
    }
    if (published && holders.length) void this.notices.venueChanged({ id: ev.id, title: ev.title }, { name: venue.name, city: venue.city }, entry.id, holders);

    return {
      event: { id: ev.id, venueId: venue.id, timezone, startsAt: ev.startsAt, doorsAt: ev.doorsAt, endsAt: ev.endsAt },
      venue: { id: venue.id, slug: venue.slug, name: venue.name, address: venue.address, city: venue.city, region: venue.region, postalCode: venue.postalCode, country: venue.country, lat: venue.lat, lng: venue.lng, timezone: venue.timezone },
      previousVenue: old ? { id: old.id, name: old.name, city: old.city } : null,
      created: !existing,
      zone: { from, to: timezone, changed, fromName: zoneName(from, at), toName },
      /** "Times stay 8:00 PM, now in Central time." when the zone changed */
      notice,
      seatMapNote,
      notified: published ? { emails: byEmail.size, pushes: holders.length } : { emails: 0, pushes: 0, reason: 'Not published yet, so nobody was told.' },
      changeId: entry.id,
    };
  }

  private async emailHolders(
    ev: Ev,
    orgName: string,
    venue: Venue,
    old: Venue | null,
    holders: { email: string; name: string; count: number }[],
    z: { changed: boolean; timezone: string; toName: string; at: Date },
  ) {
    const when = wallClockLabel(ev.startsAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const abbr = zoneAbbr(z.timezone, z.at);
    const where = addressOf(venue);
    const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';
    const mails: Mail[] = holders.map((h) => ({
      to: h.email,
      subject: `New venue for ${ev.title}: ${venue.name}`,
      ...render({
        preheader: `${ev.title} is moving to ${venue.name}, ${venue.city}. Same date and time; your tickets still work.`,
        heading: `${ev.title} has a new venue`,
        paragraphs: [
          `Hi ${first(h.name)}, ${orgName} has moved ${ev.title} to a new venue${old ? ` (it was at ${old.name}, ${old.city})` : ''}.`,
          `New venue: ${venue.name}, ${where}.`,
          // Multiple dates and multi-day events keep every date: no single "when" to show.
          `${ev.dateMode === 'SINGLE' ? `Same date and time: ${when}${abbr ? ` ${abbr}` : ''}` : 'Same dates and times as before'}.${z.changed ? ` That’s local time at the new venue, which is in ${z.toName}.` : ''}`,
          `Your ${h.count === 1 ? 'ticket stays' : `${h.count} tickets stay`} valid, with the same QR ${h.count === 1 ? 'code' : 'codes'} at the door. There’s nothing you need to do.`,
        ],
        highlight: { label: 'New venue', value: venue.name },
        cta: { label: 'Open in Maps', url: mapLink(venue) },
        footer: `You’re getting this because you have tickets to ${ev.title} on Eventro.`,
        footerLink: { label: 'See the event', url: `${config.webUrl}/events/${ev.slug}` },
      }),
    }));
    await this.mail.sendMany('event.venue', mails);
  }
}
