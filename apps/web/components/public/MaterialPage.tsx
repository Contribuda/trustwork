import type { ReactNode } from 'react';
import NextLink from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, Clock } from 'lucide-react';
import { MagazineCover, MediaFrame, Prose } from '@/components/ui';
import { ShareRow } from '@/components/public/ShareRow';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { renderBody } from '@/components/public/body';
import { formatLabel, regionLabel, topicLabel } from '@/components/public/parts';
import type { IssueView, PersonCard, PublicationCard, PublicationDetail } from '@/app/_lib/data/types';
import { issueCover, storyCover } from '@/app/_lib/media';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export type MaterialPageProps = {
  item: PublicationDetail;
  /** Section the material belongs to: drives the back link, kicker links, topic filters and «more» list. */
  section: { href: string; label: string; topicParam: (topic: string) => string };
  /** Latest materials of the section for the aside list (current item excluded by the caller). */
  more: PublicationCard[];
  moreTitle: string;
  issue: IssueView | null;
  /** Person author card (articles by people); null for editorial and company authors. */
  author?: PersonCard | null | undefined;
  cta: { title: string; body: string; action: string; actionHref: string };
  /** Extra aside block rendered after the source/author card (section-specific). */
  asideExtra?: ReactNode;
};

function credit(card: PublicationCard): string {
  const media = storyCover(card);
  return media.type === 'photo' ? t('detail.photoCredit', { author: media.author }) : t('detail.illustration');
}

/**
 * Material page of the editorial standard (news and articles). Head above the photograph (kicker line, title,
 * standfirst, byline), 16:9 cover with caption, reader column (correction banner, serif body, mentions, version
 * history, topic chips); on wide screens a left rail (author, date, read time, share, table of contents) and a
 * right aside (source or author card, more materials, magazine and workspace banners); related stories; call to action.
 */
