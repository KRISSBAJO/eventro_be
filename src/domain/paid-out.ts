import type { PayoutSchedule } from '@prisma/client';

const DAY = 86_400_000;

/**
 * Whether the organizer has already been paid for an order, reckoned the way their payouts screen is
 * (OrganizerService.payouts): sales paid through a Paystack subaccount split settle to the organizer at payment;
 * otherwise a day's sales are paid out the next day (DAILY), or within the week (WEEKLY).
 * Used for Eventro Guarantee claims and donation refunds: a refund of money the organizer already has is recorded
 * as owed by them to Eventro.
 */
export function organizerPaidOut(
  order: { provider: string; paidAt: Date | null },
  org: { payoutSchedule: PayoutSchedule; payoutProvider: string | null; paystackSubaccount: string | null },
  now = new Date(),
) {
  if (order.provider === 'paystack' && org.payoutProvider === 'paystack' && org.paystackSubaccount) return true;
  if (!order.paidAt) return false;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return day(order.paidAt) < day(new Date(now.getTime() - (org.payoutSchedule === 'DAILY' ? 1 : 7) * DAY));
}
