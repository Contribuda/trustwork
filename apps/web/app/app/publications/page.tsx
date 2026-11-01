import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, PenLine } from 'lucide-react';
import { Button } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { PublicationListRow } from '@/components/workspace/WorkRows';
import { data, DATA_SOURCE } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('publications.title') };
}

const TABS = ['all', 'draft', 'in_review', 'scheduled', 'published', 'corrected', 'retracted'] as const;
const TAB_KEY: Record<(typeof TABS)[number], 'all' | 'drafts' | 'review' | 'scheduled' | 'published' | 'corrected' | 'retracted'> = {
  all: 'all',
  draft: 'drafts',
  in_review: 'review',
  scheduled: 'scheduled',
  published: 'published',
  corrected: 'corrected',
  retracted: 'retracted',
};

/** My publications across states; company authorship only with the publish grant (hint otherwise). */
export default async function PublicationsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const principal = await requirePrincipal(searchParams, '/app/publications');
  const state = typeof params.state === 'string' && (TABS as readonly string[]).includes(params.state) ? (params.state as (typeof TABS)[number]) : 'all';
  const all = await data.listMyPublications(principal);
  const rows = state === 'all' ? all : all.filter((r) => r.status === state);
  const canCompany = principal.company?.permissions.includes('company.publish') ?? false;
  const count = (s: string) => (s === 'all' ? all.length : all.filter((r) => r.status === s).length);
  const link = (key: string) => hrefFor(principal, key === 'all' ? '/app/publications' : `/app/publications?state=${key}`);
  return (
    <>
      <PageHeader
        title={t('publications.title')}
        lede={t('publications.lede')}
        actions={
          <Button variant="accent" isDisabled aria-describedby="publications-create-note">
            {t('publications.write')}
          </Button>
        }
      />
      <div className="ws-grid ws-grid--main">
        <div className="ws-section" style={{ gap: 18 }}>
          <nav className="ws-filter" aria-label={t('publications.col.state')}>
            {TABS.filter((key) => key === 'all' || count(key) > 0).map((key) => (
              <NextLink key={key} href={link(key)} className={`ws-chip${state === key ? ' ws-chip--on' : ''}`} aria-current={state === key ? 'true' : undefined}>
                {t(`publications.tabs.${TAB_KEY[key]}`)} · {count(key)}
              </NextLink>
            ))}
          </nav>
          {rows.length === 0 ? (
            <div className="ws-empty">
              <strong>{t('publications.empty')}</strong>
              <span>{t('publications.emptyHint')}</span>
            </div>
          ) : (
            <ul className="ws-list" aria-label={t('publications.list')}>
              {rows.map((row) => (
                <PublicationListRow key={row.id} row={row} editorHref={DATA_SOURCE === 'api' ? `/app/publications/${row.id}/edit` : undefined} />
              ))}
            </ul>
          )}
          <p id="publications-create-note" className="ws-note">
            {t('publications.createDisabled')}
          </p>
        </div>
        <div className="ws-section">
          <ul className="ws-stats ws-stats--2">
            <li className="ws-stat">
              <strong>{count('published') + count('corrected')}</strong>
              <span>{t('publications.stats.published')}</span>
            </li>
            <li className="ws-stat">
              <strong>{count('in_review') + count('scheduled')}</strong>
              <span>{t('publications.stats.pipeline')}</span>
            </li>
            <li className="ws-stat">
              <strong>{count('draft')}</strong>
              <span>{t('publications.stats.drafts')}</span>
            </li>
            {DATA_SOURCE === 'fixtures' ? <li className="ws-stat">
              <strong>{all.reduce((a, r) => a + r.shownIn.filter((s) => s.kind === 'issue').length, 0)}</strong>
              <span>{t('publications.stats.inIssues')}</span>
            </li> : null}
          </ul>
          <div className="ws-card">
            <h2 className="ws-h2">
              <PenLine size={18} strokeWidth={2} aria-hidden="true" />
              {t('publications.how.title')}
            </h2>
            <ol className="ws-steps">
              {(['draft', 'review', 'publish', 'correct'] as const).map((k, i) => (
                <li key={k}>
                  <span className="ws-steps__n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{t(`publications.how.${k}`)}</span>
                </li>
              ))}
            </ol>
            <p className="ws-note">{canCompany ? t('publications.companyOk') : t('publications.companyHint')}</p>
          </div>
          <div className="ws-card ws-card--navy">
            <h2 className="ws-h2">{t('publications.magazine.title')}</h2>
            <p className="ws-muted">{t('publications.magazine.hint')}</p>
            <NextLink href="/magazine#authors" className="ws-more">
              {t('publications.magazine.cta')}
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </div>
    </>
  );
}
