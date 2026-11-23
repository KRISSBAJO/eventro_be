/**
 * Seat map format shared by the venue designer (frontend) and the API.
 *
 * A map is a canvas (width x height) with an optional stage and a list of sections.
 * Each section has a shape (curved "arc" or "rect"), a seating mode ("reserved" rows and
 * seats, or "ga" standing with a capacity) and belongs to one ticket type.
 */

export type ArcGeometry = { cx: number; cy: number; r0: number; r1: number; a0: number; a1: number };
export type RectGeometry = { x: number; y: number; w: number; h: number; rotation?: number };

export type Section = {
  id: string;
  label: string;
  ticketTypeId: string;
  shape: 'arc' | 'rect';
  seating: 'reserved' | 'ga';
  rows?: number;
  seatsPerRow?: number;
  capacity?: number;
  /** Seating level shown to fans, e.g. "Lower Level". */
  level?: string;
  geometry: ArcGeometry | RectGeometry;
};

/** What sits in the middle of the venue. Drawn with its markings; never for sale. */
export type SurfaceKind = 'stage' | 'rink' | 'court' | 'field';
const SURFACE_KINDS: SurfaceKind[] = ['stage', 'rink', 'court', 'field'];

/** Places on the map that can't be bought: lounges, bars, entrances, sound desks. */
export type AreaKind = 'lounge' | 'bar' | 'entrance' | 'other';
const AREA_KINDS: AreaKind[] = ['lounge', 'bar', 'entrance', 'other'];
export type Area = { id: string; label: string; kind: AreaKind; geometry: RectGeometry };

export type SeatMap = {
  version: 1;
  width: number;
  height: number;
  stage?: RectGeometry & { label?: string; kind?: SurfaceKind };
  areas?: Area[];
  sections: Section[];
};

export type ValidationResult = { ok: true; map: SeatMap } | { ok: false; errors: string[] };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function checkArc(g: Record<string, unknown>, where: string, errors: string[]): ArcGeometry | null {
  const keys = ['cx', 'cy', 'r0', 'r1', 'a0', 'a1'] as const;
  if (!keys.every((k) => isNum(g[k]))) {
    errors.push(`${where}: arc geometry needs numeric cx, cy, r0, r1, a0, a1`);
    return null;
  }
  const a = g as unknown as ArcGeometry;
  if (a.r0 < 0 || a.r1 <= a.r0) errors.push(`${where}: outer radius must be larger than inner radius`);
  if (a.a1 <= a.a0 || a.a1 - a.a0 > 360) errors.push(`${where}: arc must span between 0 and 360 degrees`);
  return { cx: a.cx, cy: a.cy, r0: a.r0, r1: a.r1, a0: a.a0, a1: a.a1 };
}

function checkRect(g: Record<string, unknown>, where: string, errors: string[]): RectGeometry | null {
  if (!['x', 'y', 'w', 'h'].every((k) => isNum(g[k])) || (g.rotation !== undefined && !isNum(g.rotation))) {
    errors.push(`${where}: rect geometry needs numeric x, y, w, h (and optional rotation)`);
    return null;
  }
  const r = g as unknown as RectGeometry;
  if (r.w <= 0 || r.h <= 0) errors.push(`${where}: width and height must be positive`);
  return { x: r.x, y: r.y, w: r.w, h: r.h, ...(r.rotation ? { rotation: r.rotation } : {}) };
}

