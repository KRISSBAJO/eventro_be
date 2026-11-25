/**
 * Pay what you want (PWYW) tiers and charity donations: the rules, kept free of the database so they're easy to test.
 *
 * PWYW amounts are base amounts, like an organizer's fixed basePriceCents: the fan picks one between the tier's
 * minimum and maximum (whole minor units), and the event's fee mode applies to it exactly as to a fixed price
 * (BUYER: Eventro's fee goes on top, so the fan pays buyerPrice(amount); ORGANIZER: the fan pays the amount and the
 * fee comes out of the organizer's share). Everyone in an order pays the same amount per ticket (Order.unitCents).
 *
 * Donations carry no fee, discount or ticket protection: they are added to the order total as they are, kept apart
 * from ticket revenue (Order.donationCents) and left out of Eventro Guarantee shares.
 */
import { formatMoney } from '../mail/mail.module';
import { buyerPrice, type FeeMode } from './money';

/** The highest PWYW amount when the organizer sets no maximum (the same cap as a fixed price). */
export const PWYW_CEILING_CENTS = 10_000_000;
/** The highest donation on one order. */
export const DONATION_MAX_CENTS = 10_000_000;
export const MAX_QUICK_PICKS = 4;
export const MAX_DONATION_SUGGESTIONS = 4;

/** Shown wherever organizers set up or are paid donations. */
export const DONATION_NOTE = "Eventro collects donations on the organizer's behalf; the organizer is responsible for passing them to the cause.";

export const PROMO_ON_PWYW = 'Promo codes don’t apply to pay-what-you-want tickets: you choose your own price.';

export type PwywTier = {
  name: string;
  pricing: 'FIXED' | 'PWYW';
  pwywMinCents: number | null;
  pwywSuggestedCents: number | null;
  pwywMaxCents: number | null;
  pwywQuickPicks: number[];
};

export const isPwyw = (t: { pricing: string }) => t.pricing === 'PWYW';

/** The tier's limits (base amounts): its minimum and its maximum, or the ceiling when it has none. */
export function pwywLimits(t: Pick<PwywTier, 'pwywMinCents' | 'pwywMaxCents'>) {
  const min = Math.max(0, t.pwywMinCents ?? 0);
  return { min, max: t.pwywMaxCents ?? PWYW_CEILING_CENTS };
}

/** What fans see about a PWYW tier (null for fixed prices). `feePermille` is the fee added on top (0 in ORGANIZER mode). */
export function pwywView(t: PwywTier, feeMode: FeeMode, feePermille: number) {
  if (!isPwyw(t)) return null;
  const { min, max } = pwywLimits(t);
  return {
    minCents: min,
    suggestedCents: t.pwywSuggestedCents,
    maxCents: max,
    maxSet: t.pwywMaxCents !== null,
    quickPicks: t.pwywQuickPicks,
    feePermille: feeMode === 'BUYER' ? feePermille : 0,
  };
}

/**
 * Checks a fan's PWYW amount (base, minor units) and returns the all-in price per ticket. Throws a fan-readable
 * message (as an Error; callers turn it into a 400).
 */
export function pwywUnit(t: PwywTier, amount: number | null | undefined, feeMode: FeeMode, feePermille: number, currency: string) {
  if (amount === null || amount === undefined) throw new Error(`Choose how much you want to pay for ${t.name}.`);
  if (!Number.isInteger(amount)) throw new Error('Amounts are in whole minor units (cents), so use a whole number.');
  const { min, max } = pwywLimits(t);
  if (amount < min) throw new Error(`The minimum for ${t.name} is ${formatMoney(min, currency)}.`);
  if (amount > max) throw new Error(`The most you can pay for ${t.name} is ${formatMoney(max, currency)}.`);
  return buyerPrice(amount, feeMode, feePermille);
}

