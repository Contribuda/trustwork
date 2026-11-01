/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone (PIPE-001,
 * docs/engine/hub-console/automation-and-scheduling.md#schedules). Fields take numbers, `*`, ranges, lists and steps,
 * as `CronExpressionSchema` in the console contract allows. Day-of-month and day-of-week follow the usual rule: when
 * both are restricted, either matching is enough. Times that do not exist locally (a spring-forward gap) never match;
 * a repeated local hour (fall back) matches once, at its first occurrence.
 */
export interface CronSchedule { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number>; daysRestricted: boolean; weekdaysRestricted: boolean }

const RANGES: readonly [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(text: string, [min, max]: [number, number]): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron step ${stepText}`);
    let from: number; let to: number;
    if (range === '*') { from = min; to = max; } else {
      const [a, b] = range.split('-');
      from = Number(a); to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) throw new Error(`cron field ${text} out of range ${min}-${max}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, restricted: text !== '*' };
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a cron expression has five fields');
  const [m, h, dom, mon, dow] = parts.map((p, i) => field(p, RANGES[i]!));
  const weekdays = new Set([...dow!.values].map((d) => d % 7));
  return { minutes: m!.values, hours: h!.values, days: dom!.values, months: mon!.values, weekdays, daysRestricted: dom!.restricted, weekdaysRestricted: dow!.restricted };
}

interface Local { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(timeZone, f);
  }
  return f;
}
/** The wall-clock reading of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string): Local {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday!]! };
}

export function matches(schedule: CronSchedule, local: Local): boolean {
  if (!schedule.minutes.has(local.minute) || !schedule.hours.has(local.hour) || !schedule.months.has(local.month)) return false;
  const dom = schedule.days.has(local.day);
  const dow = schedule.weekdays.has(local.weekday);
  if (schedule.daysRestricted && schedule.weekdaysRestricted) return dom || dow;
  return dom && dow;
}

const MINUTE = 60_000;
/**
 * Due instants in (after, until], oldest first, at most `limit`. Walks minute by minute in UTC and reads the local
 * clock, so offsets and daylight-saving changes come from the platform's time-zone data; a local minute repeated by a
 * fall-back is matched once.
 */
export function dueBetween(expression: string, timeZone: string, after: Date, until: Date, limit = 1000): Date[] {
  const schedule = parseCron(expression);
  const out: Date[] = [];
  const seen = new Set<string>();
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = until.getTime();
  // Bounded scan: at most 400 days of minutes.
  const hardEnd = Math.min(end, t + 400 * 24 * 60 * MINUTE);
  for (; t <= hardEnd && out.length < limit; t += MINUTE) {
    const local = localParts(new Date(t), timeZone);
    if (!matches(schedule, local)) continue;
    const key = `${local.year}-${local.month}-${local.day} ${local.hour}:${local.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new Date(t));
  }
  return out;
}

/** The next `count` due instants after `after`, for the console preview ("next five runs"). */
export function nextRuns(expression: string, timeZone: string, after: Date, count = 5): Date[] {
  return dueBetween(expression, timeZone, after, new Date(after.getTime() + 400 * 24 * 60 * MINUTE), count);
}

/** Whether an instant falls in one of the schedule's windows (local days and `HH:MM` spans; a span may cross midnight). */
export function inWindow(windows: readonly { days: readonly string[]; from: string; to: string }[], timeZone: string, instant: Date): boolean {
  if (windows.length === 0) return true;
  const local = localParts(instant, timeZone);
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const minutes = local.hour * 60 + local.minute;
  const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  return windows.some((w) => {
    const from = toMinutes(w.from); const to = toMinutes(w.to);
    if (from < to) return w.days.includes(names[local.weekday]!) && minutes >= from && minutes < to;
    // Crossing midnight: the evening part belongs to the listed day, the morning part to the day after it.
    const yesterday = names[(local.weekday + 6) % 7]!;
    return (w.days.includes(names[local.weekday]!) && minutes >= from) || (w.days.includes(yesterday) && minutes < to);
  });
}