/** Validates untrusted JSON and returns a clean copy (unknown fields dropped). */
export function validateSeatMap(input: unknown, ticketTypeIds: Set<string>): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['Seat map must be an object'] };
  const m = input as Record<string, unknown>;
  if (m.version !== 1) errors.push('version must be 1');
  if (!isInt(m.width, 100, 4000) || !isInt(m.height, 100, 4000)) errors.push('width and height must be whole numbers between 100 and 4000');
  if (!Array.isArray(m.sections)) return { ok: false, errors: [...errors, 'sections must be an array'] };
  if (m.sections.length > 300) errors.push('A seat map can have at most 300 sections');

  let stage: SeatMap['stage'];
  if (m.stage !== undefined) {
    const s = m.stage as Record<string, unknown>;
    const r = s && typeof s === 'object' ? checkRect(s, 'stage', errors) : null;
    if (s && s.kind !== undefined && !SURFACE_KINDS.includes(s.kind as SurfaceKind)) errors.push(`stage: kind must be one of ${SURFACE_KINDS.join(', ')}`);
    if (r)
      stage = {
        ...r,
        ...(typeof s.label === 'string' ? { label: s.label.slice(0, 24) } : {}),
        ...(SURFACE_KINDS.includes(s.kind as SurfaceKind) ? { kind: s.kind as SurfaceKind } : {}),
      };
  }

  const areas: Area[] = [];
  if (m.areas !== undefined) {
    if (!Array.isArray(m.areas)) errors.push('areas must be an array');
    else {
      if (m.areas.length > 100) errors.push('A seat map can have at most 100 areas');
      const seenAreas = new Set<string>();
      m.areas.forEach((raw, i) => {
        const where = `area ${i + 1}`;
        if (!raw || typeof raw !== 'object') return errors.push(`${where}: must be an object`);
        const a = raw as Record<string, unknown>;
        const id = typeof a.id === 'string' ? a.id : '';
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) errors.push(`${where}: id must be 1-24 letters, numbers, - or _`);
        else if (seenAreas.has(id)) errors.push(`${where}: duplicate id "${id}"`);
        seenAreas.add(id);
        const label = typeof a.label === 'string' ? a.label.trim().slice(0, 32) : '';
        if (!label) errors.push(`${where}: label is required`);
        if (!AREA_KINDS.includes(a.kind as AreaKind)) errors.push(`${where}: kind must be one of ${AREA_KINDS.join(', ')}`);
        const g = a.geometry && typeof a.geometry === 'object' ? checkRect(a.geometry as Record<string, unknown>, where, errors) : null;
        if (!g) errors.push(`${where}: needs a rect geometry`);
        else if (id && label) areas.push({ id, label, kind: a.kind as AreaKind, geometry: g });
      });
    }
  }

  const seen = new Set<string>();
  const sections: Section[] = [];
  m.sections.forEach((raw, i) => {
    const where = `section ${i + 1}`;
    if (!raw || typeof raw !== 'object') return errors.push(`${where}: must be an object`);
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id : '';
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) errors.push(`${where}: id must be 1-24 letters, numbers, - or _`);
    else if (seen.has(id)) errors.push(`${where}: duplicate id "${id}"`);
    seen.add(id);
    const label = typeof s.label === 'string' ? s.label.trim().slice(0, 24) : '';
    if (!label) errors.push(`${where}: label is required`);
    const tt = typeof s.ticketTypeId === 'string' ? s.ticketTypeId : '';
    if (!ticketTypeIds.has(tt)) errors.push(`${where}: ticketTypeId must be one of this event's ticket types`);
    if (s.shape !== 'arc' && s.shape !== 'rect') errors.push(`${where}: shape must be "arc" or "rect"`);
    if (s.seating !== 'reserved' && s.seating !== 'ga') errors.push(`${where}: seating must be "reserved" or "ga"`);
    if (s.seating === 'reserved' && (!isInt(s.rows, 1, 200) || !isInt(s.seatsPerRow, 1, 200)))
      errors.push(`${where}: reserved sections need rows and seatsPerRow between 1 and 200`);
    if (s.seating === 'ga' && !isInt(s.capacity, 1, 100_000)) errors.push(`${where}: standing sections need a capacity between 1 and 100,000`);
    const g = (s.geometry ?? {}) as Record<string, unknown>;
    const geometry = s.shape === 'arc' ? checkArc(g, where, errors) : s.shape === 'rect' ? checkRect(g, where, errors) : null;
    if (geometry && id && label) {
      sections.push({
        id,
        label,
        ticketTypeId: tt,
        shape: s.shape as Section['shape'],
        seating: s.seating as Section['seating'],
        ...(typeof s.level === 'string' && s.level.trim() ? { level: s.level.trim().slice(0, 24) } : {}),
        ...(s.seating === 'reserved' ? { rows: s.rows as number, seatsPerRow: s.seatsPerRow as number } : { capacity: s.capacity as number }),
        geometry,
      });
    }
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    map: { version: 1, width: m.width as number, height: m.height as number, ...(stage ? { stage } : {}), ...(areas.length ? { areas } : {}), sections },
  };
}

