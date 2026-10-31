import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight } from 'lucide-react';
import { MediaFrame } from '@/components/ui';
import { eventBadge } from '@/components/public/EventRow';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { formatLabel, regionLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { EventCard, PublicationCard } from '@/app/_lib/data/types';
import { dateRangeLabel, placeLine, typeLabel } from '@/app/_lib/events';
import { eventCover, storyCover } from '@/app/_lib/media';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { localHref } from '@/app/_lib/localize';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';

/** Search results depend on the query: rendered per request from public data only (WEB-005). */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  return { title: t('search.pageTitle') };
}

type Group = 'news' | 'articles' | 'magazine' | 'events' | 'companies' | 'people' | 'projects';
const GROUPS: Group[] = ['news', 'articles', 'magazine', 'events', 'companies', 'people', 'projects'];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Every word of the query must occur in the haystack (title, lede, labels). */
function matches(q: string[], hay: string[]): boolean {
  const text = norm(hay.join(' '));
  return q.every((w) => text.includes(w));
}

function PubRow({ card }: { card: PublicationCard }) {
  return (
    <li className="srch-row">
      <span className="srch-row__thumb" aria-hidden="true">
        <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="96px" />
      </span>
      <span className="srch-row__body">
        <span className="pub-kicker">
          {formatLabel(card)}
          {card.topics[0] ? ` · ${topicLabel(card.topics[0])}` : ''}
        </span>
        <NextLink href={card.href} className="srch-row__title">
          {typo(card.title)}
        </NextLink>
        <span className="srch-row__meta">
          {card.authorLabel} · {longDate(card.publishedAt)}
        </span>
      </span>
    </li>
  );
}

function EventRowCompact({ card }: { card: EventCard }) {
  const badge = eventBadge(card);
  return (
    <li className="srch-row">
      <span className="srch-row__thumb" aria-hidden="true">
        <MediaFrame media={eventCover(card.cover)} ratio="fill" radius="none" sizes="96px" />
      </span>
      <span className="srch-row__body">
        <span className="pub-kicker">
          {typeLabel(card.type)} · {placeLine(card)}
        </span>
        <NextLink href={card.href} className="srch-row__title">
          {typo(card.title)}
        </NextLink>
        <span className="srch-row__meta">
          {dateRangeLabel(card.startsAt, card.endsAt, card.timezone)} · <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
        </span>
      </span>
    </li>
  );
}

/**
 * Keyword search across public cards (news, articles, events, companies, people, projects) of the demo stand.
 * Deterministic substring matching over titles, ledes and labels; the governed retrieval (cited answers,
 * documents) is a separate RAG deliverable and is not imitated here.
 */
