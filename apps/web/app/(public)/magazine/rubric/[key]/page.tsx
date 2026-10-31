import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { Breadcrumb, MediaFrame } from '@/components/ui';
import { RUBRIC_ICONS, RubricChip, rubricDescription, rubricLabel } from '@/components/public/magazine/rubric';
import { data } from '@/app/_lib/data';
import type { RubricKey } from '@/app/_lib/data/types';
import { storyCover } from '@/app/_lib/media';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ key: string }> };

const KEYS: RubricKey[] = ['analysis', 'practice', 'report', 'interview', 'people', 'projectStory', 'materials', 'opinion', 'week', 'numbers', 'qa'];

function parseKey(raw: string): RubricKey | null {
  return KEYS.find((k) => k === raw) ?? null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primeLocale();
  const { key } = await params;
  const rubric = parseKey(key);
  return { title: rubric ? `${rubricLabel(rubric)} — ${t('publicNav.7')}` : t('error.notFoundTitle'), description: rubric ? rubricDescription(rubric) : undefined };
}

/** Rubric page: every item of the rubric across released issues, newest issue first, linking into the reader. */
export default async function RubricPage({ params }: Params) {
  await primeLocale();
  const { key } = await params;
  const rubric = parseKey(key);
  if (!rubric) notFound();
  const entries = data.listRubricEntries(rubric);
  const others = data.listRubrics().filter((r) => r.key !== rubric && r.count > 0);
  const Icon = RUBRIC_ICONS[rubric];
  return (
    <div className="pub pub-page mg">
      <div className="pub-wrap">
        <div className="pub-crumbs">
          <Breadcrumb
            items={[
              { id: 'home', label: t('publicNav.0'), href: '/' },
              { id: 'magazine', label: t('publicNav.7'), href: '/magazine' },
              { id: 'self', label: rubricLabel(rubric) },
            ]}
          />
        </div>
        <header className="pub-head mg-rubric-head">
          <div className="pub-head__text">
            <span className="pub-kicker">{t('magazine.rubricPageKicker')}</span>
            <h1 className="pub-h1 mg-rubric-head__title" id="page-title">
              <span className="mg-rubric-head__icon" aria-hidden="true">
                <Icon size={24} strokeWidth={1.75} />
              </span>
              {rubricLabel(rubric)}
            </h1>
            <p className="pub-lede">{typo(rubricDescription(rubric))}</p>
          </div>
        </header>

        {entries.length === 0 ? (
          <p className="cp-section__note">{t('magazine.rubricEmpty')}</p>
        ) : (
          <ol className="mg-rubric-list">
            {entries.map(({ item, issue }) => (
              <li key={`${issue.number}-${item.position}`} className="mg-piece">
                <NextLink href={`${issue.readerHref}#item-${item.position}`} className="mg-piece__media" aria-hidden="true" tabIndex={-1}>
                  <MediaFrame media={storyCover({ id: item.publicationId, slug: item.slug, format: 'article' })} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 320px" />
                </NextLink>
                <div className="mg-piece__body">
                  <p className="mg-piece__issue">
                    <NextLink href={issue.href}>{t('magazine.inIssue', { number: issue.number })}</NextLink>
                    <span>
                      {longDate(issue.dateFrom)} — {longDate(issue.dateTo)}
                    </span>
                  </p>
                  <h2 className="mg-piece__title">
                    <NextLink href={`${issue.readerHref}#item-${item.position}`}>{typo(item.title)}</NextLink>
                  </h2>
                  <p className="mg-piece__lede">{typo(item.lede)}</p>
                  <p className="mg-entry__meta">
                    {item.authorHref ? <NextLink href={item.authorHref}>{item.authorLabel}</NextLink> : <span>{item.authorLabel}</span>}
                    {item.readMinutes ? <span>{t('magazine.readMinutes', { count: item.readMinutes })}</span> : null}
                    {item.isCorrected ? <span className="mg-entry__corr">{t('common.corrected')}</span> : null}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        <section className="pub-section" aria-labelledby="other-rubrics">
          <div className="pub-h2-row">
            <h2 className="pub-h2" id="other-rubrics">
              {t('magazine.allRubrics')}
            </h2>
            <NextLink href="/magazine" className="pub-more">
              {t('publicNav.7')}
              <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
          <p className="mg-rubric-row">
            {others.map((r) => (
              <RubricChip key={r.key} rubric={r.key} link size="md" />
            ))}
          </p>
        </section>
      </div>
    </div>
  );
}
