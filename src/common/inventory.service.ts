import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { sectionCapacity, type InUse, type SeatMap, type SeatPick } from '../domain/seatmap';

type Tx = Prisma.TransactionClient | PrismaService;

/** Filters for one date of a DATES event (no filter otherwise): its tickets, and holds on its tier copies. */
const onDate = (eventDateId?: string | null) => (eventDateId ? { eventDateId } : {});
const holdOnDate = (eventDateId?: string | null) => (eventDateId ? { ticketType: { eventDateId } } : {});

/** Live availability: capacity minus sold minus unexpired holds. */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Seats still on sale for one ticket type. Call inside a transaction that has locked the row. */
  async availableForType(tx: Tx, ticketTypeId: string, now = new Date()) {
    const tt = await tx.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } });
    const held = await tx.hold.aggregate({
      where: { ticketTypeId, status: 'ACTIVE', expiresAt: { gt: now } },
      _sum: { quantity: true },
    });
    return Math.max(0, tt.capacity - tt.sold - (held._sum.quantity ?? 0));
  }

  async availabilityForEvent(eventId: string, now = new Date()) {
    const [types, holds] = await Promise.all([
      this.prisma.ticketType.findMany({ where: { eventId }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.hold.groupBy({
        by: ['ticketTypeId'],
        where: { eventId, status: 'ACTIVE', expiresAt: { gt: now } },
        _sum: { quantity: true },
      }),
    ]);
    const held = new Map(holds.map((h) => [h.ticketTypeId, h._sum.quantity ?? 0]));
    return new Map(types.map((t) => [t.id, Math.max(0, t.capacity - t.sold - (held.get(t.id) ?? 0))]));
  }

  /**
   * Sold and held seats per section (held = unexpired active holds, minus one to ignore). Multiple dates (DATES):
   * pass the date, since every date sells the same seat map.
   */
  async seatsInUse(tx: Tx, eventId: string, sectionIds: string[], now = new Date(), exceptHoldId?: string, eventDateId?: string | null): Promise<InUse> {
    const [tickets, holds] = await Promise.all([
      tx.ticket.findMany({ where: { eventId, section: { in: sectionIds }, status: { not: 'VOID' }, ...onDate(eventDateId) }, select: { section: true, row: true, seat: true } }),
      tx.hold.findMany({
        where: { eventId, status: 'ACTIVE', expiresAt: { gt: now }, sectionId: { in: sectionIds }, ...(exceptHoldId ? { id: { not: exceptHoldId } } : {}), ...holdOnDate(eventDateId) },
        select: { sectionId: true, quantity: true, seats: true },
      }),
    ]);
    const out: InUse = new Map(sectionIds.map((id) => [id, { seats: new Set<string>(), count: 0 }]));
    for (const t of tickets) {
      const u = out.get(t.section!)!;
      u.count++;
      if (t.row && t.seat) u.seats.add(`${t.row}:${t.seat}`);
    }
    for (const h of holds) {
      const u = out.get(h.sectionId!)!;
      u.count += h.quantity;
      for (const s of (h.seats as SeatPick[] | null) ?? []) if (s.row && s.seat) u.seats.add(`${s.row}:${s.seat}`);
    }
    return out;
  }

  /** Remaining places per seat-map section (DATES: on one date). */
  async availabilityForSections(tx: Tx, eventId: string, map: SeatMap, now = new Date(), eventDateId?: string | null) {
    const [sold, holds] = await Promise.all([
      tx.ticket.groupBy({ by: ['section'], where: { eventId, status: { not: 'VOID' }, section: { not: null }, ...onDate(eventDateId) }, _count: { _all: true } }),
      tx.hold.groupBy({
        by: ['sectionId'],
        where: { eventId, status: 'ACTIVE', expiresAt: { gt: now }, sectionId: { not: null }, ...holdOnDate(eventDateId) },
        _sum: { quantity: true },
      }),
    ]);
    const soldBy = new Map(sold.map((s) => [s.section, s._count._all]));
    const heldBy = new Map(holds.map((h) => [h.sectionId, h._sum.quantity ?? 0]));
    return new Map(map.sections.map((s) => [s.id, Math.max(0, sectionCapacity(s) - (soldBy.get(s.id) ?? 0) - (heldBy.get(s.id) ?? 0))]));
  }
}