export function MaterialPage({ item, section, more, moreTitle, issue, author, cta, asideExtra }: MaterialPageProps) {
  const cover = storyCover(item);
  const { nodes: bodyNodes, headings } = renderBody(item.body);
  const isNews = item.format === 'news';

  return (
    <div className="pub pub-page">
      <div className="pub-wrap pub-wrap--article">
        <NextLink href={section.href} className="pub-back">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          {section.label}
        </NextLink>
        <article className="art">
          <div className="art-layout">
            <aside className="art-rail" aria-label={t('detail.railLabel')}>
              <div className="art-rail__block art-rail__block--author">
                {author ? <PersonAvatar name={author.displayName} portrait={author.portrait} size={40} /> : null}
                <span className="art-rail__author">
                  <span className="art-rail__label">{t('publicPages.author')}</span>
                  <span className="art-rail__value">{item.authorHref ? <NextLink href={item.authorHref}>{item.authorLabel}</NextLink> : item.authorLabel}</span>
                  {author?.roleLine ? <span className="art-rail__note">{author.roleLine}</span> : null}
                </span>
              </div>
              <div className="art-rail__block">
                <span className="art-rail__label">{t('detail.publishedDate')}</span>
                <span className="art-rail__value">{longDate(item.publishedAt)}</span>
              </div>
              {item.readMinutes ? (
                <div className="art-rail__block">
                  <span className="art-rail__label">{t('detail.readTime')}</span>
                  <span className="art-rail__value">{t('articles.readTime', { minutes: item.readMinutes })}</span>
                </div>
              ) : null}
              {item.correction ? (
                <div className="art-rail__block">
                  <span className="feed-row__flag">{`${t('detail.updatedDate')} ${shortDate(item.correction.date)}`}</span>
                </div>
              ) : null}
              <div className="art-rail__block">
                <span className="art-rail__label">{t('detail.share')}</span>
                <ShareRow path={item.href} title={item.title} />
              </div>
              {headings.length > 1 ? (
                <nav className="art-rail__block" aria-label={t('detail.toc')}>
                  <span className="art-rail__label">{t('detail.toc')}</span>
                  <ol className="art-toc">
                    {headings.map((h) => (
                      <li key={h.id}>
                        <a href={`#${h.id}`}>{typo(h.text)}</a>
                      </li>
                    ))}
                  </ol>
                </nav>
              ) : null}
            </aside>

            <div className="art-main">
              <section className="art-cover" aria-labelledby="art-title">
                <header className="art-cover__content">
                  <p className="art-kickers">
                    <NextLink href={section.href} className="art-kickers__type">
                      {formatLabel(item)}
                    </NextLink>
                    {item.topics.map((topic) => (
                      <NextLink key={topic} href={section.topicParam(topic)}>
                        {topicLabel(topic)}
                      </NextLink>
                    ))}
                    {item.region ? <span>{regionLabel(item.region)}</span> : null}
                  </p>
                  <h1 className="art-title" id="art-title" tabIndex={-1}>
                    {typo(item.title)}
                  </h1>
                  <p className="art-lede">{typo(item.lede)}</p>
                  <p className="art-byline">
                    <span>{item.authorHref ? <NextLink href={item.authorHref}>{item.authorLabel}</NextLink> : item.authorLabel}</span>
                    <span>
                      <span className="art-byline__label">{t('detail.publishedDate')} </span>
                      {longDate(item.publishedAt)}
                    </span>
                    {isNews && item.eventTime ? <span className="art-byline__event">{`${t('news.eventLabel')}: ${longDate(item.eventTime)}`}</span> : null}
                    {item.readMinutes ? <span>{t('articles.readTime', { minutes: item.readMinutes })}</span> : null}
                    {item.correction ? <span className="feed-row__flag">{`${t('detail.updatedDate')} ${shortDate(item.correction.date)}`}</span> : null}
                  </p>
                </header>
                <div className="art-cover__media" aria-hidden="true">
                  <MediaFrame media={cover} ratio="fill" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 704px" />
                </div>
              </section>
              <p className="art-cover__credit">
                <span>{cover.alt}</span>
                <span>{credit(item)}</span>
              </p>

              {item.correction ? (
                <div className="art-correction" role="status">
                  <strong>{t('detail.correctionBanner', { date: longDate(item.correction.date) })}</strong> {typo(item.correction.note)} <a href="#history">{t('detail.history')}</a>
                </div>
              ) : null}
              <Prose family="serif" measure="reader">
                {bodyNodes}
              </Prose>
              {item.assistantAssisted ? <p className="art-note">{t('articles.assistantAssisted')}</p> : null}
              {item.mentions.length ? (
                <section className="art-block" aria-labelledby="mentions-title">
                  <h2 className="art-block__title" id="mentions-title">
                    {t('detail.mentions')}
                  </h2>
                  <div className="pub-chips">
                    {item.mentions.map((m) =>
                      m.href ? (
                        <NextLink key={m.label} href={m.href} className="pub-chip">
                          {m.label}
                        </NextLink>
                      ) : (
                        <span key={m.label} className="pub-chip">
                          {m.label}
                        </span>
                      ),
                    )}
                  </div>
                </section>
              ) : null}
              {item.history.length > 1 ? (
                <section className="art-block" id="history" aria-labelledby="history-title">
                  <h2 className="art-block__title" id="history-title">
                    {t('detail.history')}
                  </h2>
                  <ol className="art-history">
                    {item.history.map((h) => (
                      <li key={h.version}>
                        <span className="art-history__version">{t('detail.versionLine', { version: h.version })}</span>
                        {h.publishedAt ? <time dateTime={h.publishedAt}>{longDate(h.publishedAt)}</time> : null}
                        {h.note ? <span className="art-history__note">{typo(h.note)}</span> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              <section className="art-block" aria-labelledby="tags-title">
                <h2 className="art-block__title" id="tags-title">
                  {t('detail.tags')}
                </h2>
                <div className="pub-chips">
                  {item.topics.map((topic) => (
                    <NextLink key={topic} href={section.topicParam(topic)} className="pub-chip">
                      {topicLabel(topic)}
                    </NextLink>
                  ))}
                </div>
              </section>
            </div>

            <aside className="art-aside">
              {item.source ? (
                <section className="pub-note" aria-labelledby="source-title">
                  <h2 className="pub-note__title" id="source-title">
                    {t('detail.sourceCard')}
                  </h2>
                  <dl className="art-facts">
                    <div>
                      <dt>{t(`news.sourceType.${item.source.type}`)}</dt>
                      <dd>{item.source.name}</dd>
                    </div>
                    {item.eventTime ? (
                      <div>
                        <dt>{t('detail.eventDate')}</dt>
                        <dd>{longDate(item.eventTime)}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <a href={item.source.url} className="pub-btn" target="_blank" rel="noopener noreferrer">
                    {t('detail.sourceOpen')}
                    <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                  </a>
                  <NextLink href="/news#sources" className="pub-note__link">
                    {t('detail.sourcesLink')}
                  </NextLink>
                </section>
              ) : null}
              {author ? (
                <section className="pub-note" aria-labelledby="author-title">
                  <h2 className="pub-note__title" id="author-title">
                    {t('detail.aboutAuthor')}
                  </h2>
                  <div className="art-author">
                    <PersonAvatar name={author.displayName} portrait={author.portrait} size={48} className="art-author__avatar" />
                    <span className="art-author__text">
                      <span className="art-author__name">{author.displayName}</span>
                      <span className="art-author__role">{author.roleLine}</span>
                      {author.employer && !author.roleLine.includes(author.employer.name) ? <span className="art-author__role">{author.employer.name}</span> : null}
                    </span>
                  </div>
                  {author.headline ? <p className="pub-note__body">{typo(author.headline)}</p> : null}
                  <NextLink href={author.href} className="pub-btn">
                    {t('detail.authorProfile')}
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </NextLink>
                </section>
              ) : null}
              {asideExtra}
              <section className="pub-note art-share-card" aria-labelledby="share-title">
                <h2 className="pub-note__title" id="share-title">
                  {t('detail.share')}
                </h2>
                <ShareRow path={item.href} title={item.title} />
              </section>
              {more.length ? (
                <section aria-labelledby="more-title">
                  <div className="pub-h2-row" style={{ marginBottom: 'var(--space-2)' }}>
                    <h2 className="pub-aside__title" id="more-title" style={{ marginBottom: 0 }}>
                      {moreTitle}
                    </h2>
                    <NextLink href={section.href} className="pub-more">
                      {t('publicPages.all')}
                    </NextLink>
                  </div>
                  <div className="pub-brief">
                    {more.map((card) => (
                      <div key={card.id} className="pub-brief__item">
                        <span className="pub-brief__date">{shortDate(card.publishedAt)}</span>
                        <span className="pub-brief__title">
                          <NextLink href={card.href}>{typo(card.title)}</NextLink>
                        </span>
                      </div>
                    ))}
                  </div>
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
              <NextLink href="/#about" className="pub-banner pub-banner--navy">
                <span className="pub-banner__text">
                  <span className="pub-kicker pub-kicker--inverse">{t('detail.workspaceKicker')}</span>
                  <span className="pub-banner__title">{typo(t('detail.workspaceTitle'))}</span>
                  <span className="pub-banner__body">{typo(t('detail.workspaceBody'))}</span>
                  <span className="pub-banner__action">
                    {t('detail.workspaceAction')}
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </span>
                </span>
              </NextLink>
            </aside>
          </div>
        </article>

        {item.related.length ? (
          <section className="pub-section" aria-labelledby="related-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="related-title">
                {t('detail.related')}
              </h2>
              <NextLink href={section.href} className="pub-more">
                {t('publicPages.all')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="pub-grid-3">
              {item.related.map((card) => (
                <article key={card.id} className="story-card">
                  <div className="story-card__media" aria-hidden="true">
                    <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 76vw, 33vw" />
                  </div>
                  <span className="pub-kicker">{card.topics[0] ? topicLabel(card.topics[0]) : formatLabel(card)}</span>
                  <h3 className="story-card__title">
                    <NextLink href={card.href}>{typo(card.title)}</NextLink>
                  </h3>
                  <p className="story-card__dek">{typo(card.lede)}</p>
                  {card.readMinutes ? (
                    <span className="feed-row__meta">
                      <Clock size={14} strokeWidth={2} aria-hidden="true" />
                      {t('articles.readTime', { minutes: card.readMinutes })}
                    </span>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <section className="pub-cta" aria-labelledby="material-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="material-cta-title">
              {typo(cta.title)}
            </h2>
            <p className="pub-cta__body">{typo(cta.body)}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href={cta.actionHref} className="pub-btn pub-btn--light">
              {cta.action}
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