export const sectionCapacity = (s: Section) => (s.seating === 'reserved' ? (s.rows ?? 0) * (s.seatsPerRow ?? 0) : (s.capacity ?? 0));

/** Total seats per ticket type, from the sections linked to it. */
export function capacityByTicketType(map: SeatMap) {
  const out = new Map<string, number>();
  for (const s of map.sections) out.set(s.ticketTypeId, (out.get(s.ticketTypeId) ?? 0) + sectionCapacity(s));
  return out;
}

/** Row labels: A..Z, AA, AB, … */
export function rowLabel(index: number) {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Best-available seats in a reserved section: a block of `qty` side by side in the
 * front-most row that has one, otherwise the first free seats in row order.
 * `taken` holds "ROW:SEAT" keys. Returns null if the section doesn't have enough seats.
 */
export function assignSeats(section: Section, taken: Set<string>, qty: number): { row: string; seat: number }[] | null {
  if (section.seating !== 'reserved') return null;
  const rows = section.rows ?? 0;
  const per = section.seatsPerRow ?? 0;
  const free = (r: string, n: number) => !taken.has(`${r}:${n}`);

  for (let ri = 0; ri < rows; ri++) {
    const r = rowLabel(ri);
    let run: number[] = [];
    for (let n = 1; n <= per; n++) {
      if (free(r, n)) {
        run.push(n);
        if (run.length === qty) return run.map((seat) => ({ row: r, seat }));
      } else run = [];
    }
  }
  const any: { row: string; seat: number }[] = [];
  for (let ri = 0; ri < rows && any.length < qty; ri++) {
    const r = rowLabel(ri);
    for (let n = 1; n <= per && any.length < qty; n++) if (free(r, n)) any.push({ row: r, seat: n });
  }
  return any.length === qty ? any : null;
}

/** A ready-made arena layout (stage, floor, lower and upper bowls) for new events. */
export function arenaTemplate(ids: { floor: string; lower: string; upper: string }): SeatMap {
  const cx = 600;
  const cy = 170;
  const ring = (prefix: number, count: number, r0: number, r1: number, from: number, to: number, ticketTypeId: string, rows: number, seats: number): Section[] => {
    const w = (to - from) / count;
    return Array.from({ length: count }, (_, i) => ({
      id: String(prefix + i + 1),
      label: String(prefix + i + 1),
      ticketTypeId,
      shape: 'arc' as const,
      seating: 'reserved' as const,
      rows,
      seatsPerRow: seats,
      geometry: { cx, cy, r0, r1, a0: to - (i + 1) * w + 0.8, a1: to - i * w - 0.8 },
    }));
  };
  return {
    version: 1,
    width: 1200,
    height: 760,
    stage: { x: 450, y: 60, w: 300, h: 80, label: 'STAGE' },
    sections: [
      { id: 'FL', label: 'Floor', ticketTypeId: ids.floor, shape: 'arc', seating: 'ga', capacity: 1200, geometry: { cx, cy, r0: 120, r1: 270, a0: 28, a1: 152 } },
      ...ring(100, 6, 290, 410, 6, 174, ids.lower, 12, 20),
      ...ring(200, 8, 430, 570, -14, 194, ids.upper, 14, 24),
    ],
  };
}
