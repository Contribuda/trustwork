import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import { NeedStatus, RfqStatus } from '@/components/commerce/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('procurement.title') };
}

/**
 * Procurement (WEB-002): the person's needs and RFQs in their own rights (personal ones, and the employer's with the deals
 * grant), from `GET /v1/needs` and `GET /v1/rfqs` (or the demo projections). Budgets and private notes are never listed
 * here; they live on the RFQ page, labelled as visible only to the buyer side.
 */
export default async function ProcurementPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/procurement');
  const [needs, rfqs] = await Promise.all([commerce.listNeeds(principal), commerce.listRfqs(principal)]);
  const openNeeds = needs.filter((n) => n.status !== 'converted');
  const link = (path: string) => hrefFor(principal, path);
  const empty = openNeeds.length === 0 && rfqs.length === 0;
  return (
    <>
      <PageHeader
        title={t('procurement.title')}
        lede={t('procurement.lede')}
        actions={
          <>
            <ButtonLink href={link('/app/procurement/needs/new')} variant="accent">
              {t('procurement.createNeed')}
            </ButtonLink>
            <ButtonLink href="/companies" variant="secondary">
              {t('procurement.findSupplier')}
            </ButtonLink>
          </>
        }
      />
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      {empty ? (
        <div className="ws-empty">
          <strong>{t('procurement.empty')}</strong>
          <span>{t('procurement.emptyHint')}</span>
          <NextLink href={link('/app/procurement/needs/new')} className="ws-more">
            {t('procurement.createNeed')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
      ) : (
        <div className="cm-stack">
          {openNeeds.length ? (
            <section aria-labelledby="needs-title" className="cm-stack">
              <h2 id="needs-title" className="ws-h2">
                {t('commerce.list.needs')}
              </h2>
              <div className="ws-table-wrap">
                <table className="ws-table">
                  <caption>{t('commerce.list.needs')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('procurement.col.title')}</th>
                      <th scope="col">{t('procurement.col.status')}</th>
                      <th scope="col">{t('commerce.list.missing')}</th>
                      <th scope="col">{t('commerce.list.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openNeeds.map((n) => (
                      <tr key={n.id}>
                        <td data-label={t('procurement.col.title')}>
                          <NextLink href={link(`/app/procurement/needs/${encodeURIComponent(n.id)}`)}>{n.title}</NextLink>
                        </td>
                        <td data-label={t('procurement.col.status')}>
                          <NeedStatus status={n.status} />
                        </td>
                        <td data-label={t('commerce.list.missing')}>{n.missingFields.length ? t('commerce.list.missingCount', { count: n.missingFields.length }) : t('commerce.list.nothingMissing')}</td>
                        <td data-label={t('commerce.list.updated')}>{shortDate(n.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          <section aria-labelledby="rfqs-title" className="cm-stack">
            <h2 id="rfqs-title" className="ws-h2">
              {t('commerce.list.rfqs')}
            </h2>
            {rfqs.length === 0 ? (
              <p className="ws-muted">{t('commerce.list.noRfqs')}</p>
            ) : (
              <div className="ws-table-wrap">
                <table className="ws-table">
                  <caption>{t('procurement.list')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('procurement.col.title')}</th>
                      <th scope="col">{t('commerce.list.owner')}</th>
                      <th scope="col">{t('procurement.col.status')}</th>
                      <th scope="col">{t('procurement.col.version')}</th>
                      <th scope="col">{t('commerce.list.invitations')}</th>
                      <th scope="col">{t('commerce.list.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rfqs.map((r) => (
                      <tr key={r.id}>
                        <td data-label={t('procurement.col.title')}>
                          <NextLink href={link(`/app/procurement/rfq/${encodeURIComponent(r.id)}`)}>{r.title}</NextLink>
                        </td>
                        <td data-label={t('commerce.list.owner')}>{r.owner.kind === 'company' ? t('procurement.ownerCompany') : t('procurement.ownerPerson')}</td>
                        <td data-label={t('procurement.col.status')}>
                          <RfqStatus status={r.status} />
                        </td>
                        <td data-label={t('procurement.col.version')}>
                          {r.currentVersion ? t('commerce.versionN', { version: r.currentVersion }) : '—'}
                          {r.draftVersion ? <span className="cm-spec">{t('commerce.list.draftVersion', { version: r.draftVersion })}</span> : null}
                        </td>
                        <td data-label={t('commerce.list.invitations')}>
                          {r.invitations}
                          {r.staleInvitations ? <span className="cm-spec ws-note--warn">{t('commerce.list.staleInvitations', { count: r.staleInvitations })}</span> : null}
                        </td>
                        <td data-label={t('commerce.list.updated')}>{shortDate(r.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="ws-note">{t('procurement.how.note')}</p>
        </div>
      )}
    </>
  );
}
