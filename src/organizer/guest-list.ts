/**
 * The guest list: names let in at the door without a ticket (crew, friends of the artist, walk-ups the organizer
 * agreed to), each with up to 10 plus-ones, a group label and a note. Org admins and managers keep it; door staff see
 * it and check guests in, online or offline from the door pack, and say how many of the party arrived ("2 of 3 here").
 *
 * Every arrival is logged in GuestCheckIn, the guest list's own door log beside the ticket scan log (ScanAttempt),
 * with the same results (ADMITTED, or ALREADY_USED when the whole party was already in), the head count it let in,
 * the scanner, the staff member and the time (the scanner's own time for offline check-ins). A parallel table rather
 * than ScanAttempt rows because guest arrivals have no ticket and carry a head count, while ScanAttempt is the
 * ticket-only evidence the Eventro Guarantee reads (one row per ticket scan, and nothing else on it). Offline
 * check-ins carry an `opId`: its hash with the scanner id is the row's unique dedupe key, written in the same
 * transaction as the head count, so a re-sent sync is applied once.
 *
 *   GET    /organizer/events/:id/guest-list?q=                   (ADMIN, MANAGER, DOOR)
 *   POST   /organizer/events/:id/guest-list                      { entries? | text?, group? } (ADMIN, MANAGER)
 *   PATCH  /organizer/events/:id/guest-list/:entryId             (ADMIN, MANAGER)
 *   DELETE /organizer/events/:id/guest-list/:entryId             (ADMIN, MANAGER)
 *   POST   /organizer/events/:id/guest-list/:entryId/check-in    { guests?, deviceId? } (ADMIN, MANAGER, DOOR)
 *   POST   /organizer/events/:id/guest-list/:entryId/undo        { guests? } (ADMIN, MANAGER, DOOR)
 *   POST   /organizer/events/:id/guest-list/sync                 { deviceId, checkIns: [{ entryId, guests, at, opId }] }
 */
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma, type GuestListEntry, type ScanResult } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../common/audit.service';
import { createHash } from 'node:crypto';
import { CurrentUser, type AuthUser } from '../common/auth';
import { DOOR_ROLES, EDIT_ROLES, EMAIL, eventForRole, lines } from './access';
import { AddGuestsDto, GuestCheckInDto, GuestSyncDto, UpdateGuestDto } from './organizer.dto';

export const MAX_PLUS_ONES = 10;
/** One offline check-in's key: the scanner and its check-in id. */
const dedupeKey = (deviceId: string, opId: string) => createHash('sha256').update(`${deviceId}|guest|${opId}`).digest('base64url').slice(0, 32);
export const MAX_GUESTS_PER_BATCH = 500;

type Tx = Prisma.TransactionClient;
type NewGuest = { name: string; email: string | null; plusOnes: number; group: string | null; note: string | null };

/** An entry as clients see it: `arrived` of `partySize` (the guest and their plus-ones) are in. */
export const guestView = (g: GuestListEntry) => ({
  id: g.id,
  name: g.name,
  email: g.email,
  plusOnes: g.plusOnes,
  group: g.group,
  note: g.note,
  arrived: g.arrived,
  partySize: 1 + g.plusOnes,
  firstArrivedAt: g.firstArrivedAt,
  updatedAt: g.updatedAt,
});
type GuestView = ReturnType<typeof guestView>;

export const hereLabel = (g: { arrived: number; plusOnes: number }) => `${g.arrived} of ${1 + g.plusOnes} here`;

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, ' ').trim() || null;

