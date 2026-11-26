/**
 * Edits to a live event that wait for Omoshow (Event.pendingEdit): its title, subtitle, cover and photos are what fans
 * see on cards, shares and the event page, so once an event is PUBLISHED changes to them are checked first. Fans keep
 * seeing the approved version meanwhile. Everything else (description, times, tickets…) still changes at once.
 */
import type { Prisma } from '@prisma/client';

export type PendingEdit = { title?: string; subtitle?: string; imageUrl?: string | null; media?: unknown; submittedAt: string; by: string };
type Reviewed = 'title' | 'subtitle' | 'imageUrl' | 'media';

/** A stored pendingEdit, or null when there's nothing (left) waiting. */
export function readPendingEdit(v: unknown): PendingEdit | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const pe = v as PendingEdit;
  return ['title', 'subtitle', 'imageUrl', 'media'].some((k) => k in pe) ? pe : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Splits a change to a live event: `held` are the reviewed fields that differ from what fans see now (they wait);
 * `next` is the pendingEdit after it (a field set back to the live value stops waiting), or null if nothing waits.
 */
export function holdLiveEdit(
  live: { title: string; subtitle: string; imageUrl: string | null; media: unknown; pendingEdit: unknown },
  change: Partial<Record<Reviewed, unknown>>,
  by: string,
  now = new Date(),
): { held: Reviewed[]; next: PendingEdit | null } {
  const cur = readPendingEdit(live.pendingEdit);
  const next: Record<string, unknown> = { ...(cur ?? {}) };
  const held: Reviewed[] = [];
  for (const k of ['title', 'subtitle', 'imageUrl', 'media'] as Reviewed[]) {
    if (!(k in change) || change[k] === undefined) continue;
    if (same(change[k], live[k])) delete next[k];
    else {
      next[k] = change[k];
      held.push(k);
    }
  }
  const waiting = ['title', 'subtitle', 'imageUrl', 'media'].some((k) => k in next);
  if (!waiting) return { held, next: null };
  return { held, next: { ...next, submittedAt: held.length ? now.toISOString() : (cur?.submittedAt ?? now.toISOString()), by: held.length ? by : (cur?.by ?? by) } as PendingEdit };
}

export const pendingEditJson = (pe: PendingEdit | null) => (pe ? (pe as unknown as Prisma.InputJsonValue) : undefined);
