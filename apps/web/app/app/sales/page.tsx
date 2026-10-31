import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { LeadListRow } from '@/components/workspace/WorkRows';
import { data } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('sales.title') };
}

const STATUSES = ['new', 'drafting', 'sent', 'negotiating', 'won', 'lost', 'expired'] as const;

/** Sales list for company members with the deals grant; a person without a company sees the explanation, not a disabled page. */
export default async function SalesPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/sales');
  const sp = await searchParams;
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : 'all';
  const all = await data.listLeads(principal);
  const rows = status === 'all' ? all : all.filter((r) => r.status === status);
  const canSell = principal.company !== null && principal.company.permissions.includes('company.deals.manage');
  const canCatalogue = principal.company?.permissions.includes('company.catalogue.edit') ?? false;
  const link = (s: string) => hrefFor(principal, s === 'all' ? '/app/sales' : `/app/sales?status=${s}`);
  const nearest = all.map((r) => r.deadline).sort()[0] ?? null;
  return (
    <>
      <PageHeader
        title={t('sales.title')}
        lede={t('sales.lede')}
        actions={
          canSell ? (
            <ButtonLink href={hrefFor(principal, '/app/company#catalogue')} variant="secondary">
              {t('sales.catalogue')}
            </ButtonLink>
          ) : undefined
        }
      />
      {!canSell ? (
        <div className="ws-empty" style={{ maxWidth: '40rem' }}>
          <strong>{t('sales.noCompanyTitle')}</strong>
          <span>{t('sales.noCompanyBody')}</span>
          <NextLink href={hrefFor(principal, '/app/company')} className="ws-more">
            {t('company.title')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      ) : all.length === 0 ? (
        <div className="ws-empty" style={{ maxWidth: '40rem' }}>
          <strong>{t('sales.empty')}</strong>
          <span>{t('sales.emptyHint')}</span>
          {canCatalogue ? (
            <NextLink href={hrefFor(principal, '/app/company#catalogue')} className="ws-more">
              {t('sales.fillCatalogue')}
            </NextLink>
          ) : null}
        </div>
      ) : (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section" style={{ gap: 18 }}>
            <nav className="ws-filter" aria-label={t('sales.col.status')}>
              <NextLink href={link('all')} className={`ws-chip${status === 'all' ? ' ws-chip--on' : ''}`} aria-current={status === 'all' ? 'true' : undefined}>
                {t('projectsWs.filter.all')} · {all.length}
              </NextLink>
              {STATUSES.filter((s) => all.some((r) => r.status === s)).map((s) => (
                <NextLink key={s} href={link(s)} className={`ws-chip${status === s ? ' ws-chip--on' : ''}`} aria-current={status === s ? 'true' : undefined}>
                  {t(`leadStatus.${s}`)} · {all.filter((r) => r.status === s).length}
                </NextLink>
              ))}
            </nav>
            <ul className="ws-list" aria-label={t('sales.list')}>
              {rows.map((row) => (
                <LeadListRow key={row.id} row={row} />
              ))}
            </ul>
            <p className="ws-note">{t('sales.flowsNote')}</p>
          </div>
          <div className="ws-section">
            <ul className="ws-stats ws-stats--2">
              <li className="ws-stat">
                <strong>{all.filter((r) => r.needsDecision).length}</strong>
                <span>{t('sales.stats.decisions')}</span>
              </li>
              <li className="ws-stat">
                <strong>{all.filter((r) => r.status === 'sent' || r.status === 'negotiating').length}</strong>
                <span>{t('sales.stats.active')}</span>
              </li>
              <li className="ws-stat">
                <strong>{all.filter((r) => r.status === 'won').length}</strong>
                <span>{t('sales.stats.won')}</span>
              </li>
              <li className="ws-stat">
                <strong>{nearest ? shortDate(nearest) : '—'}</strong>
                <span>{t('procurement.stats.nearest')}</span>
              </li>
            </ul>
            <div className="ws-card ws-card--navy">
              <h2 className="ws-h2">{t('sales.catalogue')}</h2>
              <p className="ws-muted">{t('sales.catalogueHint')}</p>
              <NextLink href={hrefFor(principal, '/app/company#catalogue')} className="ws-more">
                {canCatalogue ? t('sales.fillCatalogue') : t('company.tabs.catalogue')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="ws-card">
              <h2 className="ws-h2">{t('sales.openNeeds')}</h2>
              <p className="ws-muted">{t('sales.openNeedsHint')}</p>
              <NextLink href="/projects?needs=open" className="ws-more">
                {t('publicNav.2')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
