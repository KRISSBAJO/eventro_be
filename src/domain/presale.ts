/**
 * Presale: an event can have a code that lets fans buy ticket types before their public on-sale
 * (TicketType.salesStart), from Event.presaleStartsAt (null = as soon as the code is set). The code never leaves the
 * server: fans send it with the hold (POST /holds `accessCode`), and POST /events/:slug/presale checks one.
 */

type PresaleEvent = { presaleCode: string | null; presaleStartsAt: Date | null };

/** The event has a presale that has opened. */
export const presaleRunning = (e: PresaleEvent, now = new Date()) => !!e.presaleCode && (!e.presaleStartsAt || e.presaleStartsAt <= now);

/** This code opens the event's presale right now (codes compare without case). */
export const presaleOpen = (e: PresaleEvent, code: string | undefined, now = new Date()) =>
  presaleRunning(e, now) && !!code && code.trim().toUpperCase() === e.presaleCode!.toUpperCase();

/** A ticket type's place in its sale window: not on public sale yet, on sale, or over. */
export const saleState = (t: { salesStart: Date | null; salesEnd: Date | null }, now = new Date()): 'SOON' | 'ON' | 'ENDED' =>
  t.salesEnd && t.salesEnd <= now ? 'ENDED' : t.salesStart && t.salesStart > now ? 'SOON' : 'ON';
