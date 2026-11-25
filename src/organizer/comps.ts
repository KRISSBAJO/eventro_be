/**
 * Complimentary tickets (comps): an org admin or manager gives named guests a real ticket for a ticket type, free.
 *
 * Each comp is its own $0 order (Order.kind COMP, provider "comp", PAID straight away) with one ticket and a Gift, so
 * the guest gets an email ("You’re on the guest list for {event}") with the gift link and claims the ticket like a
 * gift (GET /gifts/:token, POST /gifts/:token/claim, or accepting it from their incoming tickets). Until then the
 * ticket waits for them (TRANSFER_PENDING) and doesn't scan. Comps take a place in the tier (TicketType.sold, under
 * the same row lock as checkout), so the event can't oversell, and the event's comp limit (Event.compLimit) caps how
 * many are live. Revoking an unused comp voids its ticket (new QR seed, so saved codes stop working), frees the
 * place and emails the holder. Comps aren't sales: revenue, payouts and the Omoshow Guarantee leave them out.
 *
 *   GET  /organizer/events/:id/comps                    list and counts (ADMIN, MANAGER, DOOR)
 *   POST /organizer/events/:id/comps                    { ticketTypeId, recipients? | text?, group?, note? } (ADMIN, MANAGER)
 *   POST /organizer/events/:id/comps/:orderId/revoke    { reason? } (ADMIN, MANAGER)
 *   POST /organizer/events/:id/comps/:orderId/resend    (ADMIN, MANAGER)
 */
import { randomBytes } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { InventoryService } from '../common/inventory.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { GiftService } from '../gifts/gifts.module';
import { MailService, render } from '../mail/mail.module';
import { config } from '../config';
import { orderCode, ticketCode } from '../domain/codes';
import { pickFromSections, type SeatMap, type SeatPick } from '../domain/seatmap';
import { seatTier, ticketDateFields } from '../domain/event-dates';
import { releaseReservations } from '../schedule/release';
import { DOOR_ROLES, EDIT_ROLES, EMAIL, eventForRole, lines } from './access';
import { IssueCompsDto, RevokeCompDto } from './organizer.dto';

export const MAX_COMPS_PER_BATCH = 200;
const DAY = 86_400_000;

const COMP_INCLUDE = {
  ticketType: { select: { id: true, name: true, eventDateId: true } },
  tickets: { select: { id: true, status: true, section: true, row: true, seat: true, checkedInAt: true, holderEmail: true, holderName: true } },
  gift: { select: { id: true, recipientName: true, recipientEmail: true, claimedAt: true, sentAt: true } },
} satisfies Prisma.OrderInclude;
type CompRow = Prisma.OrderGetPayload<{ include: typeof COMP_INCLUDE }>;

