import type { Metadata } from 'next';
import NextLink from 'next/link';
import { Search, X } from 'lucide-react';
import { Breadcrumb, EmptyState, ButtonLink } from '@/components/ui';
import { Dropdown } from '@/components/public/Dropdown';
import { FilterBar } from '@/components/public/FilterBar';
import { IssueCard } from '@/components/public/magazine/IssueCard';
import { data } from '@/app/_lib/data';
import { intlTag } from '@trustwork/ui/i18n';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('magazine.archiveTitle'), description: t('magazine.archiveLede') };
}

/** Standalone month name (1-12) in the active locale. */
const monthName = (m: number) => new Intl.DateTimeFormat(intlTag(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m - 1, 1)));

type Filters = { year?: number; month?: number; q?: string };

function href(f: Filters): string {
  const p = new URLSearchParams();
  if (f.year) p.set('year', String(f.year));
  if (f.month) p.set('month', String(f.month));
  if (f.q) p.set('q', f.q);
  const q = p.toString();
  return q ? `/magazine/archive?${q}` : '/magazine/archive';
}

/** Archive: every released issue as a cover card; year / month dropdowns and a search by title, lede or number. */
export default async function MagazineArchivePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const { current, archive } = data.getMagazine();
  const years = [...new Set(archive.map((i) => Number(i.releasedAt.slice(0, 4))))].sort((a, b) => b - a);
  const filters: Filters = {
    year: years.find((y) => String(y) === str('year')),
    month: (() => {
      const m = Number.parseInt(str('month') ?? '', 10);
      return m >= 1 && m <= 12 ? m : undefined;
    })(),
    q: str('q')?.trim().slice(0, 60) || undefined,
  };
  const apply = (f: Filters, except?: keyof Filters) =>
    archive.filter((i) => {
      if (except !== 'year' && f.year && Number(i.releasedAt.slice(0, 4)) !== f.year) return false;
      if (except !== 'month' && f.month && Number(i.releasedAt.slice(5, 7)) !== f.month) return false;
      if (except !== 'q' && f.q) {
        const q = f.q.toLowerCase();
        const hay = `${i.number} № ${i.number} ${i.title} ${i.lede}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  const items = apply(filters);
  const months = [...new Set(archive.map((i) => Number(i.releasedAt.slice(5, 7))))].sort((a, b) => a - b);
  const chips: Array<{ label: string; to: string }> = [];
  if (filters.year) chips.push({ label: String(filters.year), to: href({ ...filters, year: undefined }) });
  if (filters.month) chips.push({ label: monthName(filters.month), to: href({ ...filters, month: undefined }) });
  if (filters.q) chips.push({ label: `${t('events.searchPrefix')}: ${filters.q}`, to: href({ ...filters, q: undefined }) });
  return (
    <div className="pub pub-page mg">
      <div className="pub-wrap">
        <div className="pub-crumbs">
          <Breadcrumb
            items={[
              { id: 'home', label: t('publicNav.0'), href: '/' },
              { id: 'magazine', label: t('publicNav.7'), href: '/magazine' },
              { id: 'self', label: t('magazine.archiveTitle') },
            ]}
          />
        </div>
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('magazine.archiveTitle'))}
            </h1>
            <p className="pub-lede">{typo(t('magazine.archiveLede'))}</p>
          </div>
        </header>

        <div className="mg-archive__tools">
          <FilterBar label={t('events.filtersTitle')}>
            <Dropdown
              label={t('magazine.archiveYear')}
              value={filters.year ? String(filters.year) : undefined}
              groups={[
                {
                  items: [
                    { label: t('magazine.archiveAll'), to: href({ ...filters, year: undefined }), n: apply(filters, 'year').length, active: !filters.year },
                    ...years.map((y) => ({ label: String(y), to: href({ ...filters, year: y }), n: apply({ ...filters, year: y }).length, active: filters.year === y })),
                  ],
                },
              ]}
            />
            <Dropdown
              label={t('magazine.archiveMonth')}
              value={filters.month ? monthName(filters.month) : undefined}
              groups={[
                {
                  items: [
                    { label: t('magazine.archiveAll'), to: href({ ...filters, month: undefined }), n: apply(filters, 'month').length, active: !filters.month },
                    ...months.map((m) => ({ label: monthName(m), to: href({ ...filters, month: m }), n: apply({ ...filters, month: m }).length, active: filters.month === m })),
                  ],
                },
              ]}
            />
          </FilterBar>
          <form className="mg-archive__search" action={withBase('/magazine/archive')} method="get" role="search">
            <Search size={16} strokeWidth={2} aria-hidden="true" />
            <input type="search" name="q" defaultValue={filters.q ?? ''} placeholder={t('magazine.archiveSearch')} aria-label={t('magazine.archiveSearch')} />
            {filters.year ? <input type="hidden" name="year" value={filters.year} /> : null}
            {filters.month ? <input type="hidden" name="month" value={filters.month} /> : null}
          </form>
        </div>

        <div className="ev-results" role="status">
          <span className="ev-results__count">
            {t('magazine.archiveFound')}: <strong>{items.length}</strong> {t('magazine.issuesWord', { count: items.length })}
          </span>
          {chips.length ? (
            <span className="ev-active">
              {chips.map((c) => (
                <NextLink key={c.label} href={c.to} className="ev-active__chip" scroll={false}>
                  {c.label}
                  <X size={12} strokeWidth={2.5} aria-hidden="true" />
                </NextLink>
              ))}
              <NextLink href="/magazine/archive" className="ev-active__reset" scroll={false}>
                {t('events.resetAll')}
              </NextLink>
            </span>
          ) : null}
        </div>

        {items.length === 0 ? (
          <EmptyState
            title={t('magazine.noIssues')}
            actions={
              <ButtonLink href="/magazine/archive" variant="secondary">
                {t('news.resetFilters')}
              </ButtonLink>
            }
          />
        ) : (
          <div className="mg-grid mg-grid--archive">
            {items.map((issue) => (
              <IssueCard key={issue.id} issue={issue} isCurrent={current?.number === issue.number} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
