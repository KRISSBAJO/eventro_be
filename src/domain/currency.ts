/**
 * Currencies an event can be priced in. Amounts are stored in minor units ("cents": kobo for NGN, pesewas for GHS…);
 * every currency here has 2 decimals. Paystack handles the African currencies, Stripe the rest.
 */
export const CURRENCIES = {
  USD: { name: 'US dollar', symbol: '$' },
  EUR: { name: 'Euro', symbol: '€' },
  GBP: { name: 'British pound', symbol: '£' },
  CAD: { name: 'Canadian dollar', symbol: 'CA$' },
  AUD: { name: 'Australian dollar', symbol: 'A$' },
  NGN: { name: 'Nigerian naira', symbol: '₦' },
  GHS: { name: 'Ghanaian cedi', symbol: 'GH₵' },
  KES: { name: 'Kenyan shilling', symbol: 'KSh' },
  ZAR: { name: 'South African rand', symbol: 'R' },
} as const;

export type Currency = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];

/** Paid through Paystack (local cards, bank transfer, USSD); everything else through Stripe. */
export const PAYSTACK_CURRENCIES = new Set<Currency>(['NGN', 'GHS', 'KES', 'ZAR']);

export const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && c in CURRENCIES;

/** The currency to suggest for a country (falls back to USD when we can't price in theirs). */
export function currencyForCountry(country: string | null | undefined, countryCurrency?: string | null): Currency {
  if (countryCurrency && isCurrency(countryCurrency)) return countryCurrency;
  const euro = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
  if (country && euro.has(country.toUpperCase())) return 'EUR';
  return 'USD';
}
