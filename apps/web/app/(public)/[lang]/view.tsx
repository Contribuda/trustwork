import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, ArrowUpRight, BookOpen, ChartColumn, ChevronRight, ClipboardCheck, Clock, FileSearch, FileText, FolderOpen, MessageCircleQuestion } from 'lucide-react';
import { MagazineCover, MediaFrame, VisuallyHidden } from '@/components/ui';
import { HomeHero, type HeroSlide } from '@/components/home/HomeHero';
import { homePublications } from '@/components/home/publication-feed';
import { formatLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { PublicationCard, TopicKey } from '@/app/_lib/data/types';
import { artwork, eventCover, issueCover, storyCover } from '@/app/_lib/media';
import { IssueProgress } from '@/components/public/magazine/IssueProgress';
import { RubricChip, rubricLabel } from '@/components/public/magazine/rubric';
import { eventBadge } from '@/components/public/EventRow';
import { dateRangeLabel, dayTile, placeLine, timeRangeLabel, typeLabel } from '@/app/_lib/events';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import type { ViewProps } from '@/app/_lib/public-view';
import './home.css';

export async function viewMetadata(lang: string): Promise<Metadata> {
  await primePublicLocale(lang);
  return { title: { absolute: t('brand.name') }, description: t('publicShell.tagline') };
}

const FEED_STEP = 4;
const FEED_TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
/** Lead photographs by story: panels need wide, calm frames that the pinned covers (thumbnails) do not. */
const LEAD_ARTWORKS: Record<string, string> = {
  'standart-ventfasady-vesna': 'glass-grid',
  'intervyu-tehnolog-o-protokolah': 'timber-frame',
  'material-pod-zadachu-kak-sdelat-vybor': 'blueprint-lines',
};
const TILE_PICKS = ['proizvodstvo-iznutri-ot-syrya-do-izdeliya', 'kak-skladyvaetsya-obshchij-rezultat'];
const EDITOR_PICKS = ['obzor-rynka-minvaty', 'zavod-tatarstan-minvata'];
const PEOPLE_FORMATS = ['experience', 'interview', 'projectStory'];
const USEFUL_ICONS = [FileSearch, BookOpen, MessageCircleQuestion, ClipboardCheck, FileText];

function readTime(card: PublicationCard): string | null {
  return card.readMinutes ? t('articles.readTime', { minutes: card.readMinutes }) : null;
}

function metaItems(card: PublicationCard): string[] {
  return [card.authorLabel, longDate(card.publishedAt), readTime(card)].filter((item): item is string => Boolean(item));
}

/** Topic for subject-led blocks, format for people-led stories and news (docs/design/system/editorial-cards.md §1). */
function kickerFor(card: PublicationCard): string {
  if (card.articleFormat && PEOPLE_FORMATS.includes(card.articleFormat)) return formatLabel(card);
  return card.topics[0] ? topicLabel(card.topics[0]) : formatLabel(card);
}

function isTopic(value: string | undefined): value is TopicKey {
  return FEED_TOPICS.includes(value as TopicKey);
}

/**
 * Public home. Blocks follow the approved layout: lead carousel with two side tiles,
 * the industry feed with topic chips and the sticky useful-links aside, the magazine band, people stories,
 * the meeting block and the navy call-to-action. Every block draws from one shared used set (lead → tiles →
 * picks → utility → stories → feed), so a story never appears twice on the page. The topic filter is a
 * query parameter, so the page stays a server component.
 */
export async function HomeView({ lang, query }: ViewProps) {
  await primePublicLocale(lang);
  const upcomingEvents = await data.listEvents('upcoming');
  const evLead = upcomingEvents.find((e) => e.featured && e.status === 'open') ?? upcomingEvents[0];
  const evNext = upcomingEvents.filter((e) => e.id !== evLead?.id).slice(0, 4);
  const params = query;
  const topicParam = Array.isArray(params.topic) ? params.topic[0] : params.topic;
  const topic = isTopic(topicParam) ? topicParam : null;

  const home = await data.getHome();
  const { articles, news, unavailable: publicationsUnavailable } = await homePublications(data);
  const all = [...articles, ...news];
  const used = new Set<string>();
  const claim = (cards: PublicationCard[]): PublicationCard[] => {
    const fresh = cards.filter((card) => !used.has(card.id));
    fresh.forEach((card) => used.add(card.id));
    return fresh;
  };
  const bySlugs = (slugs: readonly string[]): PublicationCard[] => slugs.map((slug) => all.find((card) => card.slug === slug)).filter((card): card is PublicationCard => Boolean(card));

  const lead = claim(home.featured).slice(0, 3);
  const slides: HeroSlide[] = lead.map((card, i) => ({
    id: card.id,
    href: card.href,
    kicker: i === 0 ? t('home.leadKicker') : formatLabel(card),
    title: card.title,
    dek: card.lede,
    meta: metaItems(card),
    media: LEAD_ARTWORKS[card.slug] ? artwork(LEAD_ARTWORKS[card.slug]!) : storyCover(card),
  }));
  const tiles = claim(bySlugs(TILE_PICKS));
  const picks = claim(bySlugs(EDITOR_PICKS));
  const useful = claim(home.useful).slice(0, 5);
  const people = claim(articles.filter((card) => card.authorKind === 'person' && PEOPLE_FORMATS.includes(card.articleFormat ?? ''))).slice(0, 3);
  const showParam = Array.isArray(params.show) ? params.show[0] : params.show;
  const show = Math.min(40, Math.max(FEED_STEP, Math.round((Number.parseInt(showParam ?? '', 10) || FEED_STEP) / FEED_STEP) * FEED_STEP));
  const feedAll = all.filter((card) => !used.has(card.id) && (!topic || card.topics.includes(topic))).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const feed = feedAll.slice(0, show);
  const feedMoreHref = feedAll.length > show ? `/?${new URLSearchParams({ ...(topic ? { topic } : {}), show: String(show + FEED_STEP) }).toString()}#feed` : null;
  const feedEvents = upcomingEvents.filter((e) => e.id !== evLead?.id && (!topic || topic === 'events' || e.topics.includes(topic))).slice(0, topic ? 2 : 1);
  const issue = home.currentIssue;

  return (
    <div className="pub">
      <VisuallyHidden as="h1">{t('home.title')}</VisuallyHidden>

      <div className="pub-wrap">
        {slides.length ? (
          <div className="pub-hero">
            <HomeHero slides={slides} />
            {tiles.length ? (
              <div className="hero-tiles">
                {tiles.map((card) => (
                  <NextLink key={card.id} href={card.href} className="hero-tile">
                    <div className="hero-tile__media" aria-hidden="true">
                      <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 72vw, (max-width: 1023px) 50vw, 33vw" />
                    </div>
                    <span className="hero-tile__body">
                      <span className="hero-tile__kicker">{kickerFor(card)}</span>
                      <span className="hero-tile__title">{typo(card.title)}</span>
                    </span>
                  </NextLink>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <section className="pub-section pub-feed" id="feed" aria-labelledby="feed-title">
          <div>
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="feed-title">
                {typo(t('home.feedTitle'))}
              </h2>
            </div>
            <div className="pub-chips">
              <NextLink href="/#feed" className="pub-chip" aria-current={topic ? undefined : 'true'} scroll={false}>
                {t('home.allTopics')}
              </NextLink>
              {FEED_TOPICS.map((key) => (
                <NextLink key={key} href={`/?topic=${key}#feed`} className="pub-chip" aria-current={topic === key ? 'true' : undefined} scroll={false}>
                  {topicLabel(key)}
                </NextLink>
              ))}
            </div>
            {publicationsUnavailable ? <p className="pub-feed__status" role="status">{t('home.publicationsUnavailable')}</p> : null}
            {feed.length || feedEvents.length ? (
              <div className="pub-rows">
                {feed.map((card) => (
                  <article key={card.id} className="feed-row">
                    <div className="feed-row__media" aria-hidden="true">
                      <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 96px, 184px" />
                    </div>
                    <div className="feed-row__body">
                      <span className="pub-kicker">
                        {card.href.startsWith('/news') ? t('home.kindNews') : t('home.kindArticle')}
                        {card.topics[0] ? ` · ${topicLabel(card.topics[0])}` : ''}
                      </span>
                      <h3 className="feed-row__title">
                        <NextLink href={card.href}>{typo(card.title)}</NextLink>
                      </h3>
                      <p className="feed-row__dek">{typo(card.lede)}</p>
                      <span className="feed-row__meta feed-row__meta--inline">
                        {formatLabel(card)} · {longDate(card.publishedAt)}
                        {readTime(card) ? ` · ${readTime(card)}` : ''}
                      </span>
                    </div>
                    <div className="feed-row__side">
                      <span className="feed-row__chip">{formatLabel(card)}</span>
                      <span className="feed-row__sideline">{card.authorLabel}</span>
                      <span className="feed-row__sideline">{longDate(card.publishedAt)}</span>
                      {readTime(card) ? (
                        <span className="feed-row__sideline feed-row__meta">
                          <Clock size={14} strokeWidth={2} aria-hidden="true" />
                          {readTime(card)}
                        </span>
                      ) : null}
                    </div>
                  </article>
                ))}
                {feedEvents.map((e) => {
                  const badge = eventBadge(e);
                  return (
                    <article key={e.id} className="feed-row feed-row--event">
                      <div className="feed-row__media" aria-hidden="true">
                        <MediaFrame media={eventCover(e.cover)} ratio="fill" radius="none" sizes="(max-width: 767px) 96px, 184px" />
                        <span className="feed-row__date-tile">
                          <span className="ev-tile__day">{dayTile(e.startsAt, e.timezone).day}</span>
                          <span className="ev-tile__month">{dayTile(e.startsAt, e.timezone).month}</span>
                        </span>
                      </div>
                      <div className="feed-row__body">
                        <span className="pub-kicker">
                          {t('home.kindEvent')} · {typeLabel(e.type)}
                        </span>
                        <h3 className="feed-row__title">
                          <NextLink href={e.href}>{typo(e.title)}</NextLink>
                        </h3>
                        <p className="feed-row__dek">{typo(e.lede)}</p>
                        <span className="feed-row__meta feed-row__meta--inline">
                          {dateRangeLabel(e.startsAt, e.endsAt, e.timezone)} · {placeLine(e)}
                        </span>
                      </div>
                      <div className="feed-row__side">
                        <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
                        <span className="feed-row__sideline">{dateRangeLabel(e.startsAt, e.endsAt, e.timezone)}</span>
                        <span className="feed-row__sideline">{timeRangeLabel(e.startsAt, e.endsAt, e.timezone)}</span>
                        <span className="feed-row__sideline">{placeLine(e)}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : publicationsUnavailable ? null : (
              <p className="pub-feed__status">{t('articles.empty')}</p>
            )}
            {feedMoreHref ? (
              <div className="pub-feed__more">
                <NextLink href={feedMoreHref} className="pub-btn" scroll={false}>
                  {t('home.moreMaterials')}
                </NextLink>
              </div>
            ) : (
              <div className="pub-feed__more">
                <NextLink href={topic ? `/articles?topic=${topic}` : '/articles'} className="pub-btn">
                  {t('home.allMaterials')}
                </NextLink>
              </div>
            )}
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
            {picks.length ? (
              <section aria-labelledby="picks-title">
                <h3 className="pub-aside__title" id="picks-title">
                  {t('home.editorsChoice')}
                </h3>
                <div className="pub-picks">
                  {picks.map((card) => (
                    <article key={card.id} className="pub-pick">
                      <div className="pub-pick__media" aria-hidden="true">
                        <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="96px" />
                      </div>
                      <div className="pub-pick__body">
                        <span className="pub-kicker">{kickerFor(card)}</span>
                        <h4 className="pub-pick__title">
                          <NextLink href={card.href}>{typo(card.title)}</NextLink>
                        </h4>
                        {readTime(card) ? (
                          <span className="feed-row__meta">
                            <Clock size={14} strokeWidth={2} aria-hidden="true" />
                            {readTime(card)}
                          </span>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
        </section>
      </div>

      {issue ? (
        <section className="pub-magazine" aria-labelledby="magazine-title">
          <div className="pub-wrap pub-magazine__inner">
            <MagazineCover
              variant="brand"
              issue={issue.number}
              dateRange={`${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`}
              title={typo(issue.title)}
              topics={issue.rubrics.slice(0, 3).map(rubricLabel)}
              media={issueCover(issue.number)}
              size="lg"
              href={issue.href}
            />
            <div className="pub-magazine__text">
              <span className="pub-kicker">{t('home.magazineKicker')}</span>
              <h2 className="pub-magazine__title" id="magazine-title">
                {typo(t('home.magazineTitle'))}
              </h2>
              <p className="pub-magazine__body">{typo(t('home.magazineBody'))}</p>
              <ul className="pub-magazine__rubrics" aria-label={t('magazine.homeRubrics')}>
                {issue.rubrics.map((r) => (
                  <li key={r}>
                    <RubricChip rubric={r} link size="md" />
                  </li>
                ))}
              </ul>
              <IssueProgress issue={issue.number} total={issue.itemsCount} readerHref={issue.readerHref} positions={issue.items.map((i) => i.position)} compact />
              <div className="pub-actions">
                <NextLink href={issue.readerHref} className="pub-btn pub-btn--dark">
                  {t('home.openMagazine')}
                </NextLink>
                <NextLink href="/magazine/archive" className="pub-more">
                  {t('home.allIssues')}
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="pub-wrap">
        {people.length ? (
          <section className="pub-section" aria-labelledby="people-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="people-title">
                {typo(t('home.peopleTitle'))}
              </h2>
              <NextLink href="/articles?format=experience" className="pub-more">
                {t('home.allStories')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="pub-people">
              {people.map((card) => (
                <article key={card.id} className="story-card">
                  <div className="story-card__media" aria-hidden="true">
                    <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 76vw, 33vw" />
                  </div>
                  <span className="pub-kicker">{kickerFor(card)}</span>
                  <h3 className="story-card__title">
                    <NextLink href={card.href}>{typo(card.title)}</NextLink>
                  </h3>
                  <p className="story-card__dek">{typo(card.lede)}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {evLead ? (
          <section className="pub-section" aria-labelledby="events-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="events-title">
                {typo(t('home.eventsTitle'))}
              </h2>
              <NextLink href="/events" className="pub-more">
                {t('home.eventsAll')}
                <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="home-ev">
              <article className="home-ev__lead">
                <NextLink href={evLead.href} className="home-ev__media" aria-hidden="true" tabIndex={-1}>
                  <MediaFrame media={eventCover(evLead.cover)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 55vw" />
                  <span className="ev-lead__tile">
                    <span className="ev-tile__day">{dayTile(evLead.startsAt, evLead.timezone).day}</span>
                    <span className="ev-tile__month">{dayTile(evLead.startsAt, evLead.timezone).month}</span>
                  </span>
                </NextLink>
                <div className="home-ev__text">
                  <span className="pub-kicker">
                    {typeLabel(evLead.type)} · {placeLine(evLead)}
                  </span>
                  <h3 className="home-ev__title">
                    <NextLink href={evLead.href}>{typo(evLead.title)}</NextLink>
                  </h3>
                  <p className="home-ev__lede">{typo(evLead.lede)}</p>
                  <ul className="ev-facts">
                    <li>{dateRangeLabel(evLead.startsAt, evLead.endsAt, evLead.timezone)}</li>
                    <li>{timeRangeLabel(evLead.startsAt, evLead.endsAt, evLead.timezone)}</li>
                    <li className={`ev-badge ev-badge--${eventBadge(evLead).tone}`}>{eventBadge(evLead).label}</li>
                  </ul>
                  <div className="pub-actions">
                    <NextLink href={`${evLead.href}#tickets`} className="pub-btn pub-btn--dark">
                      {evLead.status === 'open' ? t('events.register') : t('events.details')}
                    </NextLink>
                  </div>
                </div>
              </article>
              <ol className="home-ev__list" aria-label={t('home.eventsTitle')}>
                {evNext.map((e) => {
                  const tile = dayTile(e.startsAt, e.timezone);
                  const badge = eventBadge(e);
                  return (
                    <li key={e.id} className="home-ev__item">
                      <span className="ev-tile home-ev__tile" aria-hidden="true">
                        <span className="ev-tile__weekday">{tile.weekday}</span>
                        <span className="ev-tile__day">{tile.day}</span>
                        <span className="ev-tile__month">{tile.month}</span>
                      </span>
                      <span className="home-ev__item-body">
                        <span className="pub-kicker">
                          {typeLabel(e.type)} · {placeLine(e)}
                        </span>
                        <span className="home-ev__item-title">
                          <NextLink href={e.href}>{typo(e.title)}</NextLink>
                        </span>
                        <span className="home-ev__item-meta">
                          <span>{timeRangeLabel(e.startsAt, e.endsAt, e.timezone)}</span>
                          <span className={`ev-badge ev-badge--${badge.tone}`}>{badge.label}</span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        ) : null}
      </div>

      <section className="pub-cta" id="about" aria-labelledby="cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="cta-title">
              {typo(t('home.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('home.ctaBody'))}</p>
          </div>
          <div className="pub-cta__features">
            {(
              [
                [FileSearch, 'home.ctaFeature1Title', 'home.ctaFeature1Body'],
                [FolderOpen, 'home.ctaFeature2Title', 'home.ctaFeature2Body'],
                [ChartColumn, 'home.ctaFeature3Title', 'home.ctaFeature3Body'],
              ] as const
            ).map(([Icon, title, body]) => (
              <div key={title} className="pub-feature">
                <span className="pub-feature__icon" aria-hidden="true">
                  <Icon size={22} strokeWidth={1.75} />
                </span>
                <div>
                  <p className="pub-feature__title">{t(title)}</p>
                  <p className="pub-feature__body">{typo(t(body))}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/signup" className="pub-btn pub-btn--light">
              {t('home.ctaPrimary')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('home.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
