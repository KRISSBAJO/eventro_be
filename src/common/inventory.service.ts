import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { sectionCapacity, type SeatMap } from '../domain/seatmap';

type Tx = Prisma.TransactionClient | PrismaService;

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

  /** Remaining places per seat-map section. */
  async availabilityForSections(tx: Tx, eventId: string, map: SeatMap, now = new Date()) {
    const [sold, holds] = await Promise.all([
      tx.ticket.groupBy({ by: ['section'], where: { eventId, status: { not: 'VOID' }, section: { not: null } }, _count: { _all: true } }),
      tx.hold.groupBy({
        by: ['sectionId'],
        where: { eventId, status: 'ACTIVE', expiresAt: { gt: now }, sectionId: { not: null } },
        _sum: { quantity: true },
      }),
    ]);
    const soldBy = new Map(sold.map((s) => [s.section, s._count._all]));
    const heldBy = new Map(holds.map((h) => [h.sectionId, h._sum.quantity ?? 0]));
    return new Map(map.sections.map((s) => [s.id, Math.max(0, sectionCapacity(s) - (soldBy.get(s.id) ?? 0) - (heldBy.get(s.id) ?? 0))]));
  }
}
