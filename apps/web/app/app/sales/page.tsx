import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import { partyLabels } from '@/components/commerce/labels';
import { InvitationStatus, QuoteStatus, StaleChip } from '@/components/commerce/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('sales.title') };
}

/**
 * Sales (WEB-002): requests addressed to the person or to their employer (members with the deals grant), from
 * `GET /v1/rfq-invitations` and the person's own quotes (`GET /v1/quotes`). Each row pins the exact request version the
 * invitation names; an amended request shows the stale flag. The buyer's budget, notes and other invited suppliers
 * never appear here.
 */
export default async function SalesPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/sales');
  const [invitations, quotes] = await Promise.all([commerce.listInvitations(principal), commerce.listQuotes(principal)]);
  const canSell = principal.company?.permissions.includes('company.deals.manage') ?? false;
  const canCatalogue = principal.company?.permissions.includes('company.catalogue.edit') ?? false;
  const byRfq = new Map<string, (typeof invitations)[number]>();
  for (const item of invitations) {
    const seen = byRfq.get(item.rfq.id);
    if (!seen || seen.invitation.rfqVersion.version < item.invitation.rfqVersion.version) byRfq.set(item.rfq.id, item);
  }
  const rows = [...byRfq.values()];
  const label = await partyLabels(principal, rows.map((r) => r.rfq.buyer));
  const link = (path: string) => hrefFor(principal, path);
  return (
    <>
      <PageHeader
        title={t('sales.title')}
        lede={t('sales.lede')}
        actions={
          canSell ? (
            <ButtonLink href={link('/app/company#catalogue')} variant="secondary">
              {t('sales.catalogue')}
            </ButtonLink>
          ) : undefined
        }
      />
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      {rows.length === 0 && !canSell && !principal.company ? (
        <div className="ws-empty" style={{ maxWidth: '40rem' }}>
          <strong>{t('sales.noCompanyTitle')}</strong>
          <span>{t('sales.noCompanyBody')}</span>
          <NextLink href={link('/app/company')} className="ws-more">
            {t('company.title')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      ) : rows.length === 0 ? (
        <div className="ws-empty" style={{ maxWidth: '40rem' }}>
          <strong>{t('sales.empty')}</strong>
          <span>{t('sales.emptyHint')}</span>
          {canCatalogue ? (
            <NextLink href={link('/app/company#catalogue')} className="ws-more">
              {t('sales.fillCatalogue')}
            </NextLink>
          ) : null}
        </div>
      ) : (
        <div className="cm-stack">
          <div className="ws-table-wrap">
            <table className="ws-table">
              <caption>{t('sales.list')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('sales.col.request')}</th>
                  <th scope="col">{t('sales.col.buyer')}</th>
                  <th scope="col">{t('commerce.col.pinned')}</th>
                  <th scope="col">{t('sales.col.deadline')}</th>
                  <th scope="col">{t('sales.col.status')}</th>
                  <th scope="col">{t('sales.col.version')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const quote = quotes.find((q) => q.rfqId === row.rfq.id) ?? null;
                  const target = quote ? `/app/sales/quotes/${encodeURIComponent(quote.id)}` : `/app/sales/rfq/${encodeURIComponent(row.rfq.id)}`;
                  return (
                    <tr key={row.rfq.id}>
                      <td data-label={t('sales.col.request')}>
                        <NextLink href={link(target)}>{row.title}</NextLink>
                      </td>
                      <td data-label={t('sales.col.buyer')}>{label(row.rfq.buyer)}</td>
                      <td data-label={t('commerce.col.pinned')}>
                        {t('commerce.versionN', { version: row.invitation.rfqVersion.version })} {row.invitation.staleReason ? <StaleChip version={row.invitation.rfqVersion.version} /> : null}
                      </td>
                      <td data-label={t('sales.col.deadline')}>{shortDate(row.responseDeadline)}</td>
                      <td data-label={t('sales.col.status')}>
                        <InvitationStatus status={row.invitation.status} />
                      </td>
                      <td data-label={t('sales.col.version')}>
                        {quote ? (
                          <span className="cm-actions">
                            <QuoteStatus status={quote.status} />
                            {quote.currentVersion ? t('commerce.versionN', { version: quote.currentVersion }) : null}
                            {quote.draftVersion ? <span className="cm-spec">{t('commerce.list.draftVersion', { version: quote.draftVersion })}</span> : null}
                          </span>
                        ) : (
                          t('commerce.sales.noQuote')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="ws-note">{t('commerce.sales.privacyNote')}</p>
        </div>
      )}
    </>
  );
}