/** Pasted lines `name[, email][, +N][, group]` (comma or tab separated). */
export function parseGuestLines(text: string, defaultGroup: string | null) {
  const entries: (NewGuest & { line: number })[] = [];
  const errors: { line: number; error: string }[] = [];
  for (const l of lines(text)) {
    const parts = l.text.split(/[,\t]/).map((p) => p.trim()).filter(Boolean);
    const name = clean(parts.shift());
    let email: string | null = null;
    let plusOnes = 0;
    let group: string | null = null;
    let bad: string | null = null;
    for (const p of parts) {
      const plus = /^\+\s*(\d+)$/.exec(p);
      if (p.includes('@')) {
        if (!EMAIL.test(p.toLowerCase())) bad = `“${p}” isn’t a valid email.`;
        else email = p.toLowerCase();
      } else if (plus) plusOnes = Number(plus[1]);
      else group = group ? `${group}, ${p}` : p;
    }
    group = clean(group) ?? defaultGroup;
    if (!name) bad = 'Add a name.';
    else if (name.length > 80) bad = 'Keep names to 80 characters.';
    else if (plusOnes > MAX_PLUS_ONES) bad = `Up to ${MAX_PLUS_ONES} plus-ones per guest.`;
    else if (group && group.length > 40) bad = 'Keep the group to 40 characters.';
    if (bad) errors.push({ line: l.line, error: bad });
    else entries.push({ line: l.line, name: name!, email, plusOnes, group, note: null });
  }
  return { entries, errors };
}

