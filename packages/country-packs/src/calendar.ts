import { WEEKDAYS, type FactOf, type HolidayRule, type Weekday } from './facets.js';
import { factsFor } from './facts.js';
import type { CountryPack } from './schema.js';

/**
 * Holiday dates from calendar facts (CTRY-002). Pure date arithmetic in UTC calendar days; no time zone is involved
 * because a holiday is a calendar date in the scope that declares it.
 */

export type HolidayDate = {
  id: string;
  scope: string;
  name: Record<string, string>;
  nonWorking: boolean;
  /** The date the holiday falls on. */
  date: string;
  /** The date it is observed (differs from `date` when a weekend rule moves it). */
  observed: string;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day));
/** Weekday of a UTC date as an index into WEEKDAYS (Monday first). */
const weekdayIndex = (d: Date) => (d.getUTCDay() + 6) % 7;

function ruleDates(rule: HolidayRule, year: number): Date[] {
  switch (rule.kind) {
    case 'fixed': {
      const d = utc(year, rule.month, rule.day);
      return d.getUTCMonth() === rule.month - 1 ? [d] : [];
    }
    case 'nth-weekday': {
      const target = WEEKDAYS.indexOf(rule.weekday);
      if (rule.nth === -1) {
        const last = utc(year, rule.month + 1, 0);
        const back = (weekdayIndex(last) - target + 7) % 7;
        return [utc(year, rule.month, last.getUTCDate() - back)];
      }
      const first = utc(year, rule.month, 1);
      const offset = (target - weekdayIndex(first) + 7) % 7;
      const d = utc(year, rule.month, 1 + offset + (rule.nth - 1) * 7);
      return d.getUTCMonth() === rule.month - 1 ? [d] : [];
    }
    case 'dates':
      return rule.dates.filter((date) => date.startsWith(`${year}-`)).map((date) => new Date(`${date}T00:00:00Z`));
  }
}

function observedDate(date: Date, rule: FactOf<'calendar'> & { type: 'holiday' }): Date {
  const day: Weekday = WEEKDAYS[weekdayIndex(date)]!;
  const shift = (days: number) => new Date(date.getTime() + days * 86_400_000);
  switch (rule.observed) {
    case 'nearest-weekday':
      return day === 'sat' ? shift(-1) : day === 'sun' ? shift(1) : date;
    case 'next-weekday':
      return day === 'sat' ? shift(2) : day === 'sun' ? shift(1) : date;
    case 'sunday-to-monday':
      return day === 'sun' ? shift(1) : date;
    default:
      return date;
  }
}

function inEffect(fact: { effectiveFrom?: string | undefined; effectiveTo?: string | undefined }, date: string): boolean {
  return (!fact.effectiveFrom || fact.effectiveFrom <= date) && (!fact.effectiveTo || date <= fact.effectiveTo);
}

/** Holidays of a year in the country, or in a subdivision (country holidays plus the subdivision's own), by date. */
export function holidaysInYear(pack: CountryPack, year: number, regionCode?: string): HolidayDate[] {
  const result: HolidayDate[] = [];
  for (const { scope, fact } of factsFor(pack, 'calendar', regionCode)) {
    if (fact.type !== 'holiday') continue;
    for (const date of ruleDates(fact.rule, year)) {
      if (!inEffect(fact, iso(date))) continue;
      result.push({ id: fact.id, scope, name: fact.name, nonWorking: fact.nonWorking, date: iso(date), observed: iso(observedDate(date, fact)) });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** The working week in a scope; Monday to Friday is only a fallback when no pack states it. */
export function workingWeek(pack: CountryPack, regionCode?: string): { days: Weekday[]; stated: boolean } {
  const fact = factsFor(pack, 'calendar', regionCode).find((f) => f.fact.type === 'working-week')?.fact;
  return fact && fact.type === 'working-week' ? { days: fact.days, stated: true } : { days: ['mon', 'tue', 'wed', 'thu', 'fri'], stated: false };
}
