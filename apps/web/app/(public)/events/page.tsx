import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, MapPin, Video, X } from 'lucide-react';
import { Button, ButtonLink, EmptyState, MediaFrame, TextField } from '@/components/ui';
import { EventRow, eventBadge } from '@/components/public/EventRow';
import { Dropdown } from '@/components/public/Dropdown';
import { FilterBar } from '@/components/public/FilterBar';
import { data } from '@/app/_lib/data';
import type { EventCard, EventFormat, EventType } from '@/app/_lib/data/types';
import { eventCover } from '@/app/_lib/media';
import { dateRangeLabel, dayTile, monthKey, monthTitle, placeLine, timeRangeLabel, typeLabel, zonedParts } from '@/app/_lib/events';
import { intlTag } from '@trustwork/ui/i18n';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('events.title'), description: t('events.lede') };
}

const TYPES: EventType[] = ['conference', 'seminar', 'webinar', 'tour', 'exhibition', 'meetup'];
const FORMATS: EventFormat[] = ['offline', 'online', 'hybrid'];
/** Calendar labels in the active locale: month title, full date, short weekday heads (Monday first). */
const monthYear = (year: number, month: number) => {
  const label = new Intl.DateTimeFormat(intlTag(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1)));
  return label.charAt(0).toLocaleUpperCase(intlTag()) + label.slice(1);
};
const fullDate = (year: number, month: number, day: number) => new Intl.DateTimeFormat(intlTag(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, day)));
const weekdayHeads = () => {
  const fmt = new Intl.DateTimeFormat(intlTag(), { weekday: 'short', timeZone: 'UTC' });
  return [5, 6, 7, 8, 9, 10, 11].map((d) => fmt.format(new Date(Date.UTC(2026, 0, d))).replace(/\.$/, ''));
};
const ZONE = 'Europe/Moscow';
const DAY_MS = 86_400_000;

type Filters = { q?: string; scope: 'upcoming' | 'past'; type?: EventType; format?: EventFormat; price?: 'free' | 'paid'; city?: string; date?: 'next7' | 'next30'; month?: string; day?: string };
type FacetKey = 'type' | 'format' | 'price' | 'city' | 'time';

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** Builds a shareable `/events?…` link; empty values drop out so URLs stay short. */
function href(f: Partial<Filters>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'scope' && v === 'upcoming')) params.set(k, String(v));
  const s = params.toString();
  return s ? `/events?${s}` : '/events';
}

const dayNumber = (p: { year: number; month: number; day: number }) => Date.UTC(p.year, p.month, p.day) / DAY_MS;

