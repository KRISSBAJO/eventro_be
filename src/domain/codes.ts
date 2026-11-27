import { randomInt } from 'node:crypto';

// No 0/O/1/I/L so codes read cleanly over the phone.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function chunk(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** Human-friendly order code, e.g. EVT-7F3K-2Q9M. */
export const orderCode = () => `EVT-${chunk(4)}-${chunk(4)}`;

/** Cart code, e.g. CRT-7F3K-2Q9M: several orders (one per ticket type) bought in one checkout. */
export const cartCode = () => `CRT-${chunk(4)}-${chunk(4)}`;
export const isCartCode = (id: string) => id.startsWith('CRT-');

/** Venue booking code, e.g. VB-7KQ2-M9XD. */
export const bookingCode = () => `VB-${chunk(4)}-${chunk(4)}`;

/** Ticket code: order code + 2-digit index. */
export const ticketCode = (order: string, index: number) => `${order}-${String(index + 1).padStart(2, '0')}`;

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export const randomSuffix = () => chunk(4).toLowerCase();
