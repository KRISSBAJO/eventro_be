/** Money helpers. Everything is integer cents; percentages are per-mille (35 = 3.5%). */

export const permilleOf = (cents: number, permille: number) => Math.round((cents * permille) / 1000);

export type FeeMode = 'BUYER' | 'ORGANIZER';

/**
 * What the organizer receives for one ticket sold at `priceCents` (the all-in price).
 * BUYER mode: the fee was added on top of the organizer's base price, so base = price / (1 + fee).
 * ORGANIZER mode: the fan paid the base price; the fee comes out of it.
 */
export function organizerNet(priceCents: number, mode: FeeMode, feePermille: number) {
  if (priceCents <= 0) return 0;
  if (mode === 'BUYER') return Math.round((priceCents * 1000) / (1000 + feePermille));
  return priceCents - permilleOf(priceCents, feePermille);
}

/** All-in price shown to fans for an organizer's base price. */
export function buyerPrice(baseCents: number, mode: FeeMode, feePermille: number) {
  if (baseCents <= 0) return 0;
  return mode === 'BUYER' ? Math.round((baseCents * (1000 + feePermille)) / 1000) : baseCents;
}

export type Quote = {
  unitCents: number;
  quantity: number;
  subtotalCents: number;
  discountCents: number;
  protectionCents: number;
  totalCents: number;
};

export const PROTECTION_PERMILLE = 70; // 7% of tickets

export function quote(unitCents: number, quantity: number, promoPercent: number | null, protection: boolean): Quote {
  const subtotalCents = unitCents * quantity;
  const discountCents = promoPercent ? permilleOf(subtotalCents, promoPercent * 10) : 0;
  const protectionCents = protection ? permilleOf(subtotalCents, PROTECTION_PERMILLE) : 0;
  return {
    unitCents,
    quantity,
    subtotalCents,
    discountCents,
    protectionCents,
    totalCents: subtotalCents - discountCents + protectionCents,
  };
}
