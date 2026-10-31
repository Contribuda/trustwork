import type { EventCard, EventFormat, EventType } from './data/types';
import { formatMoney, t } from './i18n';
import { intlTag } from '@trustwork/ui/i18n';
import { currencyCode } from './country';

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

/** Calendar fields of an instant in the event's own time zone. */
export function zonedParts(iso: string, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(iso))) map[p.type] = p.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday ?? 'Sun');
  return { year: Number(map.year), month: Number(map.month) - 1, day: Number(map.day), hour: Number(map.hour) % 24, minute: Number(map.minute), weekday };
}

const two = (n: number) => String(n).padStart(2, '0');

export function timeLabel(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${two(p.hour)}:${two(p.minute)}`;
}

/** "12–14 November 2026" for multi-day, "5 November 2026" for one day, in the active locale. */
export function dateRangeLabel(startsAt: string, endsAt: string, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat(intlTag(), { timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  const a = new Date(startsAt);
  const b = new Date(endsAt);
  const pa = zonedParts(startsAt, timeZone);
  const pb = zonedParts(endsAt, timeZone);
  if (pa.year === pb.year && pa.month === pb.month && pa.day === pb.day) return fmt.format(a);
  return fmt.formatRange(a, b);
}

/** "19:00–21:30 (GMT+5)" for one-day events, "from 10:00 (GMT+5)" for multi-day. */
export function timeRangeLabel(startsAt: string, endsAt: string, timeZone: string): string {
  const a = zonedParts(startsAt, timeZone);
  const b = zonedParts(endsAt, timeZone);
  const zone = zoneShort(timeZone);
  if (a.day === b.day && a.month === b.month) return `${timeLabel(startsAt, timeZone)}–${timeLabel(endsAt, timeZone)} (${zone})`;
  return `${t('events.fromTime', { time: timeLabel(startsAt, timeZone) })} (${zone})`;
}

/** Generic zone name in the active locale ("Узбекистан", "Uzbekistan Time", "Oʻzbekiston"); falls back to the offset form. */
export function zoneShort(timeZone: string, at: Date = new Date()): string {
  for (const timeZoneName of ['shortGeneric', 'short'] as const) {
    try {
      const part = new Intl.DateTimeFormat(intlTag(), { timeZone, timeZoneName }).formatToParts(at).find((p) => p.type === 'timeZoneName');
      if (part?.value) return part.value;
    } catch {
      /* older ICU without shortGeneric: try the next form */
    }
  }
  return timeZone;
}

export function monthTitle(iso: string, timeZone: string): string {
  const label = new Intl.DateTimeFormat(intlTag(), { timeZone, month: 'long', year: 'numeric' }).format(new Date(iso));
  return label.charAt(0).toLocaleUpperCase(intlTag()) + label.slice(1);
}

export function monthKey(iso: string, timeZone: string): string {
  const p = zonedParts(iso, timeZone);
  return `${p.year}-${two(p.month + 1)}`;
}

export function dayTile(iso: string, timeZone: string): { day: string; month: string; weekday: string } {
  const date = new Date(iso);
  const tag = intlTag();
  return {
    day: String(zonedParts(iso, timeZone).day),
    month: new Intl.DateTimeFormat(tag, { timeZone, month: 'short' }).format(date).replace(/\.$/, ''),
    weekday: new Intl.DateTimeFormat(tag, { timeZone, weekday: 'short' }).format(date).replace(/\.$/, ''),
  };
}

export function priceLabel(minorUnits: number, withFrom = true): string {
  if (minorUnits === 0) return t('events.free');
  const money = formatMoney(String(minorUnits), currencyCode());
  return withFrom ? t('events.from', { price: money }) : money;
}

export function typeLabel(type: EventType): string {
  return t(`events.types.${type}`);
}

export function formatLabelOf(format: EventFormat): string {
  return t(`events.formats.${format}`);
}

/** «Ташкент · Офлайн», «Онлайн». */
export function placeLine(card: Pick<EventCard, 'city' | 'format'>): string {
  if (card.format === 'online' || !card.city) return t('events.online');
  return card.format === 'hybrid' ? `${card.city} · ${t('events.formats.hybrid')}` : card.city;
}

export type TicketToken = { slug: string; ticketId: string; name: string; email: string; company: string; qty: number; paid: boolean };

export function encodeTicket(token: TicketToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

export function decodeTicket(raw: string | undefined): TicketToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<TicketToken>;
    if (typeof parsed.slug !== 'string' || typeof parsed.ticketId !== 'string' || typeof parsed.name !== 'string' || typeof parsed.email !== 'string') return null;
    return {
      slug: parsed.slug,
      ticketId: parsed.ticketId,
      name: parsed.name,
      email: parsed.email,
      company: typeof parsed.company === 'string' ? parsed.company : '',
      qty: typeof parsed.qty === 'number' && parsed.qty > 0 ? Math.min(10, Math.floor(parsed.qty)) : 1,
      paid: Boolean(parsed.paid),
    };
  } catch {
    return null;
  }
}

/** Deterministic short code for a registration: FNV-1a over slug + ticket + email, rendered as SR-XXXX-XX. */
export function ticketCode(token: Pick<TicketToken, 'slug' | 'ticketId' | 'email'>): string {
  let h = 0x811c9dc5;
  for (const ch of `${token.slug}|${token.ticketId}|${token.email.toLowerCase()}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  let v = h;
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[v % alphabet.length];
    v = Math.floor(v / alphabet.length) + (i + 1) * 7919;
  }
  return `SR-${out.slice(0, 4)}-${out.slice(4)}`;
}

/** 21×21 pseudo-QR pattern derived from the code; purely decorative in the demo. */
export function codeMatrix(code: string, size = 21): boolean[][] {
  const rows: boolean[][] = [];
  let seed = 0x9e3779b9;
  for (const ch of code) seed = (Math.imul(seed ^ ch.charCodeAt(0), 0x85ebca6b) + 0x1b873593) >>> 0;
  const next = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      const finder = (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
      if (finder) {
        const fx = x < 7 ? x : x - (size - 7);
        const fy = y < 7 ? y : y - (size - 7);
        const ring = fx === 0 || fy === 0 || fx === 6 || fy === 6;
        const core = fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4;
        row.push(ring || core);
      } else {
        row.push(next() % 3 === 0);
      }
    }
    rows.push(row);
  }
  return rows;
}
