import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { RFQ_STAGES, RfqListRow, rfqStage, type RfqStage } from '@/components/workspace/WorkRows';
import { data } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('procurement.title') };
}

const STAGES = Object.keys(RFQ_STAGES) as RfqStage[];

/** Procurement list in the principal's rights (company RFQs with the deals grant, personal RFQs); flows are WEB-002. */
export default async function ProcurementPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/procurement');
  const sp = await searchParams;
  const stage = typeof sp.stage === 'string' && (STAGES as string[]).includes(sp.stage) ? (sp.stage as RfqStage) : 'all';
  const all = await data.listRfqs(principal);
  const rows = stage === 'all' ? all : all.filter((r) => rfqStage(r.status) === stage);
  const counts = Object.fromEntries(STAGES.map((s) => [s, all.filter((r) => rfqStage(r.status) === s).length])) as Record<RfqStage, number>;
  const decisions = all.filter((r) => r.needsDecision).length;
  const quotes = all.reduce((a, r) => a + r.quotesCount, 0);
  const nearest = all.map((r) => r.deadline).sort()[0] ?? null;
  const link = (s: string) => hrefFor(principal, s === 'all' ? '/app/procurement' : `/app/procurement?stage=${s}`);
  return (
    <>
      <PageHeader
        title={t('procurement.title')}
        lede={t('procurement.lede')}
        actions={
          <>
            <Button variant="accent" isDisabled aria-describedby="procurement-create-note">
              {t('procurement.createNeed')}
            </Button>
            <ButtonLink href="/companies" variant="secondary">
              {t('procurement.findSupplier')}
            </ButtonLink>
          </>
        }
      />
      {all.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('procurement.empty')}</strong>
          <span>{t('procurement.emptyHint')}</span>
          <NextLink href="/companies" className="ws-more">
            {t('procurement.findSupplier')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      ) : (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section" style={{ gap: 18 }}>
            <nav className="ws-filter" aria-label={t('procurement.stages')}>
              <NextLink href={link('all')} className={`ws-chip${stage === 'all' ? ' ws-chip--on' : ''}`} aria-current={stage === 'all' ? 'true' : undefined}>
                {t('projectsWs.filter.all')} · {all.length}
              </NextLink>
              {STAGES.filter((s) => counts[s] > 0).map((s) => (
                <NextLink key={s} href={link(s)} className={`ws-chip${stage === s ? ' ws-chip--on' : ''}`} aria-current={stage === s ? 'true' : undefined}>
                  {t(`procurement.stage.${s}`)} · {counts[s]}
                </NextLink>
              ))}
            </nav>
            <ul className="ws-list" aria-label={t('procurement.list')}>
              {rows.map((row) => (
                <RfqListRow key={row.id} row={row} projectHref={row.projectId ? hrefFor(principal, `/app/projects/${row.projectId}`) : null} />
              ))}
            </ul>
            <p id="procurement-create-note" className="ws-note">
              {t('procurement.createDisabled')} {t('procurement.flowsNote')}
            </p>
          </div>
          <div className="ws-section">
            <ul className="ws-stats ws-stats--2">
              <li className="ws-stat">
                <strong>{decisions}</strong>
                <span>{t('procurement.stats.decisions')}</span>
              </li>
              <li className="ws-stat">
                <strong>{quotes}</strong>
                <span>{t('procurement.stats.quotes')}</span>
              </li>
              <li className="ws-stat">
                <strong>{counts.open + counts.compare}</strong>
                <span>{t('procurement.stats.open')}</span>
              </li>
              <li className="ws-stat">
                <strong>{nearest ? shortDate(nearest) : '—'}</strong>
                <span>{t('procurement.stats.nearest')}</span>
              </li>
            </ul>
            <div className="ws-card">
              <h2 className="ws-h2">{t('procurement.how.title')}</h2>
              <ol className="ws-steps">
                {(['need', 'quotes', 'compare', 'order', 'accept'] as const).map((k, i) => (
                  <li key={k}>
                    <span className="ws-steps__n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span>{t(`procurement.how.${k}`)}</span>
                  </li>
                ))}
              </ol>
              <p className="ws-note">{t('procurement.how.note')}</p>
            </div>
            <div className="ws-card ws-card--navy">
              <h2 className="ws-h2">{t('procurement.findSupplier')}</h2>
              <p className="ws-muted">{t('procurement.findHint')}</p>
              <NextLink href="/companies" className="ws-more">
                {t('publicNav.1')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </div>
        </div>
      )}
      {all.length === 0 ? (
        <p id="procurement-create-note" className="ws-note" style={{ marginTop: 24 }}>
          {t('procurement.createDisabled')} {t('procurement.flowsNote')}
        </p>
      ) : null}
    </>
  );
}
