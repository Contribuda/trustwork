import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, Clock } from 'lucide-react';
import { ButtonLink, EmptyState, MediaFrame } from '@/components/ui';
import { SearchForm, topicLabel, regionLabel } from '@/components/public/parts';
import { data, type TopicKey } from '@/app/_lib/data';
import type { PublicationCard } from '@/app/_lib/data/types';
import { storyCover } from '@/app/_lib/media';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('news.title'), description: t('news.lede') };
}

const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
const PAGE_SIZE = 8;

function dayLabel(iso: string, today: string): string {
  const day = iso.slice(0, 10);
  if (day === today) return t('news.today');
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10)) return t('news.yesterday');
  return longDate(day);
}

function eventLine(card: PublicationCard): string | null {
  if (!card.eventTime) return null;
  return `${t('news.eventLabel')}: ${shortDate(card.eventTime)}`;
}

/**
 * News section: lead story in a tinted panel, search + topic chips, the feed grouped by day with a meta column
 * (source type, source link, event date, corrections), a sticky aside («Коротко за неделю», how sources work,
 * topics with counts) and the navy call-to-action. Filters are query parameters (server-rendered, shareable).
 */
export default async function NewsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const topicParam = typeof params.topic === 'string' && (TOPICS as string[]).includes(params.topic) ? (params.topic as TopicKey) : undefined;
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const everything = data.listNews();
  const scoped = data.listNews(topicParam);
  const items = query ? scoped.filter((n) => `${n.title} ${n.lede} ${n.source?.name ?? ''}`.toLowerCase().includes(query)) : scoped;
  const filtered = Boolean(topicParam || query);
  const page = Math.max(1, Number.parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1);
  const lead = !filtered ? items[0] : undefined;
  const allRows = lead ? items.slice(1) : items;
  const rows = allRows.slice(0, PAGE_SIZE * page);
  const moreHref = (() => {
    const next = new URLSearchParams();
    if (topicParam) next.set('topic', topicParam);
    if (query) next.set('q', query);
    next.set('page', String(page + 1));
    return `/news?${next.toString()}#feed`;
  })();
  const brief = everything.slice(0, 5);
  const today = (everything[0]?.publishedAt ?? new Date().toISOString()).slice(0, 10);
  const groups = new Map<string, PublicationCard[]>();
  for (const item of rows) {
    const key = item.publishedAt.slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('news.title'))}
            </h1>
            <p className="pub-lede">{typo(t('news.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/login?next=%2Fapp%2Fpublications" variant="secondary">
              {t('news.suggest')}
            </ButtonLink>
          </div>
        </header>

        {lead ? (
          <section className="news-lead" aria-labelledby="news-lead-title">
            <div className="news-lead__media">
              <MediaFrame media={storyCover(lead)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 1023px) 100vw, 55vw" />
            </div>
            <div className="news-lead__panel">
              <span className="pub-kicker">{t('news.leadKicker')}</span>
              <h2 className="news-lead__title" id="news-lead-title">
                <NextLink href={lead.href}>{typo(lead.title)}</NextLink>
              </h2>
              <p className="news-lead__dek">{typo(lead.lede)}</p>
              <p className="news-lead__meta">{[lead.source?.name, lead.eventTime ? `${t('news.eventLabel')}: ${longDate(lead.eventTime)}` : longDate(lead.publishedAt)].filter(Boolean).join(' · ')}</p>
              <NextLink href={lead.href} className="pub-more">
                {t('news.readNews')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </section>
        ) : null}

        <div className="pub-feed" id="feed">
          <div aria-label={t('news.feedLabel')}>
            <div className="pub-search">
              <SearchForm placeholder={t('news.searchPlaceholder')} action="/news" label={t('news.find')} />
            </div>
            <nav className="pub-chips" aria-label={t('news.allTopics')}>
              <NextLink href="/news" className="pub-chip" aria-current={topicParam ? undefined : 'true'}>
                {t('news.allTopics')}
              </NextLink>
              {TOPICS.map((key) => (
                <NextLink key={key} href={`/news?topic=${key}`} className="pub-chip" aria-current={topicParam === key ? 'true' : undefined}>
                  {topicLabel(key)}
                </NextLink>
              ))}
            </nav>

            {rows.length === 0 ? (
              filtered ? (
                <EmptyState
                  title={t('news.emptyFiltered')}
                  actions={
                    <ButtonLink href="/news" variant="secondary">
                      {t('news.resetFilters')}
                    </ButtonLink>
                  }
                />
              ) : (
                <EmptyState
                  title={t('news.empty')}
                  actions={
                    <ButtonLink href="/articles" variant="secondary">
                      {t('home.allArticles')}
                    </ButtonLink>
                  }
                />
              )
            ) : (
              [...groups.entries()].map(([day, cards]) => (
                <section key={day} aria-label={dayLabel(day, today)}>
                  <h2 className="pub-day">{dayLabel(day, today)}</h2>
                  <div className="pub-rows">
                    {cards.map((card) => (
                      <article key={card.id} className="feed-row">
                        <div className="feed-row__media" aria-hidden="true">
                          <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 96px, 216px" />
                        </div>
                        <div className="feed-row__body">
                          <span className="pub-kicker">{[card.topics[0] ? topicLabel(card.topics[0]) : null, card.region ? regionLabel(card.region) : null].filter(Boolean).join(' · ')}</span>
                          <h3 className="feed-row__title">
                            <NextLink href={card.href}>{typo(card.title)}</NextLink>
                          </h3>
                          <p className="feed-row__dek">{typo(card.lede)}</p>
                          <span className="feed-row__meta feed-row__meta--inline">
                            {[card.source ? t(`news.sourceTypeShort.${card.source.type}`) : null, shortDate(card.publishedAt), card.isCorrected ? t('news.corrected') : null].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                        <div className="feed-row__side">
                          {card.source ? <span className="feed-row__chip">{t(`news.sourceTypeShort.${card.source.type}`)}</span> : null}
                          {eventLine(card) ? <span className="feed-row__sideline">{eventLine(card)}</span> : null}
                          <span className="feed-row__sideline">
                            {t('news.publishedTime')}: {shortDate(card.publishedAt)}
                          </span>
                          {card.readMinutes ? (
                            <span className="feed-row__sideline feed-row__meta">
                              <Clock size={14} strokeWidth={2} aria-hidden="true" />
                              {t('articles.readTime', { minutes: card.readMinutes })}
                            </span>
                          ) : null}
                          {card.isCorrected ? <span className="feed-row__flag">{t('news.corrected')}</span> : null}
                          {card.source ? (
                            <a href={card.source.url} className="feed-row__source" target="_blank" rel="noopener noreferrer">
                              {t('news.toSource')}
                              <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))
            )}
            {allRows.length > rows.length ? (
              <div className="pub-feed__more">
                <NextLink href={moreHref} className="pub-btn" scroll={false}>
                  {t('news.loadMore')}
                </NextLink>
              </div>
            ) : null}
          </div>

          <aside className="pub-aside" aria-label={t('news.briefTitle')}>
            <section aria-labelledby="brief-title">
              <h3 className="pub-aside__title" id="brief-title">
                {t('news.briefTitle')}
              </h3>
              <div className="pub-brief">
                {brief.map((card) => (
                  <div key={card.id} className="pub-brief__item">
                    <span className="pub-brief__date">{shortDate(card.publishedAt)}</span>
                    <span className="pub-brief__title">
                      <NextLink href={card.href}>{typo(card.title)}</NextLink>
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <section className="pub-note" id="sources" aria-labelledby="sources-title">
              <h3 className="pub-note__title" id="sources-title">
                {t('news.sourcesTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('news.sourcesBody'))}</p>
              <NextLink href="/articles" className="pub-more">
                {t('news.readAnalyses')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>
      </div>

      <section className="pub-cta" aria-labelledby="news-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="news-cta-title">
              {typo(t('news.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('news.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-btn pub-btn--light">
              {t('news.suggest')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('news.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