/** Sorted, de-duplicated whole amounts. */
const cleanAmounts = (xs: number[] | undefined) => [...new Set((xs ?? []).filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);

/**
 * An organizer's PWYW settings, checked and cleaned. Throws a readable message. `fallbackMin` is used when no
 * minimum is given (e.g. the basePriceCents sent with it).
 */
export function cleanPwywInput(i: { pwywMinCents?: number | null; pwywSuggestedCents?: number | null; pwywMaxCents?: number | null; pwywQuickPicks?: number[] }, fallbackMin = 0) {
  const min = i.pwywMinCents ?? fallbackMin;
  if (!Number.isInteger(min) || min < 0) throw new Error('The minimum has to be 0 or more.');
  if (min > PWYW_CEILING_CENTS) throw new Error('The minimum is too high.');
  const max = i.pwywMaxCents ?? null;
  if (max !== null) {
    if (!Number.isInteger(max) || max <= 0) throw new Error('The maximum has to be more than 0, or left empty for no maximum.');
    if (max < min) throw new Error('The maximum can’t be below the minimum.');
    if (max > PWYW_CEILING_CENTS) throw new Error('The maximum is too high.');
  }
  const top = max ?? PWYW_CEILING_CENTS;
  const suggested = i.pwywSuggestedCents ?? null;
  if (suggested !== null && (!Number.isInteger(suggested) || suggested < min || suggested > top)) throw new Error('The suggested price has to be between the minimum and the maximum.');
  const picks = cleanAmounts(i.pwywQuickPicks);
  if (picks.length > MAX_QUICK_PICKS) throw new Error(`Add up to ${MAX_QUICK_PICKS} quick-pick amounts.`);
  if (picks.some((p) => p < min || p > top)) throw new Error('Quick-pick amounts have to be between the minimum and the maximum.');
  return { pwywMinCents: min, pwywSuggestedCents: suggested, pwywMaxCents: max, pwywQuickPicks: picks };
}

export type DonationSettings = {
  donationsEnabled: boolean;
  donationCause: string | null;
  donationDescription: string | null;
  donationSuggestedCents: number[];
  donationMinCents: number | null;
};

/** The event's donation settings after a change, checked. Throws a readable message. */
export function cleanDonationSettings(
  cur: DonationSettings,
  i: { donationsEnabled?: boolean; donationCause?: string | null; donationDescription?: string | null; donationSuggestedCents?: number[]; donationMinCents?: number | null },
): DonationSettings {
  const cause = i.donationCause !== undefined ? i.donationCause?.trim().replace(/\s+/g, ' ') || null : cur.donationCause;
  const description = i.donationDescription !== undefined ? i.donationDescription?.trim() || null : cur.donationDescription;
  const min = i.donationMinCents !== undefined ? i.donationMinCents : cur.donationMinCents;
  const suggested = i.donationSuggestedCents !== undefined ? cleanAmounts(i.donationSuggestedCents) : cur.donationSuggestedCents;
  const enabled = i.donationsEnabled ?? cur.donationsEnabled;
  if (cause && cause.length > 80) throw new Error('Keep the cause name to 80 characters.');
  if (description && description.length > 280) throw new Error('Keep the donation description to 280 characters.');
  if (min !== null && (!Number.isInteger(min) || min < 1 || min > DONATION_MAX_CENTS)) throw new Error('The minimum donation has to be more than 0.');
  if (suggested.length > MAX_DONATION_SUGGESTIONS) throw new Error(`Add up to ${MAX_DONATION_SUGGESTIONS} suggested donation amounts.`);
  if (suggested.some((s) => s < 1 || s > DONATION_MAX_CENTS)) throw new Error('Suggested donations have to be more than 0.');
  if (min !== null && suggested.some((s) => s < min)) throw new Error('Suggested donations can’t be below the minimum donation.');
  if (enabled && (!cause || cause.length < 2)) throw new Error('Name the cause donations go to (2–80 characters).');
  return { donationsEnabled: enabled, donationCause: cause, donationDescription: description, donationSuggestedCents: suggested, donationMinCents: min };
}

/** What fans see about donations on an event (null when it doesn't take them). */
export function donationsView(e: DonationSettings) {
  if (!e.donationsEnabled || !e.donationCause) return null;
  return { cause: e.donationCause, description: e.donationDescription, suggestedCents: e.donationSuggestedCents, minCents: e.donationMinCents, maxCents: DONATION_MAX_CENTS };
}

/** Checks a donation at checkout (0 or nothing = none). Throws a readable message. */
export function checkDonation(e: DonationSettings, cents: number | null | undefined, currency: string) {
  if (!cents) return 0;
  if (!e.donationsEnabled || !e.donationCause) throw new Error('This event doesn’t take donations.');
  if (!Number.isInteger(cents) || cents < 0) throw new Error('Donations are in whole minor units (cents), so use a whole number.');
  if (e.donationMinCents !== null && cents < e.donationMinCents) throw new Error(`The smallest donation is ${formatMoney(e.donationMinCents, currency)}.`);
  if (cents > DONATION_MAX_CENTS) throw new Error(`The largest donation on one order is ${formatMoney(DONATION_MAX_CENTS, currency)}.`);
  return cents;
}

/* ---------- an order's tickets and its donation ---------- */

type Money = { totalCents: number; refundedCents: number; donationCents?: number; donationRefundedCents?: number };

/** The order's ticket total: everything paid except the donation. */
export const ticketTotal = (o: { totalCents: number; donationCents?: number }) => o.totalCents - (o.donationCents ?? 0);
/** What has been refunded of the tickets (refunds count against the tickets first, then the donation). */
export const ticketRefunded = (o: Pick<Money, 'refundedCents' | 'donationRefundedCents'>) => Math.max(0, o.refundedCents - (o.donationRefundedCents ?? 0));
/** What can still be refunded of the tickets. */
export const ticketLeft = (o: Money) => Math.max(0, ticketTotal(o) - ticketRefunded(o));
/** What can still be refunded of the donation. */
export const donationLeft = (o: { donationCents?: number; donationRefundedCents?: number }) => Math.max(0, (o.donationCents ?? 0) - (o.donationRefundedCents ?? 0));