@Injectable()
export class GuestListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Counts for the event page and stats. */
  async summary(eventId: string) {
    const a = await this.prisma.guestListEntry.aggregate({ where: { eventId }, _count: { _all: true }, _sum: { plusOnes: true, arrived: true } });
    return { entries: a._count._all, expected: a._count._all + (a._sum.plusOnes ?? 0), arrived: a._sum.arrived ?? 0 };
  }

  /** The whole list for the door pack (offline door scanning). */
  async packEntries(eventId: string) {
    const rows = await this.prisma.guestListEntry.findMany({ where: { eventId }, orderBy: { name: 'asc' }, take: 10_000 });
    return rows.map(guestView);
  }

  async list(eventId: string, user: AuthUser, q?: string) {
    await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const s = q?.trim();
    const items = await this.prisma.guestListEntry.findMany({
      where: {
        eventId,
        ...(s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }, { group: { contains: s, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      take: 5000,
    });
    return { summary: await this.summary(eventId), items: items.map(guestView) };
  }

  async add(eventId: string, user: AuthUser, dto: AddGuestsDto) {
    const ev = await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    const group = clean(dto.group);
    const parsed = dto.text ? parseGuestLines(dto.text, group) : { entries: [], errors: [] };
    if (parsed.errors.length) throw new BadRequestException({ statusCode: 400, message: `Fix ${parsed.errors.length === 1 ? 'this line' : `these ${parsed.errors.length} lines`} and try again.`, errors: parsed.errors });
    const entries: NewGuest[] = [
      ...(dto.entries ?? []).map((e) => ({ name: clean(e.name) ?? '', email: e.email?.trim().toLowerCase() || null, plusOnes: e.plusOnes ?? 0, group: clean(e.group) ?? group, note: e.note?.trim() || null })),
      ...parsed.entries.map(({ line: _line, ...e }) => e),
    ];
    if (entries.some((e) => !e.name)) throw new BadRequestException('Every guest needs a name.');
    if (!entries.length) throw new BadRequestException('Add at least one guest.');
    if (entries.length > MAX_GUESTS_PER_BATCH) throw new BadRequestException(`Add up to ${MAX_GUESTS_PER_BATCH} guests at a time.`);
    const created = await this.prisma.$transaction(entries.map((e) => this.prisma.guestListEntry.create({ data: { ...e, eventId, createdById: user.id } })));
    await this.audit.log(user.id, 'guest_list.add', 'Event', eventId, { count: created.length });
    return { added: created.length, items: created.map(guestView) };
  }

  private async entry(eventId: string, entryId: string, db: Tx | PrismaService = this.prisma) {
    const g = await db.guestListEntry.findUnique({ where: { id: entryId } });
    if (!g || g.eventId !== eventId) throw new NotFoundException('Guest not found.');
    return g;
  }

  async update(eventId: string, entryId: string, user: AuthUser, dto: UpdateGuestDto) {
    await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    const g = await this.entry(eventId, entryId);
    if (dto.name !== undefined && !clean(dto.name)) throw new BadRequestException('Add a name.');
    if (dto.plusOnes !== undefined && 1 + dto.plusOnes < g.arrived) throw new BadRequestException(`${g.arrived} of this party are already in, so they need at least ${g.arrived - 1} plus-ones.`);
    const updated = await this.prisma.guestListEntry.update({
      where: { id: entryId },
      data: {
        ...(dto.name !== undefined ? { name: clean(dto.name)! } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim().toLowerCase() || null } : {}),
        ...(dto.plusOnes !== undefined ? { plusOnes: dto.plusOnes } : {}),
        ...(dto.group !== undefined ? { group: clean(dto.group) } : {}),
        ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
      },
    });
    await this.audit.log(user.id, 'guest_list.update', 'GuestListEntry', entryId, { eventId });
    return guestView(updated);
  }

  async remove(eventId: string, entryId: string, user: AuthUser) {
    await eventForRole(this.prisma, eventId, user, EDIT_ROLES);
    await this.entry(eventId, entryId);
    await this.prisma.guestListEntry.delete({ where: { id: entryId } });
    await this.audit.log(user.id, 'guest_list.remove', 'GuestListEntry', entryId, { eventId });
    return { deleted: true };
  }

  /**
   * Lets `guests` more of the party in, never past its size. Runs inside a transaction holding the entry's row lock,
   * so two doors can't both admit the last place. `log` writes the GuestCheckIn row in the same transaction.
   */
  private async admit(tx: Tx, entryId: string, guests: number, at: Date, log: (result: ScanResult, admitted: number) => Promise<void>) {
    await tx.$queryRaw`SELECT id FROM "GuestListEntry" WHERE id = ${entryId} FOR UPDATE`;
    const g = await tx.guestListEntry.findUniqueOrThrow({ where: { id: entryId } });
    const room = 1 + g.plusOnes - g.arrived;
    if (room <= 0) {
      await log('ALREADY_USED', 0);
      return { result: 'full' as const, admitted: 0, entry: g };
    }
    const admitted = Math.min(guests, room);
    await log('ADMITTED', admitted);
    const entry = await tx.guestListEntry.update({ where: { id: entryId }, data: { arrived: { increment: admitted }, firstArrivedAt: g.firstArrivedAt ?? at, lastArrivedAt: at } });
    return { result: 'ok' as const, admitted, entry };
  }

  async checkIn(eventId: string, entryId: string, user: AuthUser, dto: GuestCheckInDto) {
    const ev = await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    if (ev.status === 'CANCELLED') throw new BadRequestException('This event was cancelled.');
    await this.entry(eventId, entryId);
    const deviceId = dto.deviceId?.trim() || null;
    const at = new Date();
    const out = await this.prisma.$transaction((tx) =>
      this.admit(tx, entryId, dto.guests ?? 1, at, async (result, guests) => {
        await tx.guestCheckIn.create({ data: { eventId, entryId, guests, result, deviceId, userId: user.id, at } });
      }),
    );
    const here = hereLabel(out.entry);
    return {
      result: out.result,
      message: out.result === 'full' ? `Everyone is already in: ${here}.` : out.admitted < (dto.guests ?? 1) ? `${here} (that’s the whole party).` : here,
      entry: guestView(out.entry),
    };
  }

  /** Takes back a check-in made by mistake (audited; the door log keeps the arrival it recorded). */
  async undo(eventId: string, entryId: string, user: AuthUser, guests = 1) {
    await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const g = await this.entry(eventId, entryId);
    if (g.arrived <= 0) throw new BadRequestException('Nobody from this party has been checked in.');
    const n = Math.min(guests, g.arrived);
    const { count } = await this.prisma.guestListEntry.updateMany({ where: { id: entryId, arrived: g.arrived }, data: { arrived: g.arrived - n, ...(g.arrived - n === 0 ? { firstArrivedAt: null, lastArrivedAt: null } : {}) } });
    if (!count) throw new ConflictException('Someone else just checked this party in or out. Refresh and try again.');
    await this.audit.log(user.id, 'guest_list.undo', 'GuestListEntry', entryId, { eventId, guests: n });
    return { entry: guestView(await this.prisma.guestListEntry.findUniqueOrThrow({ where: { id: entryId } })) };
  }

  /**
   * Check-ins a door scanner made offline, oldest first. Each `opId` (with the scanner id) is applied once: the
   * GuestCheckIn row it writes has a unique dedupe key, created in the same transaction as the head count, so sending the batch
   * again changes nothing and comes back as it did the first time (`replay`).
   */
  async sync(eventId: string, user: AuthUser, dto: GuestSyncDto) {
    await eventForRole(this.prisma, eventId, user, DOOR_ROLES);
    const deviceId = dto.deviceId.trim();
    const now = Date.now();
    const ordered = dto.checkIns
      .map((c, index) => ({ ...c, index, when: new Date(Math.min(new Date(c.at).getTime(), now)) }))
      .sort((a, b) => a.when.getTime() - b.when.getTime() || a.index - b.index);
    const ids = [...new Set(ordered.map((c) => c.entryId))];
    const known = new Map((await this.prisma.guestListEntry.findMany({ where: { id: { in: ids } }, select: { id: true, eventId: true } })).map((g) => [g.id, g.eventId]));
    type Result = { index: number; opId: string; entryId: string; result: 'checked_in' | 'full' | 'invalid'; replay?: true; reason?: 'unknown' | 'wrong-event'; entry?: GuestView };
    const results: Result[] = [];
    for (const c of ordered) {
      const base = { index: c.index, opId: c.opId, entryId: c.entryId };
      const ev = known.get(c.entryId);
      if (!ev) {
        results.push({ ...base, result: 'invalid', reason: 'unknown' });
        continue;
      }
      if (ev !== eventId) {
        results.push({ ...base, result: 'invalid', reason: 'wrong-event' });
        continue;
      }
      const key = dedupeKey(deviceId, c.opId);
      try {
        const out = await this.prisma.$transaction((tx) =>
          this.admit(tx, c.entryId, c.guests, c.when, async (result, guests) => {
            await tx.guestCheckIn.create({ data: { eventId, entryId: c.entryId, guests, result, offline: true, deviceId, userId: user.id, at: c.when, dedupeKey: key } });
          }),
        );
        results.push({ ...base, result: out.result === 'full' ? 'full' : 'checked_in', entry: guestView(out.entry) });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        // Sent before: answer as the first time.
        const first = await this.prisma.guestCheckIn.findUnique({ where: { dedupeKey: key }, select: { result: true } });
        const entry = await this.prisma.guestListEntry.findUniqueOrThrow({ where: { id: c.entryId } });
        results.push({ ...base, result: first?.result === 'ALREADY_USED' ? 'full' : 'checked_in', replay: true, entry: guestView(entry) });
      }
    }
    results.sort((a, b) => a.index - b.index);
    const summary = { checked_in: 0, full: 0, invalid: 0 };
    for (const r of results) summary[r.result]++;
    await this.audit.log(user.id, 'guest_list.sync', 'Event', eventId, { deviceId, checkIns: dto.checkIns.length, ...summary });
    return { results, summary };
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@Controller('organizer/events/:id/guest-list')
export class GuestListController {
  constructor(private readonly svc: GuestListService) {}

  @ApiQuery({ name: 'q', required: false })
  @Get() list(@Param('id') id: string, @CurrentUser() u: AuthUser, @Query('q') q?: string) {
    return this.svc.list(id, u, q);
  }
  @Post() add(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: AddGuestsDto) {
    return this.svc.add(id, u, dto);
  }
  /** Offline door check-ins (safe to send again). Declared before :entryId so "sync" isn't taken for an id. */
  @Post('sync') @HttpCode(200) sync(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: GuestSyncDto) {
    return this.svc.sync(id, u, dto);
  }
  @Patch(':entryId') update(@Param('id') id: string, @Param('entryId') entryId: string, @CurrentUser() u: AuthUser, @Body() dto: UpdateGuestDto) {
    return this.svc.update(id, entryId, u, dto);
  }
  @Delete(':entryId') remove(@Param('id') id: string, @Param('entryId') entryId: string, @CurrentUser() u: AuthUser) {
    return this.svc.remove(id, entryId, u);
  }
  @Post(':entryId/check-in') @HttpCode(200) checkIn(@Param('id') id: string, @Param('entryId') entryId: string, @CurrentUser() u: AuthUser, @Body() dto: GuestCheckInDto) {
    return this.svc.checkIn(id, entryId, u, dto);
  }
  @Post(':entryId/undo') @HttpCode(200) undo(@Param('id') id: string, @Param('entryId') entryId: string, @CurrentUser() u: AuthUser, @Body() dto: GuestCheckInDto) {
    return this.svc.undo(id, entryId, u, dto.guests ?? 1);
  }
}
