import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, Bell, BookOpenCheck, GitCommitVertical, GraduationCap, PenSquare, Rss, ShieldCheck } from 'lucide-react';
import { ButtonLink, EmptyState } from '@/components/ui';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { IssueCard } from '@/components/public/magazine/IssueCard';
import { IssueContents } from '@/components/public/magazine/IssueContents';
import { IssueHero } from '@/components/public/magazine/IssueHero';
import { IssueLeaf } from '@/components/public/magazine/IssueLeaf';
import { IssueProgress } from '@/components/public/magazine/IssueProgress';
import { IssuePoll } from '@/components/public/magazine/IssuePoll';
import { Glossary } from '@/components/public/magazine/Glossary';
import { buildLeafPages } from '@/components/public/magazine/leaf-pages';
import { RUBRIC_ICONS, rubricDescription, rubricLabel } from '@/components/public/magazine/rubric';
import { data } from '@/app/_lib/data';
import { issueCover } from '@/app/_lib/media';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  const { current } = await data.getMagazine();
  return {
    title: t('magazine.pageTitle'),
    description: t('magazine.lede'),
    openGraph: {
      title: t('magazine.pageTitle'),
      description: current ? `${t('magazine.issueTitle', { number: current.number })} — ${current.title}` : t('magazine.lede'),
      images: current ? [{ url: issueCover(current.number).src, alt: t('magazine.coverAlt') }] : [],
    },
  };
}

/**
 * Magazine landing: the current issue (cover, facts, actions, short contents), a page-turning preview of the
 * printed layout, the rubric system, the full contents, the people who write for the magazine, the last issues
 * from the archive, how the magazine works, and the «Предложить материал» band.
 */
