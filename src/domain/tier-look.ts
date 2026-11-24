/**
 * Ticket tier looks: the visual design a ticket type gets on the website and in the app
 * (event page, checkout, wallet, orders, gifts). An organizer can pick one (`TicketType.style`);
 * otherwise it follows from the tier's name. Clients get the result as `look`.
 *
 * `tierLevel` is the same rule as the website's components/tier-perks.tsx and the app's
 * src/lib/tiers.ts. Keep the three in sync.
 */

export const TIER_LOOKS = ['early', 'standard', 'vip', 'vvip', 'platinum', 'table'] as const;
export type TierLook = (typeof TIER_LOOKS)[number];

/** Accepted on create and edit: a look, or "auto" (same as null) to follow the name. */
export const TIER_STYLE_INPUTS = [...TIER_LOOKS, 'auto'] as const;

/** How premium a tier name reads (5 = Special VIP … 0 = Early bird), or null when the name doesn't say. */
export function tierLevel(name: string): number | null {
  if (/special\s*vip|\bsvip\b|platinum|diamond|royal|ultimate/i.test(name)) return 5;
  if (/vvip/i.test(name)) return 4;
  // VIP words win over table/package words: "VIP package" is a VIP tier.
  if (/vip|premium|gold|backstage/i.test(name)) return 3;
  if (/table|group|bundle|package|party of/i.test(name)) return 2.5;
  if (/early/i.test(name)) return 0;
  if (/general|regular|standard|\bga\b|admission|entry|free/i.test(name)) return 1;
  return null;
}

/** The look a tier gets from its name alone. */
export function autoLook(name: string): TierLook {
  switch (tierLevel(name)) {
    case 5:
      return 'platinum';
    case 4:
      return 'vvip';
    case 3:
      return 'vip';
    case 2.5:
      return 'table';
    case 0:
      return 'early';
    default:
      return 'standard';
  }
}

const isLook = (v: unknown): v is TierLook => typeof v === 'string' && (TIER_LOOKS as readonly string[]).includes(v);

/** The stored value for a style sent by an organizer: null for auto (or nothing), else the look. */
export function styleInput(v: string | null | undefined): TierLook | null {
  return isLook(v) ? v : null;
}

/** The explicit style when there is one, else the look from the name. */
export function resolveLook(name: string, style: string | null | undefined): TierLook {
  return isLook(style) ? style : autoLook(name);
}

/** What a fan-facing ticket type select needs for the look, perks and badge. */
export const TIER_FIELDS = { name: true, perks: true, badge: true, style: true } as const;

/** Adds the resolved `look` to a ticket type that has its name and style. */
export function withLook<T extends { name: string; style: string | null }>(t: T): T & { look: TierLook } {
  return { ...t, look: resolveLook(t.name, t.style) };
}
