import type { PayoutSchedule } from '@prisma/client';

const DAY = 86_400_000;

/**
 * Whether the organizer has already been paid for an order, reckoned the way their payouts screen is
 * (OrganizerService.payouts): sales paid through a Paystack subaccount split settle to the organizer at payment;
 * otherwise a day's sales are paid out the next day (DAILY), or within the week (WEEKLY).
 * Used for Omoshow Guarantee claims and donation refunds: a refund of money the organizer already has is recorded
 * as owed by them to Omoshow.
 */
export function organizerPaidOut(
  order: { provider: string; paidAt: Date | null },
  org: { payoutSchedule: PayoutSchedule; payoutProvider: string | null; paystackSubaccount: string | null; stripeAccountId?: string | null },
  now = new Date(),
) {
  if (order.provider === 'paystack' && org.payoutProvider === 'paystack' && org.paystackSubaccount) return true;
  // No payout account connected (when the caller says): nothing has been paid to them yet.
  if (org.stripeAccountId !== undefined && !org.stripeAccountId && !org.paystackSubaccount) return false;
  if (!order.paidAt) return false;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return day(order.paidAt) < day(new Date(now.getTime() - (org.payoutSchedule === 'DAILY' ? 1 : 7) * DAY));
}

/**
 * The organizer's share of `amountCents` refunded from an order, as their payouts counted it: their net on the tickets
 * (after the fee, discounts and earlier refunds; a fan-resale order only carries the event's royalty) plus the donation.
 * A partial refund takes a matching part of the ticket share first, then the donation. Used to record what an organizer
 * owes back when an order they were already paid for is refunded (Order.refundOwedCents).
 */
export function organizerShareOf(
  o: { quantity: number; unitCents: number; discountCents: number; totalCents: number; refundedCents: number; donationCents: number; donationRefundedCents: number },
  amountCents: number,
  ticketNetCents: number,
) {
  const ticketTotal = o.totalCents - o.donationCents;
  const ticketRefunded = Math.max(0, o.refundedCents - o.donationRefundedCents);
  const ticketLeft = Math.max(0, ticketTotal - ticketRefunded);
  const donationLeft = Math.max(0, o.donationCents - o.donationRefundedCents);
  const net = Math.max(0, ticketNetCents);
  const fromTickets = Math.min(amountCents, ticketLeft);
  const ticketPart = ticketLeft > 0 ? Math.round((net * fromTickets) / ticketLeft) : 0;
  const donationPart = Math.min(donationLeft, Math.max(0, amountCents - fromTickets));
  return Math.min(net, ticketPart) + donationPart;
}