export default async function SearchPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: PageSearchParams }) {
  await primePublicLocale((await params).lang);
  const sp = await searchParams;
  const raw = typeof sp.q === 'string' ? sp.q.trim().slice(0, 80) : '';
  const only = GROUPS.find((g) => g === sp.in);
  const words = norm(raw)
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const has = words.length > 0;
  const news = has ? (await data.listNews()).filter((c) => matches(words, [c.title, c.lede, c.authorLabel, ...c.topics.map(topicLabel), formatLabel(c)])) : [];
  const articles = has ? (await data.listArticles()).filter((c) => matches(words, [c.title, c.lede, c.authorLabel, ...c.topics.map(topicLabel), formatLabel(c)])) : [];
  const issues = has ? (await data.getMagazine()).archive.filter((i) => matches(words, [i.title, i.lede, `№ ${i.number}`, String(i.number), ...i.items.map((x) => x.title)])) : [];
  const events = has ? (await data.listEvents('all')).filter((c) => matches(words, [c.title, c.lede, c.city ?? '', c.venueName ?? '', c.organizer.name, typeLabel(c.type), ...c.speakers.map((s) => s.name)])) : [];
  const companies = has ? (await data.listCompanies()).filter((c) => matches(words, [c.name, c.description ?? '', ...c.directions, regionLabel(c.region)])) : [];
  const people = has ? (await data.listPeople()).filter((c) => matches(words, [c.displayName, c.headline ?? '', c.roleLine, ...c.expertise, c.employer?.name ?? ''])) : [];
  const projects = has ? (await data.listPublicProjects()).filter((c) => matches(words, [c.name, c.summary ?? '', c.owner.label, regionLabel(c.region)])) : [];
  const counts: Record<Group, number> = { news: news.length, articles: articles.length, magazine: issues.length, events: events.length, companies: companies.length, people: people.length, projects: projects.length };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const visible = (g: Group) => (!only || only === g) && counts[g] > 0;
  const tab = (g?: Group) => `/search?${new URLSearchParams({ q: raw, ...(g ? { in: g } : {}) }).toString()}`;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap srch">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1">{raw ? `${t('search.pageTitle')}: «${typo(raw)}»` : t('search.pageTitle')}</h1>
            <p className="pub-lede">{typo(t('search.lede'))}</p>
          </div>
        </header>
        <form className="pub-search srch__form" action={localHref('/search')} method="get" role="search" aria-label={t('search.pageTitle')}>
          <div className="ev-field srch__field">
            <label className="sr-only" htmlFor="srch-q">
              {t('search.queryLabel')}
            </label>
            <input id="srch-q" name="q" type="search" defaultValue={raw} placeholder={t('search.placeholder')} autoComplete="off" enterKeyHint="search" />
          </div>
          <button type="submit" className="pub-btn pub-btn--dark">
            {t('publicPages.find')}
          </button>
        </form>

        {!has ? (
          <p className="pub-lede">{t('search.enterQuery')}</p>
        ) : total === 0 ? (
          <div className="srch__empty">
            <p className="pub-lede">{t('search.empty')}</p>
            <div className="pub-actions">
              <NextLink href="/news" className="pub-btn">
                {t('search.groupNews')}
              </NextLink>
              <NextLink href="/articles" className="pub-btn">
                {t('search.groupArticles')}
              </NextLink>
              <NextLink href="/events" className="pub-btn">
                {t('search.groupEvents')}
              </NextLink>
            </div>
          </div>
        ) : (
          <>
            <nav className="pub-chips srch__tabs" aria-label={t('search.pageTitle')}>
              <NextLink href={tab()} className="pub-chip" aria-current={only ? undefined : 'true'} scroll={false}>
                {t('search.all')}
                <span className="pub-chip__n">{total}</span>
              </NextLink>
              {GROUPS.filter((g) => counts[g] > 0).map((g) => (
                <NextLink key={g} href={tab(g)} className="pub-chip" aria-current={only === g ? 'true' : undefined} scroll={false}>
                  {t(`search.group${g.charAt(0).toUpperCase()}${g.slice(1)}` as 'search.groupNews')}
                  <span className="pub-chip__n">{counts[g]}</span>
                </NextLink>
              ))}
            </nav>
            <p className="ev-results" role="status">
              <span className="ev-results__count">
                {t('search.found')}: <strong>{total}</strong> {t('search.resultNoun', { count: total })}
              </span>
            </p>
            <div className="srch__groups">
              {visible('news') ? (
                <section aria-labelledby="g-news">
                  <h2 className="pub-day" id="g-news">
                    {t('search.groupNews')}
                  </h2>
                  <ul className="srch-list">
                    {news.map((c) => (
                      <PubRow key={c.id} card={c} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('articles') ? (
                <section aria-labelledby="g-articles">
                  <h2 className="pub-day" id="g-articles">
                    {t('search.groupArticles')}
                  </h2>
                  <ul className="srch-list">
                    {articles.map((c) => (
                      <PubRow key={c.id} card={c} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('magazine') ? (
                <section aria-labelledby="g-magazine">
                  <h2 className="pub-day" id="g-magazine">
                    {t('search.groupMagazine')}
                  </h2>
                  <ul className="srch-list">
                    {issues.map((i) => (
                      <li key={i.id} className="srch-row srch-row--plain">
                        <span className="srch-row__body">
                          <span className="pub-kicker">
                            {t('magazine.issueTitle', { number: i.number })} · {shortDate(i.dateFrom)} — {shortDate(i.dateTo)}
                          </span>
                          <NextLink href={i.href} className="srch-row__title">
                            {typo(i.title)}
                          </NextLink>
                          <span className="srch-row__meta">{typo(i.lede)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('events') ? (
                <section aria-labelledby="g-events">
                  <h2 className="pub-day" id="g-events">
                    {t('search.groupEvents')}
                  </h2>
                  <ul className="srch-list">
                    {events.map((c) => (
                      <EventRowCompact key={c.id} card={c} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('companies') ? (
                <section aria-labelledby="g-companies">
                  <h2 className="pub-day" id="g-companies">
                    {t('search.groupCompanies')}
                  </h2>
                  <ul className="srch-list">
                    {companies.map((c) => (
                      <li key={c.id} className="srch-row srch-row--plain">
                        <span className="srch-row__body">
                          <span className="pub-kicker">{regionLabel(c.region)}</span>
                          <NextLink href={c.href} className="srch-row__title">
                            {c.name}
                          </NextLink>
                          {c.description ? <span className="srch-row__meta">{typo(c.description)}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('people') ? (
                <section aria-labelledby="g-people">
                  <h2 className="pub-day" id="g-people">
                    {t('search.groupPeople')}
                  </h2>
                  <ul className="srch-list">
                    {people.map((c) => (
                      <li key={c.id} className="srch-row srch-row--person">
                        <PersonAvatar name={c.displayName} portrait={c.portrait} size={48} />
                        <span className="srch-row__body">
                          <span className="pub-kicker">{regionLabel(c.region)}</span>
                          <NextLink href={c.href} className="srch-row__title">
                            {c.displayName}
                          </NextLink>
                          <span className="srch-row__meta">{c.roleLine}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {visible('projects') ? (
                <section aria-labelledby="g-projects">
                  <h2 className="pub-day" id="g-projects">
                    {t('search.groupProjects')}
                  </h2>
                  <ul className="srch-list">
                    {projects.map((c) => (
                      <li key={c.id} className="srch-row srch-row--plain">
                        <span className="srch-row__body">
                          <span className="pub-kicker">{regionLabel(c.region)}</span>
                          <NextLink href={c.href} className="srch-row__title">
                            {c.name}
                          </NextLink>
                          {c.summary ? <span className="srch-row__meta">{typo(c.summary)}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </>
        )}
        <p className="pub-note__body srch__note">
          {t('search.note')}
          {has ? (
            <>
              {' '}
              <NextLink href="/events" className="pub-more">
                {t('search.groupEvents')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