/** Applies every filter except `except`, so facet counts answer «what would I get if I also picked this». */
function apply(list: EventCard[], f: Filters, nowDay: number, except?: FacetKey): EventCard[] {
  const q = f.q?.trim().toLowerCase();
  return list.filter((e) => {
    if (except !== 'type' && f.type && e.type !== f.type) return false;
    if (except !== 'format' && f.format && e.format !== f.format) return false;
    if (except !== 'price' && f.price === 'free' && e.priceFromMinorUnits > 0) return false;
    if (except !== 'price' && f.price === 'paid' && e.priceToMinorUnits === 0) return false;
    if (except !== 'city' && f.city && (f.city === 'online' ? e.format !== 'online' : e.city !== f.city)) return false;
    if (except !== 'time') {
      const p = zonedParts(e.startsAt, ZONE);
      const d = dayNumber(p);
      if (f.date === 'next7' && (d < nowDay || d > nowDay + 7)) return false;
      if (f.date === 'next30' && (d < nowDay || d > nowDay + 30)) return false;
      if (f.month && monthKey(e.startsAt, ZONE) !== f.month) return false;
      if (f.day && `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` !== f.day) return false;
    }
    if (q) {
      const hay = [e.title, e.lede, e.city ?? '', e.venueName ?? '', e.organizer.name, ...e.speakers.map((s) => s.name), typeLabel(e.type)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Month grid (Monday first, Moscow time) with month navigation; days with events link to a day filter. */
function MonthCalendar({ events, year, month, filters, nowDay }: { events: EventCard[]; year: number; month: number; filters: Filters; nowDay: number }) {
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const byDay = new Map<number, number>();
  for (const e of events) {
    const p = zonedParts(e.startsAt, ZONE);
    if (p.year === year && p.month === month) byDay.set(p.day, (byDay.get(p.day) ?? 0) + 1);
  }
  const cells: Array<number | null> = [...Array<null>(offset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const key = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}`;
  const prev = month === 0 ? key(year - 1, 11) : key(year, month - 1);
  const next = month === 11 ? key(year + 1, 0) : key(year, month + 1);
  const base = { ...filters, day: undefined, date: undefined };
  return (
    <div className="ev-cal" aria-label={monthYear(year, month)}>
      <div className="ev-cal__nav">
        <NextLink href={href({ ...base, month: prev })} className="ev-cal__arrow" scroll={false} aria-label={t('events.prevMonth')}>
          <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
        </NextLink>
        <span className="ev-cal__title" aria-live="polite">
          {monthYear(year, month)}
        </span>
        <NextLink href={href({ ...base, month: next })} className="ev-cal__arrow" scroll={false} aria-label={t('events.nextMonthNav')}>
          <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
        </NextLink>
      </div>
      <div className="ev-cal__grid" role="grid">
        {weekdayHeads().map((d) => (
          <span key={d} className="ev-cal__head" aria-hidden="true">
            {d}
          </span>
        ))}
        {cells.map((day, i) => {
          if (!day) return <span key={`e${i}`} className="ev-cal__cell ev-cal__cell--empty" />;
          const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const count = byDay.get(day);
          const isToday = dayNumber({ year, month, day }) === nowDay;
          const selected = filters.day === iso;
          const cls = ['ev-cal__cell', count ? 'ev-cal__cell--event' : '', isToday ? 'ev-cal__cell--today' : '', selected ? 'ev-cal__cell--selected' : ''].filter(Boolean).join(' ');
          return count ? (
            <NextLink
              key={day}
              href={selected ? href({ ...base, month: key(year, month) }) : href({ ...base, day: iso })}
              className={cls}
              scroll={false}
              aria-current={selected ? 'date' : undefined}
              title={`${fullDate(year, month, day)}: ${count} ${plural(count, t('events.foundOne'), t('events.foundFew'), t('events.foundMany'))}`}
            >
              {day}
              {count > 1 ? <span className="ev-cal__dot" aria-hidden="true" /> : null}
            </NextLink>
          ) : (
            <span key={day} className={cls} aria-label={isToday ? t('events.today') : undefined}>
              {day}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Events section: search, upcoming/past, quick date ranges and every month that has events (so the whole year
 * is reachable), type chips, faceted side filters with counts (format, price, city), a navigable month calendar
 * whose days filter the list, and rows grouped by month. All filters are query parameters: the page stays
 * server-rendered, works without JavaScript and every state has a shareable URL.
 */
export default async function EventsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const filters: Filters = {
    q: str('q')?.slice(0, 80),
    scope: str('scope') === 'past' ? 'past' : 'upcoming',
    type: TYPES.find((x) => x === str('type')),
    format: FORMATS.find((x) => x === str('format')),
    price: str('price') === 'free' || str('price') === 'paid' ? (str('price') as 'free' | 'paid') : undefined,
    city: str('city'),
    date: str('date') === 'next7' || str('date') === 'next30' ? (str('date') as 'next7' | 'next30') : undefined,
    month: /^\d{4}-\d{2}$/.test(str('month') ?? '') ? str('month') : undefined,
    day: /^\d{4}-\d{2}-\d{2}$/.test(str('day') ?? '') ? str('day') : undefined,
  };
  const nowParts = zonedParts(new Date().toISOString(), ZONE);
  const nowDay = dayNumber(nowParts);
  const scoped = data.listEvents(filters.scope);
  const items = apply(scoped, filters, nowDay);
  const timeless = apply(scoped, filters, nowDay, 'time');
  const active = Boolean(filters.q || filters.type || filters.format || filters.price || filters.city || filters.date || filters.month || filters.day);
  const upcoming = filters.scope === 'upcoming' ? scoped : data.listEvents('upcoming');
  const lead = upcoming.find((e) => e.featured && e.status === 'open') ?? upcoming[0];
  const rows = lead && !active && filters.scope === 'upcoming' ? items.filter((e) => e.id !== lead.id) : items;
  const cities = [...new Set(scoped.map((e) => e.city).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, 'ru'));

  const months = new Map<string, { title: string; n: number }>();
  for (const e of timeless) {
    const key = monthKey(e.startsAt, ZONE);
    const m = months.get(key) ?? { title: monthTitle(e.startsAt, ZONE), n: 0 };
    m.n += 1;
    months.set(key, m);
  }
  const groups = new Map<string, { title: string; rows: EventCard[] }>();
  for (const e of rows) {
    const key = monthKey(e.startsAt, e.timezone);
    const g = groups.get(key) ?? { title: monthTitle(e.startsAt, e.timezone), rows: [] };
    g.rows.push(e);
    groups.set(key, g);
  }

  const calKey = filters.day ? filters.day.slice(0, 7) : (filters.month ?? (items[0] ? monthKey(items[0].startsAt, ZONE) : `${nowParts.year}-${String(nowParts.month + 1).padStart(2, '0')}`));
  const calYear = Number(calKey.slice(0, 4));
  const calMonth = Number(calKey.slice(5, 7)) - 1;
  const leadBadge = lead ? eventBadge(lead) : null;
  const past = data.listEvents('past').slice(0, 3);
  const dayLabel = (iso: string) => fullDate(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const monthLabel = (key: string) => monthYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1);
  const chips: Array<{ label: string; to: string }> = [];
  if (filters.q) chips.push({ label: `${t('events.searchPrefix')}: ${filters.q}`, to: href({ ...filters, q: undefined }) });
  if (filters.date) chips.push({ label: t(`events.${filters.date}`), to: href({ ...filters, date: undefined }) });
  if (filters.month) chips.push({ label: monthLabel(filters.month), to: href({ ...filters, month: undefined }) });
  if (filters.day) chips.push({ label: dayLabel(filters.day), to: href({ ...filters, day: undefined }) });
  if (filters.type) chips.push({ label: t(`events.typesPlural.${filters.type}`), to: href({ ...filters, type: undefined }) });
  if (filters.format) chips.push({ label: t(`events.formats.${filters.format}`), to: href({ ...filters, format: undefined }) });
  if (filters.price) chips.push({ label: filters.price === 'free' ? t('events.priceFree') : t('events.pricePaid'), to: href({ ...filters, price: undefined }) });
  if (filters.city) chips.push({ label: filters.city === 'online' ? t('events.online') : filters.city, to: href({ ...filters, city: undefined }) });
  const hidden = Object.entries(filters).filter(([k, v]) => k !== 'q' && v && !(k === 'scope' && v === 'upcoming')) as Array<[string, string]>;
  const count = (except: FacetKey, pred: (e: EventCard) => boolean) => apply(scoped, filters, nowDay, except).filter(pred).length;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('events.title'))}
            </h1>
            <p className="pub-lede">{typo(t('events.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/login?next=%2Fapp%2Fpublications" variant="secondary">
              {t('events.suggest')}
            </ButtonLink>
          </div>
        </header>

        {lead && leadBadge ? (
          <section className="news-lead ev-lead" aria-labelledby="events-lead-title">
            <div className="news-lead__media">
              <MediaFrame media={eventCover(lead.cover)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 1023px) 100vw, 55vw" />
              <div className="ev-lead__tile" aria-hidden="true">
                <span className="ev-tile__day">{dayTile(lead.startsAt, lead.timezone).day}</span>
                <span className="ev-tile__month">{dayTile(lead.startsAt, lead.timezone).month}</span>
              </div>
            </div>
            <div className="news-lead__panel">
              <span className="pub-kicker">
                {t('events.leadKicker')} · {typeLabel(lead.type)}
              </span>
              <h2 className="news-lead__title" id="events-lead-title">
                <NextLink href={lead.href}>{typo(lead.title)}</NextLink>
              </h2>
              <p className="news-lead__dek">{typo(lead.lede)}</p>
              <ul className="ev-facts ev-facts--inline">
                <li>{dateRangeLabel(lead.startsAt, lead.endsAt, lead.timezone)}</li>
                <li>{timeRangeLabel(lead.startsAt, lead.endsAt, lead.timezone)}</li>
                <li>
                  {lead.format === 'online' ? <Video size={14} strokeWidth={2} aria-hidden="true" /> : <MapPin size={14} strokeWidth={2} aria-hidden="true" />}
                  {placeLine(lead)}
                </li>
                <li className={`ev-badge ev-badge--${leadBadge.tone}`}>{leadBadge.label}</li>
              </ul>
              <div className="pub-actions" style={{ marginTop: 'var(--space-2)' }}>
                <NextLink href={`${lead.href}#tickets`} className="pub-btn pub-btn--dark">
                  {lead.status === 'open' ? t('events.register') : t('events.details')}
                </NextLink>
                <NextLink href={lead.href} className="pub-more">
                  {t('events.details')}
                  <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </div>
            </div>
          </section>
        ) : null}

        <div className="pub-feed" id="feed">
          <div aria-label={t('events.feedLabel')}>
            <div className="pub-search">
              <form className="search-row" action={withBase('/events')} method="get" role="search" aria-label={t('events.find')}>
                <TextField name="q" label={t('events.find')} placeholder={t('events.searchPlaceholder')} inputMode="search" autoComplete="off" defaultValue={filters.q ?? ''} />
                <Button type="submit" variant="primary">
                  {t('events.find')}
                </Button>
                {hidden.map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
              </form>
            </div>

            <FilterBar label={t('events.filtersTitle')}>
              <div className="ev-scope" role="tablist" aria-label={t('events.feedLabel')}>
                <NextLink
                  href={href({ ...filters, scope: 'upcoming', date: undefined, month: undefined, day: undefined })}
                  className="ev-scope__tab"
                  scroll={false}
                  role="tab"
                  aria-selected={filters.scope === 'upcoming'}
                >
                  {t('events.upcoming')}
                </NextLink>
                <NextLink href={href({ ...filters, scope: 'past', date: undefined, month: undefined, day: undefined })} className="ev-scope__tab" scroll={false} role="tab" aria-selected={filters.scope === 'past'}>
                  {t('events.pastTab')}
                </NextLink>
              </div>
              <Dropdown
                label={t('events.datesLabel')}
                value={filters.day ? dayLabel(filters.day) : filters.month ? monthLabel(filters.month) : filters.date ? t(`events.${filters.date}`) : undefined}
                groups={[
                  {
                    items: [
                      { label: t('events.allDates'), n: timeless.length, active: !filters.date && !filters.month && !filters.day, to: href({ ...filters, date: undefined, month: undefined, day: undefined }) },
                      ...(filters.scope === 'upcoming'
                        ? (['next7', 'next30'] as const).map((d) => ({
                            label: t(`events.${d}`),
                            n: apply(scoped, { ...filters, date: d, month: undefined, day: undefined }, nowDay).length,
                            active: filters.date === d,
                            to: href({ ...filters, date: d, month: undefined, day: undefined }),
                          }))
                        : []),
                    ],
                  },
                  {
                    title: t('events.monthsTitle'),
                    items: [...months.entries()].map(([key, m]) => ({
                      label: m.title,
                      n: m.n,
                      active: filters.month === key || Boolean(filters.day?.startsWith(key)),
                      to: href({ ...filters, month: key, date: undefined, day: undefined }),
                    })),
                  },
                ]}
              />
              <Dropdown
                label={t('events.typesLabel')}
                value={filters.type ? t(`events.typesPlural.${filters.type}`) : undefined}
                groups={[
                  {
                    items: [
                      { label: t('events.allTypes'), n: count('type', () => true), active: !filters.type, to: href({ ...filters, type: undefined }) },
                      ...TYPES.map((key) => ({
                        label: t(`events.typesPlural.${key}`),
                        n: count('type', (e) => e.type === key),
                        active: filters.type === key,
                        to: href({ ...filters, type: filters.type === key ? undefined : key }),
                      })),
                    ],
                  },
                ]}
              />
              <Dropdown
                label={t('events.formatsLabel')}
                value={filters.format ? t(`events.formats.${filters.format}`) : undefined}
                groups={[
                  {
                    items: [
                      { label: t('events.allFormats'), n: count('format', () => true), active: !filters.format, to: href({ ...filters, format: undefined }) },
                      ...FORMATS.map((f) => ({
                        label: t(`events.formats.${f}`),
                        n: count('format', (e) => e.format === f),
                        active: filters.format === f,
                        to: href({ ...filters, format: filters.format === f ? undefined : f }),
                      })),
                    ],
                  },
                ]}
              />
              <Dropdown
                label={t('events.cityLabel')}
                value={filters.city ? (filters.city === 'online' ? t('events.online') : filters.city) : undefined}
                groups={[
                  {
                    items: [
                      { label: t('events.allCities'), n: count('city', () => true), active: !filters.city, to: href({ ...filters, city: undefined }) },
                      ...cities.map((c) => ({ label: c, n: count('city', (e) => e.city === c), active: filters.city === c, to: href({ ...filters, city: filters.city === c ? undefined : c }) })),
                      { label: t('events.online'), n: count('city', (e) => e.format === 'online'), active: filters.city === 'online', to: href({ ...filters, city: filters.city === 'online' ? undefined : 'online' }) },
                    ],
                  },
                ]}
              />
              <Dropdown
                label={t('events.priceLabel')}
                value={filters.price ? (filters.price === 'free' ? t('events.priceFree') : t('events.pricePaid')) : undefined}
                groups={[
                  {
                    items: [
                      { label: t('events.priceAll'), n: count('price', () => true), active: !filters.price, to: href({ ...filters, price: undefined }) },
                      {
                        label: t('events.priceFree'),
                        n: count('price', (e) => e.priceFromMinorUnits === 0),
                        active: filters.price === 'free',
                        to: href({ ...filters, price: filters.price === 'free' ? undefined : 'free' }),
                      },
                      { label: t('events.pricePaid'), n: count('price', (e) => e.priceToMinorUnits > 0), active: filters.price === 'paid', to: href({ ...filters, price: filters.price === 'paid' ? undefined : 'paid' }) },
                    ],
                  },
                ]}
              />
            </FilterBar>

            <div className="ev-results" role="status">
              <span className="ev-results__count">
                {t('events.found')}: <strong>{items.length}</strong> {plural(items.length, t('events.foundOne'), t('events.foundFew'), t('events.foundMany'))}
              </span>
              {chips.length ? (
                <span className="ev-active">
                  {chips.map((c) => (
                    <NextLink key={c.label} href={c.to} className="ev-active__chip" scroll={false} aria-label={`${t('events.removeFilter')}: ${c.label}`}>
                      {c.label}
                      <X size={12} strokeWidth={2.5} aria-hidden="true" />
                    </NextLink>
                  ))}
                  <NextLink href={href({ scope: filters.scope })} className="ev-active__reset" scroll={false}>
                    {t('events.resetAll')}
                  </NextLink>
                </span>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <div style={{ marginTop: 'var(--space-6)' }}>
                <EmptyState
                  title={t('events.empty')}
                  actions={
                    <ButtonLink href={href({ scope: filters.scope })} variant="secondary">
                      {t('events.reset')}
                    </ButtonLink>
                  }
                />
              </div>
            ) : (
              [...groups.entries()].map(([key, group]) => (
                <section key={key} aria-label={group.title} id={`month-${key}`}>
                  <h2 className="pub-day">{group.title}</h2>
                  <div className="pub-rows">
                    {group.rows.map((card) => (
                      <EventRow key={card.id} card={card} id={`ev-${card.slug}`} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>

          <aside className="pub-aside" aria-label={t('events.calendarTitle')}>
            <section aria-labelledby="cal-title">
              <h3 className="pub-aside__title" id="cal-title">
                {t('events.calendarTitle')}
              </h3>
              <MonthCalendar events={timeless} year={calYear} month={calMonth} filters={filters} nowDay={nowDay} />
            </section>
            {filters.scope === 'upcoming' && past.length ? (
              <section aria-labelledby="past-title">
                <div className="pub-h2-row" style={{ marginBottom: 'var(--space-2)' }}>
                  <h3 className="pub-aside__title" id="past-title" style={{ marginBottom: 0 }}>
                    {t('events.pastTitle')}
                  </h3>
                  <NextLink href="/events?scope=past" className="pub-more">
                    {t('publicPages.all')}
                  </NextLink>
                </div>
                <div className="pub-brief">
                  {past.map((e) => (
                    <div key={e.id} className="pub-brief__item">
                      <span className="pub-brief__date">
                        {dayTile(e.startsAt, e.timezone).day}.{String(zonedParts(e.startsAt, e.timezone).month + 1).padStart(2, '0')}
                      </span>
                      <span className="pub-brief__title">
                        <NextLink href={e.href}>{typo(e.title)}</NextLink>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="pub-note pub-note--tint" aria-labelledby="org-title">
              <h3 className="pub-note__title" id="org-title">
                {t('events.organizersTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('events.organizersBody'))}</p>
              <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-more">
                {t('events.organizersAction')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>
      </div>

      <section className="pub-cta" aria-labelledby="events-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="events-cta-title">
              {typo(t('events.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('events.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-btn pub-btn--light">
              {t('events.organizersAction')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('events.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
