import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, BookOpen, ChevronRight, ClipboardCheck, FileSearch, FileText, MessageCircleQuestion } from 'lucide-react';
import { ButtonLink, EmptyState, MagazineCover, MediaFrame } from '@/components/ui';
import { FeedRow } from '@/components/public/FeedRow';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { SearchForm, formatLabel, topicLabel } from '@/components/public/parts';
import { data, type TopicKey } from '@/app/_lib/data';
import type { PublicationCard } from '@/app/_lib/data/types';
import { issueCover, storyCover } from '@/app/_lib/media';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('articles.title'), description: t('articles.lede') };
}

const FORMATS = ['analysis', 'practice', 'experience', 'opinion', 'interview', 'projectStory', 'overview'] as const;
const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
const USEFUL_ICONS = [FileSearch, BookOpen, MessageCircleQuestion, ClipboardCheck, FileText];
const PAGE_SIZE = 8;

function href(format: string, topic: string | undefined): string {
  const params = new URLSearchParams();
  if (format !== 'all') params.set('format', format);
  if (topic) params.set('topic', topic);
  const query = params.toString();
  return query ? `/articles?${query}` : '/articles';
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${word}`;
}

/**
 * Articles section: lead article in a tinted panel, search, two filter rows (format, topic), the feed of rows with
 * a meta column (format, author, date, read time), a sticky aside («Полезно под рукой», «Пишут для нас», the
 * magazine banner) and the call to action. Filters are query parameters, so the page stays server-rendered.
 */
export default async function ArticlesPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const format = typeof params.format === 'string' && (FORMATS as readonly string[]).includes(params.format) ? params.format : 'all';
  const topic = typeof params.topic === 'string' && (TOPICS as string[]).includes(params.topic) ? (params.topic as TopicKey) : undefined;
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const scoped = data.listArticles(format).filter((card) => !topic || card.topics.includes(topic));
  const items = query ? scoped.filter((n) => `${n.title} ${n.lede} ${n.authorLabel}`.toLowerCase().includes(query)) : scoped;
  const filtered = format !== 'all' || Boolean(topic) || Boolean(query);
  const page = Math.max(1, Number.parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1);
  const lead = !filtered ? items[0] : undefined;
  const allRows = lead ? items.slice(1) : items;
  const rows = allRows.slice(0, PAGE_SIZE * page);
  const moreHref = (() => {
    const next = new URLSearchParams();
    if (format !== 'all') next.set('format', format);
    if (topic) next.set('topic', topic);
    if (query) next.set('q', query);
    next.set('page', String(page + 1));
    return `/articles?${next.toString()}#feed`;
  })();
  const useful = data.getHome().useful.slice(0, 5);
  const people = data.listPeople();
  const counts = new Map<string, { label: string; href: string | null; role: string; portrait: string | null; count: number }>();
  for (const card of [...data.listArticles(), ...data.listNews()]) {
    if (card.authorKind === 'editorial') continue;
    const key = card.authorHref ?? card.authorLabel;
    const person = card.authorKind === 'person' ? people.find((p) => p.href === card.authorHref) : undefined;
    const entry = counts.get(key) ?? { label: card.authorLabel, href: card.authorHref, role: person?.roleLine ?? t('articles.authorKind.company'), portrait: person?.portrait ?? null, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const authors = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru')).slice(0, 10);
  const issue = data.getHome().currentIssue;
  const metaLines = (card: PublicationCard) => [card.authorLabel, longDate(card.publishedAt)];

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('articles.title'))}
            </h1>
            <p className="pub-lede">{typo(t('articles.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/login?next=%2Fapp%2Fpublications" variant="secondary">
              {t('articles.suggest')}
            </ButtonLink>
          </div>
        </header>

        {lead ? (
          <section className="news-lead" aria-labelledby="articles-lead-title">
            <div className="news-lead__media">
              <MediaFrame media={storyCover(lead)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 1023px) 100vw, 55vw" />
            </div>
            <div className="news-lead__panel">
              <span className="pub-kicker">{t('articles.leadKicker')}</span>
              <h2 className="news-lead__title" id="articles-lead-title">
                <NextLink href={lead.href}>{typo(lead.title)}</NextLink>
              </h2>
              <p className="news-lead__dek">{typo(lead.lede)}</p>
              <p className="news-lead__meta">{[formatLabel(lead), lead.authorLabel, lead.readMinutes ? t('articles.readTime', { minutes: lead.readMinutes }) : null].filter(Boolean).join(' · ')}</p>
              <NextLink href={lead.href} className="pub-more">
                {t('articles.readArticle')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </section>
        ) : null}

        <div className="pub-feed" id="feed">
          <div aria-label={t('articles.feedLabel')}>
            <div className="pub-search">
              <SearchForm placeholder={t('news.searchPlaceholder')} action="/articles" label={t('news.find')} />
            </div>
            <div className="pub-filter-row">
              <span className="pub-filter-row__label">{t('articles.formatsLabel')}</span>
              <nav className="pub-chips" aria-label={t('articles.formatsLabel')}>
                <NextLink href={href('all', topic)} className="pub-chip" aria-current={format === 'all' ? 'true' : undefined}>
                  {t('articles.allFormats')}
                </NextLink>
                {FORMATS.map((key) => (
                  <NextLink key={key} href={href(key, topic)} className="pub-chip" aria-current={format === key ? 'true' : undefined}>
                    {t(`articles.formats.${key}`)}
                  </NextLink>
                ))}
              </nav>
            </div>
            <div className="pub-filter-row">
              <span className="pub-filter-row__label">{t('articles.topicsLabel')}</span>
              <nav className="pub-chips" aria-label={t('articles.topicsLabel')}>
                <NextLink href={href(format, undefined)} className="pub-chip" aria-current={topic ? undefined : 'true'}>
                  {t('articles.allTopics')}
                </NextLink>
                {TOPICS.map((key) => (
                  <NextLink key={key} href={href(format, key)} className="pub-chip" aria-current={topic === key ? 'true' : undefined}>
                    {topicLabel(key)}
                  </NextLink>
                ))}
              </nav>
            </div>

            {rows.length === 0 ? (
              <div style={{ marginTop: 'var(--space-6)' }}>
                <EmptyState
                  title={format !== 'all' && !topic && !query ? t('articles.empty') : t('articles.emptyFiltered')}
                  actions={
                    <ButtonLink href="/articles" variant="secondary">
                      {t('articles.resetFilters')}
                    </ButtonLink>
                  }
                />
              </div>
            ) : (
              <div className="pub-rows" style={{ marginTop: 'var(--space-5)' }}>
                {rows.map((card) => (
                  <FeedRow
                    key={card.id}
                    card={card}
                    kicker={card.topics[0] ? topicLabel(card.topics[0]) : formatLabel(card)}
                    chip={formatLabel(card)}
                    lines={metaLines(card)}
                    inlineMeta={[formatLabel(card), card.authorLabel, shortDate(card.publishedAt), card.readMinutes ? t('articles.readTime', { minutes: card.readMinutes }) : null].filter(Boolean).join(' · ')}
                  />
                ))}
              </div>
            )}
            {allRows.length > rows.length ? (
              <div className="pub-feed__more">
                <NextLink href={moreHref} className="pub-btn" scroll={false}>
                  {t('home.moreMaterials')}
                </NextLink>
              </div>
            ) : null}
          </div>

          <aside className="pub-aside" aria-label={t('home.useful')}>
            {useful.length ? (
              <section aria-labelledby="useful-title">
                <h3 className="pub-aside__title" id="useful-title">
                  {t('home.useful')}
                </h3>
                <div className="pub-useful">
                  {useful.map((card, i) => {
                    const Icon = USEFUL_ICONS[i % USEFUL_ICONS.length]!;
                    return (
                      <NextLink key={card.id} href={card.href} className="pub-useful__item">
                        <span className="pub-useful__icon" aria-hidden="true">
                          <Icon size={20} strokeWidth={1.75} />
                        </span>
                        <span className="pub-useful__text">
                          <span className="pub-useful__name">{typo(card.shortTitle ?? card.title)}</span>
                          <span className="pub-useful__sub">{typo(card.lede)}</span>
                        </span>
                        <ChevronRight size={18} strokeWidth={2} className="pub-useful__chevron" aria-hidden="true" />
                      </NextLink>
                    );
                  })}
                </div>
              </section>
            ) : null}
            {authors.length ? (
              <section aria-labelledby="authors-title">
                <div className="pub-h2-row" style={{ marginBottom: 'var(--space-2)' }}>
                  <h3 className="pub-aside__title" id="authors-title" style={{ marginBottom: 0 }}>
                    {t('articles.topAuthors')}
                  </h3>
                  <NextLink href="/people" className="pub-more">
                    {t('articles.authorsAll')}
                  </NextLink>
                </div>
                <ol className="pub-authors">
                  {authors.map((author, i) => {
                    const inner = (
                      <>
                        <span className="pub-authors__rank" aria-hidden="true">
                          {i + 1}
                        </span>
                        <PersonAvatar name={author.label} portrait={author.portrait} size={36} className="pub-authors__avatar" />
                        <span className="pub-authors__text">
                          <span className="pub-authors__name">{author.label}</span>
                          <span className="pub-authors__role">{author.role}</span>
                        </span>
                        <span className="pub-authors__count">{plural(author.count, t('articles.materialsOne'), t('articles.materialsFew'), t('articles.materialsMany'))}</span>
                      </>
                    );
                    return (
                      <li key={author.label}>
                        {author.href ? (
                          <NextLink href={author.href} className="pub-authors__item">
                            {inner}
                          </NextLink>
                        ) : (
                          <span className="pub-authors__item">{inner}</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
            {issue ? (
              <NextLink href={issue.readerHref} className="pub-banner pub-banner--tint">
                <span className="pub-banner__cover" aria-hidden="true">
                  <MagazineCover variant="brand" issue={issue.number} dateRange={`${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`} title={issue.title} media={issueCover(issue.number)} size="sm" tilt={false} />
                </span>
                <span className="pub-banner__text">
                  <span className="pub-kicker">{t('detail.magazineKicker')}</span>
                  <span className="pub-banner__title">{t('detail.magazineTitle', { number: issue.number })}</span>
                  <span className="pub-banner__body">{typo(issue.title)}</span>
                  <span className="pub-banner__action">
                    {t('detail.magazineAction')}
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </span>
                </span>
              </NextLink>
            ) : null}
          </aside>
        </div>
      </div>

      <section className="pub-cta" aria-labelledby="articles-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="articles-cta-title">
              {typo(t('articles.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('articles.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-btn pub-btn--light">
              {t('articles.suggest')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('news.ctaSignIn')}
              <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
