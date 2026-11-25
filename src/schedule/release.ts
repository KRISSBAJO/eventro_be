/**
 * Releasing session reservations. Reservations belong to a ticket: whenever a ticket stops being usable (sold on
 * resale, so the buyer gets a new ticket; refunded; voided; its date or event cancelled) its places go back. Each
 * release cancels the reservations and lowers each item's `reserved` in one statement, so the counter can't drift
 * from the reservations even with bookings running at the same time.
 */
import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'sessionReservation' | '$queryRaw'>;

/** Cancels these reservations (those still active) and gives their places back. Returns how many were released. */
export async function releaseReservationIds(db: Db, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  // Stored times are UTC without a zone; casting the ISO text keeps them so whatever the session's zone.
  const now = new Date().toISOString();
  const rows = await db.$queryRaw<{ released: number }[]>`
    WITH r AS (
      UPDATE "SessionReservation" SET "cancelledAt" = CAST(${now} AS timestamp)
      WHERE id IN (${Prisma.join(ids)}) AND "cancelledAt" IS NULL
      RETURNING "scheduleItemId"
    ),
    c AS (SELECT "scheduleItemId", count(*)::int AS n FROM r GROUP BY 1),
    u AS (
      UPDATE "ScheduleItem" s SET reserved = GREATEST(0, s.reserved - c.n) FROM c WHERE s.id = c."scheduleItemId" RETURNING s.id
    )
    SELECT (SELECT count(*)::int FROM r) AS released, (SELECT count(*)::int FROM u) AS items`;
  return rows[0]?.released ?? 0;
}

/** Releases every active reservation of the tickets matching `tickets` (e.g. { orderId }, { eventDateId }). */
export async function releaseReservations(db: Db, tickets: Prisma.TicketWhereInput): Promise<number> {
  const rows = await db.sessionReservation.findMany({ where: { cancelledAt: null, ticket: tickets }, select: { id: true } });
  return releaseReservationIds(db, rows.map((r) => r.id));
}