/** Pasted comp lines: "Name, email", "Name <email>" or "Name<TAB>email". */
export function parseCompLines(text: string) {
  const recipients: { name: string; email: string; line: number }[] = [];
  const errors: { line: number; error: string }[] = [];
  for (const l of lines(text)) {
    const angle = /^(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(l.text);
    let name: string;
    let email: string;
    if (angle) {
      name = angle[1].replace(/[,;\t]+$/, '').trim();
      email = angle[2];
    } else {
      const parts = l.text.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
      const at = parts.findIndex((p) => p.includes('@'));
      email = at >= 0 ? parts[at] : '';
      name = parts.filter((_, i) => i !== at).join(' ');
    }
    email = email.trim().toLowerCase();
    name = name.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    if (!email || !EMAIL.test(email)) errors.push({ line: l.line, error: `“${l.text}” has no valid email.` });
    else if (!name) errors.push({ line: l.line, error: `Add a name for ${email}.` });
    else if (name.length > 80) errors.push({ line: l.line, error: 'Keep names to 80 characters.' });
    else recipients.push({ name, email, line: l.line });
  }
  return { recipients, errors };
}

@Injectable()
export class CompService {
  private readonly log = new Logger('Comps');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly gifts: GiftService,
    private readonly mail: MailService,
  ) {}

  private view(o: CompRow, people: Map<string, string>) {
    const t = o.tickets[0];
    const revoked = o.status !== 'PAID';
    const status = revoked ? 'REVOKED' : t?.status === 'CHECKED_IN' ? 'CHECKED_IN' : o.gift?.claimedAt ? 'CLAIMED' : 'SENT';
    return {
      orderId: o.id,
      ticketId: t?.id ?? null,
      name: o.gift?.recipientName ?? o.buyerName,
      email: o.gift?.recipientEmail ?? o.email,
      // who holds it now (the claimer's account may use another email)
      holderName: t?.holderName ?? null,
      holderEmail: t?.holderEmail ?? null,
      group: o.compGroup,
      note: o.compNote,
      status,
      ticketType: o.ticketType,
      section: t?.section ?? null,
      row: t?.row ?? null,
      seat: t?.seat ?? null,
      issuedAt: o.createdAt,
      issuedBy: o.compIssuedById ? { id: o.compIssuedById, name: people.get(o.compIssuedById) ?? null } : null,
      claimedAt: o.gift?.claimedAt ?? null,
      checkedInAt: t?.checkedInAt ?? null,
      // null for comps cancelled with the event (status REVOKED all the same)
      revokedAt: o.compRevokedAt,
    };
  }

  private async views(rows: CompRow[]) {
    const ids = [...new Set(rows.map((r) => r.compIssuedById).filter((x): x is string => !!x))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => this.view(r, names));
  }

  async list(eventId: string, user: AuthUser) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const rows = await this.prisma.order.findMany({ where: { eventId, kind: 'COMP' }, include: COMP_INCLUDE, orderBy: { createdAt: 'desc' }, take: 5000 });
    const items = await this.views(rows);
    const live = items.filter((i) => i.status !== 'REVOKED');
    return {
      limit: ev.compLimit,
      summary: {
        issued: live.length,
        claimed: live.filter((i) => i.status === 'CLAIMED' || i.status === 'CHECKED_IN').length,
        checkedIn: live.filter((i) => i.status === 'CHECKED_IN').length,
        revoked: items.length - live.length,
        remaining: ev.compLimit === null ? null : Math.max(0, ev.compLimit - live.length),
      },
      items,
    };
  }

  async issue(eventId: string, user: AuthUser, dto: IssueCompsDto) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    if (ev.status === 'REJECTED') throw new BadRequestException('This event was rejected. Fix it and submit it again first.');
    // Event times are the venue's wall clock stored as UTC; a day's margin covers every time zone.
    if ((ev.endsAt ?? ev.startsAt).getTime() + DAY < Date.now()) throw new BadRequestException('This event is over.');
    const tt = ev.ticketTypes.find((t) => t.id === dto.ticketTypeId);
    if (!tt) throw new NotFoundException('Ticket type not found.');
    // Multiple dates: a comp is for the date of its tier copy, which has to be on and not over.
    const date = tt.eventDateId ? ev.dates.find((d) => d.id === tt.eventDateId) : null;
    if (date?.status === 'CANCELLED') throw new BadRequestException('That date was cancelled.');
    if (date && (date.endsAt ?? date.startsAt).getTime() + DAY < Date.now()) throw new BadRequestException('That date is over.');

    const parsed = dto.text ? parseCompLines(dto.text) : { recipients: [], errors: [] };
    const recipients = [...(dto.recipients ?? []).map((r, i) => ({ name: r.name.replace(/\s+/g, ' ').trim(), email: r.email.trim().toLowerCase(), line: i + 1 })), ...parsed.recipients];
    const errors = [...parsed.errors];
    const seen = new Map<string, number>();
    for (const r of recipients) {
      if (!r.name) errors.push({ line: r.line, error: `Add a name for ${r.email}.` });
      const first = seen.get(r.email);
      if (first !== undefined) errors.push({ line: r.line, error: `${r.email} is in this list twice (line ${first} too). Each guest gets one comp.` });
      else seen.set(r.email, r.line);
    }
    if (errors.length) throw new BadRequestException({ statusCode: 400, message: `Fix ${errors.length === 1 ? 'this line' : `these ${errors.length} lines`} and try again.`, errors });
    if (!recipients.length) throw new BadRequestException('Add at least one guest: a name and an email.');
    if (recipients.length > MAX_COMPS_PER_BATCH) throw new BadRequestException(`Issue up to ${MAX_COMPS_PER_BATCH} comps at a time.`);

    const group = dto.group?.trim().replace(/\s+/g, ' ') || null;
    const note = dto.note?.trim() || null;
    const now = new Date();
    const map = ev.seatMap as SeatMap | null;
    const sections = (map?.sections ?? []).filter((s) => s.ticketTypeId === seatTier(tt));
    const ids = await this.prisma.$transaction(
      async (tx) => {
        // The same row lock as checkout, so comps and sales can't both take the last places.
        await tx.$queryRaw`SELECT id FROM "TicketType" WHERE id = ${tt.id} FOR UPDATE`;
        const left = await this.inventory.availableForType(tx, tt.id, now);
        if (left < recipients.length) throw new ConflictException(left ? `Only ${left} left in ${tt.name}: comps count against its capacity.` : `${tt.name} is sold out: comps count against its capacity.`);
        if (ev.compLimit !== null) {
          const live = await tx.order.count({ where: { eventId, kind: 'COMP', status: 'PAID' } });
          if (live + recipients.length > ev.compLimit) {
            const room = Math.max(0, ev.compLimit - live);
            throw new ConflictException(`This event’s comp limit is ${ev.compLimit}: ${room ? `only ${room} more can be issued` : 'it’s reached'}.`);
          }
        }
        // Reserved or standing places from the tier's seat map, one per guest (best available first).
        let seats: (SeatPick | { section: null; row: null; seat: null })[] = recipients.map(() => ({ section: null, row: null, seat: null }));
        if (sections.length) {
          const inUse = await this.inventory.seatsInUse(tx, eventId, sections.map((s) => s.id), now, undefined, tt.eventDateId);
          seats = recipients.map(() => {
            const pick = pickFromSections(sections, inUse, 1)?.[0];
            if (!pick) throw new ConflictException(`There are no places left on the seat map for ${tt.name}.`);
            const u = inUse.get(pick.section) ?? { seats: new Set<string>(), count: 0 };
            u.count++;
            if (pick.row && pick.seat) u.seats.add(`${pick.row}:${pick.seat}`);
            inUse.set(pick.section, u);
            return pick;
          });
        }
        const out: { orderId: string; giftId: string }[] = [];
        for (const [i, r] of recipients.entries()) {
          const id = orderCode();
          const giftId = randomBytes(12).toString('hex');
          await tx.order.create({
            data: {
              id,
              kind: 'COMP',
              eventId,
              ticketTypeId: tt.id,
              email: r.email,
              buyerName: r.name,
              quantity: 1,
              unitCents: 0,
              subtotalCents: 0,
              totalCents: 0,
              currency: ev.currency,
              provider: 'comp',
              status: 'PAID',
              paidAt: now,
              compGroup: group,
              compNote: note,
              compIssuedById: user.id,
              gift: { create: { id: giftId, recipientName: r.name, recipientEmail: r.email, message: '', hidePrice: true, sendAt: now, token: randomBytes(24).toString('base64url') } },
              tickets: {
                create: {
                  id: ticketCode(id, 0),
                  eventId,
                  ticketTypeId: tt.id,
                  holderName: r.name,
                  holderEmail: r.email,
                  // Waits for the guest to claim it (like a gift): it doesn't scan until then.
                  status: 'TRANSFER_PENDING',
                  transferTo: r.email,
                  section: seats[i].section,
                  row: seats[i].row,
                  seat: seats[i].seat,
                  ...ticketDateFields(tt),
                },
              },
            },
          });
          out.push({ orderId: id, giftId });
        }
        await tx.ticketType.update({ where: { id: tt.id }, data: { sold: { increment: recipients.length } } });
        return out;
      },
      { timeout: 60_000 },
    );
    await this.audit.log(user.id, 'comp.issue', 'Event', eventId, { ticketTypeId: tt.id, count: ids.length, group, orders: ids.map((x) => x.orderId) });
    // The emails go out after replying (a batch of 200 shouldn't hold the request).
    void (async () => {
      for (const x of ids) await this.gifts.deliver(x.giftId).catch((e) => this.log.warn(`Comp email for ${x.orderId}: ${(e as Error).message}`));
    })();
    const rows = await this.prisma.order.findMany({ where: { id: { in: ids.map((x) => x.orderId) } }, include: COMP_INCLUDE, orderBy: { createdAt: 'asc' } });
    return { issued: ids.length, items: await this.views(rows) };
  }

  private async comp(eventId: string, orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: COMP_INCLUDE });
    if (!o || o.eventId !== eventId || o.kind !== 'COMP') throw new NotFoundException('Comp not found.');
    return o;
  }

  async revoke(eventId: string, orderId: string, user: AuthUser, dto: RevokeCompDto) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const o = await this.comp(eventId, orderId);
    if (o.status !== 'PAID') throw new BadRequestException('This comp has already been cancelled.');
    const t = o.tickets[0];
    if (t?.status === 'CHECKED_IN') throw new BadRequestException('This guest has already been checked in, so the comp can’t be cancelled.');
    const reason = dto.reason?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({ where: { id: orderId, status: 'PAID' }, data: { status: 'CANCELLED', compRevokedAt: new Date() } });
      if (!count) throw new ConflictException('This comp changed a moment ago. Refresh to see it.');
      // New QR seed and void: codes saved on the guest's phone stop working, and the place goes back to the tier.
      const voided = await tx.ticket.updateMany({
        where: { orderId, status: { notIn: ['VOID', 'CHECKED_IN'] } },
        data: { status: 'VOID', transferTo: null, transferExpiresAt: null, listCents: null, qrVersion: { increment: 1 } },
      });
      if (voided.count) await tx.ticketType.update({ where: { id: o.ticketTypeId }, data: { sold: { decrement: voided.count } } });
      await releaseReservations(tx, { orderId, status: 'VOID' });
      await tx.resaleListing.updateMany({ where: { ticketId: t?.id ?? '', status: { in: ['ACTIVE', 'HELD'] } }, data: { status: 'CANCELLED', cancelReason: 'Comp cancelled by the organizer', heldBy: null, heldUntil: null } });
    });
    await this.audit.log(user.id, 'comp.revoke', 'Order', orderId, { eventId, ticketId: t?.id ?? null, reason });
    const to = (t?.holderEmail ?? o.email).trim().toLowerCase();
    const { html, text } = render({
      preheader: `Your complimentary ticket to ${ev.title} was cancelled.`,
      heading: 'Your complimentary ticket was cancelled',
      paragraphs: [
        `Hi ${(t?.holderName ?? o.buyerName).split(' ')[0] || 'there'}, ${ev.org.name} cancelled your complimentary ticket to ${ev.title}.`,
        ...(reason ? [`Their note: “${reason}”`] : []),
        'Its QR code no longer works. If you think this is a mistake, contact the organizer.',
      ],
      cta: { label: 'Find events', url: `${config.webUrl}/events` },
      footer: `${ev.org.name} had put you on the guest list on Omoshow.`,
    });
    void this.mail.send('comp.revoked', { to, subject: `Your complimentary ticket was cancelled: ${ev.title}`, html, text }).catch(() => undefined);
    return (await this.views([await this.comp(eventId, orderId)]))[0];
  }

  async resend(eventId: string, orderId: string, user: AuthUser) {
    await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const o = await this.comp(eventId, orderId);
    if (o.status !== 'PAID') throw new BadRequestException('This comp was cancelled.');
    if (!o.gift || o.gift.claimedAt) throw new BadRequestException('This guest has already claimed their ticket.');
    await this.gifts.deliver(o.gift.id);
    await this.audit.log(user.id, 'comp.resend', 'Order', orderId, { eventId });
    return { sent: true };
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id/comps')
export class CompController {
  constructor(private readonly svc: CompService) {}

  /** Comps on this event, with counts and the event's comp limit (door staff can look). */
  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.list(id, u);
  }
  /** Issue comps for a ticket type: one ticket each, emailed to the guest to claim (admins and managers). */
  @Post() issue(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: IssueCompsDto) {
    return this.svc.issue(id, u, dto);
  }
  /** Cancel an unused comp: its QR stops working and the guest is emailed. */
  @Post(':orderId/revoke') @HttpCode(200) revoke(@Param('id') id: string, @Param('orderId') orderId: string, @CurrentUser() u: AuthUser, @Body() dto: RevokeCompDto) {
    return this.svc.revoke(id, orderId, u, dto);
  }
  @Post(':orderId/resend') @HttpCode(200) resend(@Param('id') id: string, @Param('orderId') orderId: string, @CurrentUser() u: AuthUser) {
    return this.svc.resend(id, orderId, u);
  }
}
