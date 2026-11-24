/**
 * Event times are the venue's wall-clock time stored as if it were UTC ("20:00" in Lagos is stored as 20:00Z),
 * with the venue's IANA zone next to it. These turn one into the real moment, for timers like reminders.
 */

/** How far `tz` is ahead of UTC at `instant`, in milliseconds. */
function offsetMs(tz: string, instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The real moment a stored wall-clock time happens in `tz` (unknown zones are treated as UTC). */
export function wallClockToInstant(wall: Date, tz: string | null | undefined): Date {
  if (!tz || tz === 'UTC') return wall;
  try {
    // Two passes settle the offset near daylight-saving changes.
    let guess = wall.getTime() - offsetMs(tz, wall);
    guess = wall.getTime() - offsetMs(tz, new Date(guess));
    return new Date(guess);
  } catch {
    return wall;
  }
}

/** The other way: what the clock on the wall in `tz` reads at `instant`, stored as if it were UTC. */
export function instantToWallClock(instant: Date, tz: string | null | undefined): Date {
  if (!tz || tz === 'UTC') return instant;
  try {
    return new Date(instant.getTime() + offsetMs(tz, instant));
  } catch {
    return instant;
  }
}

/** "Sat 8:00 PM": a stored wall-clock time as the venue shows it. */
export const wallClockLabel = (wall: Date, opts: Intl.DateTimeFormatOptions = { weekday: 'short', hour: 'numeric', minute: '2-digit' }) =>
  new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(wall);