export default async function MagazinePage() {
  await primeLocale();
  const { current, archive } = await data.getMagazine();
  const rubrics = (await data.listRubrics()).filter((r) => r.count > 0);
  const authors = (await data.listMagazineAuthors()).slice(0, 8);
  const previous = archive.filter((i) => !current || i.number !== current.number).slice(0, 3);
  const courses = (await data.listCourses()).slice(0, 4);
  return (
    <div className="pub pub-page mg">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('magazine.pageTitle'))}
            </h1>
            <p className="pub-lede">{typo(t('magazine.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/magazine/archive" variant="secondary">
              {t('magazine.archiveAction')}
            </ButtonLink>
          </div>
        </header>

        {current ? (
          <>
            <IssueHero issue={current} isCurrent headingLevel={2} contentsHref="#contents" />
            <IssueProgress issue={current.number} total={current.itemsCount} readerHref={current.readerHref} positions={current.items.map((i) => i.position)} />
          </>
        ) : (
          <EmptyState
            title={t('magazine.firstIssuePending')}
            actions={
              <ButtonLink href="/articles" variant="secondary">
                {t('home.allArticles')}
              </ButtonLink>
            }
          />
        )}
      </div>

      {current ? (
        <section className="mg-leaf-band" aria-labelledby="leaf-title">
          <div className="pub-wrap">
            <div className="pub-h2-row">
              <div>
                <h2 className="pub-h2" id="leaf-title">
                  {typo(t('magazine.leafTitle'))}
                </h2>
                <p className="pub-section__lede">{typo(t('magazine.leafLede'))}</p>
              </div>
              <NextLink href={current.readerHref} className="pub-more">
                {t('magazine.readOnline')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <IssueLeaf pages={buildLeafPages(current)} number={current.number} readerHref={current.readerHref} />
          </div>
        </section>
      ) : null}

      <div className="pub-wrap">
        <section className="pub-section" aria-labelledby="rubrics-title">
          <div className="pub-h2-row">
            <div>
              <h2 className="pub-h2" id="rubrics-title">
                {typo(t('magazine.rubricsTitle'))}
              </h2>
              <p className="pub-section__lede">{typo(t('magazine.rubricsLede'))}</p>
            </div>
          </div>
          <ul className="mg-rubrics">
            {rubrics.map((r) => {
              const Icon = RUBRIC_ICONS[r.key];
              return (
                <li key={r.key}>
                  <NextLink href={`/magazine/rubric/${r.key}`} className="mg-rubric-card">
                    <span className="mg-rubric-card__icon" aria-hidden="true">
                      <Icon size={20} strokeWidth={1.75} />
                    </span>
                    <span className="mg-rubric-card__name">{rubricLabel(r.key)}</span>
                    <span className="mg-rubric-card__desc">{typo(rubricDescription(r.key))}</span>
                    <span className="mg-rubric-card__meta">
                      {t('magazine.rubricCount', { count: r.count })}
                      {r.latestIssue ? ` · ${t('magazine.rubricLatest', { number: r.latestIssue })}` : ''}
                    </span>
                  </NextLink>
                </li>
              );
            })}
          </ul>
        </section>

        {current ? <IssueContents issue={current} id="contents" /> : null}

        {current && (current.poll || current.glossary.length) ? (
          <section className="pub-section" aria-labelledby="engage-title">
            <div className="pub-h2-row">
              <div>
                <h2 className="pub-h2" id="engage-title">
                  {typo(t('magazine.glossaryTitle'))}
                </h2>
                <p className="pub-section__lede">{typo(t('magazine.glossaryLede'))}</p>
              </div>
            </div>
            <div className="mg-engage">
              <div className="mg-gloss-wrap">{current.glossary.length ? <Glossary entries={current.glossary} /> : null}</div>
              {current.poll ? <IssuePoll issue={current.number} poll={current.poll} total={current.itemsCount} /> : null}
            </div>
          </section>
        ) : null}

        {courses.length ? (
          <section className="pub-section" aria-labelledby="academy-title">
            <div className="pub-h2-row">
              <div>
                <h2 className="pub-h2" id="academy-title">
                  {typo(t('magazine.academyTitle'))}
                </h2>
                <p className="pub-section__lede">{typo(t('magazine.academyLede'))}</p>
              </div>
            </div>
            <ul className="mg-academy">
              {courses.map((c) => (
                <li key={c.id}>
                  <NextLink href="/login?next=%2Fapp" className="mg-academy__card">
                    <GraduationCap size={20} strokeWidth={1.75} aria-hidden="true" />
                    <span className="mg-academy__title">{typo(c.title)}</span>
                    <span className="mg-academy__summary">{typo(c.summary)}</span>
                    <span className="mg-academy__meta">
                      {t('magazine.academyModules', { count: c.modules })} · {t('magazine.academyMinutes', { count: c.durationMinutes })}
                    </span>
                    <span className="mg-academy__cta">
                      {t('magazine.academyOpen')}
                      <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                    </span>
                  </NextLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {authors.length ? (
          <section className="pub-section" aria-labelledby="authors-title">
            <div className="pub-h2-row">
              <div>
                <h2 className="pub-h2" id="authors-title">
                  {typo(t('magazine.authorsTitle'))}
                </h2>
                <p className="pub-section__lede">{typo(t('magazine.authorsLede'))}</p>
              </div>
              <NextLink href="/people" className="pub-more">
                {t('publicNav.5')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <ul className="mg-authors">
              {authors.map((a) => {
                const inner = (
                  <>
                    {a.person ? (
                      <PersonAvatar name={a.person.displayName} portrait={a.person.portrait} size={48} />
                    ) : (
                      <span className="mg-authors__mark" aria-hidden="true">
                        {a.kind === 'editorial' ? <PenSquare size={20} strokeWidth={1.75} /> : a.label.slice(0, 1)}
                      </span>
                    )}
                    <span className="mg-authors__text">
                      <span className="mg-authors__name">{a.label}</span>
                      <span className="mg-authors__role">{a.person ? a.person.roleLine : a.kind === 'editorial' ? t('magazine.editorialLabel') : t('companies.kindOne.contractor')}</span>
                      <span className="mg-authors__count">{t('magazine.authorsCount', { count: a.count })}</span>
                    </span>
                  </>
                );
                return (
                  <li key={`${a.kind}:${a.label}`}>
                    {a.href ? (
                      <NextLink href={a.href} className="mg-authors__card">
                        {inner}
                      </NextLink>
                    ) : (
                      <span className="mg-authors__card">{inner}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {previous.length ? (
          <section className="pub-section" aria-labelledby="archive-title">
            <div className="pub-h2-row">
              <div>
                <h2 className="pub-h2" id="archive-title">
                  {typo(t('magazine.archiveTitle'))}
                </h2>
                <p className="pub-section__lede">{typo(t('magazine.archiveLede'))}</p>
              </div>
              <span className="pub-actions">
                <a href={withBase('/magazine/feed.xml')} className="mg-feed-link">
                  <Rss size={14} strokeWidth={2} aria-hidden="true" />
                  {t('magazine.rss')}
                </a>
                <NextLink href="/magazine/archive" className="pub-more">
                  {t('magazine.archiveAll')}
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </span>
            </div>
            <div className="mg-grid">
              {previous.map((issue) => (
                <IssueCard key={issue.id} issue={issue} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="pub-section mg-about" id="about" aria-labelledby="about-title">
          <div className="pub-h2-row">
            <h2 className="pub-h2" id="about-title">
              {typo(t('magazine.aboutTitle'))}
            </h2>
          </div>
          <ul className="mg-about__list">
            <li>
              <ShieldCheck size={22} strokeWidth={1.75} aria-hidden="true" />
              <strong>{t('magazine.aboutSources')}</strong>
              <span>{typo(t('magazine.aboutSourcesBody'))}</span>
            </li>
            <li>
              <GitCommitVertical size={22} strokeWidth={1.75} aria-hidden="true" />
              <strong>{t('magazine.aboutVersions')}</strong>
              <span>{typo(t('magazine.aboutVersionsBody'))}</span>
            </li>
            <li>
              <BookOpenCheck size={22} strokeWidth={1.75} aria-hidden="true" />
              <strong>{t('magazine.aboutFormats')}</strong>
              <span>{typo(t('magazine.aboutFormatsBody'))}</span>
            </li>
          </ul>
        </section>
      </div>

      <section className="pub-cta" aria-labelledby="suggest-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="suggest-title">
              {typo(t('magazine.suggestTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('magazine.notifyHint'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-btn pub-btn--light">
              {t('magazine.suggestAction')}
            </NextLink>
            <NextLink href="/login?next=%2Fmagazine" className="pub-cta__link">
              <Bell size={16} strokeWidth={2} aria-hidden="true" />
              {t('magazine.notify')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
