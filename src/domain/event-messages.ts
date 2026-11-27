/** Organizer messages to ticket holders (see src/organizer/messages.ts): who a message was meant for. */

/**
 * Whether a message was meant for a ticket of this type: its ticket types (none = every type) and, with multiple
 * dates or days, its date.
 */
export const messageHits = (m: { ticketTypeIds: string[]; eventDateId: string | null }, mode: string, tt: { id: string; eventDateId: string | null; validDateIds: string[] }) =>
  (!m.ticketTypeIds.length || m.ticketTypeIds.includes(tt.id)) && (!m.eventDateId || (mode === 'DATES' ? tt.eventDateId === m.eventDateId : mode === 'DAYS' ? tt.validDateIds.includes(m.eventDateId) : true));
